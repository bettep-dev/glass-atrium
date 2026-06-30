#!/usr/bin/env python3
"""Learning Log Aggregator — analyze outcomes → record patterns in core.learning_log.

PG is the single sink/source: core.learning_log · core.aggregator_state.
Read paths go through the _pg_learning_dualwrite.read_* helpers.
"""

import os
import re
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

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

DATA_DIR = os.path.expanduser("~/.claude/data")
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
    if agent in DEPRECATED_AGENTS:
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

        agent = data.get('agent', 'unknown')
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

                # strip dynamic numerics so repeated runs converge on the same signature
                pat_core = _NUMERIC_RE.sub('', pattern_label).strip()
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
