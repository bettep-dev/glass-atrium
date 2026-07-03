#!/usr/bin/env python3
# In-process PG UPSERT/read helper for learning-aggregator.
#
# Imported as a Python module (not a subprocess); each function runs one UPSERT
# in its own short connection. PG failure MUST NOT crash the aggregator — it
# degrades and retries on the next run.
#
# Param-name 3-layer discipline: file dict key == PG column == python kwarg, all
# identical ASCII strings; any drift means silent data loss. Renames are
# documented inline next to the SQL.
#
# Connection: psycopg.connect("dbname=glass_atrium") only (Unix-socket peer-auth);
# never host/port/localhost. Emits an elapsed_ms stderr line per op for latency
# aggregation.

import sys
import time

try:
    import psycopg
    from psycopg import errors as pg_errors
except ImportError as exc:
    sys.stderr.write(
        '{"hook":"_pg_learning_dualwrite","error_kind":"import_error",'
        '"message":"%s"}\n' % str(exc).replace('"', "'")
    )
    raise  # the importing aggregator catches this and falls back to file-only mode

# Role → Allowed task_types allowlist (the SINGLE off-role authority) is owned by
# the sibling write-side module — import it so the negative-signal predicate reuses
# the SAME role SoT track-outcome.sh::role_task_type_allowed and _norm_task_type
# key on. NO divergent role list is defined here. Sibling import (same hooks/ dir,
# already on sys.path for every consumer). Fallback: an unimportable sibling leaves
# every row treated as on-role (review_flag=true keeps counting) — fail-OPEN, never
# silently under-counts a genuine code-row signal.
try:
    from _pg_outcome_dualwrite import _role_task_type_allowed
except Exception as _role_import_exc:  # noqa: BLE001 — degrade loudly, never crash
    sys.stderr.write(
        '{"hook":"_pg_learning_dualwrite","op":"import_role_allowlist",'
        '"error_kind":"%s","fallback":"all_rows_on_role"}\n'
        % type(_role_import_exc).__name__
    )

    def _role_task_type_allowed(agent, task_type):  # type: ignore[misc]
        return True


# ---------------------------------------------------------------------------
# State-machine for core.learning_log.status
# ---------------------------------------------------------------------------

# Linear progression rank (higher = later). rejected is terminal and unranked:
# any non-applied → rejected is allowed, but crossing terminals (applied↔rejected)
# is not.
_STATUS_RANK = {
    "identified": 0,
    "proposed": 1,
    "approved": 2,
    "applied": 3,
}
_TERMINAL_REJECT = "rejected"
_VALID_STATUS = set(_STATUS_RANK) | {_TERMINAL_REJECT}

# Aggregator → PG tier mapping. The DB "ApprovalTier" enum keeps 'llm' for
# read back-compat — do NOT drop or narrow _VALID_TIER, or legacy rows fail on
# re-read.
_TIER_MAP = {
    "auto-approved": "auto",
    "auto": "auto",
    "llm-pending": "llm",  # legacy read back-compat; the emitter no longer sends this
    "llm": "llm",          # frozen DB enum value
    "user-pending": "user-pending",
    "user": "user",
}
_VALID_TIER = {"auto", "llm", "user-pending", "user"}


def _validate_status_transition(old_status: str | None, new_status: str) -> None:
    """Raise ValueError on illegal monotonic regression.
    Permitted: None → any · identified→proposed→approved→applied · any-non-applied → rejected.
    Forbidden: rank regression · applied→anything · rejected→anything (both terminal)."""
    if new_status not in _VALID_STATUS:
        raise ValueError(
            "invalid status %r (allowed: %s)" % (new_status, sorted(_VALID_STATUS))
        )
    if old_status is None:
        return  # first insert — any state is fine
    if old_status not in _VALID_STATUS:
        return  # corrupt existing status — trust the new value
    if old_status == "applied" and new_status != "applied":
        raise ValueError(
            "illegal transition: applied → %s (applied is terminal)" % new_status
        )
    if old_status == _TERMINAL_REJECT and new_status != _TERMINAL_REJECT:
        raise ValueError(
            "illegal transition: rejected → %s (rejected is terminal)" % new_status
        )
    if new_status in _STATUS_RANK and old_status in _STATUS_RANK:
        if _STATUS_RANK[new_status] < _STATUS_RANK[old_status]:
            raise ValueError(
                "illegal regression: %s → %s (rank %d → %d)"
                % (
                    old_status,
                    new_status,
                    _STATUS_RANK[old_status],
                    _STATUS_RANK[new_status],
                )
            )


# ---------------------------------------------------------------------------
# Shared utility: error classification + hook_failures emission
# ---------------------------------------------------------------------------

def _classify_error(exc):
    """Map an exception to a hook_failures.error_kind string."""
    if isinstance(exc, pg_errors.IntegrityError):
        return "constraint_violation"
    if isinstance(exc, psycopg.OperationalError):
        msg = str(exc).lower()
        if "timeout" in msg or "timed out" in msg:
            return "timeout"
        # Any non-timeout OperationalError is a connection/server-availability
        # fault → a literal substring list misses psycopg 3 phrasings
        # ("connection failed" / "connection to server on socket ... failed")
        # and degrades real connection errors to "unknown".
        return "connection_refused"
    return "unknown"


