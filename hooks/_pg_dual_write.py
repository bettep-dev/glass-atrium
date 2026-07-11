#!/usr/bin/env python3
# Shared PG INSERT helper for the dual-write hooks (cost-tracker, agent-tracker).
#
# Invoked as a subprocess AFTER the bash hook has appended its JSONL line; this
# is the SECOND write, so its failure MUST NOT lose data and MUST NOT block the
# Claude session (exit 0 always). Failure handling: 1 retry with 100 ms backoff,
# then a structured stderr log + best-effort core.hook_failures INSERT (errors
# swallowed to avoid recursion). Connection is Unix-socket-only via
# psycopg.connect("dbname=glass_atrium") — never -h/-p/host=/127.0.0.1/localhost.
# elapsed_ms is emitted to stderr unconditionally for latency aggregation.
#
# Stdin contract (single-line JSON):
#   {
#     "hook_name": "cost-tracker" | "agent-tracker",
#     "target_table": "core.cost_events" | "core.agent_events",
#     "payload_ref": "<session_id or agent_id, used by hook_failures.payload_ref>",
#     "row": { ... column_name -> value ... }
#   }
#
# Column types in `row` are passed to psycopg verbatim — the caller matches the
# schema. A schema mismatch raises ProgrammingError → same retry/failure path.

import json
import sys
import time

# psycopg lives in user site-packages, on sys.path by default (PEP 370).
try:
    import psycopg
    from psycopg import errors as pg_errors
except ImportError as exc:
    # psycopg missing makes dual-write impossible; jsonl is already written, so
    # emit a structured warning and exit 0.
    sys.stderr.write(
        '{"hook":"_pg_dual_write","error_kind":"import_error","message":"%s"}\n'
        % str(exc).replace('"', "'")
    )
    sys.exit(0)


# Identifier allowlist — psycopg can bind only VALUES, not identifiers, and
# _try_insert %-interpolates the table name and column list into the SQL string;
# allowlisting them here blocks identifier injection before any interpolation.
# Tables/columns mirror monitor/prisma/schema.prisma @map names and the real
# INSERT call sites (cost-tracker.sh, agent-tracker.sh row dicts). core.hook_failures
# is absent (written only via hardcoded SQL, never a dynamic target_table); id +
# inserted_at are excluded (auto-assigned, never present in `row`).
_ALLOWED_COLUMNS = {
    "core.cost_events": frozenset(
        {
            "event_date",
            "event_time",
            "session_id",
            # `kind` partitions turn vs subagent rows; `dedup_key` is the per-row
            # stable identity forming the (session_id, dedup_key) UPSERT arbiter.
            "kind",
            "dedup_key",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_creation_tokens",
            "cost_usd",
            "duration_ms",
            "num_turns",
            "stop_reason",
            "model",
            "parse_error",
            "raw_input",
        }
    ),
    "core.agent_events": frozenset(
        {
            "event_ts",
            "event_name",
            "agent_id",
            "agent_type",
        }
    ),
}


# Per-table ON CONFLICT policy. cost_events needs DO UPDATE so re-aggregating a
# turn/subagent (whole-file re-scan + Stop multi-fire) overwrites the same
# (session_id, dedup_key) row — re-aggregation is authoritative, not additive.
# Every other target keeps DO NOTHING idempotent-retry semantics; scoping this to
# cost_events keeps a shared-helper change from altering other hooks' contracts.
#
# `arbiter`  — ON CONFLICT (...) target columns; MUST match the unique index
#              cost_events_session_dedup_key ON (session_id, dedup_key).
# `update_cols` — columns overwritten with EXCLUDED.<col>; excludes the arbiter
#              and the immutable provenance columns (kind, event_date, event_time)
#              so only the re-derived token/cost/turn-stat payload is refreshed.
_UPSERT_POLICY = {
    "core.cost_events": {
        "arbiter": ("session_id", "dedup_key"),
        "update_cols": (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_creation_tokens",
            "cost_usd",
            "duration_ms",
            "num_turns",
            "stop_reason",
            "model",
            "parse_error",
            "raw_input",
        ),
    },
}


class IdentifierRejected(ValueError):
    """A target_table or column name failed the allowlist.

    Raised before any SQL-string interpolation so a crafted envelope key can
    never reach the statement builder. Carries `target_table` so the caller's
    failure-record path can log which table was rejected.
    """

    def __init__(self, message, target_table):
        super().__init__(message)
        self.target_table = target_table


def _validate_identifiers(table, cols):
    # Reject an unknown table outright — never interpolate it.
    allowed_cols = _ALLOWED_COLUMNS.get(table)
    if allowed_cols is None:
        raise IdentifierRejected(
            "target_table not in allowlist: %r" % table, table
        )
    # Reject any out-of-set column — blocks injection via a crafted `row` key.
    unknown = [c for c in cols if c not in allowed_cols]
    if unknown:
        raise IdentifierRejected(
            "unknown column(s) for %s: %r" % (table, unknown), table
        )


