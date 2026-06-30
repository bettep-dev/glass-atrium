#!/usr/bin/env python3
# _pg_push_wiki_cycle.py — invoked by wiki-daemon-cycle.sh after stages complete.
#
# Reads the daily wiki JSON report (env OUT_PATH) and pushes two rows:
#   * core.daemon_runs (daemon_name='wiki', run_date=CYCLE_DATE) with aggregate stats
#   * core.daemon_run_payload (FK 1:1) with the full JSON blob
#
# Both writes go through ~/.claude/scripts/_pg_dual_write_daemon.py (subprocess)
# so retry / hook_failures / fail-loud-and-skip semantics are preserved
# identically to wiki-sync.sh writes.
#
# Exit codes:
#   0 — happy path (helpers invoked; their own failures are logged but not propagated)
#   2 — env_missing OR path_missing (invalid invocation; caller must detect)
#   3 — parse_error (OUT_PATH contains non-JSON; surfaced to /tmp/wiki-daemon-loop.log)
# Helper subprocess failures still suppressed (return 0) — daemon must not block on PG transient errors.

import json
import os
import subprocess
import sys

OUT_PATH = os.environ.get("OUT_PATH", "")
CYCLE_DATE = os.environ.get("CYCLE_DATE", "")
CYCLE_STARTED_AT = os.environ.get("CYCLE_STARTED_AT", "")
HELPER = os.path.expanduser("~/.claude/scripts/_pg_dual_write_daemon.py")


def _aggregate(payload):
    deadlinks_count = (
        len(payload.get("deadlink_fixes") or [])
        + len(payload.get("deadlink_dryrun") or [])
    )
    # If dedup_proposals is a dict (current), count the list length under the proposals key
    # If a list (legacy), use it as-is — defend with 0 for None/absent/other types
    _dp = payload.get("dedup_proposals")
    if isinstance(_dp, dict):
        dedup_count = len(_dp.get("proposals") or [])
    elif isinstance(_dp, list):
        dedup_count = len(_dp)
    else:
        dedup_count = 0
    compilations = payload.get("compilations") or []
    total_ms = 0
    saw_ms = False
    for c in compilations:
        if isinstance(c, dict) and "elapsed_ms" in c:
            try:
                total_ms += int(c["elapsed_ms"])
                saw_ms = True
            except (TypeError, ValueError):
                pass
    compile_ms = total_ms if saw_ms else None
    errors = payload.get("deadlink_errors") or []
    status = "partial" if errors else "ok"
    # true_backlog is not aggregated here — it reaches PG via the verbatim JSONB
    # payload (core.daemon_run_payload.payload->'true_backlog'), the monitor's
    # read path; core.daemon_runs has no column for it.
    return {
        "deadlinks_count": deadlinks_count,
        "dedup_count": dedup_count,
        "compile_ms": compile_ms,
        "status": status,
    }


def main():
    # Invalid env vars → explicit failure (caller can detect)
    if not OUT_PATH or not CYCLE_DATE:
        print(
            "[wiki-cycle-push] SKIP reason=env_missing OUT_PATH=%r CYCLE_DATE=%r"
            % (OUT_PATH, CYCLE_DATE),
            file=sys.stderr,
            flush=True,
        )
        return 2
    # OUT_PATH file absent → block silent skip (a missing report with no
    # daemon_runs row created would surface as a false-negative alert).
    if not os.path.isfile(OUT_PATH):
        print(
            "[wiki-cycle-push] SKIP reason=path_missing path=%s" % OUT_PATH,
            file=sys.stderr,
            flush=True,
        )
        return 2
    try:
        with open(OUT_PATH, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    # JSON parse fail → emit 200B preview + error together (non-JSON content
    # must not be silently skipped).
    except json.JSONDecodeError as exc:
        preview = ""
        try:
            with open(OUT_PATH, "rb") as fh:
                preview = fh.read(200).decode("utf-8", errors="replace")
        except OSError:
            preview = "<unreadable>"
        print(
            "[wiki-cycle-push] SKIP reason=parse_error path=%s preview=%r error=%s"
            % (OUT_PATH, preview, exc),
            file=sys.stderr,
            flush=True,
        )
        return 3

    stats = _aggregate(payload)
    ended_at = payload.get("generated_at") or CYCLE_STARTED_AT

    run_env = {
        "op": "write_daemon_run",
        "args": {
            "daemon_name": "wiki",
            "run_date": CYCLE_DATE,
            "started_at": CYCLE_STARTED_AT,
            "ended_at": ended_at,
            "status": stats["status"],
            "deadlinks_count": stats["deadlinks_count"],
            "dedup_count": stats["dedup_count"],
            "compile_ms": stats["compile_ms"],
        },
    }
    payload_env = {
        "op": "write_daemon_run_payload",
        "args": {
            "daemon_name": "wiki",
            "run_date": CYCLE_DATE,
            "payload": payload,
        },
    }

    for env in (run_env, payload_env):
        try:
            subprocess.run(
                ["python3", HELPER],
                input=json.dumps(env),
                text=True,
                timeout=10,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(
                "[wiki-cycle-pg] helper invocation failed (op=%s): %s\n"
                % (env["op"], str(exc).replace('"', "'"))
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
