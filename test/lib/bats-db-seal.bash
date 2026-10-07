#!/usr/bin/env bash
# Live-DB seal for suites that drive the doctor: every postgres client resolves to a refusing stub
# first on PATH, so a run with no outer seal reaches no server — the live /tmp socket included.
# Call it FIRST in setup(): a suite's own scripted stub, prepended after it, still wins.
# A PATH stub rather than GA_SKIP_DB_SETUP → the doctor still runs its DB branch, and child shells
# (`run "${REAL_GA}" doctor`, `bash -c`) inherit the seal through the exported PATH.

# One declaration of the client list: ga_bats_db_seal stubs it, test/bats-db-seal.bats asserts it.
GA_BATS_DB_CLIENTS=(psql pg_isready createdb dropdb pg_dump pg_restore)

ga_bats_db_seal() {
  local seal_dir="${BATS_TEST_TMPDIR:?ga_bats_db_seal runs inside setup or a test}/db-seal-bin"
  local client
  mkdir -p -- "${seal_dir}" || return 1
  for client in "${GA_BATS_DB_CLIENTS[@]}"; do
    # exit 2 = psql's own connection-failure code, the answer an unreachable server gives
    printf '#!/bin/sh\necho "%s: refused by the bats live-DB seal (test/lib/bats-db-seal.bash)" >&2\nexit 2\n' \
      "${client}" >"${seal_dir}/${client}" || return 1
    chmod +x "${seal_dir}/${client}" || return 1
  done
  export PATH="${seal_dir}:${PATH}"
}
