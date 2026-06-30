#!/usr/bin/env python3
# autoagent-status-backfill.py — one-shot reconciliation of historical JSONL
# `status="applied"` entries → `core.autoagent_proposals.status='applied'`.
#
# Purpose:
#   daemon-apply.sh historically wrote file commit + JSONL but never updated DB.
#   This script closes that gap by reading accumulated JSONL files and reflecting
#   each `applied` entry into the PG row (matched by composite key).
#
# Inputs (read-only):
#   * ~/.claude/data/daemon-reports/autoagent-applied-YYYY-MM-DD.jsonl  (N files)
#     -- *.dryrun.jsonl excluded by glob design
#
# Writes (single transaction, idempotent):
#   * core.autoagent_proposals.status: 'pending' -> 'applied'
#     WHERE matched by (cycle_date, pattern_label, target_file)
#
# CLI:
#   --dry-run            print proposed UPDATE row count; rollback at end
#   --from-date YYYY-MM-DD  skip JSONL files older than this date
#   --verbose            per-row RETURNING output
#
# Connection: dbname=glass_atrium (Unix socket only — matches the other backfill
# scripts; libpq default socket dir resolves to /tmp on this host).
# Re-runs: safe — WHERE status='pending' clause makes re-application a no-op.
#
# Summary outputs:
#   * stderr: [backfill-status] tuples=N updated=M no_match=K errors=E elapsed=X.Xs
#   * file:   ~/.claude/data/daemon-reports/status-backfill-YYYY-MM-DD-HHMMSS.json
#
# Exit codes (named — a supervising wrapper branches on these; a precondition is
# never absorbed silently per shared-self-improve-hygiene Precondition Loud-Fail):
#   0 EXIT_OK             success (no per-row errors)
#   1 EXIT_ERRORS         per-row UPDATE failures -> transaction rolled back
#   2 EXIT_USAGE          CLI usage error (bad --from-date); argparse default
#   3 EXIT_NO_DRIVER      psycopg driver not installed
#   4 EXIT_NO_LIBPQ       psycopg present but libpq (PG client lib) unloadable
#   5 EXIT_DB_UNREACHABLE psycopg.connect failed -- PostgreSQL unreachable/refused

import argparse
import datetime as _dt
import glob
import json
import os
import re
import sys
import time

# Named exit codes (see header). Self-improve-hygiene Precondition Loud-Fail: an
# unmet precondition exits with a documented, branchable code + explicit stderr,
# never a silent skip or an opaque import traceback.
EXIT_OK = 0              # success (no per-row errors)
EXIT_ERRORS = 1          # per-row UPDATE failures -> transaction rolled back
EXIT_USAGE = 2           # CLI usage error (bad --from-date); argparse default
EXIT_NO_DRIVER = 3       # psycopg distribution not installed
EXIT_NO_LIBPQ = 4        # psycopg present but libpq (PG client lib) unloadable
EXIT_DB_UNREACHABLE = 5  # psycopg.connect failed -- PG unreachable/refused

try:
    import psycopg
except ImportError as exc:
    # Distinguish "driver absent" from "driver present, libpq unloadable" so the
    # operator gets a precise remediation hint instead of a generic import error.
    # A ModuleNotFoundError naming the top-level package == the psycopg
    # distribution is not installed; any other ImportError is the pq-wrapper raise
    # ("no pq wrapper available" -> the libpq shared library could not be found).
    if isinstance(exc, ModuleNotFoundError) and getattr(exc, "name", None) == "psycopg":
        sys.stderr.write(
            "[backfill-status] FATAL precondition: PostgreSQL driver 'psycopg' is "
            "not installed -- cannot reconcile core.autoagent_proposals.status. "
            "Install it (e.g. `uv pip install 'psycopg[binary]'`) and re-run. "
            "(exit %d)\n" % EXIT_NO_DRIVER
        )
        sys.exit(EXIT_NO_DRIVER)
    sys.stderr.write(
        "[backfill-status] FATAL precondition: psycopg is installed but libpq "
        "could not be loaded (%s) -- the PostgreSQL client library is unavailable. "
        "Install libpq (e.g. `brew install libpq`) or the `psycopg[binary]` wheel, "
        "then re-run. (exit %d)\n" % (exc, EXIT_NO_LIBPQ)
    )
    sys.exit(EXIT_NO_LIBPQ)


