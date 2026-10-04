#!/usr/bin/env bats
# live-pg-ephemeral.bats — runner for the autoagent test classes whose relationship is SQL
# behaviour on real PostgreSQL.
#
# Each such class connects only through _pg_seal.get_ephemeral_connection(), which skips outside
# this runner; here it reaches a throwaway socket-only cluster (hooks/test/lib/ephemeral-pg.bash)
# whose glass_atrium is built from monitor/prisma/migrations, so a skip is a failure. The live
# database is never contacted.

bats_require_minimum_version 1.5.0

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  # Ahead of every PG tool call: an ambient value redirects libpq past the explicit -h.
  unset PGPORT PGHOSTADDR PGSERVICE PGDATABASE PGPASSFILE
  export BATS_NO_PARALLELIZE_WITHIN_FILE=true
  local bin
  for bin in initdb pg_ctl createdb psql python3; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin}"
      return 0
    fi
  done
  if ! python3 -c 'import psycopg' >/dev/null 2>&1; then
    export EPH_SKIP="psycopg module not importable"
    return 0
  fi

  # shellcheck source-path=SCRIPTDIR source=../../hooks/test/lib/ephemeral-pg.bash
  source "${BATS_TEST_DIRNAME}/../../hooks/test/lib/ephemeral-pg.bash"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55451"
  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" eph_bootstrap || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" glass_atrium || return 1
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
  # Python 3.13+ colours unittest's status words on a tty-like stream; the asserts read them plain.
  export PYTHON_COLORS=0
  cd "${BATS_TEST_DIRNAME}" || return 1
}

# $1 module, $2.. its live classes → the module passes, nothing in it skips, each class ran ok.
_assert_live_module() {
  local module="${1}" class
  shift
  run python3 -m unittest -v "${module}"
  (( status == 0 )) || { echo "${output}"; return 1; }
  [[ "${output}" != *"... skipped"* ]] || { echo "${module}: a test skipped"; echo "${output}"; return 1; }
  for class in "$@"; do
    # per-class verdict from the summary line — the -v test description differs across Python versions
    run python3 -m unittest "${module}.${class}"
    (( status == 0 )) && [[ "${output}" == *"Ran "[1-9]* && "${output}" != *"skipped="* ]] || {
      echo "${module}.${class}: no test ran ok"
      echo "${output}"
      return 1
    }
  done
}

@test "the observation-count live classes run against the migrated cluster, none skipped" {
  _assert_live_module test_observation_count_decouple \
    TestTrueCountWithCappedSample TestApplyGateAllowlist
}

@test "the reject-learning-pattern live class runs against the migrated cluster, none skipped" {
  _assert_live_module test_pattern_lifecycle_gates TestRejectLearningPatternLivePg
}

@test "the poisoned-row aggregator live class runs against the migrated cluster, none skipped" {
  _assert_live_module test_negative_signal_triggers TestPoisonedRowsEmitNoPattern
}

@test "the pattern-intake live classes run against the migrated cluster, none skipped" {
  _assert_live_module test_pg_pattern_intake \
    TestAggregatorUpsertVisibleToIntake TestIntakeRosterRenameContract
}

@test "the poisoned-window lookback live class runs against the migrated cluster, none skipped" {
  _assert_live_module test_poisoned_window_exclusion TestPoisonedRowExcludedFromLookback
}

@test "an ambient PGHOSTADDR or PGSERVICE skips a live class with that variable named" {
  local row name
  for row in "PGHOSTADDR=127.0.0.1" "PGSERVICE=ga_seal_probe"; do
    name="${row%%=*}"
    run env "${row}" python3 -m unittest -v test_observation_count_decouple.TestApplyGateAllowlist
    (( status == 0 )) || { echo "${row}"; echo "${output}"; return 1; }
    [[ "${output}" == *"skipped '${name} set"* ]] || { echo "${row}"; echo "${output}"; return 1; }
  done
}
