#!/usr/bin/env bats
# learning-pattern-label-fallback.bats — learning-log writers on the full migration chain and on the
# chain minus the pattern-evidence migration (new code running before its migration).
#
# Relationship: the status writer moves a row identified ↔ dormant with its reason and transition time
# where the dormant label exists, leaves the row identified where it does not, and never touches a row
# in any other status; an upsert never overwrites a stored dormant status; a keyed upsert writes the row
# on either schema, carrying its key only where the column exists.
#
# Isolation: PGHOST/PGPORT point every psycopg connection at a throwaway socket-only cluster
# (hooks/test/lib/ephemeral-pg.bash); each test clones glass_atrium from a template built from
# monitor/prisma/migrations; the live database is never contacted.

bats_require_minimum_version 1.5.0

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  export BATS_NO_PARALLELIZE_WITHIN_FILE=true
  local bin
  for bin in initdb pg_ctl createdb dropdb psql python3; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin}"
      return 0
    fi
  done
  if ! python3 -c 'import psycopg' >/dev/null 2>&1; then
    export EPH_SKIP="psycopg module not importable"
    return 0
  fi

  # shellcheck source-path=SCRIPTDIR source=lib/ephemeral-pg.bash
  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"
  unset PGHOSTADDR PGSERVICE PGDATABASE PGPASSFILE
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55459"
  export LF_HOOKS="${BATS_TEST_DIRNAME}/.."

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "eph_bootstrap" || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" chain_full || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" chain_pre_evidence \
    20261005000000_add_pattern_evidence_provenance || return 1
}

teardown_file() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    return 0
  fi
  eph_pg_stop "${EPH_DATADIR}"
}

setup() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    skip "${EPH_SKIP}"
  fi
  unset PGHOSTADDR PGSERVICE PGDATABASE PGPASSFILE
  export PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}"
}

# $1 template → a fresh glass_atrium cloned from it.
_use_db() {
  dropdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" --if-exists glass_atrium || return 1
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T "${1}" glass_atrium
}

_q() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d glass_atrium -tAqc "${1}"
}

# $1 signature, $2 status → the id of one seeded learning_log row (frequency 3).
_seed_row() {
  _q "INSERT INTO core.learning_log (discovered_date, pattern_signature, frequency, agent, status,
        approval_tier, last_updated)
      VALUES ('2026-10-01', '${1}', 3, 'glass-atrium-dev-python', '${2}', 'user-pending', now())
      RETURNING id" | head -n 1
}

# $1 mode (put <id> <status> <reason> | upsert <signature> <status> <frequency> [metric_key]) — drives
# the real writers; refuses to run unless libpq is pointed at this suite's cluster.
_drive() {
  LF_EXPECT_PGHOST="${EPH_SOCKDIR}" PYTHONPATH="${LF_HOOKS}" python3 - "$@" <<'PY'
import os
import sys

if os.environ.get("PGHOST") != os.environ["LF_EXPECT_PGHOST"]:
    sys.exit("PGHOST is not the ephemeral cluster's socket dir — refusing to write")

import _pg_learning_dualwrite as writer

mode = sys.argv[1]
if mode == "put":
    result = writer.put_learning_pattern_status(int(sys.argv[2]), sys.argv[3], sys.argv[4])
    print(result.outcome)
elif mode == "upsert":
    writer.upsert_learning_pattern(
        pattern_signature=sys.argv[2],
        discovered_date="2026-10-04",
        frequency=int(sys.argv[4]),
        agent="glass-atrium-dev-python",
        status=sys.argv[3],
        approval_tier="user-pending",
        metric_key=sys.argv[5] if len(sys.argv) > 5 else None,
    )
else:
    sys.exit("unknown mode: %s" % mode)
PY
}

@test "the chain minus the pattern-evidence migration lacks the dormant label and the metric_key column" {
  _use_db chain_pre_evidence
  run _q "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'LearningStatus' AND e.enumlabel = 'dormant'"
  [[ "${output}" == "0" ]] || { echo "dormant label count: ${output}"; return 1; }
  run _q "SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'core' AND table_name = 'learning_log' AND column_name = 'metric_key'"
  [[ "${output}" == "0" ]] || { echo "metric_key column count: ${output}"; return 1; }
}

