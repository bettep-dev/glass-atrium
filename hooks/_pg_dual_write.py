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


def _try_insert(table, row_dict, connect_timeout=1):
    cols = list(row_dict.keys())
    # Validate identifiers before building the SQL string — table + column names
    # are %-interpolated below (psycopg cannot bind identifiers).
    _validate_identifiers(table, cols)
    placeholders = ", ".join(["%s"] * len(cols))
    col_list = ", ".join(cols)
    conflict_clause = _build_conflict_clause(table, cols)
    sql = "INSERT INTO %s (%s) VALUES (%s) %s" % (
        table,
        col_list,
        placeholders,
        conflict_clause,
    )
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


def main():
    start_ns = time.monotonic_ns()
    raw = sys.stdin.read()
    try:
        envelope = json.loads(raw)
        hook_name = envelope["hook_name"]
        target_table = envelope["target_table"]
        payload_ref = envelope.get("payload_ref", "")
        row = envelope["row"]
    except Exception as exc:
        # Malformed envelope = bash caller bug; log and exit 0 (jsonl is written).
        sys.stderr.write(
            '[_pg_dual_write] envelope parse failed: %s\n' % str(exc).replace('"', "'")
        )
        sys.exit(0)

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


if __name__ == "__main__":
    main()
