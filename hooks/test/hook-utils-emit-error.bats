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
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"
# shellcheck source-path=SCRIPTDIR source=lib/no-python3.bash
source "${BATS_TEST_DIRNAME}/lib/no-python3.bash"
# shellcheck source-path=SCRIPTDIR source=lib/forced-write.bash
source "${BATS_TEST_DIRNAME}/lib/forced-write.bash"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "hook-utils.sh not found: ${REAL_LIB}"
  WORK="$(mktemp -d -t hook-utils-emit.XXXXXX)"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
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

@test "an interrupted block write still exits 2 with the error JSON once on stderr, at every write site" {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local rows row label ctx expected path_env call parsed no_jq_bin
  no_jq_bin="$(minimal_bin_without_python3 bash basename sleep)"
  : >"${WORK}/empty-stdin"
  rows=(
    'jq builds the object|{"k":1}|{"k": 1}|'
    'jq degrades an unparseable context|not-json|{}|'
    'jq absent, printf fallback|{"k":1}|{"k": 1}|PATH='"${no_jq_bin}"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r label ctx expected path_env <<<"${row}"
    printf -v call 'emit_error "TST-010" "block" "forced write probe" "a suggestion" %q; exit 2' "${ctx}"
    build_fixture_hook "fixture-forced-hook.sh" "${call}"
    run_forced_hook "${WORK}/fixture-forced-hook.sh" "${WORK}/empty-stdin" ${path_env:+"${path_env}"}
    assert_forced_block '"error_code":"TST-010"' || {
      echo "row: ${label}"
      return 1
    }
    parsed="$(printf '%s' "${output}" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["hook"], json.dumps(d["context"], sort_keys=True))')" || {
      echo "row: ${label} — stderr is not one JSON object: ${output}"
      return 1
    }
    [[ "${parsed}" == "fixture-forced-hook ${expected}" ]] || {
      echo "row: ${label} — got: ${parsed}"
      return 1
    }
  done
}