# Map a psycopg exception to a core.HookErrorKind enum value
# (connection_refused | timeout | constraint_violation | unknown).
def _classify_error(exc):
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


def _build_conflict_clause(table, present_cols):
    """Build the ON CONFLICT tail for `table`.

    No policy → bare DO NOTHING (idempotent-retry semantics). A table with a
    policy (cost_events) → DO UPDATE so a re-scan overwrites the matching row
    (re-aggregation is authoritative, not additive). The SET list is intersected
    with `present_cols` so a partial row only updates the columns it supplied.
    Arbiter + update names come from the trusted module-level policy, not caller
    input, so they are safe to interpolate.
    """
    policy = _UPSERT_POLICY.get(table)
    if policy is None:
        # DO NOTHING satisfies the agent_events dedup constraint — an idempotent
        # retry/replay MUST NOT raise IntegrityError.
        return "ON CONFLICT DO NOTHING"
    arbiter = ", ".join(policy["arbiter"])
    present = set(present_cols)
    set_cols = [c for c in policy["update_cols"] if c in present]
    if not set_cols:
        # No updatable payload column present (arbiter-only row) → DO NOTHING,
        # since DO UPDATE SET <empty> is a syntax error.
        return "ON CONFLICT (%s) DO NOTHING" % arbiter
    set_list = ", ".join("%s = EXCLUDED.%s" % (c, c) for c in set_cols)
    return "ON CONFLICT (%s) DO UPDATE SET %s" % (arbiter, set_list)


def _build_insert_sql(table, cols):
    """Validate identifiers, then build the parameterized UPSERT for `table` given
    the present `cols`. Table + column names are %-interpolated (psycopg cannot
    bind identifiers), so the allowlist check MUST run first. Shared by the
    single-row and batch paths so both emit an identical statement + conflict
    policy for the same row shape."""
    _validate_identifiers(table, cols)
    placeholders = ", ".join(["%s"] * len(cols))
    col_list = ", ".join(cols)
    conflict_clause = _build_conflict_clause(table, cols)
    return "INSERT INTO %s (%s) VALUES (%s) %s" % (
        table,
        col_list,
        placeholders,
        conflict_clause,
    )


def _try_insert(table, row_dict, connect_timeout=1):
    cols = list(row_dict.keys())
    sql = _build_insert_sql(table, cols)
    values = [row_dict[c] for c in cols]
    with psycopg.connect("dbname=glass_atrium", connect_timeout=connect_timeout) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, values)
        conn.commit()


def _record_hook_failure(hook_name, target_table, error_kind, payload_ref, retry_attempted):
    # Best-effort secondary INSERT; any exception is swallowed to avoid recursing
    # into the same failure path.
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=1) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO core.hook_failures "
                    "(failure_ts, hook_name, target_table, error_kind, payload_ref, retry_attempted) "
                    "VALUES (now(), %s, %s, %s, %s, %s)",
                    (hook_name, target_table, error_kind, payload_ref, retry_attempted),
                )
            conn.commit()
    except Exception:
        # hook_failures is observability only — its unavailability is acceptable.
        pass


def _emit_row_stderr(
    hook_name, target_table, payload_ref, error_kind, error_class, message,
    retry_attempted, dedup_key,
):
    """Write the structured per-row loud-fail stderr line — the PRIMARY failure
    channel daemon-reports / log aggregation consume. No DB side effect: the
    hook_failures record is split into the separate best-effort call below so the
    connect-failure branch can emit N per-row stderr lines while recording only
    ONE aggregate hook_failures row (never N connects to a proven-unreachable DB)."""
    sys.stderr.write(
        '{"hook":"%s","target_table":"%s","error_kind":"%s","error_class":"%s",'
        '"payload_ref":"%s","dedup_key":"%s","retry_attempted":%s,"message":"%s"}\n'
        % (
            hook_name,
            str(target_table).replace('"', "'"),
            error_kind,
            error_class,
            payload_ref,
            str(dedup_key).replace('"', "'")[:200],
            "true" if retry_attempted else "false",
            message,
        )
    )


def _emit_row_failure(
    hook_name, target_table, payload_ref, error_kind, error_class, message,
    retry_attempted, dedup_key,
):
    """Loud-fail one batch row: structured stderr line (same error_kind channel
    the single-row path uses, plus the row's dedup_key for triage) + best-effort
    core.hook_failures record. Never raises — a failed row must not abort the
    batch (partial-success contract)."""
    _emit_row_stderr(
        hook_name, target_table, payload_ref, error_kind, error_class, message,
        retry_attempted, dedup_key,
    )
    _record_hook_failure(hook_name, target_table, error_kind, payload_ref, retry_attempted)