def _record_hook_failure(target_table, error_kind, payload_ref, retry_attempted):
    """Best-effort secondary INSERT into core.hook_failures. ANY exception swallowed."""
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=1) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO core.hook_failures "
                    "(failure_ts, hook_name, target_table, error_kind, "
                    "payload_ref, retry_attempted) "
                    "VALUES (now(), %s, %s, %s, %s, %s)",
                    (
                        "learning-aggregator",
                        target_table,
                        error_kind,
                        payload_ref,
                        retry_attempted,
                    ),
                )
            conn.commit()
    except Exception:
        pass


def _emit_stderr_failure(op_name, target_table, error_kind, error_class,
                         payload_ref, retry_attempted, elapsed_ms, message):
    """Single-line structured-JSON failure log + human-readable elapsed line."""
    sys.stderr.write(
        '{"hook":"learning-aggregator","op":"%s","target_table":"%s",'
        '"error_kind":"%s","error_class":"%s","payload_ref":"%s",'
        '"retry_attempted":%s,"elapsed_ms":%d,"message":"%s"}\n'
        % (
            op_name,
            target_table,
            error_kind,
            error_class,
            payload_ref,
            "true" if retry_attempted else "false",
            elapsed_ms,
            message,
        )
    )
    sys.stderr.write(
        "[learning-aggregator] elapsed_ms=%d op=%s pg_insert=fail error_kind=%s\n"
        % (elapsed_ms, op_name, error_kind)
    )


# ---------------------------------------------------------------------------
# Generic UPSERT runner with 1 retry + 100 ms backoff
# ---------------------------------------------------------------------------

def _run_with_retry(op_name, target_table, payload_ref, fn):
    """Execute fn() with 1 retry on failure. Always returns elapsed_ms, never
    raises (except ValueError); final failure emits structured stderr +
    best-effort hook_failures INSERT."""
    start_ns = time.monotonic_ns()
    last_exc = None
    retry_attempted = False
    for attempt in (1, 2):
        try:
            fn()
            elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            sys.stderr.write(
                "[learning-aggregator] elapsed_ms=%d op=%s pg_insert=ok attempt=%d\n"
                % (elapsed_ms, op_name, attempt)
            )
            return elapsed_ms
        except ValueError:
            # Validation/state-machine errors are deterministic — re-raise
            # unretried so the caller logs+skips; retrying would mislabel a
            # logic guard as a transient DB error.
            raise
        except Exception as exc:  # noqa: BLE001 — we intentionally catch all
            last_exc = exc
            if attempt == 1:
                retry_attempted = True
                time.sleep(0.1)

    error_kind = _classify_error(last_exc)
    error_class = type(last_exc).__name__
    error_msg = str(last_exc)[:200].replace('"', "'").replace("\n", " ")
    elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000

    _emit_stderr_failure(
        op_name, target_table, error_kind, error_class,
        payload_ref[:96], retry_attempted, elapsed_ms, error_msg,
    )
    _record_hook_failure(target_table, error_kind, payload_ref[:96], retry_attempted)
    return elapsed_ms


# ---------------------------------------------------------------------------
# UPSERT: core.learning_log
# ---------------------------------------------------------------------------

_LEARNING_LOG_SELECT_SQL = """
SELECT status::text FROM core.learning_log WHERE pattern_signature = %s
"""

_LEARNING_LOG_UPSERT_SQL = """
INSERT INTO core.learning_log (
    discovered_date, pattern_signature, frequency, agent, status,
    approval_tier, last_updated
) VALUES (
    %(discovered_date)s, %(pattern_signature)s, %(frequency)s, %(agent)s,
    %(status)s::core."LearningStatus",
    %(approval_tier)s::core."ApprovalTier",
    now()
)
ON CONFLICT (pattern_signature) DO UPDATE SET
    discovered_date = EXCLUDED.discovered_date,
    frequency = EXCLUDED.frequency,
    agent = EXCLUDED.agent,
    status = EXCLUDED.status,
    approval_tier = EXCLUDED.approval_tier,
    last_updated = now()
"""


