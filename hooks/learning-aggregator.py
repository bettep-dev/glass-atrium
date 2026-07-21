#!/usr/bin/env python3
"""Learning Log Aggregator — analyze outcomes → record patterns in core.learning_log.

PG is the single sink/source: core.learning_log · core.aggregator_state.
Read paths go through the _pg_learning_dualwrite.read_* helpers.
"""

import json
import os
import re
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Pin this hook's own dir on sys.path so the sibling ga_paths seam resolves under
# any invocation (script or importlib). Unlike the fail-soft sibling imports below,
# the runtime-path seam is load-bearing, so its import is not guarded.
_HOOKS_DIR = str(Path(__file__).resolve().parent)
if _HOOKS_DIR not in sys.path:
    sys.path.insert(0, _HOOKS_DIR)
import ga_paths  # noqa: E402 — sys.path insert immediately above

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

# PG dual-write/read helpers (in-process import). psycopg missing → all PG ops
# become no-ops (HAS_PG_DUALWRITE=False); failure here MUST NOT crash the aggregator.
try:
    from _pg_learning_dualwrite import (
        upsert_learning_pattern as _pg_upsert_learning_pattern,
        update_aggregator_state as _pg_update_aggregator_state,
        batch_complete as _pg_batch_complete,
        read_aggregator_watermark as _pg_read_aggregator_watermark,
        read_learning_log_signatures as _pg_read_learning_log_signatures,
        read_outcomes_since as _pg_read_outcomes_since,
        insert_audit_queue_rows as _pg_insert_audit_queue_rows,
        negative_signal_hits as _negative_signal_hits,
        NEGATIVE_SIGNAL_NAMES as _NEGATIVE_SIGNAL_NAMES,
    )
    HAS_PG_DUALWRITE = True
except Exception as _pg_import_exc:  # noqa: BLE001 — psycopg or helper itself
    HAS_PG_DUALWRITE = False
    print(
        f"[learning-aggregator] PG dual-write disabled (import failed): "
        f"{type(_pg_import_exc).__name__}: {_pg_import_exc}",
        file=sys.stderr,
    )

DATA_DIR = str(ga_paths.get_data_root())
OUTCOMES_DIR = os.path.join(DATA_DIR, "outcomes")
# Outcomes excluded by the input filter — append-only, deduped (grep target for missing signals).
AUDIT_QUEUE_FILE = os.path.join(DATA_DIR, "outcomes-audit-queue.txt")
# file→PG sync watermark — count of audit-queue lines already mirrored into core.audit_queue.
# A sidecar single-line int file (mirrors the legacy learning-aggregator-state single-line style),
# so the file→PG sync needs NO DB migration / unique constraint: the append-only file lets a
# line-count watermark drive an idempotent "push only NEW lines" sync. Env-overridable for tests.
AUDIT_QUEUE_PG_OFFSET_FILE = os.environ.get(
    "CLAUDE_AUDIT_QUEUE_PG_OFFSET_FILE",
    os.path.join(DATA_DIR, "outcomes-audit-queue-pg-offset"),
)

# Per-phase wallclock budget, re-anchored on each phase entry — a shared module-import anchor
# would let phase 1 starve phase 2. Tests inject via CLAUDE_AGGREGATOR_MAX_SECONDS.
def _parse_max_seconds(raw: str, fallback: float = 5.0) -> float:
    """Parse CLAUDE_AGGREGATOR_MAX_SECONDS — invalid input (empty/non-numeric/≤0) falls back."""
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return fallback
    return val if val > 0 else fallback


MAX_SECONDS = _parse_max_seconds(os.environ.get("CLAUDE_AGGREGATOR_MAX_SECONDS", ""))
_PHASE_START = time.time()  # refreshed on each phase entry via _reset_phase_deadline


def _reset_phase_deadline() -> None:
    """Reset the wallclock-budget anchor on phase entry — each phase gets an independent budget."""
    global _PHASE_START
    _PHASE_START = time.time()


def _phase_deadline_exceeded() -> bool:
    """Whether the current phase exceeded MAX_SECONDS since the last _reset_phase_deadline."""
    return time.time() - _PHASE_START > MAX_SECONDS

# Strips numbers/dates/percentages from a pattern label (for duplicate-pattern comparison).
# Mirrored by daemon_cycle._PATTERN_NUMERIC_RE (proposal-history streak matching) — keep in
# sync; drift there fails open (missed match → no snooze), never suppresses a pattern.
_NUMERIC_RE = re.compile(r'\d[\d.]*%?|\d{4}-\d{2}-\d{2}|avg [\d.]+|score \d+|\d+/\d+')

# 2-tier approval (core-learning-log.md §"Instruction Improvement Approval Tier"). Only these two
# labels are emittable — daemon_cycle.read_user_pending_patterns consumes only 'user-pending'
# and auto rows are applied upstream, so a third label would desync emitter↔consumer.
PATTERN_STATUS_AUTO = "auto-approved"
PATTERN_STATUS_USER = "user-pending"
# Auto-tier entry — 3+ occurrences AND ≤5 changed lines. Larger changes stay user-pending (safety).
AUTO_FAILURE_THRESHOLD = 3
AUTO_CHANGE_LINES_MAX = 5
# No change-line estimator yet (stage 2), so this default > AUTO_CHANGE_LINES_MAX forces every
# pattern to user-pending — guarantees 0 auto-apply until the auto-apply-capable stage exists.
STAGE1_DEFAULT_CHANGE_LINES = 6

# Cross-cutting agent bucket — mirrors daemon_cycle.read_user_pending_patterns. These rows cannot
# generate patches (no agent file) yet re-upsert every cycle = churn → block emit at intake.
NOT_PATCHABLE_AGENTS = frozenset({"전체", "ALL", "all", ""})

# Pattern-5 floors — ≥50% of an agent's outcomes carrying a negative signal over ≥3 samples.
# Load-bearing mirror of daemon_cycle.py STALE_MIN_SAMPLE / STALE_FAILURE_RATE_FLOOR: the
# staleness recompute uses the same floors, or a live pattern gets mis-skipped as stale.
# (The OR-term predicate itself is shared via _pg_learning_dualwrite.negative_signal_hits.)
RATE_MIN_SAMPLE = 3
RATE_FAILURE_FLOOR = 0.5

# Pattern-7 (budget-overage concentration) — per-agent_type clustering of the
# best-effort core.budget_overages rows written at soft-budget crossings (see
# advisory-subagent-budget.sh + the plan's budget_overages contract). The
# improvement target is the AGENT FILE's emit discipline (checkpoint earlier /
# print-block-then-emit earlier), so the label is legitimately per-agent
# patchable. The ORCHESTRATOR sizing failure mode is NOT routed through this loop
# — it is handled STATICALLY by the P4 rules calibration line (D4 routing split);
# a null / cross-cutting agent_type has no agent file to patch and is dropped at
# intake (_UNPREFIXABLE_AGENTS / _emit_xc).
BUDGET_OVERAGE_LABEL = "budget-overage concentration"
# Minimum same-agent_type overage count within one watermark window before a
# cluster row is emitted — mirrors the established 3+ occurrence floor
# (AUTO_FAILURE_THRESHOLD / RATE_MIN_SAMPLE), avoiding one-off noise. Single-batch
# reachability limit (same as pattern-1's budget-truncation note): 1-2
# overages/window never form a pattern; cross-window totals accrue via the
# learning_log UPSERT frequency merge, not a lowered floor.
BUDGET_OVERAGE_MIN_OCCURRENCE = 3

