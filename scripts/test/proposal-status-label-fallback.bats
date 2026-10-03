#!/usr/bin/env bats
# proposal-status-label-fallback.bats — proposal status writes on a schema with and without
# the `unadjudicated` ProposalStatus label (new code running before its migration).
#
# Relationship: a write requesting `unadjudicated` persists it where the label exists and
# persists `rejected` where it does not; every other status persists as requested; the
# shared label probe answers present / absent, and unknown when the query cannot run.
#
# Isolation: PGHOST/PGPORT point every psycopg connection at a throwaway socket-only cluster
# (hooks/test/lib/ephemeral-pg.bash); each test clones glass_atrium from a template built
# from monitor/prisma/migrations; the live database is never contacted.

bats_require_minimum_version 1.5.0

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  export BATS_NO_PARALLELIZE_WITHIN_FILE=true
  local bin migration
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

  # shellcheck source-path=SCRIPTDIR source=../../hooks/test/lib/ephemeral-pg.bash
  source "${BATS_TEST_DIRNAME}/../../hooks/test/lib/ephemeral-pg.bash"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55449"
  export LF_SCRIPTS="${BATS_TEST_DIRNAME}/.."
  local migrations="${BATS_TEST_DIRNAME}/../../monitor/prisma/migrations"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "eph_bootstrap" || return 1
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" label_present || return 1
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" label_absent || return 1
  for migration in "${migrations}"/*/migration.sql; do
    psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d label_present -v ON_ERROR_STOP=1 -q \
      -f "${migration}" >/dev/null || return 1
    [[ "${migration}" == *_add_proposal_status_unadjudicated/migration.sql ]] && continue
    psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d label_absent -v ON_ERROR_STOP=1 -q \
      -f "${migration}" >/dev/null || return 1
  done
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

# $1 mode (push <status> | probe | probe-closed) — drives the real helper; refuses to run
# unless libpq is pointed at this suite's cluster.
_drive() {
  LF_EXPECT_PGHOST="${EPH_SOCKDIR}" PYTHONPATH="${LF_SCRIPTS}" python3 - "$@" <<'PY'
import os
import sys

if os.environ.get("PGHOST") != os.environ["LF_EXPECT_PGHOST"]:
    sys.exit("PGHOST is not the ephemeral cluster's socket dir — refusing to write")

import _pg_dual_write_daemon as helper

mode = sys.argv[1]
if mode == "push":
    helper.write_autoagent_proposal(
        cycle_date="2026-10-03",
        pattern_label="label-fallback",
        target_file="agents/glass-atrium-dev-python.md",
        target_agent="glass-atrium-dev-python",
        classification="apply",
        rationale="superseded by a later run in the same cycle",
        haiku_status="ok",
        approval_tier="auto",
        status=sys.argv[2],
        proposed_diff="",
        cost_guard_state="ok",
        source_file="autoagent-2026-10-03.json",
        source_file_mtime=0,
    )
elif mode == "probe":
    with helper._connect() as conn:
        print(helper.get_proposal_status_label_state(conn))
elif mode == "probe-closed":
    conn = helper._connect()
    conn.close()
    print(helper.get_proposal_status_label_state(conn))
PY
}

@test "a status push persists as requested, and unadjudicated falls back to rejected only where the label is absent" {
  local rows=(
    "label_present unadjudicated unadjudicated"
    "label_absent unadjudicated rejected"
    "label_absent pending pending"
  )
  local row template requested expected
  for row in "${rows[@]}"; do
    read -r template requested expected <<<"${row}"
    _use_db "${template}" || { echo "${row}: clone failed"; return 1; }
    run _drive push "${requested}"
    [[ "${status}" -eq 0 ]] || { echo "${row}: ${output}"; return 1; }
    [[ "$(_q "SELECT status FROM core.autoagent_proposals WHERE pattern_label = 'label-fallback'")" == "${expected}" ]] \
      || { echo "${row}: stored $(_q "SELECT status FROM core.autoagent_proposals")"; return 1; }
  done
}

@test "the label probe answers present, absent, and unknown when the query cannot run" {
  local rows=(
    "label_present probe present"
    "label_absent probe absent"
    "label_present probe-closed unknown"
  )
  local row template mode expected
  for row in "${rows[@]}"; do
    read -r template mode expected <<<"${row}"
    _use_db "${template}" || { echo "${row}: clone failed"; return 1; }
    run --separate-stderr _drive "${mode}"
    [[ "${status}" -eq 0 ]] || { echo "${row}: ${output} ${stderr}"; return 1; }
    [[ "${output}" == "${expected}" ]] || { echo "${row}: answered ${output}"; return 1; }
  done
}
