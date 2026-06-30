#!/usr/bin/env python3
"""Shared PG dual-write helper for Claude Code hooks (Phase 1 migration).

Used by cost-tracker.sh and agent-tracker.sh to perform the PG INSERT step
of the dual-write pattern. The jsonl append remains the responsibility of
the calling hook (so jsonl is preserved bit-for-bit if PG fails).

Contract (per plan §7.3 fail-loud-and-skip):
  1. Connect via Unix socket (Const-16 — `dbname=glass_atrium` only, no host=).
  2. Execute the INSERT.
  3. On OperationalError / InterfaceError: 1 retry after 100ms backoff.
  4. On 2nd failure: log structured stderr line + best-effort INSERT into
     core.hook_failures (which itself swallows all errors — no recursion).
  5. Always emit `[<hook_name>] elapsed_ms=N` to stderr (AC1-3 latency).
  6. Always exit 0 — never block the Claude session.

Connection timeout: 1 second (so a dead postmaster does not stall the hook
beyond the latency budget).

Usage from a hook:
    python3 _pg-write.py <hook_name> <table> <<<'<json_row>'

  where <json_row> is a JSON object whose keys map 1:1 to column names of
  the target table. The wrapping hook is responsible for the retry-aware
  start_ns measurement passed via stdin (the helper measures its own
  end-to-end elapsed_ms, which the hook then prints).
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any

# psycopg2 is the installed driver (psycopg 3 is not available system-wide).
# Const-16 Unix-socket-only requirement; psycopg2 honors
# this when no host= is passed (libpq defaults to /tmp socket).
try:
    import psycopg2
    from psycopg2 import OperationalError, InterfaceError
except ImportError as e:
    # No driver — best we can do is emit a structured stderr line and exit 0.
    sys.stderr.write(
        '{"hook":"_pg-write","error_kind":"missing_driver","detail":"%s"}\n'
        % str(e).replace('"', "'")
    )
    sys.exit(0)


CONNECT_TIMEOUT_SEC = 1
RETRY_BACKOFF_SEC = 0.1


# Identifier allowlist — table + column names are f-string-interpolated into the
# INSERT (psycopg cannot bind identifiers), so an unvetted name is a SQL-injection
# surface. Mirrors _pg_dual_write.py so both dual-write helpers share one contract.
_ALLOWED_COLUMNS = {
    "core.cost_events": frozenset(
        {
            "event_date",
            "event_time",
            "session_id",
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


class IdentifierRejected(ValueError):
    """A target table or column name failed the allowlist.

    Raised before any SQL-string interpolation so a crafted stdin key can never
    reach the statement builder.
    """


def _validate_identifiers(table: str, columns: list[str]) -> None:
    # Reject an unknown table outright — never interpolate it.
    allowed_cols = _ALLOWED_COLUMNS.get(table)
    if allowed_cols is None:
        raise IdentifierRejected("target_table not in allowlist: %r" % table)
    # Reject any out-of-set column — blocks injection via a crafted `row` key.
    unknown = [c for c in columns if c not in allowed_cols]
    if unknown:
        raise IdentifierRejected("unknown column(s) for %s: %r" % (table, unknown))


def _classify_error(exc: Exception) -> str:
    """Map a psycopg2 exception to one of the core.HookErrorKind enum values."""
    name = type(exc).__name__
    msg = str(exc).lower()
    if "could not connect" in msg or "connection refused" in msg:
        return "connection_refused"
    if "timeout" in msg or "timed out" in msg:
        return "timeout"
    if name in ("IntegrityError", "DataError", "ProgrammingError"):
        return "constraint_violation"
    if isinstance(exc, (OperationalError, InterfaceError)):
        return "connection_refused"
    return "unknown"


def _record_failure(
    hook_name: str,
    target_table: str,
    error_kind: str,
    payload_ref: str | None,
    retry_attempted: bool,
) -> None:
    """Best-effort INSERT into core.hook_failures. Swallows ALL errors —
    this is the secondary path and MUST NOT recurse into another failure."""
    try:
        conn = psycopg2.connect(dbname="glass_atrium", connect_timeout=CONNECT_TIMEOUT_SEC)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO core.hook_failures "
                    "(failure_ts, hook_name, target_table, error_kind, "
                    "payload_ref, retry_attempted) "
                    "VALUES (now(), %s, %s, %s, %s, %s)",
                    (hook_name, target_table, error_kind, payload_ref, retry_attempted),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — by design; secondary path
        pass


def _build_insert_sql(table: str, columns: list[str]) -> str:
    # Validate before interpolation — table + columns are f-string'd in below.
    _validate_identifiers(table, columns)
    placeholders = ", ".join(["%s"] * len(columns))
    column_list = ", ".join(columns)
    # ON CONFLICT DO NOTHING on the dedup unique index — re-running the
    # same hook payload is a no-op rather than a constraint violation.
    return (
        f"INSERT INTO {table} ({column_list}) "
        f"VALUES ({placeholders}) ON CONFLICT DO NOTHING"
    )


def pg_dual_write(
    hook_name: str,
    table: str,
    row: dict[str, Any],
    payload_ref: str | None,
) -> int:
    """Insert `row` into `table` with 1-retry-100ms-backoff. Returns elapsed ms.

    On failure: emits structured stderr line + records hook_failure. Never raises.
    """
    start_ns = time.monotonic_ns()
    columns = list(row.keys())
    values = [row[c] for c in columns]
    try:
        sql = _build_insert_sql(table, columns)
    except IdentifierRejected as exc:
        # A rejection is a caller bug, not a transient DB error — skip the insert,
        # record the failure once, and return without consuming a retry.
        sys.stderr.write(
            json.dumps(
                {
                    "hook": hook_name,
                    "target_table": str(table),
                    "error_kind": "identifier_rejected",
                    "payload_ref": payload_ref,
                    "message": str(exc)[:200].replace('"', "'"),
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                }
            )
            + "\n"
        )
        # "unknown" bucket — the HookErrorKind enum has no identifier-reject member.
        _record_failure(hook_name, table, "unknown", payload_ref, False)
        return (time.monotonic_ns() - start_ns) // 1_000_000

    last_exc: Exception | None = None
    retry_attempted = False
    for attempt in (1, 2):
        try:
            conn = psycopg2.connect(
                dbname="glass_atrium", connect_timeout=CONNECT_TIMEOUT_SEC
            )
            try:
                with conn.cursor() as cur:
                    cur.execute(sql, values)
                conn.commit()
            finally:
                conn.close()
            elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            return elapsed_ms
        except (OperationalError, InterfaceError) as exc:
            last_exc = exc
            if attempt == 1:
                retry_attempted = True
                time.sleep(RETRY_BACKOFF_SEC)
                continue
            break
        except Exception as exc:  # noqa: BLE001 — IntegrityError, DataError, etc.
            last_exc = exc
            break

    # Both attempts (or single non-retryable attempt) failed.
    error_kind = _classify_error(last_exc) if last_exc else "unknown"
    sys.stderr.write(
        json.dumps(
            {
                "hook": hook_name,
                "target_table": table,
                "error_kind": error_kind,
                "payload_ref": payload_ref,
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            }
        )
        + "\n"
    )
    _record_failure(hook_name, table, error_kind, payload_ref, retry_attempted)
    elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
    return elapsed_ms


def _main() -> None:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: _pg-write.py <hook_name> <table>\n")
        sys.exit(0)
    hook_name = sys.argv[1]
    table = sys.argv[2]

    raw = sys.stdin.read()
    if not raw.strip():
        # No payload — nothing to insert. Still emit elapsed_ms=0.
        sys.stdout.write("0\n")
        sys.exit(0)

    try:
        row = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.stderr.write(
            '{"hook":"%s","error_kind":"unknown","detail":"json_decode: %s"}\n'
            % (hook_name, str(exc).replace('"', "'"))
        )
        sys.stdout.write("0\n")
        sys.exit(0)

    payload_ref = row.pop("__payload_ref__", None) if isinstance(row, dict) else None
    if not isinstance(row, dict):
        sys.stderr.write(
            '{"hook":"%s","error_kind":"unknown","detail":"row_not_object"}\n'
            % hook_name
        )
        sys.stdout.write("0\n")
        sys.exit(0)

    elapsed_ms = pg_dual_write(hook_name, table, row, payload_ref)
    # Print elapsed_ms on stdout for the calling shell to capture and re-emit
    # in its hook-scoped `[hook_name] elapsed_ms=N` line.
    sys.stdout.write(f"{elapsed_ms}\n")


if __name__ == "__main__":
    _main()
