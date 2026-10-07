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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple

# Pin this hook's own dir on sys.path so the sibling ga_paths seam resolves under
# any invocation (script or importlib). Unlike the fail-soft sibling imports below,
# the runtime-path seam is load-bearing, so its import is not guarded.
_HOOKS_DIR = str(Path(__file__).resolve().parent)
if _HOOKS_DIR not in sys.path:
    sys.path.insert(0, _HOOKS_DIR)
import ga_paths  # noqa: E402 — sys.path insert immediately above
# Negative-signal rules are stdlib-only and imported OUTSIDE the PG guard below: the
# pattern emit needs the predicate even when psycopg is absent, and routing it through
# the guarded helper is what previously forced a second, drifting copy here.
from _outcome_signal import (  # noqa: E402 — sys.path insert above
    negative_signal_hits as _negative_signal_hits,
    NEGATIVE_SIGNAL_NAMES as _NEGATIVE_SIGNAL_NAMES,
    METRIC_BUDGET_OVERAGE,
    METRIC_EMIT_FAILURE,
    VERDICT_FAIL,
    VERDICT_PASS,
    FloorResult,
    PairWindows,
    get_pair_windows,
    is_new_pair,
    # the emit_failure metric's outcome leg — its batch rows are the pattern's frequency
    _EMIT_FAILURE_ATTRIBUTIONS,
)

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
        insert_liveness_observation as _pg_insert_liveness_observation,
        put_learning_pattern_status as _pg_put_learning_pattern_status,
        read_outcome_window as _pg_read_outcome_window,
        read_pattern_floors as _pg_read_pattern_floors,
        LivenessSinkMissing,
    )
    HAS_PG_DUALWRITE = True
except Exception as _pg_import_exc:  # noqa: BLE001 — psycopg or helper itself
    HAS_PG_DUALWRITE = False
    # Keep the name bindable so the liveness except-clause below stays valid on the
    # psycopg-absent path (that path returns before it can ever be reached).
    LivenessSinkMissing = RuntimeError
    print(
        f"[learning-aggregator] PG dual-write disabled (import failed): "
        f"{type(_pg_import_exc).__name__}: {_pg_import_exc}",
        file=sys.stderr,
    )

DATA_DIR = str(ga_paths.get_data_root())
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
# (The OR-term predicate itself is shared via _outcome_signal.negative_signal_hits.)
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
# Spawns ended with no own [COMPLETION] (no SubagentStop or recorder-synthesized) per agent
EMIT_FAILURE_LABEL = "emit-failure concentration"
# Keyed families: emitted only on a passing S2f floor, never on a batch count.
_KEYED_LABELS = {
    BUDGET_OVERAGE_LABEL: METRIC_BUDGET_OVERAGE,
    EMIT_FAILURE_LABEL: METRIC_EMIT_FAILURE,
}

# Pattern-8 (size-est under-estimate concentration) — the retrospective half of the
# [SIZE-EST] attestation. track-outcome.sh records, on one body_md line, the MEASURED
# tool_use count of a spawn beside the estimate its parent DECLARED; this pattern reads
# the pair back and surfaces an agent whose spawns systematically overrun the estimate.
# Detection, not trust: the declaration is never blocked in the moment, so the correction
# is next-cycle. The improvement target is the ESTIMATING side, but the pattern is keyed on
# the measured AGENT because that is the only patchable file in the row (an orchestrator
# sizing miss has no agent file — the same D4 routing split pattern 7 makes).
TOOL_USE_BODY_PREFIX = "- **Tool use**: "
# Writer of this grammar: hooks/track-outcome.sh (TOOL_USE_LINE). The two literals are pinned
# against each other by hooks/test/test_size_est_underestimate.py — a silent divergence would
# leave this reader matching nothing while the recorder kept writing.
_TOOL_USE_BODY_RE = re.compile(
    r"^- \*\*Tool use\*\*: actual=(\d+)(?: declared=(\d+))?$", re.M
)
SIZE_EST_UNDER_LABEL = "size-est under-estimate concentration"
# Same 3+ occurrence floor as the sibling patterns, PLUS a rate floor: 3 overruns out of 30
# paired spawns is ordinary estimate noise, and only the rate distinguishes that from an agent
# whose estimates are systematically low. Both floors must clear.
SIZE_EST_UNDER_MIN_OCCURRENCE = 3
SIZE_EST_UNDER_RATE_FLOOR = 0.5

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

