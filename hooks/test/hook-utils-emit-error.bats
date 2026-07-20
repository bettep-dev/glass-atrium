#!/usr/bin/env bats
# hooks/hook-utils.sh — emit_error attribution suite.
#
# Pins the error-JSON "hook" field contract: an EXECUTED hook reporting through the emit_error
# wrapper is attributed with its OWN script name — never the shared library name ("hook-utils") —
# and the direct 5-param hook_emit_error path keeps the same attribution.
# Fixtures are SCRIPTS run via bash (execution path): a sourced in-process call does not
# reproduce the wrapper-frame misattribution and is not a valid regression vehicle.
#
# Run via: bats hooks/test/hook-utils-emit-error.bats
# Hermetic: fixtures live under a mktemp WORK; no live ~/.claude state is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/hooks/hook-utils.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "hook-utils.sh not found: ${REAL_LIB}"
  WORK="$(mktemp -d -t hook-utils-emit.XXXXXX)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Build an executable fixture hook: sources the real library, then runs the given call line.
# Args: $1=script_basename $2=call_line
build_fixture_hook() {
  local name="${1}" call="${2}"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -Eeuo pipefail\n'
    printf 'source %q\n' "${REAL_LIB}"
    printf '%s\n' "${call}"
  } >"${WORK}/${name}"
  chmod +x "${WORK}/${name}"
}

@test "wrapper path: executed hook is attributed with its own name, never hook-utils" {
  build_fixture_hook "fixture-wrapper-hook.sh" \
    'emit_error "TST-001" "warn" "wrapper attribution probe"'
  run --separate-stderr bash "${WORK}/fixture-wrapper-hook.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${stderr}" == *'"hook":"fixture-wrapper-hook"'* ]]
  [[ "${stderr}" != *'"hook":"hook-utils"'* ]]
}

@test "direct path: 5-param hook_emit_error keeps the executing hook's name (no regression)" {
  build_fixture_hook "fixture-direct-hook.sh" \
    'hook_emit_error "TST-002" "warn" "direct attribution probe" "a suggestion" "{\"k\":1}"'
  run --separate-stderr bash "${WORK}/fixture-direct-hook.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${stderr}" == *'"hook":"fixture-direct-hook"'* ]]
}
