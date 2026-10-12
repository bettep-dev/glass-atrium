#!/usr/bin/env bats
# live-pg-ephemeral.bats — runner for the autoagent test classes whose relationship is SQL
# behaviour on real PostgreSQL, and for the doctor's canary-ledger statement (lib/ga-doctor.sh)
# over the ledger rows the daemon writes.
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
  # Proposal writer rows: the full chain, and the chain before the migration adding the link columns.
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T glass_atrium proposal_link_full || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" proposal_link_absent \
    20261005000000_add_pattern_evidence_provenance || return 1
  # Cycle-verdict templates: each test clones its own database, since the table is append-only.
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T glass_atrium cycle_verdicts_tpl || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" cycle_verdicts_absent_tpl \
    20261008000000_add_trial_ledger_and_cycle_verdicts || return 1
  # Trial-ledger templates, cloned per test (append-only); the absent one shares the cut-off migration.
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T glass_atrium trial_ledger_tpl || return 1
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T cycle_verdicts_absent_tpl \
    trial_ledger_absent_tpl || return 1
  # Spawn-manifest writer rows: the chain before the migration adding the canary exposure columns.
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" spawn_manifest_exposure_absent \
    20261009000000_add_spawn_manifest_arm_fields || return 1
  # Spool-close rows: the chain before the migration adding the loop-event count columns.
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" spool_close_counts_absent_tpl \
    20261010000000_add_loop_event_spool_close_counts || return 1
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
    TestAggregatorUpsertVisibleToIntake TestIntakeRosterRenameContract \
    TestRosterMismatchDormantOnLivePg
}

@test "the poisoned-window lookback live class runs against the migrated cluster, none skipped" {
  _assert_live_module test_poisoned_window_exclusion TestPoisonedRowExcludedFromLookback
}

@test "the spawn-manifest writer, binding-read and stored-rows-read live class runs against the migrated cluster, none skipped" {
  _assert_live_module test_manifest_ingest TestSpawnManifestWriterLivePg
}

@test "the cycle-verdict writer and walk live class runs against the migrated cluster, none skipped" {
  _assert_live_module test_all_reject_alert TestCycleVerdictsLivePg
}

@test "the trial-ledger writer live class runs against the migrated cluster, none skipped" {
  cd "${BATS_TEST_DIRNAME}/../../scripts/test" || return 1
  _assert_live_module test_pg_dual_write_trial_ledger TestTrialLedgerWriterLivePg
}

@test "the canary-ledger probe counts the windowed unstarted and foreign-hash voids the daemon writes, each with its agents" {
  local db="doctor_canary_ledger" sep=$'\x1f' unstarted_reason want
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T trial_ledger_tpl "${db}" || return 1

  # three in-window decision rows through the daemon's own writer; stdout = its unstarted reason
  # shellcheck disable=SC2154  # BATS_TEST_TMPDIR comes from bats
  run --separate-stderr env LF_DB="${db}" LF_EXPECT_PGHOST="${EPH_SOCKDIR}" \
    GA_DATA_ROOT="${BATS_TEST_TMPDIR}/data" \
    PYTHONPATH="${BATS_TEST_DIRNAME}/../../scripts:${BATS_TEST_DIRNAME}/.." python3 - <<'PY'
import os
import sys

if os.environ.get("PGHOST") != os.environ["LF_EXPECT_PGHOST"]:
    sys.exit("PGHOST is not the ephemeral cluster's socket dir — refusing to write")

import psycopg

import _pg_dual_write_daemon as helper
import daemon_cycle as daemon

# The helper names glass_atrium; this row's database is a sibling on the same cluster.
helper._connect = lambda: psycopg.connect(dbname=os.environ["LF_DB"], connect_timeout=2)
unstarted, foreign = daemon.LIVE_TRIAL.UNSTARTED_REASON, daemon.CANARY.VOID_REASON
rows = (
    (1, "glass-atrium-dev-shell", unstarted),
    (2, "glass-atrium-dev-python", unstarted),
    (3, "glass-atrium-qa-debugger", foreign),
)
for proposal_id, agent, reason in rows:
    void = {"void": {"reason": reason, "agent": agent}}
    landed = daemon._write_live_decision(helper.get_live_trial_key(proposal_id), agent, None, void)
    if landed != 1:
        sys.exit(f"{agent}: decision row did not land ({landed})")
print(unstarted)
PY
  (( status == 0 )) || { echo "${output}"; echo "${stderr}"; return 1; }
  unstarted_reason="${output}"
  [[ "${unstarted_reason}" =~ ^[a-z-]+$ ]] || { echo "unstarted reason: '${unstarted_reason}'"; return 1; }
  # a fourth agent's unstarted void older than the window — the writer takes no recorded_at
  _q_db "${db}" "INSERT INTO core.autoagent_trial_ledger (recorded_at, agent, event, actor, payload)
    VALUES (now() - interval '30 days', 'glass-atrium-dev-node', 'live-decision', 'daemon-cycle-live',
      jsonb_build_object('void', jsonb_build_object('reason', '${unstarted_reason}',
        'agent', 'glass-atrium-dev-node')))" || return 1

  # shellcheck disable=SC2016  # $1 and $2 expand in the child shell, not here
  run env PG_SOCKET="${EPH_SOCKDIR}" bash -c \
    'source "$1/lib/ga-doctor.sh" && _pg_canary_ledger_probe "$2" 14' _ "${BATS_TEST_DIRNAME}/../.." "${db}"
  (( status == 0 )) || { echo "probe exit ${status}: ${output}"; return 1; }
  want="1${sep}2${sep}0${sep}glass-atrium-qa-debugger${sep}glass-atrium-dev-python,glass-atrium-dev-shell${sep}"
  [[ "${output}" == "${want}" ]] || { echo "counted ${output//${sep}/ | }"; return 1; }
}

@test "the power check's design-effect ledger read runs against the migrated cluster, none skipped" {
  _assert_live_module test_power_check_intake DesignEffectReadLivePgTest
}

@test "the shadow stage's pre-registration ledger read runs against the migrated cluster, none skipped" {
  _assert_live_module test_shadow_engine PreRegistrationReadLivePgTest
}

@test "the A/A harness's open-state ledger read runs against the migrated cluster, none skipped" {
  _assert_live_module test_aa_harness AaOpenReadLivePgTest
}

@test "the A/A harness's join-coverage read runs against the migrated cluster, none skipped" {
  _assert_live_module test_aa_harness AaJoinCoverageReadLivePgTest
}

@test "the spool-close count writer and the sink's close read run against the migrated cluster, none skipped" {
  _assert_live_module test_aa_harness AaSpoolCloseLivePgTest
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