# Pattern-1 DISPLAY label decouple (P3a). The signature-ANCHOR literal is load-bearing:
# PATTERN1_FAIL_LABEL is the core.learning_log pattern_signature core AND the daemon
# _FAIL_COUNT_LABEL_PREFIXES startswith-match target, so it MUST stay verbatim. A
# soft-signal-only concentration (no actual result=fail — the fleet-wide fail=0 regime
# where review_flag/blocked/done_with_concerns drive the trigger) is mislabelled by a
# literal "repeated failure"; it is shown accurately as PATTERN1_SOFT_LABEL while its
# persisted signature is anchored back to PATTERN1_FAIL_LABEL via _SIGNATURE_ANCHOR
# (no row orphan, no daemon snooze fail-open). Renaming the signature itself would need a
# LOCKSTEP migration of the daemon _FAIL_COUNT/_FAIL_RATE prefixes — out of this item's scope.
PATTERN1_FAIL_LABEL = "repeated failure by same agent"
PATTERN1_SOFT_LABEL = "recurring negative-signal concentration"
# DISPLAY label → stable pattern_signature core. Only the decoupled soft label remaps;
# every other label derives its own signature unchanged (.get default = identity), so
# pattern-5 ("agent instruction-improvement candidate …") and the legacy rows are untouched.
_SIGNATURE_ANCHOR = {PATTERN1_SOFT_LABEL: PATTERN1_FAIL_LABEL}


# Signature-residue guard (D-F4). _NUMERIC_RE strips a label's dynamic numeric but not the
# punctuation around it: 'agent instruction-improvement candidate (failure rate 75%)' → the
# orphan '(failure rate )'. Left in the dedup core that trailing-space remnant forks the
# signature. _NUMERIC_RE stays untouched (its daemon_cycle mirror; R3 regex-expansion rejected)
# — this is a separate forward-only cleanup applied at signature derivation.
_SIG_SEP_BEFORE_CLOSE_RE = re.compile(r"[,;]\s*\)")
_SIG_OPEN_SPACE_RE = re.compile(r"\(\s+")
_SIG_SPACE_CLOSE_RE = re.compile(r"\s+\)")
_SIG_EMPTY_PAREN_RE = re.compile(r"\s*\(\s*\)")
_SIG_MULTISPACE_RE = re.compile(r"\s{2,}")


def _normalize_signature_residue(text: str) -> str:
    """Normalize the residue _NUMERIC_RE leaves after stripping a label's dynamic numeric so
    the dedup signature core does not fork on a cosmetic empty-paren remnant. Forward-only:
    legacy rows keep their stored core (NO DB writes), so a re-triggered agent re-keys at most
    once (benign). Non-parenthetical labels (patterns 1/7) pass through unchanged."""
    text = _SIG_SEP_BEFORE_CLOSE_RE.sub(")", text)  # '(feature, )' → '(feature)'
    text = _SIG_OPEN_SPACE_RE.sub("(", text)
    text = _SIG_SPACE_CLOSE_RE.sub(")", text)  # '(failure rate )' → '(failure rate)'
    text = _SIG_EMPTY_PAREN_RE.sub("", text)  # 'foo ()' → 'foo'
    text = _SIG_MULTISPACE_RE.sub(" ", text)
    return text.strip()


def _pattern1_display_label(has_actual_fail: bool) -> str:
    """Pattern-1 DISPLAY label — verbatim PATTERN1_FAIL_LABEL when the agent's
    negative-signal concentration includes an actual result=fail, else the accurate
    PATTERN1_SOFT_LABEL. Both anchor to the same signature core (see _SIGNATURE_ANCHOR),
    so the daemon _FAIL_COUNT prefix match + accumulated learning_log rows survive."""
    return PATTERN1_FAIL_LABEL if has_actual_fail else PATTERN1_SOFT_LABEL


# Dead-signal WARN gate — below this batch size a zero count is expected (small watermark
# batch), not evidence of a dead metric pipeline; ~20 ≈ one full day of outcomes, the
# smallest sample where an all-zero trigger metric is anomalous.
DEAD_SIGNAL_MIN_SAMPLE = 20


def _warn_dead_signals(signal_counts: dict[str, int], sample: int) -> None:
    """WARN when a trigger metric never fired across the batch — a dead metric pipeline
    (e.g. the grader stops writing verdicts) silently starves the re-keyed per-agent
    triggers, so surface it loudly instead of letting candidates quietly dry up."""
    if not HAS_PG_DUALWRITE or sample < DEAD_SIGNAL_MIN_SAMPLE:
        return
    dead = [name for name in _NEGATIVE_SIGNAL_NAMES if signal_counts.get(name, 0) == 0]
    if not dead:
        return
    print(
        f"[learning-aggregator] WARN: dead trigger signals — 0 occurrences "
        f"across {sample} aggregated records: {', '.join(dead)}",
        file=sys.stderr,
    )


def atomic_write(path: str, content: str, mode: int = 0o644) -> None:
    """Atomic same-FS write (tempfile.mkstemp + fsync + os.replace) — crash/concurrent-run safe.
    On failure, cleans up the tmp file and re-raises (caller owns the fallback)."""
    dir_name = os.path.dirname(path) or '.'
    fd, tmp_path = tempfile.mkstemp(prefix='.tmp_', dir=dir_name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())  # persist before rename
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)  # POSIX atomic rename (same FS only)
    except Exception:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise


# ---------------------------------------------------------------------------
# T3 telemetry sink — compliance-rate signal recorder.
# DETECTION-ONLY: records a signal line, NEVER blocks aggregation. The rate
# COMPUTATION and the JSONL WRITER both live in ONE shared SoT module
# (compliance_telemetry — sibling of this file under hooks/), imported by both
# this aggregator and daemon_cycle.py so the formula + sink each exist once.
# ---------------------------------------------------------------------------

# Shared SoT for the compliance-rate computation + signal-store writer. This file
# runs from ~/.claude/hooks (its own dir is on sys.path), so the sibling module is
# importable by bare name. Fail-soft: a missing module disables the recorder
# rather than crashing aggregation.
try:
    import compliance_telemetry as _compliance_telemetry
except Exception as _ct_import_exc:  # noqa: BLE001 — telemetry is non-critical
    # _compliance_telemetry is None is the SOLE disabled-state flag consulted;
    # record_compliance_signal delegates the store path to append_signal, so no
    # local SIGNAL_STORE_FILE fallback is needed or read here.
    _compliance_telemetry = None
    print(
        f"[learning-aggregator] compliance_telemetry import failed — compliance "
        f"recorder disabled: {type(_ct_import_exc).__name__}: {_ct_import_exc}",
        file=sys.stderr,
    )


def record_compliance_signal(
    *,
    gate_log_file: str | None = None,
    store_file: str | None = None,
) -> bool:
    """Record the TRUE gate COMPLIANCE-RATE into the signal store (shared SoT).

    The proxy metric is the COMPLIANCE RATE (``pass / total`` over REAL gate
    encounters from the durable workflow-gate trace log), NEVER a rule-count or
    patch-count (core Goodhart guard), and NEVER the former degenerate
    ``1 - (trip)/(trip)`` 0/1 flag. When the gate log is absent/empty the rate is
    ``None`` (honest insufficient-data, never a fabricated value); the override
    dimension has no durable store so ``override_rate`` is always ``None``.

    Both the rate computation and the JSONL append delegate to the single shared
    module. Fail-soft: a missing module / write failure returns False — a
    telemetry sink problem MUST NOT block aggregation.
    """
    if _compliance_telemetry is None:
        print(
            "[learning-aggregator] compliance_telemetry unavailable — "
            "compliance signal not recorded",
            file=sys.stderr,
        )
        return False

    log_path = Path(gate_log_file) if gate_log_file is not None else None
    compliance = _compliance_telemetry.compute_compliance_rate(log_file=log_path)
    payload = {
        "signal_type": "compliance_rate",
        "detection_only": True,
        "compliance_rate": compliance["compliance_rate"],
        "override_rate": compliance["override_rate"],
        "gate_pass_count": compliance["gate_pass_count"],
        "gate_trip_count": compliance["gate_trip_count"],
        "gate_total_count": compliance["gate_total_count"],
    }
    return _compliance_telemetry.append_signal(payload, store_file)


