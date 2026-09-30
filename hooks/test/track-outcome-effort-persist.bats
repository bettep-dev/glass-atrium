#!/usr/bin/env bats
# track-outcome-effort-persist.bats — the outcome writer's effort / has_mixed_effort columns.
#
# Relationship: a short lowercase tier token lands verbatim with its flag, anything else lands
# NULL with a NULL flag, a re-fire refreshes both, and a schema without the columns (hooks deployed
# before the migration) still writes the row. The columns come from the real migration file.
#
# Isolation: PGHOST/PGPORT point every psycopg connection at a throwaway socket-only cluster
# (hooks/test/lib/ephemeral-pg.bash); HOME is a temp dir; the live database is never contacted.

# shellcheck disable=SC2154
MIGRATION_SQL="${BATS_TEST_DIRNAME}/../../monitor/prisma/migrations/20260930000000_add_effort_to_outcomes_and_cost_events/migration.sql"

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  export BATS_NO_PARALLELIZE_WITHIN_FILE=true
  local bin ddl
  for bin in initdb pg_ctl createdb psql python3 jq; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin}"
      return 0
    fi
  done
  export EF_PSYCOPG_PP
  EF_PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  if [[ -z "${EF_PSYCOPG_PP}" ]]; then
    export EPH_SKIP="psycopg module not importable"
    return 0
  fi

  # shellcheck source-path=SCRIPTDIR source=lib/ephemeral-pg.bash
  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"
  export EPH_DB="glass_atrium"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55447"
  export EPH_HOME="${BATS_FILE_TMPDIR}/home"
  mkdir -p "${EPH_HOME}"
  export EF_PG_HELPER
  EF_PG_HELPER="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)/_pg_outcome_dualwrite.py"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
  ddl="$(eph_pg_outcomes_schema_sql)" || return 1
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q <<<"${ddl}" \
    || return 1
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q \
    -f "${MIGRATION_SQL}" || return 1
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
}

_q() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -tAqc "${1}"
}

# $1 agent · $2 record_ts · $3 effort JSON · $4 has_mixed_effort JSON ("absent" omits a key).
_mk_envelope() {
  jq -nc --arg agent "${1}" --arg ts "${2}" --arg effort "${3}" --arg mixed "${4}" '{
    outcome: ({
      timestamp: $ts, agent: $agent, task_type: "feature", result: "done",
      confidence: "high", metric_pass: "true", review_flag: "false",
      revision_count: "0", summary: "effort fixture"
    }
    + (if $effort == "absent" then {} else {effort: ($effort | fromjson)} end)
    + (if $mixed == "absent" then {} else {has_mixed_effort: ($mixed | fromjson)} end)),
    signals: [], learning_hint: null
  }'
}

_run_helper() {
  run env HOME="${EPH_HOME}" PYTHONPATH="${EF_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    bash -c 'printf "%s" "$1" | python3 "$2" 2>&1' _ "${1}" "${EF_PG_HELPER}"
}

# Prints `effort|has_mixed_effort` for the agent's row, NULL rendered as `null`.
_stored() {
  _q "SELECT coalesce(effort, 'null') || '|' || coalesce(has_mixed_effort::text, 'null')
      FROM core.outcomes WHERE agent = '${1}';"
}

@test "a tier token persists with its flag; any other value persists NULL with a NULL flag" {
  local rows row name effort mixed want agent got i=0
  rows=(
    "mixed tier token|\"xhigh\"|true|xhigh|true"
    "single tier token|\"high\"|false|high|false"
    "token over 16 chars|\"abcdefghijklmnopq\"|false|null|null"
    "uppercase token|\"HIGH\"|false|null|null"
    "non-string tier|3|true|null|null"
    "flag without a tier|absent|true|null|null"
    "neither key|absent|absent|null|null"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name effort mixed want <<<"${row}"
    i=$((i + 1))
    agent="ef-$$-row${i}"
    _run_helper "$(_mk_envelope "${agent}" "2026-09-30T10:00:0${i}.000Z" "${effort}" "${mixed}")"
    [[ "${status}" -eq 0 && "${output}" == *"pg_insert=ok"* ]] \
      || {
        echo "${name}: helper exit ${status}: ${output}"
        return 1
      }
    got="$(_stored "${agent}")"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: want '${want}', got '${got}'"
      return 1
    }
  done
}

@test "a re-fire of the same record refreshes effort and has_mixed_effort" {
  local agent="ef-$$-upsert" ts="2026-09-30T11:00:00.000Z" n
  _run_helper "$(_mk_envelope "${agent}" "${ts}" '"high"' 'false')"
  [[ "${status}" -eq 0 ]] || {
    echo "first insert: ${output}"
    return 1
  }
  _run_helper "$(_mk_envelope "${agent}" "${ts}" '"xhigh"' 'true')"
  [[ "${status}" -eq 0 ]] || {
    echo "re-fire: ${output}"
    return 1
  }
  n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")"
  [[ "${n}" == "1" && "$(_stored "${agent}")" == "xhigh|true" ]] \
    || {
      echo "rows=${n} stored='$(_stored "${agent}")'"
      return 1
    }
}

@test "a schema without the effort columns still writes the row" {
  local agent="ef-$$-premigration" st out n
  _q "ALTER TABLE core.outcomes DROP COLUMN effort, DROP COLUMN has_mixed_effort;" || return 1
  _run_helper "$(_mk_envelope "${agent}" "2026-09-30T12:00:00.000Z" '"xhigh"' 'true')"
  st="${status}" out="${output}"
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q \
    -f "${MIGRATION_SQL}" || return 1

  [[ "${st}" -eq 0 && "${out}" == *"pg_insert=ok"* ]] \
    || {
      echo "helper exit ${st}: ${out}"
      return 1
    }
  n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")"
  [[ "${n}" == "1" ]] || {
    echo "row count ${n} != 1: ${out}"
    return 1
  }
}
