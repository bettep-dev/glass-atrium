#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_* come from bats; GA_BATS_DB_CLIENTS from the loaded helper
# shellcheck disable=SC2030,SC2031  # each @test body is its own subshell, so a PATH change stays in it
# Live-DB seal (test/lib/bats-db-seal.bash): a sealed shell reaches no postgres client behind the
# seal, a sandbox seal reaches only its own socket dir, and every suite that runs a real postgres
# client is sealed — the doctor's DB checks run `psql -h /tmp`, and an ephemeral-cluster suite
# drives psycopg hooks and psql, either of which an unsealed run could send to the live server.
# Suites that reach only their own scripted client stubs are not members.

setup() {
  load 'lib/bats-db-seal'
}

# A non-comment line runs the doctor: a run_doctor call, or the launcher's doctor subcommand.
drives_doctor() {
  awk '/^[[:space:]]*#/ { next }
    /(^|[^A-Za-z0-9_])run_doctor($|[^A-Za-z0-9_])|["}] doctor($|[^A-Za-z0-9_-])/ { found = 1; exit }
    END { exit !found }' "$1"
}

# A non-comment line loads the ephemeral-cluster helper (hooks/test/lib/ephemeral-pg.bash).
loads_ephemeral_pg() {
  awk '/^[[:space:]]*#/ { next }
    /(^|[[:space:]])(source|load|\.)[[:space:]].*ephemeral-pg/ { found = 1; exit }
    END { exit !found }' "$1"
}

# A non-comment line starts the cluster through eph_pg_start, which seals the file to its socket dir.
starts_ephemeral_cluster() {
  awk '/^[[:space:]]*#/ { next }
    /(^|[^A-Za-z0-9_])eph_pg_start($|[^A-Za-z0-9_])/ { found = 1; exit }
    END { exit !found }' "$1"
}

# The setup() body holds a non-comment ga_bats_db_seal call.
seals_in_setup() {
  awk '/^setup\(\) \{$/ { inside = 1; next }
    inside && /^\}/ { exit }
    inside && /^[[:space:]]*ga_bats_db_seal[[:space:]]*$/ { found = 1 }
    END { exit !found }' "$1"
}

@test "a sealed child shell refuses every postgres client and never reaches one later on PATH" {
  local later="${BATS_TEST_TMPDIR:?}/later-bin" reached="${BATS_TEST_TMPDIR:?}/reached.log" client
  mkdir -p "${later}"
  for client in "${GA_BATS_DB_CLIENTS[@]}"; do
    # shellcheck disable=SC2016  # $0 expands when the stub runs, not here
    printf '#!/bin/sh\necho "$0" >>"%s"\n' "${reached}" >"${later}/${client}"
    chmod +x "${later}/${client}"
  done
  PATH="${later}:${PATH}"

  ga_bats_db_seal

  for client in "${GA_BATS_DB_CLIENTS[@]}"; do
    run bash -c '"$1" -h /tmp -d postgres' _ "${client}"
    [[ "${status}" -eq 2 && "${output}" == *"refused by the bats live-DB seal"* ]] || {
      printf '%s: status %s, output: %s\n' "${client}" "${status}" "${output}"
      return 1
    }
  done
  [[ ! -e "${reached}" ]] || {
    echo "a client behind the seal was reached:"
    cat -- "${reached}"
    return 1
  }
}

@test "the doctor-suite detector counts a doctor run only on a non-comment line" {
  # shellcheck disable=SC2016  # fixture rows hold suite source text, never expanded here
  local rows=(
    'launcher doctor subcommand|  run "${REAL_GA}" doctor|0'
    "run_doctor inside a child shell|  bash -c 'source lib/ga-core.sh; run_doctor'|0"
    'run_doctor named only in a comment|# run_doctor §6 binding check|1'
    'a run_doctor-prefixed helper name only|  run_doctor_sandbox|1'
  )
  local row name body want fixture="${BATS_TEST_TMPDIR:?}/suite.bats"
  for row in "${rows[@]}"; do
    IFS='|' read -r name body want <<<"${row}"
    printf '%s\n' "${body}" >"${fixture}"
    run drives_doctor "${fixture}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
  done
}

@test "the seal detector accepts only a non-comment call inside setup" {
  local rows=(
    'called in setup|setup() {\n  ga_bats_db_seal\n}|0'
    'called only in a test body|setup() {\n  true\n}\n@test "x" {\n  ga_bats_db_seal\n}|1'
    'named only in a setup comment|setup() {\n  # ga_bats_db_seal\n}|1'
  )
  local row name body want fixture="${BATS_TEST_TMPDIR:?}/suite.bats"
  for row in "${rows[@]}"; do
    IFS='|' read -r name body want <<<"${row}"
    printf '%b\n' "${body}" >"${fixture}"
    run seals_in_setup "${fixture}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
  done
}