def _classify_pattern_status(pattern: dict) -> str:
    """Occurrence count + estimated change-lines → 2-tier approval label.

    Without estimated_change_lines, STAGE1_DEFAULT_CHANGE_LINES applies and the pattern always
    falls into user-pending — the safe default (0 auto-apply until a change-line estimator exists).
    """
    failure_count = pattern.get("failure_count", 0)
    if not isinstance(failure_count, int) or failure_count < 0:
        return PATTERN_STATUS_USER  # invalid input → safest tier (blocks auto-apply)
    estimated = pattern.get("estimated_change_lines", STAGE1_DEFAULT_CHANGE_LINES)
    if not isinstance(estimated, int) or estimated < 0:
        estimated = STAGE1_DEFAULT_CHANGE_LINES

    if failure_count >= AUTO_FAILURE_THRESHOLD and estimated <= AUTO_CHANGE_LINES_MAX:
        return PATTERN_STATUS_AUTO
    return PATTERN_STATUS_USER


def _build_entry(
    today: str,
    pattern_label: str,
    freq_str: str,
    agent_label: str,
    failure_count: int,
    estimated_change_lines: int | None = None,
) -> str:
    """Build one learning-log table row (6th column = 2-tier approval tier)."""
    pattern_for_classify: dict = {"failure_count": failure_count}
    if estimated_change_lines is not None:
        pattern_for_classify["estimated_change_lines"] = estimated_change_lines
    tier = _classify_pattern_status(pattern_for_classify)
    return f"| {today} | {pattern_label} | {freq_str} | {agent_label} | identified | {tier} |"


def _emit_xc(entries: list, entry: str, agent_label: str) -> None:
    """Intake gate — appends only patchable-agent patterns. NOT_PATCHABLE_AGENTS are blocked
    (downstream daemon_cycle skips the same set, so they would only churn learning_log)."""
    if agent_label in NOT_PATCHABLE_AGENTS:
        return
    entries.append(entry)


def _regex_yaml_parse(text: str) -> dict | None:
    """Simple YAML frontmatter parser for when PyYAML is absent — flat key: value pairs only.
    CONTRACT: valid only for the writer's flat-scalar fields; any list/dict field would be dropped."""
    result = {}
    for line in text.strip().splitlines():
        m = re.match(r'^(\w[\w_-]*)\s*:\s*(.+)$', line)
        if not m:
            continue
        key = m.group(1)
        val = m.group(2).strip()
        if val.lower() == 'true':
            result[key] = True
        elif val.lower() == 'false':
            result[key] = False
        else:
            try:
                result[key] = int(val)
            except ValueError:
                result[key] = val
    return result or None


def load_outcome(path: str) -> dict | None:
    """Parse YAML frontmatter (PyYAML first, regex fallback if absent).
    A per-file exception is logged + returns None so one bad file cannot abort the aggregation."""
    # UTF-8 strict first, errors='replace' on failure (lossy is fine — only frontmatter needed)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError as e:
        print(f"[learning-aggregator] UTF-8 decode failed, errors='replace' fallback: {os.path.basename(path)} ({e})", file=sys.stderr)
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except OSError as e2:
            print(f"[learning-aggregator] fallback read also failed, skip: {os.path.basename(path)} ({e2})", file=sys.stderr)
            return None
    except OSError as e:
        print(f"[learning-aggregator] file read failed, skip: {os.path.basename(path)} ({e})", file=sys.stderr)
        return None

    if not content.startswith('---'):
        return None
    parts = content.split('---', 2)
    if len(parts) < 3:
        return None

    frontmatter = parts[1]
    # YAML parse → regex fallback → None (never abort the whole aggregation on one file)
    if HAS_YAML:
        try:
            parsed = yaml.safe_load(frontmatter)
            if parsed is None or not isinstance(parsed, dict):
                return _regex_yaml_parse(frontmatter)  # empty/non-dict → regex fallback
            return parsed
        except yaml.YAMLError as e:
            print(f"[learning-aggregator] YAML parse failed, regex fallback: {os.path.basename(path)} ({str(e)[:80]})", file=sys.stderr)
            try:
                return _regex_yaml_parse(frontmatter)
            except Exception as e2:
                print(f"[learning-aggregator] regex fallback also failed, skip: {os.path.basename(path)} ({e2})", file=sys.stderr)
                return None
        except Exception as e:
            print(f"[learning-aggregator] exception during parse, skip: {os.path.basename(path)} ({type(e).__name__}: {str(e)[:80]})", file=sys.stderr)
            return None
    try:
        return _regex_yaml_parse(frontmatter)
    except Exception as e:
        print(f"[learning-aggregator] regex parse exception, skip: {os.path.basename(path)} ({e})", file=sys.stderr)
        return None

# ---------------------------------------------------------------------------
# Input filter — exclude polluted records (unknown/deprecated agent, missing lesson).
# Deterministic; recording to the audit queue is the caller's job. See _should_include_outcome
# for the per-branch decision logic.
# ---------------------------------------------------------------------------


# Values treated as an empty lesson — covers yaml-fallback raw tokens too (None / "" / '""' / "''")
_EMPTY_LESSON_SENTINELS = {"", '""', "''", "null", "none", "n/a"}

# Deprecated/sandbox/retired agents — excluded so their fails do not skew agent-level patterns.
DEPRECATED_AGENTS: frozenset[str] = frozenset({
    "Explore",
    "animator",
    "general-purpose",
    "code-simplifier",
    "feature-dev",
})

# Live agents/*.md stems carry this prefix; outcome rows record the same logical
# agent as bare, prefixed, or colon-qualified forms — without one canonical key
# a single agent splits across aggregation keys and written patterns.
_CANONICAL_AGENT_PREFIX = "glass-atrium-"
# Sentinel/label values that are never roster stems — prefixing them would
# fabricate a nonexistent agents/<stem>.md target for daemon_cycle intake.
_UNPREFIXABLE_AGENTS = frozenset({"", "unknown", "전체", "ALL", "all"})


def _get_bare_agent_stem(agent: str) -> str:
    """Prefix-stripped stem — prefix-insensitive matching (DEPRECATED_AGENTS)."""
    if agent.startswith(_CANONICAL_AGENT_PREFIX):
        return agent[len(_CANONICAL_AGENT_PREFIX):]
    return agent


def _canonical_agent(raw: object) -> str:
    """Canonical agent key = the live roster stem form (glass-atrium-<bare>).

    - colon form ('dev-shell:qualifier') keeps only the leading agent segment
    - already-prefixed stems pass through unchanged
    - sentinel + deprecated names stay bare (no roster stem exists for them)
    - any other bare stem gains the canonical prefix, so counts and patterns
      written going forward key on the stem daemon_cycle intake resolves to
      agents/<stem>.md
    """
    agent = str(raw).strip() if raw is not None else ""
    if ":" in agent:
        agent = agent.split(":", 1)[0].strip()
    if agent.startswith(_CANONICAL_AGENT_PREFIX):
        return agent
    if agent in _UNPREFIXABLE_AGENTS or agent.lower() == "unknown":
        return agent
    if agent in DEPRECATED_AGENTS:
        return agent
    return _CANONICAL_AGENT_PREFIX + agent


def _is_empty_lesson(value: object) -> bool:
    """Whether the lesson field is empty/unusable. Non-str (int/bool/list) counts as empty too;
    the regex fallback keeps raw tokens like '""', so those are caught by the sentinel set."""
    if value is None:
        return True
    if not isinstance(value, str):
        return True
    return value.strip().lower() in _EMPTY_LESSON_SENTINELS


def _should_include_outcome(record: dict) -> tuple[bool, str]:
    """Input-stage filter for one outcome record → (include?, exclusion_reason).
      include=True  → reason '' (normal) or 'empty_lesson_only'/'cron_no_lesson' (OK to aggregate, excluded from clustering)
      include=False → classified reason string (for audit/log)
    Deterministic, no side effects (the caller records to the audit queue)."""
    agent = record.get("agent", "")
    attribution = record.get("attribution_source", "")
    if not isinstance(agent, str):
        agent = str(agent) if agent is not None else ""
    if not isinstance(attribution, str):
        attribution = str(attribution) if attribution is not None else ""
    attribution = attribution.strip()

    # deprecated agent first — so 'Explore' + empty lesson reports 'deprecated_agent', not 'empty_lesson_only'
    # · prefix/colon-insensitive via the canonical bare stem, so 'glass-atrium-animator'
    #   and 'animator:x' do not slip past the exclusion under an alias form
    if _get_bare_agent_stem(_canonical_agent(agent)) in DEPRECATED_AGENTS:
        return False, "deprecated_agent"

    if attribution == "completion-missing":
        return False, "completion_missing"
    if attribution == "agent-id-missing":
        return False, "agent_id_missing"
    if attribution == "cron-derived":
        # verified normal path — pass through; empty lesson → 'cron_no_lesson' (clustering exclusion)
        if _is_empty_lesson(record.get("lesson")):
            return True, "cron_no_lesson"
        return True, ""

    # no attribution + agent 'unknown' → legacy polluted record
    if (not attribution) and agent.strip().lower() == "unknown":
        return False, "legacy_unknown"

    # normal agent — missing lesson does not affect pattern aggregation, only clustering
    if _is_empty_lesson(record.get("lesson")):
        return True, "empty_lesson_only"

    return True, ""


