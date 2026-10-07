#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_* come from bats; GA_BATS_DB_CLIENTS from the loaded helper
# Live-DB seal (test/lib/bats-db-seal.bash): a sealed shell reaches no postgres client behind the
# seal, and every suite that drives the doctor applies the seal in its setup — the doctor's DB
# checks run `psql -h /tmp`, which an unsealed run would send to the live server.

setup() {
  load 'lib/bats-db-seal'
}

# A non-comment line runs the doctor: a run_doctor call, or the launcher's doctor subcommand.
drives_doctor() {
  awk '/^[[:space:]]*#/ { next }
    /(^|[^A-Za-z0-9_])run_doctor($|[^A-Za-z0-9_])|["}] doctor($|[^A-Za-z0-9_-])/ { found = 1; exit }
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

@test "every suite that drives the doctor applies the live-DB seal in its setup" {
  local root file members=0 unsealed=() suites="${BATS_TEST_TMPDIR:?}/suites"
  root="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  find "${root}/test" "${root}/hooks/test" "${root}/scripts/test" "${root}/autoagent/test" \
    -name '*.bats' -type f -print0 >"${suites}"
  while IFS= read -r -d '' file; do
    # this file names the doctor only in detector fixture rows
    [[ "${file}" == "${BATS_TEST_FILENAME}" ]] && continue
    drives_doctor "${file}" || continue
    members=$((members + 1))
    seals_in_setup "${file}" || unsealed+=("${file#"${root}/"}")
  done <"${suites}"

  [[ "${members}" -gt 0 ]] || {
    echo "no suite matched the doctor detector — the pin would pass vacuously"
    return 1
  }
  [[ "${#unsealed[@]}" -eq 0 ]] || {
    printf 'drives the doctor without ga_bats_db_seal in setup(): %s\n' "${unsealed[@]}"
    return 1
  }
}
