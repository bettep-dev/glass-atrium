#!/usr/bin/env bats
# audit-inert-assert.bats — pins how scripts/audit-inert-assert.sh classifies a bare `[[ ]]` line in a
# Bats @test body: MID-BODY (finding), TERMINAL (exempt) or NESTED (abstention), plus the quote-span
# carry that keeps a multi-line `bash -c '...'` string from being scored as assertions.
#
# Every fixture is written into a per-test temp tree — no repository file is read as a fixture.

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME is set by the bats runtime
AUDITOR="${BATS_TEST_DIRNAME}/../audit-inert-assert.sh"
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../lib/path-guard.sh"

setup() {
  IA_TMP="$(mktemp -d -t audit-inert.XXXXXX)"
}

teardown() {
  if ga_guard_path "${IA_TMP:-}"; then rm -rf -- "${IA_TMP:?}"; fi
}

# Writes stdin into a fixture file and runs the auditor on it alone. Bats rewrites every column-0
# `@test` line in this file, heredocs included, so fixtures spell it `%%test%%`.
audit_fixture() {
  sed 's/^%%test%%/@test/' >"${IA_TMP}/fixture.bats"
  run bash "${AUDITOR}" --path "${IA_TMP}/fixture.bats"
}

@test "a bare [[ ]] followed by another statement is reported as MID-BODY at its own line" {
  audit_fixture <<'BATS'
%%test%% "t" {
  run foo
  [[ "${output}" == x ]]
  echo after
}
BATS
  [[ "${status}" -eq 0 && "${output}" == *"mid_body=1 nested=0 unscanned=0 tests_scanned=1"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"MID_BODY"*"fixture.bats:3:"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "a bare [[ ]] that is the body's last statement is exempt as TERMINAL" {
  audit_fixture <<'BATS'
%%test%% "t" {
  run foo
  # trailing comment and blank lines are not statements

  [[ "${output}" == x ]]

}
BATS
  [[ "${status}" -eq 0 && "${output}" == *"mid_body=0 nested=0 unscanned=0 tests_scanned=1"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" != *"MID_BODY"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "the guarded [[ ]] || { ...; return 1; } form is exempt, single-line and multi-line" {
  audit_fixture <<'BATS'
%%test%% "t" {
  run foo
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == x ]] || {
    echo "${output}"
    return 1
  }
  echo after
}
BATS
  [[ "${status}" -eq 0 && "${output}" == *"mid_body=0 nested=0 unscanned=0 tests_scanned=1"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "a bare [[ ]] inside if or for counts in nested=, never as a finding" {
  audit_fixture <<'BATS'
%%test%% "t" {
  if true; then
    [[ a == a ]]
  fi
  for row in a b; do
    [[ "${row}" == a ]]
  done
  echo after
}
BATS
  [[ "${status}" -eq 0 && "${output}" == *"mid_body=0 nested=2 unscanned=0 tests_scanned=1"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" != *"MID_BODY"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "lines inside a multi-line bash -c string are not scored, and scoring resumes after it closes" {
  audit_fixture <<'BATS'
%%test%% "t" {
  run bash -c '
    set -e
    [[ -f /nonexistent ]]
    echo y
}
  '
  [[ "${output}" == y ]]
  echo after
}
BATS
  # The column-0 `}` inside the string must not close the body, and only line 8 is a real finding.
  [[ "${status}" -eq 0 && "${output}" == *"mid_body=1 nested=0 unscanned=0 tests_scanned=1"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"fixture.bats:8:"* && "${output}" != *"fixture.bats:4:"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "findings still exit 0 on --path and scope runs, test/ included; only --strict blocks" {
  local dir
  for dir in hooks/test scripts/test autoagent/test test; do
    mkdir -p "${IA_TMP}/repo/${dir}"
  done
  printf '@test "t" {\n  [[ a == b ]]\n  echo after\n}\n' >"${IA_TMP}/repo/test/dirty.bats"

  run bash "${AUDITOR}" --path "${IA_TMP}/repo/test/dirty.bats"
  [[ "${status}" -eq 0 && "${output}" == *"mid_body=1"* ]] || {
    echo "path run: ${output}"
    return 1
  }
  run bash "${AUDITOR}" --root "${IA_TMP}/repo"
  [[ "${status}" -eq 0 && "${output}" == *"test/dirty.bats:2:"* && "${output}" == *"mid_body=1"* ]] || {
    echo "scope run: ${output}"
    return 1
  }
  run bash "${AUDITOR}" --strict --root "${IA_TMP}/repo"
  [[ "${status}" -eq 1 ]] || {
    echo "strict run: ${status} ${output}"
    return 1
  }
}
