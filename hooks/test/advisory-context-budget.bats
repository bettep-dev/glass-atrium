#!/usr/bin/env bats
# advisory-context-budget.sh — threshold-vs-cited-onset reconciliation coverage (T17).
#
# The default per-turn occupancy threshold is reconciled to the GLOBAL_RULES "Context drift
# at 80K+" onset the same file cites: the advisory must fire as drift begins, not 4x past it.
# Fail-at-HEAD proof: with the pre-reconciliation 350k default, a 90k-token turn stays silent —
# these fixtures assert it now fires. The hook stays advisory (exit 0) at every threshold.
#
# Run via: bats hooks/test/advisory-context-budget.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic: no live DB. CONTEXT_ADVISORY_TEST_TOKENS stubs the occupancy read directly and
# CONTEXT_BUDGET_ADVISORY_CACHE_BYPASS=1 forces every call past the short-TTL read cache, so
# each fixture drives a deterministic value with zero psycopg dependency.

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-context-budget.sh"
INPUT='{"tool_name":"Agent","session_id":"t17-ctx-sess"}'

setup() {
  [[ -x "${HOOK_SH}" ]] || skip "hook not found or not executable: ${HOOK_SH}"
}

# Fire the hook with a stubbed occupancy value. $1=tokens, $2=threshold override (optional).
run_ctx() {
  local tokens="$1" thresh="${2:-}"
  if [[ -n "${thresh}" ]]; then
    run env \
      CONTEXT_ADVISORY_TEST_TOKENS="${tokens}" \
      CONTEXT_BUDGET_ADVISORY_CACHE_BYPASS=1 \
      CONTEXT_BUDGET_ADVISORY_THRESHOLD="${thresh}" \
      "${HOOK_SH}" <<<"${INPUT}"
  else
    run env \
      CONTEXT_ADVISORY_TEST_TOKENS="${tokens}" \
      CONTEXT_BUDGET_ADVISORY_CACHE_BYPASS=1 \
      "${HOOK_SH}" <<<"${INPUT}"
  fi
}

# AC2 (fail-at-HEAD core): a 90k-token turn crosses the reconciled 80k default and fires.
@test "fires at the reconciled default when occupancy exceeds the 80k onset" {
  run_ctx 90000
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"context-budget-advisory"* ]]
}

# AC1 (fail-at-HEAD): the threshold the advisory reports equals the cited 80k drift onset.
@test "reported threshold matches the cited 80k drift onset (mutual consistency)" {
  run_ctx 90000
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"80k per-turn-occupancy threshold"* ]]
  [[ "${output}" == *"80k+"* ]]
}

# AC1 (lower boundary): at-or-below the onset stays silent (<= threshold is silent).
@test "stays silent at exactly the 80k onset" {
  run_ctx 80000
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"context-budget-advisory"* ]]
}

# Boundary: one token past the onset fires.
@test "fires one token past the onset boundary" {
  run_ctx 80001
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"context-budget-advisory"* ]]
}

# AC3 (every threshold): a custom lowered threshold still fires AND stays advisory (exit 0).
@test "remains advisory (exit 0) and fires at a custom lowered threshold" {
  run_ctx 60000 50000
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"context-budget-advisory"* ]]
  [[ "${output}" == *"50k per-turn-occupancy threshold"* ]]
}

# AC3: silent path is exit 0 too (never blocks a spawn).
@test "remains advisory (exit 0) when silent below threshold" {
  run_ctx 10000
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"context-budget-advisory"* ]]
}

# Gate: a non-Agent tool exits 0 silently before any read.
@test "non-Agent tool exits 0 silently" {
  run env \
    CONTEXT_ADVISORY_TEST_TOKENS=90000 \
    CONTEXT_BUDGET_ADVISORY_CACHE_BYPASS=1 \
    "${HOOK_SH}" <<<'{"tool_name":"Read","session_id":"t17-ctx-sess"}'
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"context-budget-advisory"* ]]
}
