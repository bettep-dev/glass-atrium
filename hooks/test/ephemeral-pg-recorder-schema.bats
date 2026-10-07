#!/usr/bin/env bats
# ephemeral-pg-recorder-schema.bats — the recorder cluster (lib/ephemeral-pg.bash →
# eph_pg_start_recorder) rejects every out-of-domain value production rejects, so a recorder
# suite running on it cannot pass a write that would be a lost outcome in production.

# shellcheck source-path=SCRIPTDIR

readonly PROBE_AGENT="eph-schema-probe"

# BATS_TEST_DIRNAME / BATS_FILE_TMPDIR are assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  local bin
  for bin in initdb pg_ctl createdb psql; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin} (PostgreSQL client/server)"
      return 0
    fi
  done
  # shellcheck source=lib/ephemeral-pg.bash
  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  eph_pg_start_recorder "${EPH_DATADIR}" "${BATS_FILE_TMPDIR}/sock" 55453
}

teardown_file() {
  [[ -n "${EPH_SKIP:-}" ]] && return 0
  # shellcheck source=lib/ephemeral-pg.bash
  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"
  eph_pg_stop "${EPH_DATADIR}"
}

setup() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    skip "${EPH_SKIP}"
  fi
}

# One transaction: an in-domain outcomes row, then $1; always rolled back → no row survives.
run_in_probe_txn() {
  run env LC_ALL=C psql -X -d glass_atrium -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO core.outcomes (record_ts, agent, task_type, result, summary)
  VALUES (now(), '${PROBE_AGENT}', 'doc', 'done', 'schema probe');
${1}
ROLLBACK;
SQL
}

@test "recorder cluster rejects each out-of-domain recorder value by its production CHECK" {
  local row name sql
  local -a rows=(
    "outcomes_evaluative_signal_check|UPDATE core.outcomes SET evaluative_signal = 2 WHERE agent = '${PROBE_AGENT}';"
    "outcomes_revision_count_check|UPDATE core.outcomes SET revision_count = -1 WHERE agent = '${PROBE_AGENT}';"
    "outcomes_metric_type_check|UPDATE core.outcomes SET metric_type = 'not-a-task-type' WHERE agent = '${PROBE_AGENT}';"
    "outcomes_attribution_source_check|UPDATE core.outcomes SET attribution_source = 'not-a-source' WHERE agent = '${PROBE_AGENT}';"
    "correction_signals_task_type_check|INSERT INTO core.correction_signals (event_ts, task_type, stage1_matched, stage2_matched, final_detected, revision_count_delta) VALUES (now(), 'not-a-task-type', false, false, false, 0);"
  )
  for row in "${rows[@]}"; do
    name="${row%%|*}"
    sql="${row#*|}"
    run_in_probe_txn "${sql}"
    [[ "${status}" -ne 0 && "${output}" == *"violates check constraint \"${name}\""* ]] \
      || {
        echo "row ${name}: status=${status}"
        echo "${output}"
        return 1
      }
  done
}

@test "recorder cluster accepts the in-domain boundary value of every recorder CHECK" {
  run_in_probe_txn "UPDATE core.outcomes SET evaluative_signal = -1, revision_count = 0,
      metric_type = 'cleanup', attribution_source = 'structuredoutput-completion'
    WHERE agent = '${PROBE_AGENT}';
  INSERT INTO core.correction_signals (event_ts, task_type, stage1_matched, stage2_matched,
      final_detected, revision_count_delta) VALUES (now(), 'cleanup', false, false, false, 0);"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
}
