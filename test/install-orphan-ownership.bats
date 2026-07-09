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

setup() {
  [[ -f "${HARNESS}" ]] || skip "harness not found: ${HARNESS}"
  [[ -f "${GA}/glass-atrium" ]] || skip "glass-atrium launcher not found"
}

@test "Part B orphan-ownership harness passes (all scenarios green, zero fails)" {
  run bash "${HARNESS}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"0 failed"* ]]
  [[ "$output" != *"    FAIL "* ]]
}

@test "Part B harness asserts our-stray self-heal (A) + foreign no-kill (B)" {
  run bash "${HARNESS}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"our-stray: SIGTERM issued to the verified pid"* ]]
  [[ "$output" == *"our-stray: not mis-classified as FOREIGN"* ]]
  [[ "$output" == *"foreign(argv): NO kill issued"* ]]
  [[ "$output" == *"foreign(cwd): NO kill issued"* ]]
}

@test "Part B harness asserts launchd unchanged (C) + never-frees escalation (D)" {
  run bash "${HARNESS}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"orphan detector yields NOTHING (kill path never fires on launchd)"* ]]
  [[ "$output" == *"bootout issued for com.glass-atrium.monitor"* ]]
  [[ "$output" == *"never-frees: SIGTERM then SIGKILL both issued to the verified pid"* ]]
}