def upsert_learning_pattern(
    pattern_signature: str,
    discovered_date,
    frequency: int,
    agent: str | None,
    status: str,
    approval_tier: str,
) -> int:
    """UPSERT one row into core.learning_log keyed by pattern_signature.

    Validates the monotonic state transition before commit and raises ValueError
    on illegal regression (the caller catches, logs, and skips). Returns
    elapsed_ms; never raises on PG-side errors, only on input validation (status
    enum, tier enum), which runs before connect so the caller sees a schema bug
    clearly.
    """
    # Input validation (raises ValueError before any PG call).
    if not pattern_signature or not isinstance(pattern_signature, str):
        raise ValueError("pattern_signature must be non-empty str")
    if status not in _VALID_STATUS:
        raise ValueError(
            "status %r not in %s" % (status, sorted(_VALID_STATUS))
        )
    # Map aggregator-side tier string → PG enum value at the boundary.
    mapped_tier = _TIER_MAP.get(approval_tier, approval_tier)
    if mapped_tier not in _VALID_TIER:
        raise ValueError(
            "approval_tier %r (mapped %r) not in %s"
            % (approval_tier, mapped_tier, sorted(_VALID_TIER))
        )
    if not isinstance(frequency, int) or frequency < 0:
        raise ValueError("frequency must be non-negative int, got %r" % (frequency,))

    row = {
        "pattern_signature": pattern_signature,
        "discovered_date": discovered_date,
        "frequency": frequency,
        "agent": (agent or None),
        "status": status,
        "approval_tier": mapped_tier,
    }

    def _do():
        # autocommit=False so SELECT-validate-UPSERT runs in one transaction,
        # closing the race between reading old_status and the UPSERT.
        with psycopg.connect(
            "dbname=glass_atrium", connect_timeout=1, autocommit=False
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(_LEARNING_LOG_SELECT_SQL, (pattern_signature,))
                existing = cur.fetchone()
                old_status = existing[0] if existing else None
                # Raises ValueError (not psycopg) on illegal regression.
                _validate_status_transition(old_status, status)
                cur.execute(_LEARNING_LOG_UPSERT_SQL, row)
            conn.commit()

    return _run_with_retry(
        op_name="upsert_learning_pattern",
        target_table="core.learning_log",
        payload_ref=pattern_signature[:96],
        fn=_do,
    )


# ---------------------------------------------------------------------------
# Lifecycle transition: core.learning_log → terminal 'rejected' (snooze)
# ---------------------------------------------------------------------------
#
# Generation-side anti-fossil snooze. "LearningStatus" has no 'snoozed' value
# (that label exists only on "ProposalStatus"), so terminal 'rejected' is the
# nearest existing state: the intake predicate (_PENDING_PATTERNS_SELECT_SQL,
# status='identified') stops selecting the row, and the aggregator's terminal
# skip-set + _validate_status_transition block any resurrection to 'identified'.
# Reversal is an explicit operator action only (manual UPDATE back to
# 'identified'); last_transition_reason carries the audit trail.

_LEARNING_LOG_REJECT_SQL = """
UPDATE core.learning_log
SET status = 'rejected'::core."LearningStatus",
    last_transition_at = now(),
    last_transition_reason = %(reason)s,
    last_updated = now()
WHERE id = %(pattern_id)s
  AND status NOT IN ('applied'::core."LearningStatus",
                     'rejected'::core."LearningStatus")
RETURNING id
"""


def reject_learning_pattern(pattern_id: int, reason: str) -> int | None:
    """Transition one core.learning_log row to terminal 'rejected' + audit reason.

    The WHERE status guard re-states _validate_status_transition's terminal
    rules in SQL (applied/rejected never leave their state), so the call is
    idempotent: an already-terminal row matches nothing and returns None.

    Returns the transitioned row id; None when no row matched or PG failed.
    Raises ValueError on input validation only (before any PG call).
    """
    if not isinstance(pattern_id, int) or pattern_id <= 0:
        raise ValueError("pattern_id must be positive int, got %r" % (pattern_id,))
    if not reason or not isinstance(reason, str):
        raise ValueError("reason must be non-empty str")

    updated: list[int] = []

    def _do():
        with psycopg.connect(
            "dbname=glass_atrium", connect_timeout=1, autocommit=False
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _LEARNING_LOG_REJECT_SQL,
                    # varchar(500) guard — mirrors the agent[:64] boundary style.
                    {"pattern_id": pattern_id, "reason": reason[:500]},
                )
                updated.extend(row[0] for row in cur.fetchall())
            conn.commit()

    _run_with_retry(
        op_name="reject_learning_pattern",
        target_table="core.learning_log",
        payload_ref="learning_log:%d" % pattern_id,
        fn=_do,
    )
    return updated[0] if updated else None


# ---------------------------------------------------------------------------
# UPSERT: core.aggregator_state
# ---------------------------------------------------------------------------
#
# PG is the canonical watermark store. The legacy single-line POSIX-timestamp
# state file maps to `last_processed_ts` (PG timestamptz).
#
# Param-name 3-layer mapping (with documented rename):
#   file value (POSIX float)  → PG column           → python kwarg
#   --                          name                  name (PK; varchar(64))
#   `time.time()` → datetime    last_processed_ts     last_processed_ts
#   --                          lag_seconds           lag_seconds (nullable)
#
# Single-row pattern keyed on the name PK, which also backs the UPSERT conflict.

_AGGREGATOR_STATE_UPSERT_SQL = """
INSERT INTO core.aggregator_state (name, last_processed_ts, lag_seconds)
VALUES (%(name)s, %(last_processed_ts)s, %(lag_seconds)s)
ON CONFLICT (name) DO UPDATE SET
    last_processed_ts = EXCLUDED.last_processed_ts,
    lag_seconds = EXCLUDED.lag_seconds
"""


def update_aggregator_state(
    name: str,
    last_processed_ts,
    lag_seconds: int | None = None,
) -> int:
    """UPSERT single-row state for the named aggregator.

    Returns elapsed_ms. Never raises on PG errors. Raises ValueError on input
    validation only.
    """
    if not name or not isinstance(name, str):
        raise ValueError("name must be non-empty str")
    if len(name) > 64:
        raise ValueError("name exceeds varchar(64): %d chars" % len(name))
    if lag_seconds is not None and not isinstance(lag_seconds, int):
        raise ValueError("lag_seconds must be int or None, got %r" % (lag_seconds,))

    row = {
        "name": name,
        "last_processed_ts": last_processed_ts,
        "lag_seconds": lag_seconds,
    }

    def _do():
        with psycopg.connect(
            "dbname=glass_atrium", connect_timeout=1, autocommit=False
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(_AGGREGATOR_STATE_UPSERT_SQL, row)
            conn.commit()

    return _run_with_retry(
        op_name="update_aggregator_state",
        target_table="core.aggregator_state",
        payload_ref=name[:96],
        fn=_do,
    )


# ---------------------------------------------------------------------------
# INSERT: core.audit_queue
# ---------------------------------------------------------------------------
#
# Mirrors the append-only learning-exclusion flat file into PG (file→PG push).
#
# Row-level idempotency is NOT enforced (no unique constraint) — the caller owns
# it via a line-count watermark, pushing only NEW lines each cycle. This helper
# plain-INSERTs exactly the rows handed to it, so a double-call with the same
# rows duplicates; the caller MUST advance its watermark.
#
# Param-name 3-layer mapping (file column == PG column == python dict key):
#   excluded_path  ==  excluded_path  ==  excluded_path   (path/audit-ref field)
#   reason         ==  reason         ==  reason          (exclusion-reason field)
#   excluded_at    ==  excluded_at    ==  excluded_at     (timestamptz; now() when None)
#
# excluded_at defaults to now() in SQL when omitted — the flat file carries no
# timestamp, so the mirror stamps ingest time as the closest proxy.

_AUDIT_QUEUE_INSERT_SQL = """
INSERT INTO core.audit_queue (excluded_path, reason, excluded_at)
VALUES (%(excluded_path)s, %(reason)s, COALESCE(%(excluded_at)s, now()))
"""


def insert_audit_queue_rows(rows: list[dict]) -> int:
    """Batch-INSERT excluded-outcome rows into core.audit_queue (file→PG mirror).

    Each row dict needs `excluded_path` + `reason` (both non-empty str);
    `excluded_at` is optional (None → SQL stamps now()). Empty list is a no-op.

    Not row-level idempotent (no unique constraint), so re-inserting the same rows
    duplicates — the caller guarantees idempotency via a line-count watermark,
    handing only new lines (learning-aggregator._sync_audit_queue_to_pg).

    Returns elapsed_ms; never raises on PG-side errors (degrade-not-die), only on
    input validation so the caller can log+skip a malformed batch.
    """
    if not isinstance(rows, list):
        raise ValueError("rows must be a list, got %r" % (type(rows).__name__,))
    if not rows:
        return 0  # nothing to push — skip the connect entirely

    clean: list[dict] = []
    for idx, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError("rows[%d] must be a dict, got %r" % (idx, type(row).__name__))
        excluded_path = row.get("excluded_path")
        reason = row.get("reason")
        if not excluded_path or not isinstance(excluded_path, str):
            raise ValueError("rows[%d].excluded_path must be non-empty str" % idx)
        if not reason or not isinstance(reason, str):
            raise ValueError("rows[%d].reason must be non-empty str" % idx)
        clean.append({
            "excluded_path": excluded_path,
            "reason": reason,
            "excluded_at": row.get("excluded_at"),  # None → SQL COALESCE to now()
        })

    def _do():
        with psycopg.connect(
            "dbname=glass_atrium", connect_timeout=1, autocommit=False
        ) as conn:
            with conn.cursor() as cur:
                cur.executemany(_AUDIT_QUEUE_INSERT_SQL, clean)
            conn.commit()

    return _run_with_retry(
        op_name="insert_audit_queue_rows",
        target_table="core.audit_queue",
        payload_ref="rows=%d:%s" % (len(clean), clean[0]["reason"][:32]),
        fn=_do,
    )


# ---------------------------------------------------------------------------
# Optional: end-of-run summary
# ---------------------------------------------------------------------------

def batch_complete(stats_dict: dict) -> int:
    """Emit a structured stderr line summarizing a single aggregator run.

    No metrics table by design — a core.aggregator_run_log was rejected because:
      1. scope is dual-write of existing legacy sinks; a new table is scope creep.
      2. the aggregator already prints a human-readable summary via
         _emit_exclusion_summary; this adds a structured-JSON line for log parity.
      3. watermark + counts are recoverable from learning_log row counts directly.
    Returns 0 (stderr-only, no PG operation).
    """
    safe = {
        k: (v if isinstance(v, (str, int, float, bool)) else str(v))
        for k, v in (stats_dict or {}).items()
    }
    parts = ",".join(
        '"%s":%s' % (
            k,
            (v if isinstance(v, (int, float, bool)) and not isinstance(v, bool) else
             ('true' if v is True else 'false' if v is False else
              '"%s"' % str(v).replace('"', "'")))
        )
        for k, v in safe.items()
    )
    sys.stderr.write(
        '{"hook":"learning-aggregator","op":"batch_complete",%s}\n' % parts
    )
    return 0


# ---------------------------------------------------------------------------
# READ helpers
# ---------------------------------------------------------------------------
# The legacy md/state files are no longer written, so read sites now source from
# PG. These are READ-only (no PG mutation), each self-contained (single short
# autocommit connection) via psycopg.connect("dbname=glass_atrium") only — no
# host/port/localhost. On failure they fall back to empty/zero so the aggregator
# never crashes (degrade-not-die).

def read_aggregator_watermark(name: str) -> float:
    """Return last_processed_ts for an aggregator row as a unix epoch float.

    Falls back to 0.0 if the row is missing OR PG is unreachable — same semantics
    as the file-missing fallback the aggregator already handles (full rescan).
    """
    if not name or not isinstance(name, str):
        return 0.0
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=1, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT EXTRACT(EPOCH FROM last_processed_ts) "
                    "FROM core.aggregator_state WHERE name = %s",
                    (name,),
                )
                row = cur.fetchone()
                if not row or row[0] is None:
                    return 0.0
                return float(row[0])
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        sys.stderr.write(
            '{"hook":"_pg_learning_dualwrite","op":"read_aggregator_watermark",'
            '"error_kind":"%s","fallback":"0.0"}\n'
            % type(exc).__name__
        )
        return 0.0


def read_learning_log_signatures() -> dict:
    """Return current learning_log signatures keyed by (pattern_signature_core, agent).

    Shape: {(pat_core, agent): {"frequency": int, "status": str, "approval_tier": str}}.

    pat_core = pattern signature stripped of surrounding whitespace; the caller
    does any further normalization (its own _NUMERIC_RE.sub() before dedup).
    Falls back to {} on any failure — the aggregator treats missing rows as new
    entries and the PG UPSERT dedupes by signature anyway.
    """
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=1, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT pattern_signature, frequency, status, approval_tier, agent "
                    "FROM core.learning_log"
                )
                out: dict = {}
                for sig, freq, status, tier, agent in cur.fetchall():
                    pat_core = (sig or "").strip()
                    # PG signature is "<pat_core>|<agent>" per aggregator's UPSERT
                    # contract — split back so caller can dedup against (pat_core, agent).
                    parts = pat_core.split("|", 1)
                    if len(parts) == 2:
                        key = (parts[0].strip(), parts[1].strip())
                    else:
                        key = (pat_core, (agent or "").strip())
                    out[key] = {
                        "frequency": int(freq or 0),
                        "status": status or "identified",
                        "approval_tier": tier or "user-pending",
                    }
                return out
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(
            '{"hook":"_pg_learning_dualwrite","op":"read_learning_log_signatures",'
            '"error_kind":"%s","fallback":"empty"}\n'
            % type(exc).__name__
        )
        return {}


