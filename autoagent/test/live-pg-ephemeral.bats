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
  # Proposal writer rows: the full chain, and the chain minus the migration adding the link columns.
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T glass_atrium proposal_link_full || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" proposal_link_absent \
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

# $1 database, $2 SQL → tuples-only output.
_q_db() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${1}" -tAqc "${2}"
}

# $1 database → id of one seeded core.learning_log row.
_seed_pattern() {
  _q_db "${1}" "INSERT INTO core.learning_log (discovered_date, pattern_signature, frequency, agent,
      status, approval_tier, last_updated)
    VALUES ('2026-10-04', 'pattern-link|glass-atrium-dev-python', 3, 'glass-atrium-dev-python',
      'identified', 'user-pending', now())
    RETURNING id" | head -n 1
}

# $1 database, $2 learning_log id → one proposal pushed through the real helper with its pattern
# link and input version; refuses to run unless libpq is pointed at this suite's cluster.
_push_linked_proposal() {
  LF_DB="${1}" LF_EXPECT_PGHOST="${EPH_SOCKDIR}" PYTHONPATH="${BATS_TEST_DIRNAME}/../../scripts" \
    python3 - "${2}" <<'PY'
import os
import sys

if os.environ.get("PGHOST") != os.environ["LF_EXPECT_PGHOST"]:
    sys.exit("PGHOST is not the ephemeral cluster's socket dir — refusing to write")

import psycopg

import _pg_dual_write_daemon as helper

# The helper names glass_atrium; this row's database is a sibling on the same cluster.
helper._connect = lambda: psycopg.connect(dbname=os.environ["LF_DB"], connect_timeout=2)
helper.write_autoagent_proposal(
    cycle_date="2026-10-05",
    pattern_label="pattern-link",
    target_file="agents/glass-atrium-dev-python.md",
    target_agent="glass-atrium-dev-python",
    classification="apply",
    rationale="pattern recurred across 3 outcomes",
    haiku_status="ok",
    approval_tier="auto",
    status="pending",
    proposed_diff="",
    cost_guard_state="ok",
    source_file="autoagent-2026-10-05.json",
    source_file_mtime=0,
    learning_pattern_id=int(sys.argv[1]),
    generator_input_version="gen-inputs-1",
)
PY
}

@test "a proposal push stores its pattern link and input version on the migrated schema" {
  local id
  id="$(_seed_pattern proposal_link_full)"
  [[ "${id}" =~ ^[0-9]+$ ]] || { echo "seed returned: ${id}"; return 1; }

  run --separate-stderr _push_linked_proposal proposal_link_full "${id}"
  (( status == 0 )) || { echo "${output}"; echo "${stderr}"; return 1; }

  run _q_db proposal_link_full "SELECT learning_pattern_id || '|' || generator_input_version
    FROM core.autoagent_proposals WHERE pattern_label = 'pattern-link'"
  [[ "${output}" == "${id}|gen-inputs-1" ]] || { echo "${output}"; return 1; }
}

@test "a proposal push on a schema without the link columns still writes the row and names the migration" {
  local id
  run _q_db proposal_link_absent "SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'core' AND table_name = 'autoagent_proposals'
      AND column_name IN ('learning_pattern_id', 'generator_input_version')"
  [[ "${output}" == "0" ]] || { echo "link columns present: ${output}"; return 1; }
  id="$(_seed_pattern proposal_link_absent)"
  [[ "${id}" =~ ^[0-9]+$ ]] || { echo "seed returned: ${id}"; return 1; }

  run --separate-stderr _push_linked_proposal proposal_link_absent "${id}"
  (( status == 0 )) || { echo "${output}"; echo "${stderr}"; return 1; }
  [[ "${stderr}" == *"DEGRADED"*"20261005000000_add_pattern_evidence_provenance"* ]] || {
    echo "${stderr}"
    return 1
  }

  run _q_db proposal_link_absent \
    "SELECT count(*) FROM core.autoagent_proposals WHERE pattern_label = 'pattern-link'"
  [[ "${output}" == "1" ]] || { echo "${output}"; return 1; }
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

@test "the spawn-manifest writer live class runs against the migrated cluster, none skipped" {
  _assert_live_module test_manifest_ingest TestSpawnManifestWriterLivePg
}

@test "the pattern-metric window read runs against the migrated cluster, none skipped" {
  cd "${BATS_TEST_DIRNAME}/../../hooks/test" || return 1
  _assert_live_module test_pattern_metric TestPatternFloorReadLivePg
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
