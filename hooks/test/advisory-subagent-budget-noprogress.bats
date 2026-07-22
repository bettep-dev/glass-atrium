#!/usr/bin/env bats
# advisory-subagent-budget.sh — no-progress mechanical brake basics (companion to the split-limit
# contract suite advisory-subagent-budget-split-limit.bats).
#
# The brake escalates a streak of consecutive exact-duplicate call signatures (same tool_name +
# tool_input = zero forward delta) over TWO independent limits: a one-shot advisory at
# SUBAGENT_NOPROGRESS_LIMIT and an exit-2 block at the higher SUBAGENT_NOPROGRESS_BLOCK_LIMIT
# (default-armed; SUBAGENT_NOPROGRESS_DISARM=1 downgrades to advisory-only). A varied loop resets
# the streak. This suite carries the coverage unique to it: the kill switch and non-integer overrides.
#
# Run via: bats hooks/test/advisory-subagent-budget-noprogress.bats
# Requires: bats, bash 3.2+, python3
#
# Hermetic: the per-agent state dir is redirected (SUBAGENT_TOOL_BUDGET_DIR) so the streak accumulates
# in a sandbox, and the advisory limit is shrunk (SUBAGENT_NOPROGRESS_LIMIT=3) so a crossing is reached
# in 3 invocations. No live DB is touched. Every assertion gates the test via `|| return 1` — a bare
# non-terminal [[ ]] would be swallowed (bats fails only on the final command).

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

# Run the hook once. Args: $1=input JSON; $2..=extra env assignments (e.g. SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3).
run_hook() {
  printf '%s' "$1" >"${SANDBOX}/input.json"
  run env \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_NOPROGRESS_LIMIT="${LIMIT}" \
    "${@:2}" \
    bash "${HOOK_SH}" <"${SANDBOX}/input.json"
}

@test "identical calls below the advisory limit neither block nor advise" {
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "call1 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "call2 expected 0, got ${status}" >&2; return 1; }
  [[ "${output}" != *"NO-PROGRESS"* ]] || { echo "unexpected advisory below the limit: ${output}" >&2; return 1; }
}

@test "reaching the advisory limit fires a one-shot advisory (exit 0, block limit not reached)" {
  # advisory=3, block-limit default (10, not reached) → advise + exit 0 at the third identical call.
  run_hook "${SAME}"
  run_hook "${SAME}"
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "call3 expected advisory + exit 0, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"NO-PROGRESS"* ]] || { echo "expected a NO-PROGRESS advisory, got: ${output}" >&2; return 1; }
}

@test "reaching the block limit blocks (exit 2, default-armed)" {
  # block-limit lowered to 3 (== advisory, clamped) → the third identical call blocks.
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "call1 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "call2 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 2 ]] || { echo "call3 expected block exit 2, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"NOPROGRESS-001"* ]] || { echo "expected NOPROGRESS-001 coded error, got: ${output}" >&2; return 1; }
  [[ "${output}" == *"3 consecutive"* ]] || { echo "expected the streak count 3 in the block error, got: ${output}" >&2; return 1; }
}

@test "a varied legitimate loop never accumulates a streak (low block limit, never blocks)" {
  # Alternating A,B,A,B,A,B resets the streak to 1 on every call, so neither the advisory nor the
  # default-armed block ever fires — even with the block limit lowered to 3.
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || { echo "SAME#1 expected 0, got ${status}" >&2; return 1; }
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || { echo "OTHER#1 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || { echo "SAME#2 expected 0, got ${status}" >&2; return 1; }
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || { echo "OTHER#2 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || { echo "SAME#3 expected 0, got ${status}" >&2; return 1; }
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || { echo "OTHER#3 expected 0, got ${status}" >&2; return 1; }
}

@test "a varied call resets the streak just before a crossing" {
  run_hook "${SAME}"
  run_hook "${SAME}"
  # The break in the streak — the next identical run is only repeat=1 again.
  run_hook "${OTHER}"
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || { echo "final SAME expected 0 (streak reset), got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" != *"NO-PROGRESS"* ]] || { echo "unexpected advisory after a reset: ${output}" >&2; return 1; }
}

@test "the kill switch disables the brake even at the block limit" {
  # Without the kill switch the third identical call would block (streak 3 == block limit);
  # SUBAGENT_TOOL_BUDGET_OFF short-circuits the hook to exit 0 before the brake runs.
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "call1 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "call2 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3 SUBAGENT_TOOL_BUDGET_OFF=1
  [[ "${status}" -eq 0 ]] || { echo "call3 expected 0 (kill switch), got ${status}: ${output}" >&2; return 1; }
}

@test "a main-session call (no agent_id) never brakes" {
  run_hook '{}' SUBAGENT_NOPROGRESS_BLOCK_LIMIT=1
  [[ "${status}" -eq 0 ]] || { echo "main-session expected 0, got ${status}: ${output}" >&2; return 1; }
}

@test "a non-integer advisory-limit override falls back to the default (no crash)" {
  LIMIT="abc"
  run_hook "${SAME}"
  [[ "${status}" -eq 0 ]] || { echo "expected fail-safe exit 0, got ${status}: ${output}" >&2; return 1; }
}

@test "a non-integer block-limit override falls back to the default (no crash, no premature block)" {
  # advisory=3, block-limit non-integer → default (10). Reaching the advisory limit advises (exit 0);
  # the invalid block limit degraded to the default, NOT to a low value, so it does not block early.
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT="xyz"
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT="xyz"
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_BLOCK_LIMIT="xyz"
  [[ "${status}" -eq 0 ]] || { echo "expected advisory + exit 0 (block degraded to default), got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"NO-PROGRESS"* ]] || { echo "expected a NO-PROGRESS advisory, got: ${output}" >&2; return 1; }
}