# Intake predicate — proposal generation consumes only not-yet-adjudicated rows
# ('identified'; proposed/approved/applied/rejected are downstream states) in the
# intake tier band: 'user-pending' + 'llm' (the frozen DB value the retired
# 'llm-pending' band maps to via _TIER_MAP — those rows fold into the
# user-pending flow downstream, never dropped). Served by learning_log_status_tier_idx.
_PENDING_PATTERNS_SELECT_SQL = """
SELECT id, discovered_date, pattern_signature, frequency, agent,
       status::text, approval_tier::text
FROM core.learning_log
WHERE status = 'identified'::core."LearningStatus"
  AND approval_tier IN ('user-pending'::core."ApprovalTier",
                        'llm'::core."ApprovalTier")
ORDER BY frequency DESC, id
"""


def read_pending_learning_patterns() -> list[dict]:
    """Return proposal-generation intake rows from core.learning_log.

    Intake SoT: this module owns BOTH sides of the pattern hand-off — the
    aggregator writes via upsert_learning_pattern, the daemon intake reads via
    this function — so writer and reader can never diverge on source or
    predicate. The full intake predicate lives in _PENDING_PATTERNS_SELECT_SQL.

    Shape: [{"id": int, "discovered_date": date, "pattern_signature": str,
    "frequency": int, "agent": str, "status": str, "approval_tier": str}],
    frequency DESC. Falls back to [] on any failure — the daemon takes the
    zero-pattern path (no generation this cycle; next cycle retries).
    """
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=1, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(_PENDING_PATTERNS_SELECT_SQL)
                rows: list[dict] = []
                for (
                    row_id, discovered_date, signature, frequency, agent,
                    status, tier,
                ) in cur.fetchall():
                    rows.append({
                        "id": row_id,
                        "discovered_date": discovered_date,
                        "pattern_signature": (signature or "").strip(),
                        "frequency": int(frequency or 0),
                        "agent": (agent or "").strip(),
                        "status": status or "identified",
                        "approval_tier": tier or "user-pending",
                    })
                return rows
    except Exception as exc:  # noqa: BLE001 — read fallback is loud (stderr) + safe
        sys.stderr.write(
            '{"hook":"_pg_learning_dualwrite","op":"read_pending_learning_patterns",'
            '"error_kind":"%s","fallback":"empty"}\n'
            % type(exc).__name__
        )
        return []