REPORTS_DIR = os.path.expanduser("~/.claude/data/daemon-reports")
INPUT_GLOB = os.path.join(REPORTS_DIR, "autoagent-applied-*.jsonl")
# Filename pattern — captures cycle_date; excludes *.dryrun.jsonl by anchored regex.
_FNAME_RE = re.compile(r"^autoagent-applied-(\d{4}-\d{2}-\d{2})\.jsonl$")

# Parameterized SQL — Korean pattern_label binds safely via psycopg parameters.
# WHERE status='pending' makes the operation idempotent (re-runs are no-ops).
_UPDATE_SQL = """
UPDATE core.autoagent_proposals
SET status = 'applied'::core."ProposalStatus"
WHERE cycle_date = %(cycle_date)s
  AND pattern_label = %(pattern_label)s
  AND target_file = %(target_file)s
  AND status = 'pending'
RETURNING id, target_agent
"""

# Dry-run preview query — same WHERE clause, no write.
_PREVIEW_SQL = """
SELECT id, target_agent, status
FROM core.autoagent_proposals
WHERE cycle_date = %(cycle_date)s
  AND pattern_label = %(pattern_label)s
  AND target_file = %(target_file)s
"""


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill autoagent_proposals.status from JSONL applied entries.")
    p.add_argument("--dry-run", action="store_true",
                   help="Preview affected rows; rollback transaction at end.")
    p.add_argument("--from-date", type=str, default=None,
                   help="Skip JSONL files dated before YYYY-MM-DD (inclusive lower bound).")
    p.add_argument("--verbose", action="store_true",
                   help="Print per-row RETURNING output to stdout.")
    return p.parse_args()


def _parse_from_date(s: str | None) -> _dt.date | None:
    if not s:
        return None
    try:
        return _dt.date.fromisoformat(s)
    except ValueError:
        sys.stderr.write("[backfill-status] invalid --from-date '%s' (expect YYYY-MM-DD)\n" % s)
        sys.exit(EXIT_USAGE)


