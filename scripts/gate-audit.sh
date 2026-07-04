#!/usr/bin/env bash
# gate-audit.sh — Plan Direction Verification Gate post-hoc audit (measurement tool).
#
# Purpose (measurement instrument):
#   Post-hoc audit of core.outcomes to check whether the complex-plan workflow's
#   stage-2 "verification team (qa-code-reviewer + DEV)" gate actually ran per CID.
#   Among CID groups where intel-planner participated or task_type=plan, flag any
#   group with no qa-code-reviewer record on the same CID as a "gate miss". Also
#   record DEV participation (the hard gate).
#
# This script is measurement-only — it changes no state (read-only SELECT).
#   monitor/src/server/routes/improvement.ts is left untouched (avoids dirtying other sessions).
#
# CID identification:
#   coalesce(cid, correlation_id) — outcome-record prefers cid, falling back to
#   correlation_id (the schema carries both). With 97.5% single-agent chains,
#   most groups have one record, but only multi-agent CIDs are gate targets.
#
# PG access (socket-only invariant):
#   psql "dbname=glass_atrium" — Unix socket only. NEVER -h / -p / host= / 127.0.0.1.
#   Precedent: _pg_dual_write.py header (socket-only invariant).
#
# Usage:
#   gate-audit.sh [--days N] [--format table|csv|json]
#     --days N    lookback window (default 14). record_ts >= now() - N days.
#     --format    output format (default table). csv/json for pipeline ingestion.
#
# Output:
#   list of gate-miss CIDs + summary counts. exit 0 even with 0 misses (normal = audit pass).
#   PG unreachable / psql missing → explicit stderr error + exit 1 (a measurement tool
#   loud-fails — it is not a hook, so no fail-open. Silencing a measurement failure
#   would produce a false "pass").

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="gate-audit"

# Default parameters.
days=14
out_format="table"

usage() {
  cat <<'USAGE'
Usage: gate-audit.sh [--days N] [--format table|csv|json]

  --days N      Lookback window in days (default 14).
  --format FMT  Output format: table (default) | csv | json.
  -h, --help    Show this help.

Audits core.outcomes for plan-CIDs whose verification gate did not run
(no co-occurring qa-code-reviewer for a CID that has a intel-planner/plan record).
Read-only. Exits 1 on PG access failure (loud-fail — measurement tool).
USAGE
}

# Argument parsing — explicit branching (getopts does not support long options).
while [[ $# -gt 0 ]]; do
  case "${1}" in
    --days)
      days="${2:-}"
      shift 2 || true
      ;;
    --format)
      out_format="${2:-}"
      shift 2 || true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf '[%s] unknown argument: %s\n' "${SCRIPT_NAME}" "${1}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Validate days is an integer.
if [[ ! "${days}" =~ ^[0-9]+$ ]]; then
  printf '[%s] --days must be a non-negative integer (got: %s)\n' "${SCRIPT_NAME}" "${days}" >&2
  exit 2
fi

# Validate format against the whitelist.
case "${out_format}" in
  table | csv | json) ;;
  *)
    printf '[%s] --format must be one of: table, csv, json (got: %s)\n' "${SCRIPT_NAME}" "${out_format}" >&2
    exit 2
    ;;
esac

# psql missing → cannot measure. loud-fail (silence risks a false pass).
if ! command -v psql >/dev/null 2>&1; then
  printf '[%s] psql not found on PATH — cannot audit core.outcomes\n' "${SCRIPT_NAME}" >&2
  exit 1
fi

# Audit SQL — read-only SELECT.
#   Target groups: CIDs with intel-planner participation OR task_type=plan (plan-workflow start signal).
#   Miss determination: no qa-code-reviewer record in that group → gate did not run.
#   DEV participation (hard gate): flag presence of 1+ of the DEV-set agents.
#   Single-agent chains (n=1) are not gate targets (intel-planner alone) — not excluded,
#   marked has_reviewer=false with a separate dev_present column for context.
#
# DEV-set: the canonical DEV agents from core-compliance-matrix.md Scope Legend.
# AUTO-SYNCED: the two inline SQL DEV-set lists below (AUDIT_SQL + SUMMARY_SQL) are kept byte-identical
#   and in sync with the scope-dev.md DEV roster (the DEV-only SoT — agent-registry.json dropped its
#   scope field and can no longer name the DEV subset) by agent_lifecycle: the add/delete transaction
#   + `python -m agent_lifecycle sync-gate-roster`. Manual editing is NO LONGER the sync path — do NOT
#   hand-edit the lists.
read -r -d '' AUDIT_SQL <<SQL || true
WITH grp AS (
  SELECT coalesce(cid, correlation_id) AS gid,
         bool_or(agent = 'glass-atrium-intel-planner') AS has_planner,
         bool_or(task_type = 'plan') AS has_plan_task,
         bool_or(agent = 'glass-atrium-qa-code-reviewer') AS has_reviewer,
         bool_or(agent IN (
           'glass-atrium-dev-front','glass-atrium-dev-react','glass-atrium-dev-angular','glass-atrium-dev-gsap','glass-atrium-dev-android',
           'glass-atrium-dev-nestjs','glass-atrium-dev-node','glass-atrium-dev-python','glass-atrium-dev-db','glass-atrium-dev-rag',
           'glass-atrium-dev-animator','glass-atrium-dev-shell','glass-atrium-dev-swift'
         )) AS has_dev,
         count(*) AS n,
         min(record_ts) AS first_ts
  FROM core.outcomes
  WHERE coalesce(cid, correlation_id) IS NOT NULL
    AND record_ts >= now() - (interval '1 day' * ${days})
  GROUP BY coalesce(cid, correlation_id)
)
SELECT gid,
       to_char(first_ts, 'YYYY-MM-DD HH24:MI') AS first_seen,
       n AS records,
       has_dev AS dev_present