# ---------------------------------------------------------------------------
# Negative-signal trigger predicate (AP-3) — the SINGLE definition both learning
# consumers key on: learning-aggregator.py pattern emit (patterns 1/5) AND
# daemon_cycle.py staleness recompute import it from here, so the emit condition
# and its live-window recompute cannot drift apart (drift = live patterns
# mis-skipped as stale). Co-located with read_outcomes_since because the
# predicate is defined over exactly the row dict that function returns.
# ---------------------------------------------------------------------------

NEGATIVE_SIGNAL_RESULTS = frozenset({"fail", "blocked", "done_with_concerns"})
# Provenance marker track-outcome.sh stamps on a [COMPLETION]-absent + tool_use≥1
# turn (the SubagentStop synthesis path). A synthesized row's result is itself
# synthesized, so its result polarity is NOT an agent-emitted signal.
ATTRIBUTION_SYNTHESIZED = "completion-synthesized"
# Sibling synthesized-provenance marker track-outcome.sh stamps when a subagent is
# hard-killed at its tool_use/turn budget ceiling BEFORE emitting [COMPLETION]. A
# budget-kill IS an agent-relevant negative (the truncated subagent's own
# instructions should improve), so — unlike the pure measurement gap above — it is
# DELIBERATELY left on the CLUSTERABLE side of _is_synthesized_measurement_gap.
# Accepted-scope REACHABILITY limit: pattern-1 clustering needs 3+ same-agent
# negatives within ONE daily watermark batch, so 1-2 truncations/day never form a
# pattern (cross-batch accumulation is a deferred follow-on, out of scope here).
ATTRIBUTION_BUDGET_TRUNCATION = "budget-truncation"
# Per-row floor mirroring the core-learning-log.md "revision_count 2+" process-
# improvement bar — 1 rework request is normal iteration, 2+ marks a correction.
NEGATIVE_REVISION_MIN = 2
GRADER_VERDICT_FAIL = "verified_fail"
# Hard-bar task_type set — EXACTLY {bug-fix, feature}, the SAME 2-element SoT as
# track-outcome.sh::task_type_has_hard_test_bar and lib/code-based-grader.sh. The
# no-test-bar set is the COMPLEMENT (NOT a re-listed 7-element list) so no new
# task_type list exists to drift — membership is derived as "not bug-fix and not
# feature", mirroring the grader's check structure.
HARD_TEST_BAR_TASK_TYPES = frozenset({"bug-fix", "feature"})
# Dead-signal universe — the aggregator's detector iterates this fixed tuple so
# a metric that NEVER fires still gets reported (a hit-derived dict would omit it).
NEGATIVE_SIGNAL_NAMES = (
    "result=fail",
    "result=blocked",
    "result=done_with_concerns",
    "grader_verdict=verified_fail",
    "review_flag=true",
    "revision_count>=2",
)