@test "the status writer moves a row identified to dormant and back, recording each reason and transition time" {
  _use_db chain_full
  local id
  id="$(_seed_row 'dormancy-round-trip|glass-atrium-dev-python' identified)"

  run --separate-stderr _drive put "${id}" dormant "pair-failed: confirmation below baseline"
  [[ "${status}" -eq 0 && "${output}" == "moved" ]] || { echo "${output}"; echo "${stderr}"; return 1; }
  run _q "SELECT status::text || '|' || last_transition_reason || '|' || (last_transition_at IS NOT NULL)
          FROM core.learning_log WHERE id = ${id}"
  [[ "${output}" == "dormant|pair-failed: confirmation below baseline|true" ]] || { echo "${output}"; return 1; }
  local first_at
  first_at="$(_q "SELECT last_transition_at FROM core.learning_log WHERE id = ${id}")"

  run --separate-stderr _drive put "${id}" identified "new pair passed"
  [[ "${status}" -eq 0 && "${output}" == "moved" ]] || { echo "${output}"; echo "${stderr}"; return 1; }
  run _q "SELECT status::text || '|' || last_transition_reason || '|' || (last_transition_at >= '${first_at}')
          FROM core.learning_log WHERE id = ${id}"
  [[ "${output}" == "identified|new pair passed|true" ]] || { echo "${output}"; return 1; }
}

@test "the status writer leaves a row in any status outside the pair untouched" {
  _use_db chain_full
  local stored id
  for stored in proposed approved applied rejected; do
    id="$(_seed_row "outside-pair-${stored}|glass-atrium-dev-python" "${stored}")"
    run --separate-stderr _drive put "${id}" dormant "pair-failed"
    [[ "${status}" -eq 0 && "${output}" == "not_matched" ]] || { echo "${stored}: ${output}"; echo "${stderr}"; return 1; }
    run _q "SELECT status::text || '|' || (last_transition_at IS NULL) FROM core.learning_log WHERE id = ${id}"
    [[ "${output}" == "${stored}|true" ]] || { echo "${stored}: ${output}"; return 1; }
  done
}

@test "on a schema without the dormant label the status writer leaves the row identified and unstamped" {
  _use_db chain_pre_evidence
  local id
  id="$(_seed_row 'label-absent|glass-atrium-dev-python' identified)"

  run --separate-stderr _drive put "${id}" dormant "pair-failed"
  [[ "${status}" -eq 0 && "${output}" == "not_matched" ]] || { echo "${output}"; echo "${stderr}"; return 1; }
  run _q "SELECT status::text || '|' || (last_transition_at IS NULL) || '|' || (last_transition_reason IS NULL)
          FROM core.learning_log WHERE id = ${id}"
  [[ "${output}" == "identified|true|true" ]] || { echo "${output}"; return 1; }
}

@test "an upsert on a dormant row refreshes its evidence and keeps it dormant" {
  _use_db chain_full
  local id
  id="$(_seed_row 'dormant-refresh|glass-atrium-dev-python' identified)"
  run --separate-stderr _drive put "${id}" dormant "pair-failed"
  [[ "${status}" -eq 0 && "${output}" == "moved" ]] || { echo "${output}"; echo "${stderr}"; return 1; }

  run --separate-stderr _drive upsert 'dormant-refresh|glass-atrium-dev-python' identified 9
  [[ "${status}" -eq 0 ]] || { echo "${output}"; echo "${stderr}"; return 1; }
  run _q "SELECT status::text || '|' || frequency || '|' || discovered_date FROM core.learning_log WHERE id = ${id}"
  [[ "${output}" == "dormant|9|2026-10-04" ]] || { echo "${output}"; return 1; }
}

@test "a keyed upsert writes the row on either schema, carrying its key only where the column exists" {
  local row template expected
  local rows=(
    "chain_full|identified|budget_overage"
    "chain_pre_evidence|identified|"
  )
  for row in "${rows[@]}"; do
    template="${row%%|*}"
    expected="${row#*|}"
    _use_db "${template}"
    run --separate-stderr _drive upsert 'budget-overage concentration|glass-atrium-dev-python' identified 5 budget_overage
    [[ "${status}" -eq 0 ]] || { echo "${template}: ${output}"; echo "${stderr}"; return 1; }
    if [[ "${template}" == "chain_full" ]]; then
      run _q "SELECT status::text || '|' || COALESCE(metric_key::text, '') FROM core.learning_log
              WHERE pattern_signature = 'budget-overage concentration|glass-atrium-dev-python'"
    else
      run _q "SELECT status::text || '|' FROM core.learning_log
              WHERE pattern_signature = 'budget-overage concentration|glass-atrium-dev-python'"
    fi
    [[ "${output}" == "${expected}" ]] || { echo "${template}: ${output}"; return 1; }
  done
}
