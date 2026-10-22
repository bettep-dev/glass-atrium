#!/usr/bin/env bash
# Live-DB seal: every postgres client resolves to a stub first on PATH, so a run with no outer seal
# reaches no live server — the /tmp socket included. Call it FIRST in setup(): a suite's own
# scripted stub, prepended after it, still wins.
# A PATH stub rather than GA_SKIP_DB_SETUP → the doctor still runs its DB branch, and child shells
# (`run "${REAL_GA}" doctor`, `bash -c`) inherit the seal through the exported PATH.

# One declaration of the client list: ga_bats_db_seal stubs it, test/bats-db-seal.bats asserts it.
GA_BATS_DB_CLIENTS=(psql pg_isready createdb dropdb pg_dump pg_restore)

GA_BATS_DB_SEAL_CLIENT="${BASH_SOURCE[0]%/*}/bats-db-seal-client.bash"

# Args: [$1=sandbox socket dir]. No dir → every client call is refused. A dir → a call passes to
# the real client only when it provably targets that dir (bats-db-seal-client.bash), so a suite's
# own ephemeral cluster stays reachable. Inside a test the seal is per test; from setup_file it
# covers the whole file, since tests inherit the exported PATH.
ga_bats_db_seal() {
  local sandbox="${1:-}" scope_dir="${BATS_TEST_TMPDIR:-${BATS_FILE_TMPDIR:-}}"
  local seal_dir="${scope_dir:?ga_bats_db_seal runs inside setup_file, setup or a test}/db-seal-bin"
  local client real
  mkdir -p -- "${seal_dir}" || return 1
  for client in "${GA_BATS_DB_CLIENTS[@]}"; do
    real="$(command -v "${client}" 2>/dev/null || true)"
    if [[ -n "${sandbox}" && "${real}" == /* ]]; then
      printf '#!/bin/sh\nexec %q %q %q %q "$@"\n' \
        "${GA_BATS_DB_SEAL_CLIENT}" "${client}" "${real}" "${sandbox}" >"${seal_dir}/${client}" || return 1
    else
      # exit 2 = psql's own connection-failure code, the answer an unreachable server gives
      printf '#!/bin/sh\necho "%s: refused by the bats live-DB seal (test/lib/bats-db-seal.bash)" >&2\nexit 2\n' \
        "${client}" >"${seal_dir}/${client}" || return 1
    fi
    chmod +x "${seal_dir}/${client}" || return 1
  done
  export PATH="${seal_dir}:${PATH}"
}