def _is_structural_row(row: dict) -> bool:
    """True when the row is a no-test-bar task_type OR an off-role write — i.e.
    a metric_pass=false / review_flag=true on it is definitionally expected, not a
    real failure signal. Mirrors the track-outcome.sh D1 emit-side definition:
        STRUCTURAL == (task_type_has_hard_test_bar == 0) OR (off-role)
    Off-role reuses the imported role SoT (_role_task_type_allowed); the hard-bar
    set is the 2-element {bug-fix, feature} SoT (complement = no-test-bar). NO new
    task_type list is introduced. Tolerates missing keys (synthetic rows)."""
    task_type = (row.get("task_type") or "").strip()
    no_test_bar = task_type not in HARD_TEST_BAR_TASK_TYPES
    off_role = not _role_task_type_allowed(row.get("agent"), task_type)
    return no_test_bar or off_role


def _is_synthesized_measurement_gap(row: dict) -> bool:
    """True when the row is a SubagentStop-synthesized done_with_concerns — i.e. the
    agent finished but emitted no [COMPLETION] block, so track-outcome.sh synthesized
    the outcome with attribution_source=completion-synthesized. Such a row is a
    MEASUREMENT GAP, not an agent failure: its done_with_concerns result is the
    synthesis DEFAULT, not an agent-emitted signal, so it must contribute ZERO
    negative hits. Scoped to done_with_concerns ONLY — a synthesized fail/blocked
    (should not occur from this path) is left to normal evaluation. Tolerates
    missing keys (synthetic test rows).

    budget-truncation shares the synthesized provenance but is a real negative, not
    a measurement gap — the explicit guard keeps it clusterable and holds that
    invariant even if the completion-synthesized match is ever broadened."""
    if (row.get("attribution_source") or "") == ATTRIBUTION_BUDGET_TRUNCATION:
        return False
    return (
        (row.get("attribution_source") or "") == ATTRIBUTION_SYNTHESIZED
        and (row.get("result") or "") == "done_with_concerns"
    )