def _insert_batch(hook_name, target_table, payload_ref, rows, connect_timeout=1):
    """Write every row in `rows` through ONE connection.

    The single-row entry point pays a fresh process + psycopg import + connect PER
    row, so a Stop firing N subagent rows forks N writers (the Stop-event latency
    spike). This path forks one writer, imports psycopg once, connects once, then
    upserts each row on a shared autocommit connection.

    autocommit=True makes each row its own transaction, so one row's failure
    neither leaves the connection in an aborted-transaction state nor drops the
    rows around it — the per-row partial-success contract the single-row path had
    via separate connections, preserved. Each failed row loud-fails (structured
    stderr + best-effort hook_failures) exactly as the single-row path does; the
    caller turns a nonzero return into a named exit code. Returns the count of
    rows that failed after one retry (0 == full success)."""
    if not rows:
        # Empty batch → no work; skip the connection entirely. Defensive: the
        # current caller guards with `if batch:`, so this only shields a future
        # empty-batch caller from a pointless connect.
        return 0
    # Connect ONCE, retrying the connect a single time (100 ms backoff) to match
    # the transient-failure tolerance the per-row path had per invocation. A total
    # connect failure loud-fails every row via stderr and returns the full count.
    conn = None
    connect_exc = None
    for attempt in (1, 2):
        try:
            conn = psycopg.connect(
                "dbname=glass_atrium",
                connect_timeout=connect_timeout,
                autocommit=True,
            )
            break
        except Exception as exc:  # noqa: BLE001 — classify + loud-fail below
            connect_exc = exc
            if attempt == 1:
                time.sleep(0.1)  # backoff before the single connect retry
    if conn is None:
        error_kind = _classify_error(connect_exc)
        error_class = type(connect_exc).__name__
        message = str(connect_exc)[:200].replace('"', "'").replace("\n", " ")
        # Per-row stderr stays (each row stays individually visible in the loud
        # channel the aggregator consumes), but the DB is proven unreachable — so
        # emit stderr ONLY per row and record ONE aggregate hook_failures row for
        # the whole batch, never a fresh per-row connect (~N wasted connect_timeout
        # stalls). Mirrors the single-row path's one-record-per-failure; the named
        # exit code + per-row loud signal are unchanged.
        for row in rows:
            dedup_key = row.get("dedup_key") if isinstance(row, dict) else None
            _emit_row_stderr(
                hook_name, target_table, payload_ref, error_kind, error_class,
                message, True, dedup_key,
            )
        _record_hook_failure(hook_name, target_table, error_kind, payload_ref, True)
        return len(rows)

    failed = 0
    try:
        for row in rows:
            if not isinstance(row, dict):
                # A non-dict row is a caller bug, not a DB fault — loud-fail and
                # skip; never abort the batch.
                _emit_row_failure(
                    hook_name, target_table, payload_ref, "unknown", "TypeError",
                    "row is not an object", False, None,
                )
                failed += 1
                continue
            cols = list(row.keys())
            dedup_key = row.get("dedup_key")
            try:
                sql = _build_insert_sql(target_table, cols)
            except IdentifierRejected as exc:
                # Identifier rejection is a caller bug — record once, skip the row,
                # never consume a retry or misclassify it as a DB error.
                _emit_row_failure(
                    hook_name, target_table, payload_ref, "identifier_rejected",
                    "IdentifierRejected",
                    str(exc)[:200].replace('"', "'").replace("\n", " "),
                    False, dedup_key,
                )
                failed += 1
                continue
            values = [row[c] for c in cols]
            row_exc = None
            retry_attempted = False
            # Fresh cursor per attempt — mirrors the single-row path (one cursor
            # per write) and keeps a prior row's error from touching this one.
            for attempt in (1, 2):
                try:
                    with conn.cursor() as cur:
                        cur.execute(sql, values)  # autocommit → commits now
                    row_exc = None
                    break
                except Exception as exc:  # noqa: BLE001 — classify + loud-fail below
                    row_exc = exc
                    if attempt == 1:
                        retry_attempted = True
                        time.sleep(0.1)  # backoff before the single retry
            if row_exc is not None:
                _emit_row_failure(
                    hook_name, target_table, payload_ref, _classify_error(row_exc),
                    type(row_exc).__name__,
                    str(row_exc)[:200].replace('"', "'").replace("\n", " "),
                    retry_attempted, dedup_key,
                )
                failed += 1
    finally:
        conn.close()
    return failed


