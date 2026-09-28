#!/usr/bin/env bats
# install-orphan-ownership.bats — bats wrapper for the Part B (ADR-2) foreign-vs-ours
# install-conflict refinement falsifiable suite. The substance lives in the sibling
# exec-harness (install-orphan-ownership-exec-harness.sh), which sources ./glass-atrium as a
# library and drives the REAL conflict helpers against ps/lsof/launchctl/kill shell-function
# stubs (kill is a bash builtin, so a function — not a PATH stub — is required to intercept
# it). This wrapper asserts the harness runs green and surfaces its per-scenario verdicts.
#
# Coverage (see the harness header for the AC mapping):
#   (A) AC-S2.5b — our-stray (relative argv `node dist/server/main.js` + cwd ${GA_ROOT}/monitor)
#                  self-heals: SIGTERM, proceed. The fixture uses the REAL relative-argv shape;
#                  an absolute-cmdline fixture would green-wash the defect.
#   (B) AC-S2.5c — a FOREIGN holder (fails argv OR cwd) fails the install loudly WITHOUT a kill.
#   (C) AC-S2.5a — a launchd-owned holder yields nothing from the orphan detector (kill path
#                  never fires) while stop_launchd bootouts/settles/proceeds — UNCHANGED.
#   (D) AC-S2.5d — an our-stray whose port never frees escalates SIGTERM->SIGKILL, then
#                  loud-fails bounded.
#
# Run via: bats test/install-orphan-ownership.bats
# Requires: bats, bash 3.2+; READ-ONLY toward the live system (all mutating commands stubbed).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
HARNESS="${GA}/test/install-orphan-ownership-exec-harness.sh"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

# The harness is deterministic + fully stubbed (read-only), and all three tests assert different
# substrings of the SAME ~6s run — so run it ONCE in setup_file and cache stdout+status. Per-test
# setup() keeps the skip guards; each @test reads the cache instead of re-running the harness.
setup_file() {
  local ga harness
  ga="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  harness="${ga}/test/install-orphan-ownership-exec-harness.sh"
  [[ -f "${harness}" && -f "${ga}/glass-atrium" ]] || return 0
  HARNESS_OUT_FILE="$(mktemp)"
  HARNESS_RC_FILE="${HARNESS_OUT_FILE}.rc"
  export HARNESS_OUT_FILE HARNESS_RC_FILE
  bash "${harness}" >"${HARNESS_OUT_FILE}" 2>&1
  echo $? >"${HARNESS_RC_FILE}"
}

teardown_file() {
  if ga_guard_path "${HARNESS_OUT_FILE:-}"; then rm -f -- "${HARNESS_OUT_FILE:?}"; fi
  if ga_guard_path "${HARNESS_RC_FILE:-}"; then rm -f -- "${HARNESS_RC_FILE:?}"; fi
}

setup() {
  [[ -f "${HARNESS}" ]] || skip "harness not found: ${HARNESS}"
  [[ -f "${GA}/glass-atrium" ]] || skip "glass-atrium launcher not found"
}

@test "Part B orphan-ownership harness passes (all scenarios green, zero fails)" {
  local output status
  output="$(cat "${HARNESS_OUT_FILE}")"
  status="$(cat "${HARNESS_RC_FILE}")"
  [ "$status" -eq 0 ]
  [[ "$output" == *"0 failed"* ]]
  [[ "$output" != *"    FAIL "* ]]
}

@test "Part B harness asserts our-stray self-heal (A) + foreign no-kill (B)" {
  local output status
  output="$(cat "${HARNESS_OUT_FILE}")"
  status="$(cat "${HARNESS_RC_FILE}")"
  [ "$status" -eq 0 ]
  [[ "$output" == *"our-stray: SIGTERM issued to the verified pid"* ]]
  [[ "$output" == *"our-stray: not mis-classified as FOREIGN"* ]]
  [[ "$output" == *"foreign(argv): NO kill issued"* ]]
  [[ "$output" == *"foreign(cwd): NO kill issued"* ]]
}

@test "Part B harness asserts launchd unchanged (C) + never-frees escalation (D)" {
  local output status
  output="$(cat "${HARNESS_OUT_FILE}")"
  status="$(cat "${HARNESS_RC_FILE}")"
  [ "$status" -eq 0 ]
  [[ "$output" == *"orphan detector yields NOTHING (kill path never fires on launchd)"* ]]
  [[ "$output" == *"bootout issued for com.glass-atrium.monitor"* ]]
  [[ "$output" == *"never-frees: SIGTERM then SIGKILL both issued to the verified pid"* ]]
}

@test "teardown_file succeeds silently when setup_file skipped before creating the output files" {
  local saved_out="${HARNESS_OUT_FILE:-}" saved_rc="${HARNESS_RC_FILE:-}"
  unset HARNESS_OUT_FILE HARNESS_RC_FILE
  run teardown_file
  HARNESS_OUT_FILE="${saved_out}"
  HARNESS_RC_FILE="${saved_rc}"
  [[ "${status}" -eq 0 ]] || {
    echo "teardown_file without output files failed (status ${status}): ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "teardown_file without output files wrote: ${output}" >&2
    return 1
  }
}

@test "harness removes its scratch dir when TMPDIR is relative" {
  local scratch="${BATS_TEST_TMPDIR:?}"
  mkdir -p "${scratch}/rel"
  run bash -c 'cd -- "$1" && TMPDIR=rel bash "$2"' _ "${scratch}" "${HARNESS}"
  [[ "${status}" -eq 0 ]] || {
    echo "harness under a relative TMPDIR failed (status ${status}): ${output}" >&2
    return 1
  }
  local leftover
  leftover="$(find "${scratch}/rel" -name 'ga-orphan.*')"
  [[ -z "${leftover}" ]] || {
    echo "harness left its scratch dir under a relative TMPDIR: ${leftover}" >&2
    return 1
  }
}