FROM grp
WHERE (has_planner OR has_plan_task)
  AND NOT has_reviewer
ORDER BY first_ts DESC;
SQL

# Summary-count SQL — computes denominator/numerator together (all plan-CIDs vs gate-not-run).
read -r -d '' SUMMARY_SQL <<SQL || true
WITH grp AS (
  SELECT coalesce(cid, correlation_id) AS gid,
         bool_or(agent = 'glass-atrium-intel-planner') AS has_planner,
         bool_or(task_type = 'plan') AS has_plan_task,
         bool_or(agent = 'glass-atrium-qa-code-reviewer') AS has_reviewer,
         bool_or(agent IN (
           'glass-atrium-dev-front','glass-atrium-dev-react','glass-atrium-dev-angular','glass-atrium-dev-gsap','glass-atrium-dev-android',
           'glass-atrium-dev-nestjs','glass-atrium-dev-node','glass-atrium-dev-python','glass-atrium-dev-db','glass-atrium-dev-rag',
           'glass-atrium-dev-animator','glass-atrium-dev-shell','glass-atrium-dev-swift'
         )) AS has_dev
  FROM core.outcomes
  WHERE coalesce(cid, correlation_id) IS NOT NULL
    AND record_ts >= now() - (interval '1 day' * ${days})
  GROUP BY coalesce(cid, correlation_id)
)
SELECT count(*) FILTER (WHERE has_planner OR has_plan_task) AS plan_cids,
       count(*) FILTER (WHERE (has_planner OR has_plan_task) AND has_reviewer) AS gated,
       count(*) FILTER (WHERE (has_planner OR has_plan_task) AND has_reviewer AND has_dev) AS full_team
FROM grp;
SQL

# Check PG reachability once — loud-fail on failure.
if ! psql "dbname=glass_atrium" -c 'SELECT 1' >/dev/null 2>&1; then
  printf '[%s] cannot reach PG (dbname=glass_atrium via Unix socket) — is postgres running?\n' "${SCRIPT_NAME}" >&2
  exit 1
fi

# Branch by output format.
case "${out_format}" in
  csv)
    # CSV — for pipeline ingestion (includes header).
    psql "dbname=glass_atrium" --csv -c "${AUDIT_SQL}"
    ;;
  json)
    # JSON array — row_to_json aggregation.
    psql "dbname=glass_atrium" -t -A -c "
      SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
      FROM ( ${AUDIT_SQL%;} ) t;"
    ;;
  table)
    # Human-readable table + summary line.
    printf '=== Gate Audit — plan-CIDs missing verification gate (last %s days) ===\n\n' "${days}"
    psql "dbname=glass_atrium" -c "${AUDIT_SQL}"

    printf '\n--- Summary ---\n'
    # Extract summary figures — t -A yields a single pipe-delimited line.
    summary_line=""
    summary_line="$(psql "dbname=glass_atrium" -t -A -F'|' -c "${SUMMARY_SQL}" 2>/dev/null)" || summary_line=""
    if [[ -n "${summary_line}" ]]; then
      plan_cids="${summary_line%%|*}"
      rest="${summary_line#*|}"
      gated="${rest%%|*}"
      full_team="${rest##*|}"
      # Empty-value guard (grep -c zero-match-trap class — empty cell → 0).
      [[ -z "${plan_cids}" ]] && plan_cids=0
      [[ -z "${gated}" ]] && gated=0
      [[ -z "${full_team}" ]] && full_team=0
      missing=$((plan_cids - gated))
      printf 'plan-CIDs total      : %s\n' "${plan_cids}"
      printf 'gate ran (reviewer)  : %s\n' "${gated}"
      printf 'full team (+DEV)     : %s\n' "${full_team}"
      printf 'gate MISSING         : %s\n' "${missing}"
    else
      printf '(summary unavailable)\n'
    fi
    ;;
  *)
    # Unreachable — out_format was whitelist-validated above (defensive default).
    printf '[%s] internal: unhandled format %s\n' "${SCRIPT_NAME}" "${out_format}" >&2
    exit 2
    ;;
esac

exit 0