def _run_single(hook_name, target_table, payload_ref, row, start_ns):
    """Original single-row write path (agent-tracker + any legacy caller), kept
    byte-identical: one connection per invocation, one retry, exit 0 always."""
    # Validate identifiers before the DB retry loop: a rejection is a caller bug,
    # not a transient DB error, so skip the insert, record the failure once, and
    # exit 0 without consuming a retry or misclassifying it as a DB error.
    try:
        _validate_identifiers(target_table, list(row.keys()) if isinstance(row, dict) else [])
    except IdentifierRejected as exc:
        elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
        sys.stderr.write(
            '{"hook":"%s","target_table":"%s","error_kind":"identifier_rejected",'
            '"error_class":"IdentifierRejected","payload_ref":"%s","retry_attempted":false,'
            '"elapsed_ms":%d,"message":"%s"}\n'
            % (
                hook_name,
                str(target_table).replace('"', "'"),
                payload_ref,
                elapsed_ms,
                str(exc)[:200].replace('"', "'").replace("\n", " "),
            )
        )
        sys.stderr.write(
            "[%s] elapsed_ms=%d pg_insert=reject error_kind=identifier_rejected\n"
            % (hook_name, elapsed_ms)
        )
        _record_hook_failure(hook_name, target_table, "identifier_rejected", payload_ref, False)
        sys.exit(0)

    last_exc = None
    retry_attempted = False
    for attempt in (1, 2):
        try:
            _try_insert(target_table, row)
            elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            sys.stderr.write(
                "[%s] elapsed_ms=%d pg_insert=ok attempt=%d\n"
                % (hook_name, elapsed_ms, attempt)
            )
            sys.exit(0)
        except Exception as exc:  # noqa: BLE001 — we intentionally catch all
            last_exc = exc
            if attempt == 1:
                retry_attempted = True
                time.sleep(0.1)  # backoff before the single retry

    # Both attempts failed — fail loud and skip.
    error_kind = _classify_error(last_exc)
    error_class = type(last_exc).__name__
    error_msg = str(last_exc)[:200].replace('"', "'").replace("\n", " ")
    elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000

    # Structured stderr line (consumed by daemon-reports / log aggregation).
    sys.stderr.write(
        '{"hook":"%s","target_table":"%s","error_kind":"%s","error_class":"%s",'
        '"payload_ref":"%s","retry_attempted":%s,"elapsed_ms":%d,"message":"%s"}\n'
        % (
            hook_name,
            target_table,
            error_kind,
            error_class,
            payload_ref,
            "true" if retry_attempted else "false",
            elapsed_ms,
            error_msg,
        )
    )
    sys.stderr.write(
        "[%s] elapsed_ms=%d pg_insert=fail error_kind=%s\n"
        % (hook_name, elapsed_ms, error_kind)
    )

    _record_hook_failure(hook_name, target_table, error_kind, payload_ref, retry_attempted)
    sys.exit(0)


def main():
    start_ns = time.monotonic_ns()
    raw = sys.stdin.read()
    try:
        envelope = json.loads(raw)
        hook_name = envelope["hook_name"]
        target_table = envelope["target_table"]
        payload_ref = envelope.get("payload_ref", "")
    except Exception as exc:
        # Malformed envelope = bash caller bug; log and exit 0 (jsonl is written).
        sys.stderr.write(
            '[_pg_dual_write] envelope parse failed: %s\n' % str(exc).replace('"', "'")
        )
        sys.exit(0)

    # Dispatch on the row cardinality key: `rows` (a list) → batch path (one
    # connection for the whole fire); `row` (a dict) → single-row path, kept
    # byte-identical for agent-tracker + any legacy caller.
    if "rows" in envelope:
        rows = envelope.get("rows")
        if not isinstance(rows, list):
            sys.stderr.write(
                '[_pg_dual_write] batch envelope "rows" is not a list — skipped\n'
            )
            sys.exit(0)
        failed = _insert_batch(hook_name, target_table, payload_ref, rows)
        elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
        written = len(rows) - failed
        sys.stderr.write(
            "[%s] elapsed_ms=%d pg_batch=%s rows_written=%d rows_failed=%d\n"
            % (
                hook_name,
                elapsed_ms,
                "ok" if failed == 0 else "partial",
                written,
                failed,
            )
        )
        # Named nonzero exit (3) is the loud-fail signal for a batch that had
        # failed rows. The bash caller invokes this via subprocess without check
        # and the hook's dual-write block is `|| true`, so the code is a
        # diagnosable signal — it never blocks the Claude session.
        sys.exit(0 if failed == 0 else 3)

    try:
        row = envelope["row"]
    except Exception as exc:
        sys.stderr.write(
            '[_pg_dual_write] envelope parse failed: %s\n' % str(exc).replace('"', "'")
        )
        sys.exit(0)
    _run_single(hook_name, target_table, payload_ref, row, start_ns)


if __name__ == "__main__":
    main()