def negative_signal_hits(row: dict) -> tuple[str, ...]:
    """Names (subset of NEGATIVE_SIGNAL_NAMES) of the OR-terms this outcome trips.

    A row with ANY hit counts ONCE toward the per-agent trigger (the caller
    keys on truthiness, never on len() — one bad outcome must not be
    double-counted); the per-name breakdown feeds the dead-signal detector.
    Tolerates missing keys (synthetic test rows carry only 'result').

    Synthesized-measurement-gap carve-out (lockstep with the SubagentStop synthesis
    default flip needs_context → done_with_concerns): a completion-synthesized
    done_with_concerns row is a measurement gap, not an agent failure — it produces
    ZERO negative hits. Scoped to that exact provenance+result pair, so a REAL agent
    emitting done_with_concerns still counts.

    D2 structural carve-out (lockstep with track-outcome.sh D1 emit-side): on a
    structural row (no-test-bar task_type OR off-role) a review_flag=true is the
    polar-mismatch artifact D1 already stopped emitting for fresh rows — it is NOT
    a real failure signal, so it does NOT count as a standalone negative hit here.
    The carve-out is review_flag-SPECIFIC: result=fail / grader_verdict=verified_fail
    / revision_count>=2 on a structural row are GENUINE failures and still count.
    A genuine code row (dev-* on-role bug-fix/feature) keeps review_flag=true as a
    real overconfidence signal (real-signal guard)."""
    if _is_synthesized_measurement_gap(row):
        return ()
    hits: list[str] = []
    result = row.get("result") or ""
    if result in NEGATIVE_SIGNAL_RESULTS:
        hits.append("result=%s" % result)
    if (row.get("grader_verdict") or "") == GRADER_VERDICT_FAIL:
        hits.append("grader_verdict=verified_fail")
    if bool(row.get("review_flag")) and not _is_structural_row(row):
        hits.append("review_flag=true")
    try:
        revision = int(row.get("revision_count") or 0)
    except (TypeError, ValueError):
        revision = 0
    if revision >= NEGATIVE_REVISION_MIN:
        hits.append("revision_count>=2")
    return tuple(hits)


def is_negative_signal_outcome(row: dict) -> bool:
    """True when the row counts toward the per-agent negative-signal trigger."""
    return bool(negative_signal_hits(row))


def _learning_window_where(
    since_epoch: float,
    *,
    agent: str | None,
    task_type: str | None,
) -> tuple[list[str], list[object]]:
    """WHERE clauses + params for the learning-signal window — single SoT.

    Shared by read_outcomes_since (row read) and count_outcomes_since
    (observation count) so the two consumers can never diverge on what
    "qualifying outcome" means. Learning-signal exclusion (always on) drops
    rows that are not real per-agent signal:
      1) sentinel agents (subagent_stop_missing / agent_id_missing) are
         attribution failures — counting them invents a phantom top-agent.
      2) attribution_source IS NULL = legacy rows with no recoverable agent
         identity → exclude, do NOT backfill.
      3) poisoned_window = grader-gap mis-measurement rows — training on them
         re-learns the bogus failure rates. COALESCE: NULL-safe on a DB where
         the column backfill has not run yet.
    Such rows stay in core.outcomes (the monitor reads them directly); this
    filter only keeps them out of the LEARNING aggregate. Read-only.
    """
    if not isinstance(since_epoch, (int, float)) or since_epoch < 0:
        since_epoch = 0.0
    where_clauses: list[str] = [
        "record_ts > to_timestamp(%s)",
        "attribution_source IS NOT NULL",
        "agent NOT IN ('subagent_stop_missing', 'agent_id_missing')",
        "COALESCE(poisoned_window, false) = false",
    ]
    params: list[object] = [since_epoch]
    if agent is not None:
        where_clauses.append("agent = %s")
        params.append(agent)
    if task_type is not None:
        where_clauses.append("task_type = %s::core.\"TaskType\"")
        params.append(task_type)
    return where_clauses, params