def _collect_applied_tuples(from_date: _dt.date | None) -> tuple[list[dict], int, int]:
    """Scan JSONL files → list of (cycle_date, pattern_label, target_file) dicts.

    Returns: (tuples, files_scanned, lines_skipped)
    De-duped within source. Filenames matching `*.dryrun.jsonl` excluded by regex.
    """
    files = sorted(glob.glob(INPUT_GLOB))
    tuples: dict[tuple, dict] = {}
    files_scanned = 0
    lines_skipped = 0

    for path in files:
        fname = os.path.basename(path)
        m = _FNAME_RE.match(fname)
        if not m:
            # *.dryrun.jsonl or unexpected name -> skip silently (regex enforces glob refinement).
            continue
        cycle_str = m.group(1)
        try:
            cycle_date = _dt.date.fromisoformat(cycle_str)
        except ValueError:
            sys.stderr.write("[backfill-status] skip bad cycle in filename: %s\n" % fname)
            continue
        if from_date and cycle_date < from_date:
            continue
        files_scanned += 1

        try:
            with open(path, "r", encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, start=1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError as exc:
                        sys.stderr.write(
                            "[backfill-status] %s:%d JSON parse fail: %s\n"
                            % (fname, lineno, str(exc).replace('"', "'"))
                        )
                        lines_skipped += 1
                        continue
                    if not isinstance(obj, dict):
                        lines_skipped += 1
                        continue
                    if obj.get("status") != "applied":
                        continue
                    pattern_label = obj.get("pattern_label")
                    target_file = obj.get("target_file")
                    if not pattern_label or not target_file:
                        sys.stderr.write(
                            "[backfill-status] %s:%d applied entry missing pattern_label/target_file\n"
                            % (fname, lineno)
                        )
                        lines_skipped += 1
                        continue
                    key = (cycle_date, pattern_label, target_file)
                    if key not in tuples:
                        tuples[key] = {
                            "cycle_date": cycle_date,
                            "pattern_label": pattern_label,
                            "target_file": target_file,
                            "source_file": fname,
                            "source_line": lineno,
                        }
        except OSError as exc:
            sys.stderr.write("[backfill-status] cannot read %s: %s\n" % (path, exc))
            continue

    return list(tuples.values()), files_scanned, lines_skipped


def _apply_updates(conn, tuples: list[dict], dry_run: bool, verbose: bool) -> dict:
    """Execute UPDATE per tuple inside a single transaction.

    Returns stats dict. On any per-row error, log + continue (do NOT swallow);
    final commit/rollback decision is in main() based on error count + dry_run.
    """
    stats = {
        "tuples_processed": 0,
        "rows_updated": 0,
        "no_match": 0,
        "errors": 0,
        "updated_ids": [],
        "no_match_keys": [],
        "error_keys": [],
    }
    with conn.cursor() as cur:
        for t in tuples:
            stats["tuples_processed"] += 1
            params = {
                "cycle_date": t["cycle_date"],
                "pattern_label": t["pattern_label"],
                "target_file": t["target_file"],
            }
            try:
                if dry_run:
                    cur.execute(_PREVIEW_SQL, params)
                    rows = cur.fetchall()
                    if not rows:
                        stats["no_match"] += 1
                        stats["no_match_keys"].append({
                            "cycle_date": t["cycle_date"].isoformat(),
                            "pattern_label": t["pattern_label"],
                            "target_file": t["target_file"],
                            "source": "%s:%d" % (t["source_file"], t["source_line"]),
                        })
                        if verbose:
                            sys.stdout.write(
                                "[dry-run] NO-MATCH cycle=%s label=%s file=%s\n"
                                % (t["cycle_date"], t["pattern_label"], t["target_file"])
                            )
                        continue
                    # Preview: count rows whose current status is 'pending'
                    pending_rows = [r for r in rows if r[2] == "pending"]
                    if not pending_rows:
                        # row exists but already applied / other status -> no-op on real run
                        stats["no_match"] += 1
                        if verbose:
                            statuses = ",".join(r[2] for r in rows)
                            sys.stdout.write(
                                "[dry-run] NO-PENDING cycle=%s ids=%s statuses=%s\n"
                                % (t["cycle_date"], [r[0] for r in rows], statuses)
                            )
                        continue
                    stats["rows_updated"] += len(pending_rows)
                    for r in pending_rows:
                        stats["updated_ids"].append({"id": r[0], "target_agent": r[1]})
                        if verbose:
                            sys.stdout.write(
                                "[dry-run] WOULD-UPDATE id=%d agent=%s cycle=%s label=%s\n"
                                % (r[0], r[1], t["cycle_date"], t["pattern_label"])
                            )
                else:
                    cur.execute(_UPDATE_SQL, params)
                    rows = cur.fetchall()
                    if not rows:
                        stats["no_match"] += 1
                        stats["no_match_keys"].append({
                            "cycle_date": t["cycle_date"].isoformat(),
                            "pattern_label": t["pattern_label"],
                            "target_file": t["target_file"],
                            "source": "%s:%d" % (t["source_file"], t["source_line"]),
                        })
                        if verbose:
                            sys.stdout.write(
                                "NO-MATCH cycle=%s label=%s file=%s\n"
                                % (t["cycle_date"], t["pattern_label"], t["target_file"])
                            )
                        continue
                    stats["rows_updated"] += len(rows)
                    for r in rows:
                        stats["updated_ids"].append({"id": r[0], "target_agent": r[1]})
                        if verbose:
                            sys.stdout.write(
                                "UPDATED id=%d agent=%s cycle=%s label=%s\n"
                                % (r[0], r[1], t["cycle_date"], t["pattern_label"])
                            )
            except psycopg.Error as exc:
                # No silent swallow — log AND record. Caller decides on commit/rollback.
                stats["errors"] += 1
                stats["error_keys"].append({
                    "cycle_date": t["cycle_date"].isoformat(),
                    "pattern_label": t["pattern_label"],
                    "target_file": t["target_file"],
                    "error": "%s: %s" % (type(exc).__name__, str(exc)[:200]),
                })
                sys.stderr.write(
                    "[backfill-status] UPDATE failed cycle=%s label=%s: %s\n"
                    % (t["cycle_date"], t["pattern_label"][:40], str(exc)[:160])
                )
    return stats


def _write_summary(stats: dict, dry_run: bool, files_scanned: int, lines_skipped: int,
                   from_date: _dt.date | None, elapsed: float) -> str:
    ts = _dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    out_path = os.path.join(REPORTS_DIR, "status-backfill-%s.json" % ts)
    summary = {
        "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "mode": "dry-run" if dry_run else "apply",
        "from_date": from_date.isoformat() if from_date else None,
        "files_scanned": files_scanned,
        "lines_skipped": lines_skipped,
        "tuples_processed": stats["tuples_processed"],
        "rows_updated": stats["rows_updated"],
        "no_match": stats["no_match"],
        "errors": stats["errors"],
        "elapsed_seconds": round(elapsed, 3),
        "updated_ids": stats["updated_ids"],
        "no_match_keys": stats["no_match_keys"],
        "error_keys": stats["error_keys"],
        "cid": "2026-05-12_status-backfill_ll11",
    }
    try:
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=2, sort_keys=True)
    except OSError as exc:
        sys.stderr.write("[backfill-status] summary write failed (%s): %s\n" % (out_path, exc))
        return ""
    return out_path


