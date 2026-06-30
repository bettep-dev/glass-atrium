#!/usr/bin/env python3
# _pg_push_autoagent_loop_events.py — invoked by daemon-cycle.sh after the
# autoagent cycle pipeline completes. Mirrors _pg_push_autoagent_cycle.py.
#
# Reads ~/.claude/logs/autoagent-loop.jsonl (append-only ndjson emitted by the
# autoagent runner at every loop iteration) and pushes each line into
# core.autoagent_loop_events via _pg_dual_write_daemon.py (subprocess).
#
# JSONL line schema (1 row → 1 envelope):
#   {"ts":"<iso8601>", "agent":"<str>", "rice":<float|null>,
#    "eval_result":"<str>", "changes_added":<int>, "changes_removed":<int>}
#
# Field mapping: jsonl `ts` → DB column `event_ts`. All others 1:1.
#
# Idempotency: the helper's writer (write_autoagent_loop_event) does
# `ON CONFLICT (event_ts, agent, eval_result) DO UPDATE` keyed by the
# autoagent_loop_events_dedup UNIQUE INDEX. Re-running this publisher with
# unchanged lines is therefore a no-op at the DB level — no checkpoint file
# is needed and re-runs are safe by design.
#
# Backfill: the JSONL is small (mtime-based growth, not a hot loop). Each run
# scans the entire file end-to-end. Fail-loud-and-skip — exit 0 even on errors
# so the daemon does not block.
#
# CLI:
#   _pg_push_autoagent_loop_events.py [--dry-run] [--limit N] [--since YYYY-MM-DD]
#     --dry-run   parse + classify but do NOT call helper (count + first/last ts)
#     --limit N   cap envelopes published this run (default: no cap)
#     --since DT  skip lines with event_ts < DT (ISO-8601 prefix match)
#
# Exit 0 always — daemon must not block on PG failure.

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

# Path constants — same helper location as _pg_push_autoagent_cycle.py
LOOP_LOG: str = os.path.expanduser("~/.claude/logs/autoagent-loop.jsonl")
HELPER: str = os.path.expanduser("~/.claude/scripts/_pg_dual_write_daemon.py")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="_pg_push_autoagent_loop_events",
        description="Publish autoagent-loop.jsonl to core.autoagent_loop_events",
    )
    # WHY: dry-run outputs only gate-pass/skip counts without invoking helper → for verification
    parser.add_argument("--dry-run", action="store_true", help="No DB writes; count only")
    # WHY: limit prevents backfill flooding — e.g. on first run, split 10K+ lines into chunks
    parser.add_argument("--limit", type=int, default=0, help="Cap envelopes per run (0=unlimited)")
    # WHY: since is used when the operator retries only entries after a specific point in time
    parser.add_argument("--since", type=str, default="", help="Skip lines with ts < SINCE")
    return parser.parse_args()


def _invoke_helper(envelope: dict[str, Any]) -> bool:
    """Invoke helper — fail-loud-and-skip. Returns bool indicating success.

    Same signature/exception policy as _invoke_helper in _pg_push_autoagent_cycle.py.
    The helper script always exits 0 → returncode alone cannot determine failure.
    Here we track only subprocess exceptions (PG failures are recorded in the helper's internal hook_failures).
    """
    try:
        subprocess.run(
            ["python3", HELPER],
            input=json.dumps(envelope),
            text=True,
            timeout=10,
            check=False,
        )
        return True
    except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
        # WHY: helper invocation itself failed (timeout, FileNotFoundError, etc.) → report to stderr and continue
        sys.stderr.write(
            "[autoagent-loop-pg] helper invocation failed: %s\n"
            % str(exc).replace('"', "'")
        )
        return False


def _build_envelope(obj: dict[str, Any]) -> dict[str, Any] | None:
    """One JSONL line → write_autoagent_loop_event argument envelope.

    Returns None when a required field is missing (skip + stderr).
    Maps jsonl `ts` → helper kwarg `event_ts` (matching the schema column).
    """
    ts = obj.get("ts")
    agent = obj.get("agent")
    eval_result = obj.get("eval_result")
    # WHY: the 3 dedup index keys are NOT NULL — if missing, the INSERT fails with IntegrityError
    if not ts or not agent or not eval_result:
        return None
    try:
        changes_added = int(obj.get("changes_added") or 0)
        changes_removed = int(obj.get("changes_removed") or 0)
    except (TypeError, ValueError):
        # WHY: integer cast failure → the line itself is corrupt, so skip it
        return None
    return {
        "op": "write_autoagent_loop_event",
        "args": {
            "event_ts": ts,
            "agent": agent,
            "eval_result": eval_result,
            "changes_added": changes_added,
            "changes_removed": changes_removed,
            "rice": obj.get("rice"),
        },
    }


def _iter_loop_lines(path: str) -> list[dict[str, Any]]:
    """Parse jsonl file → list of dicts. Corrupt lines go to stderr then are skipped."""
    if not os.path.isfile(path):
        sys.stderr.write("[autoagent-loop-pg] LOOP_LOG missing: %s; skipping\n" % path)
        return []
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                # WHY: a single corrupt line must not block the entire publisher
                sys.stderr.write(
                    "[autoagent-loop-pg] line %d JSON parse failed: %s\n"
                    % (lineno, str(exc).replace('"', "'"))
                )
    return rows


def main() -> int:
    args = _parse_args()
    rows = _iter_loop_lines(LOOP_LOG)

    # WHY: the since filter is a lexicographic ts string comparison (ISO-8601 lexicographic order = chronological order)
    if args.since:
        rows = [r for r in rows if str(r.get("ts") or "") >= args.since]

    envelopes: list[dict[str, Any]] = []
    skipped_invalid = 0
    for obj in rows:
        env = _build_envelope(obj)
        if env is None:
            skipped_invalid += 1
            continue
        envelopes.append(env)

    if args.limit and args.limit > 0:
        envelopes = envelopes[: args.limit]

    # Stats — for reporting first/last event_ts
    first_ts = envelopes[0]["args"]["event_ts"] if envelopes else ""
    last_ts = envelopes[-1]["args"]["event_ts"] if envelopes else ""

    if args.dry_run:
        # WHY: dry-run reports only counts/ranges to stdout without invoking helper → for verification/CI
        sys.stdout.write(
            "[autoagent-loop-pg] dry-run total_lines=%d publishable=%d skipped_invalid=%d "
            "first_ts=%s last_ts=%s\n"
            % (len(rows), len(envelopes), skipped_invalid, first_ts, last_ts)
        )
        return 0

    if not envelopes:
        sys.stderr.write(
            "[autoagent-loop-pg] no publishable rows (total_lines=%d skipped_invalid=%d); skipping\n"
            % (len(rows), skipped_invalid)
        )
        return 0

    # Actual publish — helper guarantees dedup via ON CONFLICT → idempotent
    published = 0
    helper_failures = 0
    for env in envelopes:
        if _invoke_helper(env):
            published += 1
        else:
            helper_failures += 1

    sys.stderr.write(
        "[autoagent-loop-pg] published=%d helper_failures=%d skipped_invalid=%d "
        "first_ts=%s last_ts=%s\n"
        % (published, helper_failures, skipped_invalid, first_ts, last_ts)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