# Keyless family signature cores (patterns 1, 2, 3, 5, 8; 6 by suffix) + legacy Korean 1/5
# A stored row matching none is not this aggregator's → status kept
_KEYLESS_FAMILY_PREFIXES = (
    PATTERN1_FAIL_LABEL,
    "동일 에이전트 반복 실패",
    "high rework-request frequency (",
    "metric_pass auto-judgment needs improvement",
    "agent instruction-improvement candidate",
    "에이전트 지침 개선 후보",
    SIZE_EST_UNDER_LABEL,
)
_PATTERN6_SUFFIX = " type low success rate"
# Statuses the pair verdict moves between; every other status keeps its value.
_PAIR_STATUSES = frozenset({"identified", "dormant"})
# Lead of every status reason this aggregator writes.
PAIR_REASON_PREFIX = "aggregator-pair"
# `record_ts > since` reads → 1 s earlier keeps a detection-start row; Python re-applies bounds
_WINDOW_READ_MARGIN = timedelta(seconds=1)


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


# --- Liveness observation channel -------------------------------------------

# A terminal learning_log row still clusters: the run built its entry, so the
# pattern cleared its own family's emit gate. The aggregator then discards it at a
# bare `continue`. These helpers append that fact instead, and report a lost append
# on a named channel — the module's fail-open "PG skip" line is not enough here,
# because this evidence accrues for weeks before anyone reads it, so a silent
# outage surfaces only once the window it was supposed to cover is spent.
_LIVENESS_DEGRADATIONS: list[dict[str, str]] = []

# Latched for the rest of the run after the first failed append: the cause is
# per-run (table absent, sink down), so retrying it once per terminal row would
# repeat one line per row and say nothing new.
_liveness_sink_down = False


def get_liveness_degradations() -> list[dict[str, str]]:
    """Lost appends so far — one entry per cause, latched at the first occurrence."""
    return list(_LIVENESS_DEGRADATIONS)


def clear_liveness_degradations() -> None:
    global _liveness_sink_down
    _LIVENESS_DEGRADATIONS.clear()
    _liveness_sink_down = False


def record_liveness_degradation(reason: str, error: BaseException) -> None:
    """Record one lost observation + emit its named warning."""
    detail = f"{type(error).__name__}: {str(error)[:160]}"
    _LIVENESS_DEGRADATIONS.append({"reason": reason, "error": detail})
    print(
        f"[learning-aggregator] WARN: liveness observation not persisted "
        f"({reason}) — terminal-skip evidence is accruing nowhere: {detail}",
        file=sys.stderr,
    )


def emit_liveness_observation(signature: str, agent: str | None, run_date, frequency: int) -> bool:
    """Append one observation for a terminal row whose family floor cleared this run.

    True when this run appended the row. The floor is the family's own, applied
    upstream at its emit gate, so no threshold is introduced here. A missing table
    (migration merged, never deployed) and a live sink outage are distinct named
    causes, both loud; never raises into the aggregation.
    """
    global _liveness_sink_down
    if not HAS_PG_DUALWRITE or _liveness_sink_down:
        return False
    try:
        return _pg_insert_liveness_observation(
            pattern_signature=signature,
            agent=agent,
            run_date=run_date,
            frequency=frequency,
        )
    except LivenessSinkMissing as exc:
        _liveness_sink_down = True
        record_liveness_degradation("migration_absent", exc)
        return False
    except Exception as exc:  # noqa: BLE001 — branched below, never absorbed
        _liveness_sink_down = True
        record_liveness_degradation("sink_unavailable", exc)
        return False


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