def main() -> int:
    args = _parse_args()
    from_date = _parse_from_date(args.from_date)
    t0 = time.monotonic()

    tuples, files_scanned, lines_skipped = _collect_applied_tuples(from_date)
    if not tuples:
        sys.stderr.write(
            "[backfill-status] no applied tuples found (files=%d lines_skipped=%d)\n"
            % (files_scanned, lines_skipped)
        )
        # Still emit empty summary for audit trail.
        elapsed = time.monotonic() - t0
        empty_stats = {
            "tuples_processed": 0, "rows_updated": 0, "no_match": 0, "errors": 0,
            "updated_ids": [], "no_match_keys": [], "error_keys": [],
        }
        out = _write_summary(empty_stats, args.dry_run, files_scanned, lines_skipped, from_date, elapsed)
        if out:
            sys.stderr.write("[backfill-status] summary: %s\n" % out)
        return EXIT_OK

    sys.stderr.write(
        "[backfill-status] collected %d unique applied tuples from %d files (%d lines skipped)\n"
        % (len(tuples), files_scanned, lines_skipped)
    )

    # Single transaction: BEGIN implicit on first execute; COMMIT/ROLLBACK in finally.
    # autocommit=False enforces atomic semantics per C5.
    conn = None
    try:
        try:
            conn = psycopg.connect("dbname=glass_atrium", connect_timeout=5, autocommit=False)
        except psycopg.OperationalError as exc:
            # Loud precondition fail — PG unreachable / refused. No silent skip and
            # no opaque traceback. Unrelated to the per-line JSONDecodeError
            # tolerance in _collect_applied_tuples (that leniency is intentional —
            # one malformed audit line must not abort the whole reconciliation).
            sys.stderr.write(
                "[backfill-status] FATAL precondition: cannot connect to "
                "dbname=glass_atrium (%s) -- PostgreSQL unreachable; no status "
                "reconciliation performed. (exit %d)\n"
                % (str(exc).strip().replace("\n", " ")[:200], EXIT_DB_UNREACHABLE)
            )
            return EXIT_DB_UNREACHABLE
        stats = _apply_updates(conn, tuples, dry_run=args.dry_run, verbose=args.verbose)

        if args.dry_run:
            conn.rollback()
            sys.stderr.write("[backfill-status] DRY-RUN — transaction rolled back\n")
        elif stats["errors"] > 0:
            conn.rollback()
            sys.stderr.write(
                "[backfill-status] %d errors — transaction ROLLED BACK (no changes committed)\n"
                % stats["errors"]
            )
        else:
            conn.commit()
            sys.stderr.write("[backfill-status] transaction COMMITTED\n")
    finally:
        if conn is not None:
            conn.close()

    elapsed = time.monotonic() - t0
    out_path = _write_summary(stats, args.dry_run, files_scanned, lines_skipped, from_date, elapsed)

    sys.stderr.write(
        "[backfill-status] tuples=%d updated=%d no_match=%d errors=%d elapsed=%.2fs\n"
        % (stats["tuples_processed"], stats["rows_updated"], stats["no_match"],
           stats["errors"], elapsed)
    )
    if out_path:
        sys.stderr.write("[backfill-status] summary: %s\n" % out_path)

    # Exit non-zero only on errors (no_match is informational, not failure).
    return EXIT_ERRORS if stats["errors"] > 0 else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