def read_outcomes_since(
    since_epoch: float,
    *,
    agent: str | None = None,
    task_type: str | None = None,
    limit: int | None = None,
    order: str = "ASC",
) -> list[dict]:
    """Return core.outcomes records after since_epoch as aggregator dicts.

    PG is the single discovery source — once the .md file sink was retired, glob
    discovery returned 0, the aggregator early-returned, and the watermark froze;
    sourcing from PG keeps discovery alive.

    - shape contract: equivalent to the frontmatter dict load_outcome() returned —
      every key used by _should_include_outcome and pattern aggregation. The extra
      'record_ts' + 'pg_audit_ref' keys feed the audit queue / watermark and do
      not affect existing callers.
    - attribution_source: write-time provenance label (e.g. 'hook-input',
      'completion-synthesized'); fed through so the negative-signal carve-out can
      tell a completion-synthesized measurement gap from a real agent failure.
    - fallback: psycopg missing / PG unreachable → empty list (caller takes the
      zero-record path).
    - idempotent (read-only): same args → same result.
    - order: 'ASC' (default) keeps the watermark monotonic (aggregator contract);
      'DESC' serves the agent-scoped recent-N query.

    Optional kwargs push filtering server-side:
    - agent: single-agent match via `outcomes_agent_ts_idx`
    - task_type: task_type match (fully pushes down AND-combined with agent)
    - limit: server-side LIMIT — blocks over-fetch on a top-N fetch
    - order: 'ASC' | 'DESC'

    Existing callers pass no keywords → all optionals None → original since-only
    SQL (ASC, no LIMIT) unchanged.
    """
    # order whitelist — injection defense where parameterized binding is impossible.
    order_upper = (order or "ASC").upper()
    if order_upper not in ("ASC", "DESC"):
        order_upper = "ASC"
    # limit: None omits the LIMIT clause; otherwise positive int only.
    limit_int: int | None
    if limit is None:
        limit_int = None
    elif isinstance(limit, int) and limit > 0:
        limit_int = limit
    else:
        limit_int = None  # invalid input → omit LIMIT (safe fallback)

    # agent/task_type clauses are omitted when None so the since-only call keeps
    # the simplest plan; exclusion rationale lives on _learning_window_where.
    where_clauses, params = _learning_window_where(
        since_epoch, agent=agent, task_type=task_type
    )

    sql = (
        "SELECT record_ts, agent, task_type::text, result::text, "
        "       confidence::text, metric_pass, metric_type, "
        "       revision_count, evaluative_signal, directive_hint, "
        "       lesson, concerns, files_modified, correlation_id, cid, "
        "       summary, review_flag, grader_verdict::text, attribution_source "
        "FROM core.outcomes "
        "WHERE " + " AND ".join(where_clauses) + " "
        "ORDER BY record_ts " + order_upper
    )
    if limit_int is not None:
        sql += " LIMIT %s"
        params.append(limit_int)

    rows: list[dict] = []
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=2, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                for (
                    record_ts, agent_, task_type_, result_, confidence, metric_pass,
                    metric_type, revision_count, evaluative_signal, directive_hint,
                    lesson, concerns, files_modified, correlation_id, cid, summary,
                    review_flag, grader_verdict, attribution_source,
                ) in cur.fetchall():
                    # audit ref — file-path replacement identifier, for user grep tracing
                    audit_ref = "pg:%s:%s:%s" % (
                        record_ts.isoformat(timespec="seconds"),
                        agent_ or "",
                        task_type_ or "",
                    )
                    rows.append({
                        "record_ts": record_ts,
                        "pg_audit_ref": audit_ref,
                        "agent": agent_ or "",
                        "task_type": task_type_ or "",
                        "result": result_ or "",
                        "confidence": confidence or "",
                        "metric_pass": metric_pass,
                        "metric_type": metric_type or "",
                        "revision_count": int(revision_count or 0),
                        "evaluative_signal": evaluative_signal,
                        "directive_hint": directive_hint or "",
                        "lesson": lesson or "",
                        "concerns": list(concerns or []),
                        "files_modified": list(files_modified or []),
                        "correlation_id": correlation_id or "",
                        "cid": cid or "",
                        "summary": summary or "",
                        "review_flag": bool(review_flag),
                        "grader_verdict": grader_verdict or "",
                        # write-time provenance → downstream carve-outs see the
                        # completion-synthesized marker
                        "attribution_source": attribution_source or "",
                    })
        return rows
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        sys.stderr.write(
            '{"hook":"_pg_learning_dualwrite","op":"read_outcomes_since",'
            '"error_kind":"%s","fallback":"empty","since_epoch":%s,'
            '"agent":%s,"task_type":%s,"limit":%s,"order":"%s"}\n'
            % (
                type(exc).__name__,
                since_epoch,
                ('"%s"' % agent) if agent else "null",
                ('"%s"' % task_type) if task_type else "null",
                str(limit_int) if limit_int is not None else "null",
                order_upper,
            )
        )
        return []


def count_outcomes_since(
    since_epoch: float,
    *,
    agent: str | None = None,
    task_type: str | None = None,
) -> int | None:
    """COUNT(*) of qualifying core.outcomes rows over the learning-signal window.

    Same WHERE as read_outcomes_since (shared _learning_window_where — the row
    read and the count can never diverge on what "qualifying" means), with no
    LIMIT: a row-read cap bounds LLM-context size, never evidence volume. This
    is the promotion ladder's observation_count source — len() of a capped
    sample undercounts and silently blocks the n>=10 candidate floor.

    - fallback: PG unreachable / query error → None (caller chooses the
      degrade; None is distinct from a true 0 of an empty window).
    """
    where_clauses, params = _learning_window_where(
        since_epoch, agent=agent, task_type=task_type
    )
    sql = (
        "SELECT count(*) FROM core.outcomes WHERE " + " AND ".join(where_clauses)
    )
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=2, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                row = cur.fetchone()
        return int(row[0]) if row is not None else None
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        sys.stderr.write(
            '{"hook":"_pg_learning_dualwrite","op":"count_outcomes_since",'
            '"error_kind":"%s","fallback":"none","since_epoch":%s,'
            '"agent":%s,"task_type":%s}\n'
            % (
                type(exc).__name__,
                since_epoch,
                ('"%s"' % agent) if agent else "null",
                ('"%s"' % task_type) if task_type else "null",
            )
        )
        return None
