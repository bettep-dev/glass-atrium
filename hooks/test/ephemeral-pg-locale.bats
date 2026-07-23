#!/usr/bin/env bats
# ephemeral-pg-locale.bats — pins the LC_ALL=C locale pin in lib/ephemeral-pg.bash.
# Under the daemon launchd context (ko_KR locale) PostgreSQL 18 on macOS dies with
# FATAL "postmaster became multithreaded during startup" — macOS CoreFoundation
# spawns a thread during non-C locale init (PG's own hint: set LC_ALL).
#
# HONESTY: that CoreFoundation abort is launchd-context-specific and does NOT
# reproduce in an interactive shell (verified: an UNPINNED bring-up under
# LC_ALL=ko_KR.UTF-8 succeeds interactively). So instead of reproducing the
# abort, this suite proves the pin HOLDS where it matters: the whole bring-up
# runs under a hostile ko_KR caller locale, then asserts
#   (a) the cluster comes up and answers queries,
#   (b) the daemonized postmaster's PROCESS ENV carries LC_ALL=C (the caller
#       locale never reaches a PG process — LC_ALL outranks LANG/LC_* per POSIX),
#   (c) the cluster itself is locale-independent (initdb --locale=C: datcollate/
#       datctype/lc_messages all C), so no suite depends on the machine locale.

# shellcheck source-path=SCRIPTDIR

# Postmaster env dump, one VAR=value per line. /proc on Linux (exact, NUL-split);
# BSD `ps eww` fallback on macOS (space-split — safe for the space-less pin value).
pg_process_env() {
  local pid="${1}" envdump
  if [[ -r "/proc/${pid}/environ" ]]; then
    tr '\0' '\n' <"/proc/${pid}/environ"
  else
    envdump="$(ps eww -p "${pid}")" || return 1
    tr ' ' '\n' <<<"${envdump}"
  fi
}

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
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

  export EPH_DB="glass_atrium"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55447"

  # Bring the cluster up UNDER the hostile locale — the polarity condition. The
  # subshell scopes the hostile env to the bring-up; the helper's per-command
  # LC_ALL=C pin must win for every PG child process it spawns.
  (
    export LC_ALL=ko_KR.UTF-8 LANG=ko_KR.UTF-8
    eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}"
  ) || return 1
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

@test "eph-pg locale pin: bring-up under hostile ko_KR caller locale succeeds" {
  run psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -Atc "SELECT 1"
  [[ "${status}" -eq 0 ]] && [[ "${output}" == "1" ]]
}

@test "eph-pg locale pin: postmaster process env carries LC_ALL=C, not the caller locale" {
  local pid envdump
  pid="$(head -n 1 "${EPH_DATADIR}/postmaster.pid")"
  [[ -n "${pid}" ]]
  envdump="$(pg_process_env "${pid}")"
  grep -qx 'LC_ALL=C' <<<"${envdump}"
  if grep -q '^LC_ALL=ko_KR' <<<"${envdump}"; then
    echo "caller locale leaked into the postmaster process env" >&2
    return 1
  fi
}

@test "eph-pg locale pin: cluster locale is C regardless of caller locale" {
  run psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -Atc \
    "SELECT datcollate || '|' || datctype FROM pg_database WHERE datname = current_database()"
  [[ "${status}" -eq 0 ]] && [[ "${output}" == "C|C" ]]
  run psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -Atc "SHOW lc_messages"
  [[ "${status}" -eq 0 ]] && [[ "${output}" == "C" ]]
}