def _emit_xc(
    entries: list, entry: str, agent_label: str, registry: frozenset[str] | None = None
) -> str:
    """Intake gate — appends only patchable, roster-registered agent patterns.
    Returns the drop reason ('' = emitted), mirroring the _should_include_outcome convention.

    - NOT_PATCHABLE_AGENTS are blocked (downstream daemon_cycle skips the same set, so they
      would only churn learning_log)
    - an agent key outside the registry resolves to a nonexistent agents/<stem>.md, so the
      pattern is unpatchable by construction — blocked loudly, never silently
    - registry=None means the roster is unavailable → validation SKIPPED (fail-open: a
      registry problem must never drop real patterns)
    """
    if agent_label in NOT_PATCHABLE_AGENTS:
        return "not_patchable"
    if registry is not None and agent_label not in registry:
        # the rejected key is the evidence trail for the still-live upstream defect
        # (core.budget_overages.agent_type carries bare worktree slugs) → never a silent drop
        print(
            f"[learning-aggregator] pattern skip (unregistered agent '{agent_label}')",
            file=sys.stderr,
        )
        return "unregistered_agent"
    entries.append(entry)
    return ""


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


def _read_size_est_pairs(since_epoch: float) -> list[dict]:
    """Read core.outcomes rows carrying a recorded tool_use measurement after since_epoch.

    Windowed by the shared aggregator watermark for the same reason
    _read_budget_overages is — a whole-table read would re-count every row under the
    learning_log UPSERT frequency merge. The LIKE narrows the scan to rows the recorder
    actually measured (the body line is omitted where no counter existed), so an install
    with the advisory disabled reads nothing rather than scanning every body. PG absent /
    unreachable → [] (degrade-not-die, sibling policy to the other read helpers)."""
    if not HAS_PG_DUALWRITE:
        return []
    try:
        return _fetch_size_est_pairs(since_epoch)
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        print(
            f"[learning-aggregator] size-est actuals read failed, skip "
            f"({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
        return []


def _read_size_est_window(since_epoch: float) -> list[dict] | None:
    """_read_size_est_pairs for a window judge — None on any failure, never an empty window."""
    if not HAS_PG_DUALWRITE:
        return None
    try:
        return _fetch_size_est_pairs(since_epoch)
    except Exception as exc:  # noqa: BLE001 — every failure is an outage the caller fails closed on
        print(
            f"[learning-aggregator] size-est window read failed "
            f"({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
        return None


def _fetch_size_est_pairs(since_epoch: float) -> list[dict]:
    import psycopg  # HAS_PG_DUALWRITE True guarantees this import succeeds

    with psycopg.connect("dbname=glass_atrium", connect_timeout=2, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT agent, body_md, record_ts FROM core.outcomes "
                "WHERE record_ts > to_timestamp(%s) AND body_md LIKE %s",
                (since_epoch, f"%{TOOL_USE_BODY_PREFIX}%"),
            )
            return [
                {"agent": row[0], "body_md": row[1], "record_ts": row[2]}
                for row in cur.fetchall()
            ]


def _cluster_size_est_underestimates(rows: list[dict]) -> dict[str, dict[str, int]]:
    """Cluster measured-vs-declared rows into per-agent {'paired', 'under', 'excess'} counts.

    Pure (no I/O) so it unit-tests without a live DB. A row whose body carries only
    `actual=` is DROPPED, not counted as a match: an unpaired measurement says nothing
    about estimate quality, and counting it as a non-overrun would dilute the rate floor
    toward silence. 'excess' accumulates actual-declared over the overrunning rows only,
    so the emitted label can state the size of the miss rather than just its frequency.
    Agent canonicalization + the unpatchable drop mirror _cluster_budget_overages."""
    stats: dict[str, dict[str, int]] = defaultdict(
        lambda: {"paired": 0, "under": 0, "excess": 0}
    )
    for row in rows:
        agent = _canonical_agent(row.get("agent"))
        if agent in _UNPREFIXABLE_AGENTS:
            continue  # null / unknown / cross-cutting → no agent file to patch
        match = _TOOL_USE_BODY_RE.search(row.get("body_md") or "")
        if not match or match.group(2) is None:
            continue  # no measurement, or measured with nothing declared to compare against
        actual, declared = int(match.group(1)), int(match.group(2))
        stats[agent]["paired"] += 1
        if actual > declared:
            stats[agent]["under"] += 1
            stats[agent]["excess"] += actual - declared
    return dict(stats)


# Agent-key allowlist source — the lifecycle-CLI-written registry; env-overridable for tests.
AGENT_REGISTRY_FILE = os.environ.get(
    "CLAUDE_AGENT_REGISTRY_FILE",
    os.path.expanduser("~/.glass-atrium/agent-registry.json"),
)


def _load_registry_agents(path: str) -> frozenset[str] | None:
    """Agent-key allowlist — the registry's agent keys (the patchable roster).
    Missing/unreadable/malformed → None, meaning validation is SKIPPED (fail-open: a registry
    problem must never drop real patterns)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    agents = data.get("agents") if isinstance(data, dict) else None
    if not isinstance(agents, dict) or not agents:
        return None
    return frozenset(agents)


class _Emit(NamedTuple):
    """One pattern a family rule raised: the learning-log entry's label, frequency text,
    agent and count. Fleet-wide rows (patterns 2, 3, 6) skip the roster tally."""

    label: str
    freq: str
    agent: str
    count: int
    is_fleet: bool = False


class _OutcomeTally(NamedTuple):
    negative: dict[str, int]  # rows tripping ANY negative-signal OR-term, per agent
    hard_fail: dict[str, bool]  # agents with ≥ 1 actual result=fail among their negative rows
    total: dict[str, int]
    revisions: dict[str, list[int]]
    metric_pass: dict[str, int]
    task_results: dict[str, dict[str, int]]


def _get_utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _get_signature_core(pattern_label: str) -> str:
    """Stable pattern_signature core: dynamic numerics stripped so repeated runs converge,
    the residue normalized (D-F4), the pattern-1 display label anchored (P3a)."""
    core = _normalize_signature_residue(_NUMERIC_RE.sub("", pattern_label)) or pattern_label
    return _SIGNATURE_ANCHOR.get(core, core)


def _get_outcome_tally(records: list[dict]) -> _OutcomeTally:
    tally = _OutcomeTally(
        defaultdict(int), defaultdict(bool), defaultdict(int), defaultdict(list),
        {"true": 0, "false": 0}, defaultdict(lambda: {"done": 0, "total": 0}),
    )
    for data in records:
        _add_outcome(tally, data)
    return tally


def _add_outcome(tally: _OutcomeTally, data: dict) -> None:
    # canonical stem keys the per-agent counts — bare / prefixed / colon forms of one
    # logical agent aggregate as ONE key
    agent = _canonical_agent(data.get("agent", "unknown"))
    result, task_type = data.get("result", ""), data.get("task_type", "")
    tally.total[agent] += 1
    # one row counts ONCE toward the agent trigger however many OR-terms it trips
    hits = _negative_signal_hits(data)
    if hits:
        tally.negative[agent] += 1
        tally.hard_fail[agent] |= "result=fail" in hits  # keeps pattern-1's verbatim label
    metric_pass = data.get("metric_pass")
    if metric_pass is not None:
        is_pass = metric_pass is True or str(metric_pass).lower() == "true"
        tally.metric_pass["true" if is_pass else "false"] += 1
    if task_type and result:
        tally.task_results[task_type]["total"] += 1
        if result == "done":
            tally.task_results[task_type]["done"] += 1
    revision = data.get("revision_count", 0)
    if revision:
        try:
            tally.revisions[task_type].append(int(revision))
        except (ValueError, TypeError):
            pass


def _get_outcome_emits(records: list[dict]) -> list[_Emit]:
    """Patterns 1, 5 (per agent) and 2, 3, 6 (fleet-wide) over included outcome records."""
    tally = _get_outcome_tally(records)
    return [*_get_agent_emits(tally), *_get_fleet_emits(tally)]


def _get_agent_emits(tally: _OutcomeTally) -> list[_Emit]:
    emits = []
    # pattern 1: same agent tripping the negative-signal trigger 3+ times
    for agent, count in tally.negative.items():
        if count >= AUTO_FAILURE_THRESHOLD:
            label = _pattern1_display_label(tally.hard_fail.get(agent, False))
            emits.append(_Emit(label, str(count), agent, count))
    # pattern 5: per-agent negative-signal rate (label kept verbatim — signature constraint)
    for agent, negative in tally.negative.items():
        total = tally.total.get(agent, 0)
        if total >= RATE_MIN_SAMPLE and negative / total >= RATE_FAILURE_FLOOR:
            rate = round(negative / total * 100)
            label = f"agent instruction-improvement candidate (failure rate {rate}%)"
            emits.append(_Emit(label, f"{negative}/{total}", agent, negative))
    return emits


def _get_fleet_emits(tally: _OutcomeTally) -> list[_Emit]:
    """'전체' rows — _emit_xc blocks them (no agent file); the signal stays in the label."""
    emits = []
    for task_type, revs in tally.revisions.items():  # pattern 2: rework average 2+
        if revs and sum(revs) / len(revs) >= 2:
            avg = round(sum(revs) / len(revs), 1)
            label = f"high rework-request frequency ({task_type}, avg {avg})"
            emits.append(_Emit(label, str(len(revs)), "전체", len(revs), is_fleet=True))
    mp_total = tally.metric_pass["true"] + tally.metric_pass["false"]
    if mp_total > 0:  # pattern 3: metric_pass rate below 50%
        mp_rate = round(tally.metric_pass["true"] / mp_total * 100, 1)
        if mp_rate < 50:
            label = f"metric_pass auto-judgment needs improvement ({mp_rate}%)"
            emits.append(_Emit(label, str(mp_total), "전체", mp_total, is_fleet=True))
    for task_type, counts in tally.task_results.items():  # pattern 6: success rate below 60%
        total = counts["total"]
        if total >= 3:
            done_rate = round(counts["done"] / total * 100, 1)
            if done_rate < 60:
                label = f"{task_type} type low success rate ({done_rate}%)"
                emits.append(_Emit(label, str(total), "전체", total, is_fleet=True))
    return emits


def _get_size_est_emits(stats: dict[str, dict[str, int]]) -> list[_Emit]:
    """Pattern 8: an agent whose paired spawns overrun their declared [SIZE-EST]."""
    emits = []
    for agent, counts in stats.items():
        under, paired, excess = counts["under"], counts["paired"], counts["excess"]
        if under >= SIZE_EST_UNDER_MIN_OCCURRENCE and under / paired >= SIZE_EST_UNDER_RATE_FLOOR:
            label = f"{SIZE_EST_UNDER_LABEL} (avg overrun +{round(excess / under)} tool_uses)"
            emits.append(_Emit(label, f"{under}/{paired}", agent, under))
    return emits


def _cluster_emit_failures(records: list[dict]) -> dict[str, int]:
    """Per-agent batch outcomes the recorder wrote for a spawn that emitted no
    [COMPLETION] — the emit-failure pattern's frequency, never its gate."""
    counts: dict[str, int] = defaultdict(int)
    for row in records:
        agent = _canonical_agent(row.get("agent"))
        if agent in _UNPREFIXABLE_AGENTS:
            continue
        if (row.get("attribution_source") or "") in _EMIT_FAILURE_ATTRIBUTIONS:
            counts[agent] += 1
    return dict(counts)


def _get_keyed_agents(
    registry: frozenset[str] | None, stored: dict, contributions: dict[str, dict[str, int]]
) -> set[str]:
    """Agents whose floors this run reads: the roster, every keyed row the pair verdict can
    move, and — with no roster to read — the agents of this batch's keyed events."""
    agents = set(registry or ())
    agents.update(
        agent for (core, agent), row in stored.items()
        if _get_signature_core(core) in _KEYED_LABELS and row.get("status") in _PAIR_STATUSES
    )
    if registry is None:
        for counts in contributions.values():
            agents.update(counts)
    return agents


def _get_keyed_floors(
    agents: set[str], windows: PairWindows, evaluated_at: datetime
) -> dict[tuple[str, str], FloorResult]:
    """S2f floor per (keyed label, agent), every agent from one set read. Empty = the read
    failed: no keyed row gets a verdict this run, nothing keyed is emitted, statuses hold."""
    floors = _pg_read_pattern_floors(agents, windows, evaluated_at)
    if floors is None:
        print(
            "[learning-aggregator] WARN: no keyed pair verdict this run — the floor read "
            f"failed; keyed rows of {len(agents)} agents keep their status",
            file=sys.stderr,
        )
        return {}
    return {
        (label, agent): floors[(agent, metric_key)]
        for agent in agents
        for label, metric_key in _KEYED_LABELS.items()
    }


def _get_keyed_emits(
    floors: dict[tuple[str, str], FloorResult], contributions: dict[str, dict[str, int]]
) -> list[_Emit]:
    emits = []
    for (label, agent), floor in sorted(floors.items()):
        if floor.verdict == VERDICT_PASS:
            count = contributions[label].get(agent, 0)
            emits.append(_Emit(label, str(count), agent, count))
    return emits


def _get_keyless_pair_keys(windows: PairWindows) -> set[tuple[str, str]] | None:
    """(signature core, agent) keys whose family emit rule holds in detection AND in
    confirmation, over window rows — never a batch. None = a window read failed."""
    since = (windows.start.detection - _WINDOW_READ_MARGIN).timestamp()
    outcomes = _pg_read_outcome_window(since)
    size_est = _read_size_est_window(since)
    if outcomes is None or size_est is None:
        return None
    included = [row for row in outcomes if _should_include_outcome(row)[0]]
    held = []
    for start, end in (
        (windows.start.detection, windows.start.confirmation),
        (windows.start.confirmation, windows.end),
    ):
        emits = _get_outcome_emits(_get_rows_between(included, start, end))
        size_est_stats = _cluster_size_est_underestimates(_get_rows_between(size_est, start, end))
        emits += _get_size_est_emits(size_est_stats)
        held.append({(_get_signature_core(e.label), e.agent) for e in emits})
    return held[0] & held[1]


def _get_rows_between(rows: list[dict], start: datetime, end: datetime) -> list[dict]:
    return [r for r in rows if r.get("record_ts") is not None and start <= r["record_ts"] < end]


def _is_keyless_family(core: str) -> bool:
    return core.startswith(_KEYLESS_FAMILY_PREFIXES) or core.endswith(_PATTERN6_SUFFIX)


def _get_pair_verdict(
    core: str, agent: str, pair_keys: set[tuple[str, str]] | None,
    floors: dict[tuple[str, str], FloorResult],
) -> str | None:
    """A stored row's pair verdict; None = not this aggregator's family, or no verdict this run."""
    if core in _KEYED_LABELS:
        floor = floors.get((core, agent))
        return None if floor is None else floor.verdict
    if pair_keys is None or not _is_keyless_family(core):
        return None
    return VERDICT_PASS if (core, agent) in pair_keys else VERDICT_FAIL


def _get_pair_target(row: dict, verdict: str, windows: PairWindows) -> str | None:
    """identified + a non-pass → dormant · dormant + a pass on a new pair (N59) → identified."""
    if row.get("status") == "identified":
        return None if verdict == VERDICT_PASS else "dormant"
    transition_at = row.get("last_transition_at")
    is_new = transition_at is None or is_new_pair(windows, transition_at)
    return "identified" if verdict == VERDICT_PASS and is_new else None


def _put_pair_statuses(
    stored: dict, pair_keys: set[tuple[str, str]] | None,
    floors: dict[tuple[str, str], FloorResult], windows: PairWindows,
) -> None:
    """Set every identified/dormant family row's status from its pair verdict, written or
    not this run — a row the aggregator no longer emits leaves 'identified' too (39701 → E5)."""
    moves: dict[str, int] = defaultdict(int)
    detection = f"{windows.start.detection:%Y-%m-%d}"
    for (stored_core, agent), row in stored.items():
        if row.get("status") not in _PAIR_STATUSES:
            continue
        core = _get_signature_core(stored_core)
        verdict = _get_pair_verdict(core, agent, pair_keys, floors)
        target = None if verdict is None else _get_pair_target(row, verdict, windows)
        if target is None:
            continue
        rule = f"{_KEYED_LABELS[core]} floor" if core in _KEYED_LABELS else "family emit rule"
        reason = f"{PAIR_REASON_PREFIX} {verdict}: {rule}, pair from {detection}"
        result = _pg_put_learning_pattern_status(row["id"], target, reason)
        moves[f"{target}={result.outcome}"] += 1
    if moves:
        print(
            "[learning-aggregator] pair status: "
            + ", ".join(f"{name}:{n}" for name, n in sorted(moves.items())),
            file=sys.stderr,
        )


def main(registry_path: str | None = None) -> None:
    """registry_path overrides the live AGENT_REGISTRY_FILE for the pattern-intake allowlist.
    None keeps the production default; a caller that must not depend on a live install injects
    a roster."""
    # Watermark + outcome discovery both from PG. Helper read failure → 0.0 / empty list (full
    # scan / zero-record batch); the aggregator never dies.
    since = 0.0
    if HAS_PG_DUALWRITE:
        since = _pg_read_aggregator_watermark("learning-aggregator")

    new_records: list[dict] = []
    if HAS_PG_DUALWRITE:
        new_records = _pg_read_outcomes_since(since)

    # input-filter exclusion counts accumulated by the pattern-aggregation loop below
    exclusion_counts: dict[str, int] = defaultdict(int)
    included: list[dict] = []
    signal_counts: dict[str, int] = defaultdict(int)  # per-OR-term hits → dead-signal detector

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
        included.append(data)

        # record_ts arrives monotonically increasing → last is the max
        rec_ts = data.get("record_ts")
        if rec_ts is not None:
            try:
                max_record_epoch = max(max_record_epoch, rec_ts.timestamp())
            except (AttributeError, OSError):
                pass
        for hit in _negative_signal_hits(data):
            signal_counts[hit] += 1
    aggregated_count = len(included)

    # dead-signal detector — emit BEFORE pattern extraction so a starved trigger
    # is visible even on runs that produce zero entries.
    _warn_dead_signals(signal_counts, aggregated_count)

    # pattern extraction
    today = datetime.now().strftime("%Y-%m-%d")
    entries = []

    # Roster allowlist for every agent-keyed pattern write — fail-open loader, so an
    # unreadable/malformed registry skips validation rather than dropping real patterns.
    # _canonical_agent output and registry keys share the glass-atrium-<stem> form, so
    # membership is a direct lookup.
    registry = _load_registry_agents(registry_path or AGENT_REGISTRY_FILE)
    if registry is None:
        print(
            "[learning-aggregator] agent registry unavailable, "
            "pattern-key validation skipped (fail-open)",
            file=sys.stderr,
        )
    emit_skips: dict[str, int] = defaultdict(int)

    # pair windows read every run, empty batch included → no verdict waits for a next batch
    stored: dict = _pg_read_learning_log_signatures() if HAS_PG_DUALWRITE else {}
    windows = get_pair_windows(_get_utc_now())
    # pending judged at the day anchor, as in the daemon intake
    evaluated_at = windows.end
    # batch reads windowed by `since` → counted once across runs; empty batch: skipped, no advance
    overage_rows = _read_budget_overages(since) if new_records else []
    size_est_rows = _read_size_est_pairs(since) if new_records else []
    contributions = {
        BUDGET_OVERAGE_LABEL: _cluster_budget_overages(overage_rows),
        EMIT_FAILURE_LABEL: _cluster_emit_failures(included),
    }
    floors: dict[tuple[str, str], FloorResult] = {}
    if HAS_PG_DUALWRITE:
        floors = _get_keyed_floors(
            _get_keyed_agents(registry, stored, contributions), windows, evaluated_at
        )

    # Patterns 7 and the emit-failure pattern are keyed (floor-gated); pattern 8 pairs the
    # measured tool_use count against the declared [SIZE-EST] on one outcome row. The
    # ORCHESTRATOR sizing failure mode is handled statically by the P4 calibration line,
    # never through this per-agent loop (D4 routing split).
    emits = [
        *_get_outcome_emits(included),
        *_get_keyed_emits(floors, contributions),
        *_get_size_est_emits(_cluster_size_est_underestimates(size_est_rows)),
    ]
    for emit in emits:
        entry = _build_entry(today, emit.label, emit.freq, emit.agent, emit.count)
        if emit.is_fleet:
            _emit_xc(entries, entry, emit.agent)
            continue
        # one intake gate for agent-keyed patterns; drops tallied, never a silent loss
        reason = _emit_xc(entries, entry, emit.agent, registry)
        if reason:
            emit_skips[reason] += 1

    # Outside the `if entries:` block on purpose — a run whose every pattern was gated still
    # reports the drop total, so the filtered signal never disappears with the rows.
    if emit_skips:
        print(
            "[learning-aggregator] pattern intake skips: "
            + ", ".join(f"{reason}={n}" for reason, n in sorted(emit_skips.items())),
            file=sys.stderr,
        )

    # UPSERT into core.learning_log keyed on pattern_signature = "<pat_core>|<agent>".
    # _pg_read_learning_log_signatures returns the same (pat_core, agent) key, so dedup is symmetric:
    # on match accumulate frequency + reclassify tier, on miss insert fresh.
    if entries:
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

                pat_core = _get_signature_core(pattern_label)
                signature = f"{pat_core}|{agent_label}"

                freq_match = re.search(r'\d+', freq_str)  # "10/16" → 10, "23" → 23
                new_freq = int(freq_match.group()) if freq_match else 0

                key = (pat_core, agent_label)
                existing = stored.get(key)
                # terminal rows (rejected/applied) are already adjudicated — re-emitting as
                # 'identified' is an illegal state-machine regression; skip (no signal lost).
                if existing and existing.get("status") in ("rejected", "applied"):
                    # The skip stays exactly as it was; the observation records that this
                    # signature was still clustering when the run discarded it.
                    emit_liveness_observation(signature, agent_label, today_date, new_freq)
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
                        metric_key=_KEYED_LABELS.get(pat_core),
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

    if HAS_PG_DUALWRITE:
        pair_keys = _get_keyless_pair_keys(windows)
        if pair_keys is None:
            print(
                "[learning-aggregator] WARN: no keyless pair verdict this run — a window "
                "read failed; keyless rows keep their status",
                file=sys.stderr,
            )
        _put_pair_statuses(_pg_read_learning_log_signatures(), pair_keys, floors, windows)

    _emit_exclusion_summary(aggregated_count, exclusion_counts)
    if not new_records:
        # mirror any audit-queue appends into PG; an empty batch leaves the watermark alone
        _sync_audit_queue_to_pg()
        return

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