def _append_audit_queue(path: str, reason: str) -> None:
    """Append an excluded outcome path to the audit queue (deduped).
    Failures log to stderr only — never block the aggregation flow."""
    line = f"{reason}\t{path}\n"
    # idempotency: skip if the line already exists (keeps the file bounded)
    try:
        if os.path.exists(AUDIT_QUEUE_FILE):
            with open(AUDIT_QUEUE_FILE, "r", encoding="utf-8") as f:
                if line in f.read():
                    return
    except OSError as e:
        print(f"[learning-aggregator] audit queue read failed, continuing write attempt: {e}", file=sys.stderr)
    try:
        with open(AUDIT_QUEUE_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError as e:
        print(f"[learning-aggregator] audit queue write failed: {e}", file=sys.stderr)


def _parse_audit_queue_line(line: str) -> dict | None:
    """Parse one `<reason>\\t<excluded_path>\\n` audit-queue line → row dict, or None when malformed.
    The file format is exactly the `_append_audit_queue` write shape: a single TAB splits reason
    (left) from path (right). Blank lines / missing TAB / empty halves → None (skipped by the sync)."""
    stripped = line.rstrip("\n")
    if not stripped:
        return None
    parts = stripped.split("\t", 1)
    if len(parts) != 2:
        return None
    reason, excluded_path = parts[0].strip(), parts[1].strip()
    if not reason or not excluded_path:
        return None
    # excluded_at omitted — flat file carries no timestamp; PG INSERT stamps now() via COALESCE.
    return {"excluded_path": excluded_path, "reason": reason}


def _read_audit_queue_pg_offset() -> int:
    """Lines already mirrored into core.audit_queue (the file→PG watermark).
    Missing / unreadable / non-int → 0 (re-mirror from the top — the watermark only ever advances
    after a successful PG push, so a reset-to-0 cannot skip an un-pushed line)."""
    try:
        with open(AUDIT_QUEUE_PG_OFFSET_FILE, "r", encoding="utf-8") as f:
            return max(0, int(f.read().strip()))
    except (OSError, ValueError):
        return 0


def _write_audit_queue_pg_offset(count: int) -> None:
    """Persist the file→PG watermark (count of mirrored lines) atomically. Failure logs only —
    a lost watermark re-mirrors already-pushed lines next run (acceptable: the audit_queue table is
    a grep aid, not a learning input, so a rare duplicate row is harmless vs. blocking aggregation)."""
    try:
        atomic_write(AUDIT_QUEUE_PG_OFFSET_FILE, f"{max(0, count)}\n")
    except OSError as e:
        print(f"[learning-aggregator] audit-queue PG offset write failed: {e}", file=sys.stderr)


def _sync_audit_queue_to_pg() -> int:
    """Mirror NEW audit-queue file lines into core.audit_queue (idempotent file→PG push).

    Watermark-driven: reads the line-count offset, pushes only lines BEYOND it, then advances the
    offset ONLY after a successful PG insert. Re-running with no new appends is a no-op (the offset
    already covers every line) — so this never duplicates rows despite the table having no unique
    constraint. PG-side failure is swallowed (the offset is NOT advanced, so the next run retries the
    same lines) — a PG audit_queue problem MUST NOT block aggregation (fail-soft, sibling policy).
    Returns the number of lines pushed this call (0 when nothing new / PG unavailable)."""
    if not HAS_PG_DUALWRITE:
        return 0
    try:
        with open(AUDIT_QUEUE_FILE, "r", encoding="utf-8") as f:
            all_lines = f.readlines()
    except FileNotFoundError:
        return 0  # no file yet → nothing to mirror
    except OSError as e:
        print(f"[learning-aggregator] audit-queue sync read failed, skip: {e}", file=sys.stderr)
        return 0

    offset = _read_audit_queue_pg_offset()
    total = len(all_lines)
    if offset >= total:
        return 0  # watermark covers the whole file — nothing new

    new_lines = all_lines[offset:]
    rows = [r for r in (_parse_audit_queue_line(ln) for ln in new_lines) if r is not None]
    if not rows:
        # all new lines were blank/malformed → still advance past them so we don't re-scan forever
        _write_audit_queue_pg_offset(total)
        return 0

    try:
        _pg_insert_audit_queue_rows(rows)
    except ValueError as ve:  # malformed batch — log + skip, do NOT advance (caller can fix + retry)
        print(f"[learning-aggregator] audit_queue PG skip (validation): {ve}", file=sys.stderr)
        return 0
    except Exception as exc:  # noqa: BLE001 — fail-soft: PG audit_queue MUST NOT block aggregation
        print(
            f"[learning-aggregator] audit_queue PG insert failed ({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
        return 0  # offset NOT advanced → next run retries these same lines

    # advance the watermark only after a confirmed push (covers parsed + skipped malformed lines)
    _write_audit_queue_pg_offset(total)
    return len(rows)


def _emit_exclusion_summary(aggregated: int, exclusion_counts: dict[str, int]) -> None:
    """One-line input-filter summary log; skip when both counts are 0 (avoid noise)."""
    total_excluded = sum(exclusion_counts.values())
    if aggregated == 0 and total_excluded == 0:
        return
    parts = ", ".join(
        f"{reason}={count}" for reason, count in sorted(exclusion_counts.items())
    )
    parts_str = f" ({parts})" if parts else ""
    print(
        f"[learning-aggregator] aggregated {aggregated} records, "
        f"excluded {total_excluded}{parts_str}",
        file=sys.stderr,
    )


def _read_budget_overages(since_epoch: float) -> list[dict]:
    """Read core.budget_overages agent_type values written after since_epoch.

    Windowed by the shared aggregator watermark (ts > since_epoch) so each overage
    row is clustered in exactly one run — reading the whole table every run would
    double-count under the learning_log UPSERT frequency merge. PG absent /
    unreachable → [] (degrade-not-die, sibling policy to the _pg_learning_dualwrite
    read helpers). Only agent_type is fetched — the sole field per-agent_type
    clustering needs."""
    if not HAS_PG_DUALWRITE:
        return []
    try:
        import psycopg  # HAS_PG_DUALWRITE True guarantees this import succeeds
    except ImportError:
        return []
    try:
        with psycopg.connect(
            "dbname=glass_atrium", connect_timeout=2, autocommit=True
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT agent_type FROM core.budget_overages "
                    "WHERE ts > to_timestamp(%s)",
                    (since_epoch,),
                )
                return [{"agent_type": row[0]} for row in cur.fetchall()]
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        print(
            f"[learning-aggregator] budget_overages read failed, skip "
            f"({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
        return []


def _cluster_budget_overages(overage_rows: list[dict]) -> dict[str, int]:
    """Cluster budget_overage rows into per-canonical-agent_type counts.

    Pure (no I/O) so it unit-tests without a live DB. Each row's agent_type is
    canonicalized to the live roster stem (glass-atrium-<stem>) so daemon_cycle
    intake resolves it to agents/<stem>.md; a null / unknown / cross-cutting
    agent_type has no patchable agent file (_UNPREFIXABLE_AGENTS) and is dropped.
    The ORCHESTRATOR sizing failure mode is handled statically by the P4
    calibration line, never routed through this per-agent loop (D4 routing split)."""
    counts: dict[str, int] = defaultdict(int)
    for row in overage_rows:
        # _canonical_agent maps a null / missing agent_type to "" (an
        # _UNPREFIXABLE_AGENTS member), so the single drop gate below covers it.
        agent = _canonical_agent(row.get("agent_type"))
        if agent in _UNPREFIXABLE_AGENTS:
            continue  # null / unknown / cross-cutting → no agent file to patch
        counts[agent] += 1
    return counts


# ---------------------------------------------------------------------------
# AD-1 / AD-2 — CTM/EPM lesson store: size-capped labeled memory blocks
# (Letta/MemGPT) with consolidation-op ingest (Mem0). A local JSON store —
# NOT PG — because the spawn-time consumer (inject-scope-rules.sh, AD-3) is a
# Bash hook that reads it with jq; a PG read from Bash is impractical + violates
# the hook's <1s / fail-open contract. The pure functions below take no I/O so
# they unit-test without a live DB (aggregator-test convention).
# ---------------------------------------------------------------------------

# Store path — env-overridable for tests + the AD-3 hook's matching default.
LESSON_STORE_FILE = os.environ.get(
    "CLAUDE_LESSONS_STORE_FILE", os.path.join(DATA_DIR, "lessons.json")
)

# AD-1 per-bucket char caps (MemGPT memory-block precedent). Cap is on the ACTIVE
# (non-tombstoned, non-digest) lesson-text sum; overflow triggers evict-with-digest — a
# hard-evict plus a NO-LLM evicted-digest footer (the non-agentic hook has no LLM call, so
# true Letta-style summarization is not portable; the footer preserves a count/tag trace).
CTM_BUCKET_MAX_CHARS = 4000
EPM_BUCKET_MAX_CHARS = 4000

# AD-3 CTM injectable floor — the injector selects score >= 4; admission is tiered (D4):
# high lands AT the floor immediately, medium lands BELOW it (provisional) until corroborated.
CTM_MIN_SCORE = 4

# confidence enum → stored lesson score (self-report; unknown=3). medium=3 is the D4
# provisional SUB-FLOOR — non-injectable until promoted; classify gates medium by the
# confidence string, so low (also 3) never rides along into CTM.
_CONFIDENCE_SCORE = {"high": 5, "medium": 3, "low": 3}

# D4 corroboration bar — a provisional lesson re-observed to this frequency promotes to the floor.
CORROBORATION_MIN_FREQUENCY = 2

# D1 staleness window (days) — a live lesson whose `updated` anchor is older is tombstoned by
# the ingest-time sweep (soft-delete; MERGE resurrection keeps a wrong sweep recoverable).
LESSON_STALE_DAYS = 30

# D2/D3 lesson-key allowlist source — the lifecycle-CLI-written registry; env-overridable for tests.
AGENT_REGISTRY_FILE = os.environ.get(
    "CLAUDE_AGENT_REGISTRY_FILE",
    os.path.expanduser("~/.glass-atrium/agent-registry.json"),
)

# Numeric/whitespace strip for lesson-text dedup — two lessons differing only in a
# count/date/percentage are ONE lesson (a duplicate bumps frequency, never a new row).
_LESSON_NORM_RE = re.compile(r"\d[\d.]*%?")


def _normalize_lesson_text(text: object) -> str:
    """Dedup key for a lesson body — lowercased, numeric-stripped, whitespace-collapsed.
    A cosmetic numeric/case/spacing difference must NOT fork a duplicate into a new entry."""
    s = str(text or "").strip().lower()
    s = _LESSON_NORM_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def _lesson_size(entry: dict) -> int:
    """Char weight of one lesson = its text length (the injected surface, AD-1 cap basis)."""
    return len(str(entry.get("text", "")))


def _bucket_active_size(bucket: list[dict]) -> int:
    """Sum of active (non-tombstoned, non-digest) lesson-text lengths — the AD-1 cap is measured
    on THIS; the evicted-digest footer carries no active weight, so it is cap-excluded here."""
    return sum(
        _lesson_size(e) for e in bucket if not e.get("tombstoned") and not e.get("digest")
    )


def _lesson_score(record: dict) -> int:
    """Outcome confidence enum → integer lesson score (CTM score>=4 filter basis)."""
    conf = str(record.get("confidence", "")).strip().lower()
    return _CONFIDENCE_SCORE.get(conf, 3)


def _record_is_negative(record: dict) -> bool:
    """DB-independent negative-signal check (mirrors the _negative_signal_hits OR-terms) so
    classify_lesson_bucket unit-tests without the PG helper: fail/blocked/done_with_concerns,
    revision_count>=2, evaluative_signal=-1, or review_flag=true → EPM-bound."""
    if str(record.get("result", "")).strip() in ("fail", "blocked", "done_with_concerns"):
        return True
    try:
        if int(record.get("revision_count", 0) or 0) >= 2:
            return True
    except (TypeError, ValueError):
        pass
    if str(record.get("evaluative_signal", "")).strip() == "-1":
        return True
    rf = record.get("review_flag")
    return rf is True or str(rf).strip().lower() == "true"


def classify_lesson_bucket(record: dict) -> str | None:
    """Route one outcome's lesson to "ctm" (success) / "epm" (failure) / None (skip).

    Negative signal → EPM. Clean done + metric_pass → CTM by confidence tier (D4): high
    admits at the injectable floor immediately; medium admits PROVISIONAL (sub-floor score,
    injectable only after promote_corroborated_lessons); low/unknown never admit. A
    grader_verdict of verified_fail never admits CTM — falsified evidence outranks the
    writer self-report even when review_flag was not set."""
    if _record_is_negative(record):
        return "epm"
    if str(record.get("grader_verdict", "")).strip().lower() == "verified_fail":
        return None
    mp = record.get("metric_pass")
    mp_true = mp is True or str(mp).strip().lower() == "true"
    if str(record.get("result", "")).strip() != "done" or not mp_true:
        return None
    if _lesson_score(record) >= CTM_MIN_SCORE:
        return "ctm"
    if str(record.get("confidence", "")).strip().lower() == "medium":
        return "ctm"
    return None


def _outcome_to_lesson_entry(record: dict, today: str) -> dict:
    """Distil one outcome record into a lesson-store entry (canonical agent key + score).
    A medium-confidence record stores the provisional sub-floor score (D4, via _lesson_score)."""
    return {
        "agent": _canonical_agent(record.get("agent", "")),
        "task_type": str(record.get("task_type", "")).strip(),
        "text": str(record.get("lesson", "")).strip(),
        "score": _lesson_score(record),
        "updated": today,
    }


def ingest_lesson(bucket: list[dict], entry: dict) -> str:
    """AD-2 consolidation-op ingest (Mem0) — ADD / UPDATE / MERGE, NEVER hard-delete.

    - live (agent, task_type, normalized-text) match → UPDATE: frequency+1, score=max,
      refresh `updated` (a DUPLICATE lesson bumps frequency, it never appends a new row).
    - tombstoned match → MERGE: resurrect (tombstoned=False) + frequency+1 (a re-observed
      stale lesson revives rather than duplicating).
    - no match → ADD a fresh entry (frequency 1).
    Returns the op name for the caller's audit log. Hard-delete is NOT an op here — capacity
    removal is enforce_bucket_cap's job (AD-1); staleness removal is tombstone_lesson's."""
    key = (
        entry.get("agent"),
        entry.get("task_type"),
        _normalize_lesson_text(entry.get("text")),
    )
    for existing in bucket:
        ekey = (
            existing.get("agent"),
            existing.get("task_type"),
            _normalize_lesson_text(existing.get("text")),
        )
        if ekey == key:
            existing["frequency"] = int(existing.get("frequency", 0) or 0) + 1
            existing["score"] = max(
                int(existing.get("score", 0) or 0), int(entry.get("score", 0) or 0)
            )
            existing["updated"] = entry.get("updated", existing.get("updated", ""))
            if existing.get("tombstoned"):
                existing["tombstoned"] = False
                return "MERGE"
            return "UPDATE"
    bucket.append({
        "agent": entry.get("agent"),
        "task_type": entry.get("task_type"),
        "text": str(entry.get("text", "")),
        "score": int(entry.get("score", 0) or 0),
        "frequency": 1,
        "tombstoned": False,
        "updated": entry.get("updated", ""),
    })
    return "ADD"


def tombstone_lesson(bucket: list[dict], agent: str, task_type: str, text: str) -> bool:
    """AD-2 TOMBSTONE — SOFT-delete a stale lesson (tombstoned=True), row RETAINED (never
    hard-deleted). Excluded from injection + the active-cap sum, but resurrectable via a later
    MERGE ingest. Returns True when a matching live/tombstoned row was marked."""
    key = (agent, task_type, _normalize_lesson_text(text))
    for existing in bucket:
        ekey = (
            existing.get("agent"),
            existing.get("task_type"),
            _normalize_lesson_text(existing.get("text")),
        )
        if ekey == key:
            existing["tombstoned"] = True
            return True
    return False


def _lesson_is_stale(entry: dict, today: datetime, stale_days: int) -> bool:
    """D1 staleness — `updated` older than stale_days; a missing/empty/unparseable anchor is
    stale too (a row that cannot demonstrate freshness cannot be trusted as current)."""
    raw = str(entry.get("updated", "") or "").strip()
    if not raw:
        return True
    try:
        updated = datetime.strptime(raw, "%Y-%m-%d")
    except ValueError:
        return True
    return (today - updated).days > stale_days


def sweep_stale_lessons(store: dict, today: datetime, stale_days: int = LESSON_STALE_DAYS) -> int:
    """D1 staleness sweep — tombstone every live stale lesson via the canonical tombstone_lesson
    (AD-2 soft-delete: row retained, MERGE-resurrectable). Fresh ingests always stamp `updated`
    with today, so a same-pass ingest can never be swept. Returns the tombstoned count."""
    swept = 0
    for bucket in (store.get("ctm", []), store.get("epm", [])):
        live = [e for e in bucket if not e.get("tombstoned") and not e.get("digest")]
        for entry in live:
            if _lesson_is_stale(entry, today, stale_days) and tombstone_lesson(
                bucket, entry.get("agent"), entry.get("task_type"), entry.get("text")
            ):
                swept += 1
    return swept


def promote_corroborated_lessons(bucket: list[dict]) -> int:
    """D4 promotion — a provisional (sub-floor score) lesson corroborated to
    CORROBORATION_MIN_FREQUENCY is bumped to the injectable floor. Explicit, because the
    ingest UPDATE path's score=max(existing, entry) can never lift a medium duplicate
    (3 vs 3) past the floor. Returns the promoted count."""
    promoted = 0
    for entry in bucket:
        if entry.get("tombstoned") or entry.get("digest"):
            continue
        if (
            int(entry.get("frequency", 0) or 0) >= CORROBORATION_MIN_FREQUENCY
            and int(entry.get("score", 0) or 0) < CTM_MIN_SCORE
        ):
            entry["score"] = CTM_MIN_SCORE
            promoted += 1
    return promoted


# AD-1 evicted-digest footer — a single NO-LLM summary row per bucket recording what
# capacity-eviction dropped (cumulative count + per-task_type tags). It preserves a trace of the
# lost signal (Letta summarize-and-evict INTENT) without an LLM call, and is EXCLUDED from the
# active-size cap, so appending it can never breach the cap invariant.
_EVICTED_DIGEST_PREFIX = "[evicted-digest]"


def _find_evicted_digest(bucket: list[dict]) -> dict | None:
    """The bucket's single digest footer, if one exists (marked digest=True)."""
    for e in bucket:
        if e.get("digest"):
            return e
    return None


def _render_evicted_digest_text(count: int, tags: dict[str, int]) -> str:
    """One-line count/tag summary — e.g. '[evicted-digest] 3 evicted: feature×2, bug-fix×1',
    tags ordered by descending count then name (stable, NO-LLM)."""
    parts = ", ".join(
        f"{tag or '?'}×{n}" for tag, n in sorted(tags.items(), key=lambda kv: (-kv[1], kv[0]))
    )
    body = f": {parts}" if parts else ""
    return f"{_EVICTED_DIGEST_PREFIX} {count} evicted{body}"


def _update_evicted_digest(bucket: list[dict], evicted: list[dict]) -> None:
    """Fold the just-evicted entries into the bucket's single digest footer (cumulative, NO-LLM).
    The footer is cap-excluded (_bucket_active_size skips digest rows), so it never re-triggers
    eviction. Digest rows among `evicted` are skipped (the digest is never an eviction victim)."""
    live_evicted = [e for e in evicted if not e.get("digest")]
    if not live_evicted:
        return
    digest = _find_evicted_digest(bucket)
    if digest is None:
        digest = {"digest": True, "evicted_count": 0, "tags": {}, "text": ""}
        bucket.append(digest)
    tags: dict[str, int] = dict(digest.get("tags") or {})
    for e in live_evicted:
        tag = str(e.get("task_type") or "").strip()
        tags[tag] = tags.get(tag, 0) + 1
    digest["evicted_count"] = int(digest.get("evicted_count", 0) or 0) + len(live_evicted)
    digest["tags"] = tags
    digest["text"] = _render_evicted_digest_text(digest["evicted_count"], tags)


def enforce_bucket_cap(bucket: list[dict], max_chars: int) -> list[dict]:
    """AD-1 evict-with-digest — keep the ACTIVE lesson-text sum <= max_chars.

    Eviction order (lowest value first): tombstoned dead-weight, then live ascending by
    (score, frequency). Capacity eviction is the SOLE hard-removal path and is DISTINCT from
    the AD-2 tombstone soft-delete — it fires on capacity pressure, not staleness, so removing
    a tombstoned row here is legitimate (it reclaims file space, carries no active weight).
    Evicted entries are then folded into a single NO-LLM evicted-digest footer (count +
    per-task_type tags) so the dropped signal leaves a trace (Letta summarize-and-evict INTENT,
    sans LLM). The digest footer is cap-EXCLUDED and is NEVER an eviction candidate.
    Mutates `bucket` in place; returns the evicted entries for the caller's audit.
    AC: on return, _bucket_active_size(bucket) <= max_chars."""
    evicted: list[dict] = []

    def _evict_rank(e: dict) -> tuple:
        return (
            0 if e.get("tombstoned") else 1,  # tombstoned evicted first
            int(e.get("score", 0) or 0),
            int(e.get("frequency", 0) or 0),
        )

    # Evicting a tombstoned row does not shrink the active sum, so the loop keeps going until a
    # live row is removed — it terminates because the candidate pool strictly shrinks each pass.
    while _bucket_active_size(bucket) > max_chars:
        candidates = [e for e in bucket if not e.get("digest")]
        if not candidates:
            break  # only the cap-excluded digest remains → active sum is already 0
        victim = min(candidates, key=_evict_rank)
        bucket.remove(victim)
        evicted.append(victim)
    if evicted:
        _update_evicted_digest(bucket, evicted)
    return evicted


def load_lesson_store(path: str) -> dict:
    """Load the JSON lesson store → {"ctm": [...], "epm": [...]}. Missing / unreadable /
    malformed → a fresh empty store (fail-soft: a corrupt store must not block aggregation)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    for bucket in ("ctm", "epm"):
        if not isinstance(data.get(bucket), list):
            data[bucket] = []
    return data


def save_lesson_store(path: str, store: dict) -> None:
    """Atomically persist the lesson store (reuses the crash-safe atomic_write)."""
    atomic_write(
        path, json.dumps(store, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )


def _load_registry_agents(path: str) -> frozenset[str] | None:
    """D2/D3 lesson-key allowlist — the registry's agent keys (the injectable roster).
    Missing/unreadable/malformed → None, meaning validation is SKIPPED (fail-open: a registry
    problem must never block lesson ingest — sibling policy to the store fail-soft)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    agents = data.get("agents") if isinstance(data, dict) else None
    if not isinstance(agents, dict) or not agents:
        return None
    return frozenset(agents)


def ingest_outcome_lessons(
    records: list[dict],
    path: str | None = None,
    registry_path: str | None = None,
    stale_days: int = LESSON_STALE_DAYS,
) -> dict[str, int]:
    """Build/update the CTM/EPM lesson store from a batch of outcomes, then run the D1
    staleness sweep, the D4 corroboration promotion, and the AD-1 cap enforcement.

    Lesson keys are validated against the agent registry (D2/D3): an unregistered agent's
    lesson is rejected with one loud skip line (invariant: lesson keys ⊆ injectable registry
    keys); an unavailable registry skips validation with one warning (fail-open).
    Fail-soft: any error logs + returns zero-counts — a lesson-store problem MUST NOT block the
    core aggregation (sibling policy to the PG read helpers). Returns per-op counts for the log."""
    store_path = path or LESSON_STORE_FILE
    ops: dict[str, int] = defaultdict(int)
    try:
        registry = _load_registry_agents(registry_path or AGENT_REGISTRY_FILE)
        if registry is None:
            print(
                "[learning-aggregator] agent registry unavailable, "
                "lesson-key validation skipped (fail-open)",
                file=sys.stderr,
            )
        store = load_lesson_store(store_path)
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        for rec in records:
            if _is_empty_lesson(rec.get("lesson")):
                continue
            bucket_name = classify_lesson_bucket(rec)
            if bucket_name is None:
                continue
            entry = _outcome_to_lesson_entry(rec, today)
            if not entry["agent"] or entry["agent"] in _UNPREFIXABLE_AGENTS:
                continue  # no roster stem → not injectable at spawn (AD-3 matches on agent)
            if registry is not None and entry["agent"] not in registry:
                # D2: a key outside the registry has NO injection consumer — reject loudly
                # rather than accumulate dead weight (lesson keys ⊆ injectable keys).
                print(
                    f"[learning-aggregator] lesson skip (unregistered agent "
                    f"'{entry['agent']}')",
                    file=sys.stderr,
                )
                ops["SKIP_UNREGISTERED"] += 1
                continue
            ops[ingest_lesson(store[bucket_name], entry)] += 1
        promoted = promote_corroborated_lessons(store["ctm"])
        if promoted:
            ops["PROMOTE"] += promoted
        swept = sweep_stale_lessons(store, now, stale_days)
        if swept:
            ops["TOMBSTONE"] += swept
        for name, cap in (("ctm", CTM_BUCKET_MAX_CHARS), ("epm", EPM_BUCKET_MAX_CHARS)):
            evicted = enforce_bucket_cap(store[name], cap)
            if evicted:
                ops["EVICT"] += len(evicted)
        save_lesson_store(store_path, store)
    except Exception as exc:  # noqa: BLE001 — fail-soft: lesson store MUST NOT block aggregation
        print(
            f"[learning-aggregator] lesson-store ingest failed, skip "
            f"({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
    return dict(ops)


def main() -> None:
    if not os.path.isdir(OUTCOMES_DIR):
        return

    # Watermark + outcome discovery both from PG. Helper read failure → 0.0 / empty list (full
    # scan / early-return); the aggregator never dies.
    since = 0.0
    if HAS_PG_DUALWRITE:
        since = _pg_read_aggregator_watermark("learning-aggregator")

    new_records: list[dict] = []
    if HAS_PG_DUALWRITE:
        new_records = _pg_read_outcomes_since(since)

    # input-filter exclusion counts accumulated by the pattern-aggregation loop below
    exclusion_counts: dict[str, int] = defaultdict(int)
    aggregated_count = 0

    if not new_records:
        _emit_exclusion_summary(aggregated_count, exclusion_counts)
        # mirror any audit-queue appends into PG before the early return (fail-soft)
        _sync_audit_queue_to_pg()
        return

    # pattern aggregation
    agent_negative = defaultdict(int)  # rows tripping ANY negative-signal OR-term, per agent
    # agents with >=1 actual result=fail among their negative rows → pattern-1 keeps the
    # verbatim "repeated failure" DISPLAY label; soft-signal-only agents get the decoupled one.
    agent_hard_fail: dict[str, bool] = defaultdict(bool)
    agent_total = defaultdict(int)
    task_revisions = defaultdict(list)
    metric_pass_counts = {"true": 0, "false": 0}
    signal_counts: dict[str, int] = defaultdict(int)  # per-OR-term hits → dead-signal detector
    task_type_results = defaultdict(lambda: {"done": 0, "total": 0})

    # watermark = MAX(record_ts) of processed records (data-progress point, not run time) → rerun
    # re-reads nothing (idempotent).
    max_record_epoch: float = since
    _reset_phase_deadline()  # independent budget for the main-aggregation phase
    for data in new_records:
        if _phase_deadline_exceeded():
            print("[learning-aggregator] timeout, partial processing", file=sys.stderr)
            break

        include, reason = _should_include_outcome(data)
        if not include:
            exclusion_counts[reason] += 1
            if reason in ("legacy_unknown", "agent_id_missing", "deprecated_agent"):
                _append_audit_queue(data.get("pg_audit_ref", ""), reason)
            continue
        # 'empty_lesson_only'/'cron_no_lesson' → count only (aggregation passes through)
        if reason in ("empty_lesson_only", "cron_no_lesson"):
            exclusion_counts[reason] += 1
        aggregated_count += 1

        # record_ts arrives monotonically increasing → last is the max
        rec_ts = data.get("record_ts")
        if rec_ts is not None:
            try:
                max_record_epoch = max(max_record_epoch, rec_ts.timestamp())
            except (AttributeError, OSError):
                pass

        # canonical stem keys the per-agent counts + written patterns — bare /
        # prefixed / colon forms of one logical agent must aggregate as ONE key
        agent = _canonical_agent(data.get('agent', 'unknown'))
        result = data.get('result', '')
        task_type = data.get('task_type', '')
        revision = data.get('revision_count', 0)

        agent_total[agent] += 1
        # negative-signal OR-terms (fail/blocked/done_with_concerns/verified_fail/
        # review_flag/revision≥2) — one row counts ONCE toward the agent trigger
        # however many terms it trips; per-term counts feed the dead-signal WARN.
        hits = _negative_signal_hits(data)
        for hit in hits:
            signal_counts[hit] += 1
        if hits:
            agent_negative[agent] += 1
            # "result=fail" is the actual-failure OR-term name — its presence keeps
            # pattern-1's verbatim "repeated failure" label (P3a decouple condition).
            if "result=fail" in hits:
                agent_hard_fail[agent] = True

        metric_pass = data.get('metric_pass')
        if metric_pass is not None:
            if metric_pass is True or str(metric_pass).lower() == 'true':
                metric_pass_counts["true"] += 1
            else:
                metric_pass_counts["false"] += 1

        if task_type and result:
            task_type_results[task_type]["total"] += 1
            if result == 'done':
                task_type_results[task_type]["done"] += 1

        if revision:
            try:
                task_revisions[task_type].append(int(revision))
            except (ValueError, TypeError):
                pass

    # dead-signal detector — emit BEFORE pattern extraction so a starved trigger
    # is visible even on runs that produce zero entries.
    _warn_dead_signals(signal_counts, aggregated_count)

    # pattern extraction
    today = datetime.now().strftime("%Y-%m-%d")
    entries = []

    # pattern 1: same agent tripping the negative-signal trigger 3+ times. The DISPLAY
    # label is decoupled (P3a) — an actual result=fail keeps the verbatim
    # PATTERN1_FAIL_LABEL, a soft-signal-only concentration gets the accurate
    # PATTERN1_SOFT_LABEL. Both anchor to the SAME pattern_signature core via
    # _SIGNATURE_ANCHOR in the upsert below, so pattern_signature derivation, the daemon
    # _FAIL_COUNT_LABEL_PREFIXES staleness match, and accumulated learning_log rows are
    # all preserved regardless of which label is shown.
    for agent, count in agent_negative.items():
        if count >= AUTO_FAILURE_THRESHOLD:
            label = _pattern1_display_label(agent_hard_fail.get(agent, False))
            entries.append(_build_entry(today, label, str(count), agent, count))

    # pattern 2: revision_count average 2+. '전체' is in NOT_PATCHABLE_AGENTS so _emit_xc blocks it
    # (no agent file to patch); the task_type signal is preserved in the label.
    for task_type, revs in task_revisions.items():
        if revs and sum(revs) / len(revs) >= 2:
            avg = round(sum(revs) / len(revs), 1)
            _emit_xc(entries, _build_entry(today, f"high rework-request frequency ({task_type}, avg {avg})", str(len(revs)), "전체", len(revs)), "전체")

    # pattern 3: metric_pass rate below 50% ('전체' → blocked by _emit_xc, same as pattern 2)
    mp_total = metric_pass_counts["true"] + metric_pass_counts["false"]
    if mp_total > 0:
        mp_rate = round(metric_pass_counts["true"] / mp_total * 100, 1)
        if mp_rate < 50:
            _emit_xc(entries, _build_entry(today, f"metric_pass auto-judgment needs improvement ({mp_rate}%)", str(mp_total), "전체", mp_total), "전체")

    # pattern 5: per-agent negative-signal concentration (label kept verbatim —
    # same signature/prefix constraint as pattern 1).
    for agent, negative in agent_negative.items():
        total = agent_total.get(agent, 0)
        if total >= RATE_MIN_SAMPLE and negative / total >= RATE_FAILURE_FLOOR:
            entries.append(_build_entry(today, f"agent instruction-improvement candidate (failure rate {round(negative/total*100)}%)", f"{negative}/{total}", agent, negative))

    # pattern 6: per-task_type success rate ('전체' → blocked by _emit_xc, same as pattern 2)
    for task_type, counts in task_type_results.items():
        total = counts["total"]
        if total >= 3:
            done_rate = round(counts["done"] / total * 100, 1)
            if done_rate < 60:
                _emit_xc(entries, _build_entry(today, f"{task_type} type low success rate ({done_rate}%)", str(total), "전체", total), "전체")

    # pattern 7: per-agent_type budget-overage concentration. Clusters the
    # best-effort core.budget_overages rows (written at soft-budget crossings) into
    # a per-agent_type instruction-improvement candidate targeting the AGENT FILE's
    # emit discipline. Read is windowed by `since` (the run's entry watermark), so
    # each overage counts once across runs; _emit_xc intake-gates cross-cutting
    # agents. The ORCHESTRATOR sizing failure mode is handled statically by the P4
    # calibration line, NOT through this loop (D4 routing split).
    overage_counts = _cluster_budget_overages(_read_budget_overages(since))
    for agent, overages in overage_counts.items():
        if overages >= BUDGET_OVERAGE_MIN_OCCURRENCE:
            _emit_xc(
                entries,
                _build_entry(today, BUDGET_OVERAGE_LABEL, str(overages), agent, overages),
                agent,
            )

    # UPSERT into core.learning_log keyed on pattern_signature = "<pat_core>|<agent>".
    # _pg_read_learning_log_signatures returns the same (pat_core, agent) key, so dedup is symmetric:
    # on match accumulate frequency + reclassify tier, on miss insert fresh.
    if entries:
        existing_by_key: dict = {}
        if HAS_PG_DUALWRITE:
            existing_by_key = _pg_read_learning_log_signatures()

        new_count = 0
        updated_count = 0

        if HAS_PG_DUALWRITE:
            today_date = datetime.strptime(today, "%Y-%m-%d").date()
            for entry in entries:
                cols = [c.strip() for c in entry.split('|')]
                if len(cols) < 6:
                    continue
                # _build_entry layout: ['', date, pattern_label, freq_str, agent, status, tier, '']
                pattern_label = cols[2]
                freq_str = cols[3]
                agent_label = cols[4]
                status_label = cols[5]
                tier_label = cols[6] if len(cols) > 6 else "user-pending"

                # strip dynamic numerics so repeated runs converge on the same signature,
                # then normalize the residue so the dedup core is not forked by an orphan
                # '(failure rate )' remnant the strip leaves (D-F4).
                pat_core = _normalize_signature_residue(_NUMERIC_RE.sub('', pattern_label))
                if not pat_core:
                    pat_core = pattern_label
                # P3a DISPLAY-only decouple: a decoupled soft label re-anchors to its
                # stable signature core, keeping the daemon _FAIL_COUNT prefix + the
                # existing learning_log row identity intact (no orphan, no fail-open).
                pat_core = _SIGNATURE_ANCHOR.get(pat_core, pat_core)
                signature = f"{pat_core}|{agent_label}"

                freq_match = re.search(r'\d+', freq_str)  # "10/16" → 10, "23" → 23
                new_freq = int(freq_match.group()) if freq_match else 0

                key = (pat_core, agent_label)
                existing = existing_by_key.get(key)
                # terminal rows (rejected/applied) are already adjudicated — re-emitting as
                # 'identified' is an illegal state-machine regression; skip (no signal lost).
                if existing and existing.get("status") in ("rejected", "applied"):
                    continue
                if existing:
                    merged_freq = int(existing.get("frequency", 0) or 0) + new_freq
                    updated_count += 1
                else:
                    merged_freq = new_freq
                    new_count += 1

                merged_tier = _classify_pattern_status({"failure_count": merged_freq})

                try:
                    _pg_upsert_learning_pattern(
                        pattern_signature=signature,
                        discovered_date=today_date,
                        frequency=merged_freq,
                        agent=agent_label[:64] if agent_label else None,
                        status=status_label if status_label in ("identified", "proposed", "approved", "applied", "rejected") else "identified",
                        approval_tier=merged_tier,
                    )
                except ValueError as ve:  # state-machine regression OR input validation
                    print(
                        f"[learning-aggregator] learning_log PG skip "
                        f"(validation): {signature[:80]} | {ve}",
                        file=sys.stderr,
                    )
                except Exception as exc:  # noqa: BLE001 — defensive
                    print(
                        f"[learning-aggregator] learning_log PG skip "
                        f"({type(exc).__name__}): {signature[:80]} | {exc}",
                        file=sys.stderr,
                    )
            print(
                f"[learning-aggregator] {new_count} new + {updated_count} frequency-updated",
                file=sys.stderr,
            )

    # AD-1/AD-2: consolidate this batch's lessons into the size-capped CTM/EPM store the
    # spawn-time injector (AD-3) reads. Fail-soft — never blocks the core aggregation.
    lesson_ops = ingest_outcome_lessons(new_records)
    if lesson_ops:
        print(
            "[learning-aggregator] lesson store: "
            + ", ".join(f"{op}={n}" for op, n in sorted(lesson_ops.items())),
            file=sys.stderr,
        )

    _emit_exclusion_summary(aggregated_count, exclusion_counts)

    # watermark = MAX(record_ts) of the processed batch (data-progress point, not run time → no
    # duplicate re-processing on rerun). Fallback when all records lack timestamps → time.time().
    state_ts = max_record_epoch if max_record_epoch > since else time.time()

    if HAS_PG_DUALWRITE:
        try:
            state_dt = datetime.fromtimestamp(state_ts)
            lag_secs = max(0, int(time.time() - state_ts))  # how far behind the data the watermark is
            _pg_update_aggregator_state(
                name="learning-aggregator",
                last_processed_ts=state_dt,
                lag_seconds=lag_secs,
            )
            _pg_batch_complete({  # end-of-run summary (stderr only)
                "aggregated": aggregated_count,
                "excluded_total": sum(exclusion_counts.values()),
                "new_records": len(new_records),
                "watermark_ts": state_dt.isoformat(timespec="seconds"),
            })
        except ValueError as ve:
            print(
                f"[learning-aggregator] aggregator_state PG skip (validation): {ve}",
                file=sys.stderr,
            )
        except Exception as exc:  # noqa: BLE001 — defensive
            print(
                f"[learning-aggregator] aggregator_state PG skip "
                f"({type(exc).__name__}): {exc}",
                file=sys.stderr,
            )

    # mirror this run's audit-queue appends (feedback + pattern stages) into core.audit_queue.
    # Last step so every append is captured; watermark-driven → idempotent (no duplicate rows).
    _sync_audit_queue_to_pg()


if __name__ == "__main__":
    main()
