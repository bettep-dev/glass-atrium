#!/usr/bin/env bats
# advisory-subagent-budget.sh — no-progress mechanical brake coverage.
#
# Proves the brake on top of the tool_use advisory: N consecutive exact-duplicate
# call signatures (same tool_name + tool_input) escalate to a block, while a varied
# loop resets the streak and is never affected. Advisory-first: the brake WARNS by
# default and only exits 2 when the burn-in flag SUBAGENT_NOPROGRESS_BLOCK=1 arms it.
#
# Run via: bats hooks/test/advisory-subagent-budget-noprogress.bats
# Requires: bats, bash 3.2+, python3
#
# Hermetic: the per-agent state dir is redirected (SUBAGENT_TOOL_BUDGET_DIR) so the
# streak accumulates in a sandbox, and the limit is shrunk (SUBAGENT_NOPROGRESS_LIMIT=3)
# so a crossing is reached in 3 invocations. No live DB is touched.

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-subagent-budget.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required for the call signature"
  SANDBOX="$(mktemp -d -t ga-noprogress-bats.XXXXXX)"
  BUDGET_DIR="${SANDBOX}/counters"
  LIMIT=3
  mkdir -p "${BUDGET_DIR}"
  SAME='{"agent_id":"agent-a","tool_name":"Read","tool_input":{"file_path":"/x"}}'
  OTHER='{"agent_id":"agent-a","tool_name":"Read","tool_input":{"file_path":"/y"}}'
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Run the hook once. Args: $1=input JSON; $2..=extra env assignments (e.g. SUBAGENT_NOPROGRESS_BLOCK=1).
run_hook() {
  printf '%s' "$1" >"${SANDBOX}/input.json"
  run env \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_NOPROGRESS_LIMIT="${LIMIT}" \
    "${@:2}" \
    bash "${HOOK_SH}" <"${SANDBOX}/input.json"
}

@test "identical calls below the limit neither block nor advise" {
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]]
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"NO-PROGRESS"* ]]
}

@test "reaching the limit fires a one-shot advisory (unarmed default, exit 0)" {
  run_hook "${SAME}"
  run_hook "${SAME}"
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"NO-PROGRESS"* ]]
}

@test "reaching the limit blocks (exit 2) when the burn-in flag is armed" {
  run_hook "${SAME}"
  run_hook "${SAME}"
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"3 consecutive"* ]]
}

@test "a varied legitimate loop never accumulates a streak (armed, no block)" {
  # Alternating signatures A,B,A,B,A,B — the streak resets to 1 on every call.
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "a varied call resets the streak just before a crossing" {
  run_hook "${SAME}"
  run_hook "${SAME}"
  # The break in the streak — next identical run is only repeat=1 again.
  run_hook "${OTHER}"
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"NO-PROGRESS"* ]]
}

@test "kill switch disables the brake even past the limit while armed" {
  run_hook "${SAME}"
  run_hook "${SAME}"
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK=1 SUBAGENT_TOOL_BUDGET_OFF=1
  [[ "${status}" -eq 0 ]]
}

@test "a main-session call (no agent_id) never brakes" {
  run_hook '{}' SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "a non-integer limit override falls back to the default (no crash)" {
  LIMIT="abc"
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]]
}
