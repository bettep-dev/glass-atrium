#!/usr/bin/env python3
# Outcome-record READ helper (SELECT-only) for pre-compact.sh's survival packet.
#
# Per-outcome .md files are retired; PG core.outcomes is the DB-only sink (written
# by _pg_outcome_dualwrite.py). pre-compact.sh builds its "recent outcomes" table +
# active-CID correlation from the newest rows, so this helper reads them back. It
# mirrors the dualwrite helper's connection contract EXACTLY —
# psycopg.connect("dbname=glass_atrium", connect_timeout=1), host/port-less so libpq
# resolves through PGHOST/PGPORT (the test harness redirects to an ephemeral cluster;
# production uses the default /tmp socket). It NEVER writes or issues DDL.
#
# Contract:
#   argv[1] = fetch limit (positive int; absent/invalid → DEFAULT_LIMIT). Bounds the
#             query because the shared multi-project core.outcomes has no project key
#             and unbounded history — unlike the legacy .md scan's full-corpus walk.
#   stdout  = one line per row, TAB-separated `detail<TAB>result<TAB>cid`, newest-first
#             (record_ts DESC). `detail` = the outcome summary (tabs/newlines squashed,
#             truncated); `cid` = coalesce(cid, correlation_id). This tuple ORDER
#             matches the .md-scan awk stream in pre-compact.sh so the downstream
#             formatter is source-agnostic.
#   exit    = 0 on success (including zero rows — empty stdout); a named non-zero code
#             on failure. pre-compact.sh runs this under `|| true` and falls back to
#             the legacy .md scan on empty/failed output, so the hook NEVER blocks
#             compaction regardless of the code.
#
# Loud-fail (shared-self-improve-hygiene Precondition Loud-Fail Principle): a genuine
# DB-unreachable/timeout/query error prints ONE concise stderr line so the degrade is
# visible. A missing driver (ImportError) degrades SILENTLY — it is a permanent
# deployment state, not a transient failure, so a per-compact note would be noise.

import sys

EXIT_OK = 0
EXIT_IMPORT_ERR = 3       # psycopg driver unavailable — silent degrade to .md fallback
EXIT_DB_UNREACHABLE = 5   # connect/query failed — 1-line stderr note, degrade to fallback

DEFAULT_LIMIT = 100
SUMMARY_MAXLEN = 200
STATEMENT_TIMEOUT_MS = 1000

# SELECT-only. `result::text` yields the enum label; coalesce(cid, correlation_id)
# prefers the short cid but falls back to the full correlation_id. The summary is
# squashed to a single line (TAB/newline → space) and truncated so it cannot corrupt
# the TAB-delimited stdout stream or bloat the packet. NULLS LAST keeps rows with a
# missing record_ts from sorting above real recent activity.
_READ_SQL = """
SELECT
    left(regexp_replace(coalesce(summary, ''), '[\\t\\n\\r]+', ' ', 'g'), %(maxlen)s) AS detail,
    coalesce(result::text, '') AS result,
    coalesce(cid, correlation_id, '') AS cid
FROM core.outcomes
ORDER BY record_ts DESC NULLS LAST
LIMIT %(limit)s
"""


def _parse_limit(argv):
    if len(argv) >= 2:
        try:
            n = int(argv[1])
            if n > 0:
                return n
        except (ValueError, TypeError):
            pass
    return DEFAULT_LIMIT


def main():
    limit = _parse_limit(sys.argv)

    try:
        import psycopg
    except ImportError:
        # Driver absent = this deployment has no PG read path. Silent degrade.
        return EXIT_IMPORT_ERR

    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=1) as conn:
            with conn.cursor() as cur:
                # Bound the query so a slow/locked table cannot stall compaction.
                cur.execute("SET statement_timeout = %s" % int(STATEMENT_TIMEOUT_MS))
                cur.execute(_READ_SQL, {"maxlen": SUMMARY_MAXLEN, "limit": limit})
                rows = cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — any DB failure degrades to the fallback
        sys.stderr.write(
            "[pre-compact] core.outcomes read failed (%s) — survival packet "
            "outcome sections degrade to the legacy scan\n" % type(exc).__name__
        )
        return EXIT_DB_UNREACHABLE

    out = sys.stdout
    for detail, result, cid in rows:
        # Defensive squash: the SQL already strips tabs/newlines, but guard the
        # tuple boundary regardless so a driver quirk can never split a field.
        detail = (detail or "").replace("\t", " ").replace("\n", " ")
        result = (result or "").replace("\t", " ").replace("\n", " ")
        cid = (cid or "").replace("\t", " ").replace("\n", " ")
        out.write("%s\t%s\t%s\n" % (detail, result, cid))

    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
