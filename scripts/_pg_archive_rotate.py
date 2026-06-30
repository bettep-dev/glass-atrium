#!/usr/bin/env python3
# _pg_archive_rotate.py — weekly archive rotation helper.
#
# Function: Move aged rows from monitor.audit_log -> monitor.audit_log_archive
# (180 days). Each MOVE = single transaction (INSERT ... RETURNING id, then DELETE).
#
# Idempotency: If 0 rows old enough, the transaction reports 0 moved.
# Designed to run every Sunday from daemon-weekly-clear.sh autoagent role.
#
# CLI: stdout `[archive-rotate] audit_log moved={M} elapsed={X}s`
# Exit: 0 always (best-effort, like the other helpers).
# Connection: psycopg.connect("dbname=glass_atrium") Unix socket only.
#   NEVER -h, -p, host=, 127.0.0.1, localhost.

import sys
import time

try:
    import psycopg
except ImportError as exc:
    sys.stderr.write(
        '{"hook":"_pg_archive_rotate","error_kind":"import_error","message":"%s"}\n'
        % str(exc).replace('"', "'")
    )
    sys.exit(0)


def _connect():
    # Unix socket only — dbname=glass_atrium has no host/port.
    return psycopg.connect("dbname=glass_atrium", connect_timeout=2)


def rotate_audit_log(conn):
    """Move monitor.audit_log rows older than 180 days into monitor.audit_log_archive.

    INSERT-RETURNING + DELETE single-transaction pattern. Returns int (rows moved).
    """
    sql_insert = """
        INSERT INTO monitor.audit_log_archive
            (id, event_ts, actor, action_kind, target_table, target_id,
             payload, result_code, archived_at)
        SELECT
            id, event_ts, actor, action_kind, target_table, target_id,
            payload, result_code, NOW()
        FROM monitor.audit_log
        WHERE event_ts < NOW() - INTERVAL '180 days'
        RETURNING id
    """
    sql_delete = "DELETE FROM monitor.audit_log WHERE id = ANY(%s)"

    with conn.cursor() as cur:
        cur.execute(sql_insert)
        moved_ids = [row[0] for row in cur.fetchall()]
        if moved_ids:
            cur.execute(sql_delete, (moved_ids,))
    conn.commit()
    return len(moved_ids)


def main():
    start = time.monotonic()
    audit_moved = 0

    try:
        with _connect() as conn:
            try:
                audit_moved = rotate_audit_log(conn)
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(
                    '{"hook":"_pg_archive_rotate","tx":"audit_log","error":"%s"}\n'
                    % str(exc)[:200].replace('"', "'").replace("\n", " ")
                )
                conn.rollback()
    except Exception as exc:  # noqa: BLE001 — connection-level failure
        sys.stderr.write(
            '{"hook":"_pg_archive_rotate","tx":"connect","error":"%s"}\n'
            % str(exc)[:200].replace('"', "'").replace("\n", " ")
        )

    elapsed = time.monotonic() - start
    sys.stdout.write(
        "[archive-rotate] audit_log moved=%d elapsed=%.2fs\n"
        % (audit_moved, elapsed)
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