@test "a sandbox seal runs the real client only for a call that provably targets its socket dir" {
  local real="${BATS_TEST_TMPDIR:?}/real-bin" sandbox="${BATS_TEST_TMPDIR:?}/sock"
  local reached="${BATS_TEST_TMPDIR:?}/reached.log"
  mkdir -p "${real}" "${sandbox}"
  # shellcheck disable=SC2016  # $* expands when the fake client runs, not here
  printf '#!/bin/sh\necho "$*" >>"%s"\n' "${reached}" >"${real}/psql"
  chmod +x "${real}/psql"
  PATH="${real}:${PATH}"
  ga_bats_db_seal "${sandbox}"

  # name|PGHOST (- = unset)|extra env (- = none)|want status|comma-separated client args
  local rows=(
    "explicit -h to the sandbox|-|-|0|-h,${sandbox},-d,x"
    "--host= to the sandbox|-|-|0|--host=${sandbox},-d,x"
    "attached -h to the sandbox|-|-|0|-h${sandbox},-d,x"
    "PGHOST names the sandbox, no host flag|${sandbox}|-|0|-d,x"
    "URI whose host= query is the sandbox|-|-|0|-d,postgresql://u@localhost:1/db?host=${sandbox}"
    "no host flag and PGHOST unset: the default socket|-|-|2|-d,x"
    "explicit -h /tmp over a sandbox PGHOST|${sandbox}|-|2|-h,/tmp,-d,x"
    "host flag inside a short-option cluster|${sandbox}|-|2|-qh,/tmp,-d,x"
    "connection string naming /tmp|${sandbox}|-|2|-d,host=/tmp dbname=x"
    "URI with no host= query|${sandbox}|-|2|-d,postgresql://u@localhost:5432/db"
    "PGHOSTADDR routes past the socket host|${sandbox}|PGHOSTADDR=127.0.0.1|2|-d,x"
  )
  local row name pghost extra want argstr
  local -a args env_args
  for row in "${rows[@]}"; do
    IFS='|' read -r name pghost extra want argstr <<<"${row}"
    IFS=',' read -r -a args <<<"${argstr}"
    env_args=(-u PGHOST -u PGHOSTADDR -u PGSERVICE)
    [[ "${pghost}" == "-" ]] || env_args+=(PGHOST="${pghost}")
    [[ "${extra}" == "-" ]] || env_args+=("${extra}")
    : >"${reached}"
    run env "${env_args[@]}" psql "${args[@]}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
    if [[ "${want}" -eq 0 ]]; then
      [[ -s "${reached}" ]] || {
        echo "${name}: passed the seal but never reached the real client"
        return 1
      }
    else
      [[ ! -s "${reached}" && "${output}" == *"refused by the bats live-DB seal"* ]] || {
        printf '%s: reached the real client or refused silently, output: %s\n' "${name}" "${output}"
        return 1
      }
    fi
  done
}

@test "the ephemeral-suite detectors count only a non-comment load or eph_pg_start call" {
  # shellcheck disable=SC2016  # fixture rows hold suite source text, never expanded here
  local rows=(
    'helper sourced|loads_ephemeral_pg|source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"|0'
    'helper named only in a comment|loads_ephemeral_pg|# source lib/ephemeral-pg.bash|1'
    'cluster started|starts_ephemeral_cluster|  eph_pg_start "${D}" "${S}" "${P}" "${DB}"|0'
    'eph_pg_start named only in a comment|starts_ephemeral_cluster|  # eph_pg_start seals the file|1'
    'an eph_pg_start-prefixed helper name only|starts_ephemeral_cluster|  eph_pg_start_extra|1'
  )
  local row name detector body want fixture="${BATS_TEST_TMPDIR:?}/suite.bats"
  for row in "${rows[@]}"; do
    IFS='|' read -r name detector body want <<<"${row}"
    printf '%s\n' "${body}" >"${fixture}"
    run "${detector}" "${fixture}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
  done
}

@test "every suite that runs a real postgres client applies the live-DB seal" {
  local root file members=0 unsealed=() suites="${BATS_TEST_TMPDIR:?}/suites"
  root="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  find "${root}/test" "${root}/hooks/test" "${root}/scripts/test" "${root}/autoagent/test" \
    -name '*.bats' -type f -print0 >"${suites}"
  while IFS= read -r -d '' file; do
    # this file names the doctor and the helper only in detector fixture rows
    [[ "${file}" == "${BATS_TEST_FILENAME}" ]] && continue
    if drives_doctor "${file}"; then
      members=$((members + 1))
      seals_in_setup "${file}" || unsealed+=("drives the doctor without ga_bats_db_seal in setup(): ${file#"${root}/"}")
    fi
    if loads_ephemeral_pg "${file}"; then
      members=$((members + 1))
      seals_in_setup "${file}" || starts_ephemeral_cluster "${file}" \
        || unsealed+=("loads ephemeral-pg but neither seals in setup() nor calls eph_pg_start: ${file#"${root}/"}")
    fi
  done <"${suites}"

  [[ "${members}" -gt 0 ]] || {
    echo "no suite matched either detector — the pin would pass vacuously"
    return 1
  }
  [[ "${#unsealed[@]}" -eq 0 ]] || {
    printf '%s\n' "${unsealed[@]}"
    return 1
  }
}
