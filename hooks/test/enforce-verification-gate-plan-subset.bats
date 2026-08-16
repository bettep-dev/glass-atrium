#!/usr/bin/env bats
# enforce-verification-gate-plan-subset.bats — pins the C3-H [PLAN-SUBSET] presence NUDGE.
#
# ADVISORY ONLY (stderr + exit 0), deliberately NOT a fifth exit-2 gate: the attestation is
# conditional on the delegation being a strict subset of a plan, so its absence is often correct.
# Every case below asserts exit 0 — a promotion to a block would fail here, which is the intent.
#
# Fixtures carry a [SIZE-EST] attestation so the sibling VGATE-SIZE-001 block does not preempt this
# surface, and a qa-code-reviewer line is pre-stamped in the sandboxed session-spawns marker so the
# reviewer-miss block does not either.
#
# BATS GATING NOTE: only the LAST command gates a test — every assertion carries `|| return 1`.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-verification-gate.sh"
NUDGE_PHRASE='carries no [PLAN-SUBSET]'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-verification-gate.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  DATA_DIR="${BATS_TEST_TMPDIR}/data"
  mkdir -p "${DATA_DIR}/session-spawns"
  printf '%s\n' "glass-atrium-qa-code-reviewer" >"${DATA_DIR}/session-spawns/sess-test-001"
  PLAN_REF="Implement clauded-docs/3854. [SIZE-EST] bundles=1 tool_uses~=10 — small."
}

# $1=prompt $2=agent_id (empty → orchestrator origin)
run_gate() {
  local payload
  payload="$(jq -n --arg p "${1}" --arg a "${2:-}" --arg s "sess-test-001" \
    '{tool_name:"Agent", session_id:$s,
      tool_input:{subagent_type:"glass-atrium-dev-shell", prompt:$p}}
     + (if $a == "" then {} else {agent_id:$a} end)')"
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" bash "$3" 2>&1' \
    _ "${payload}" "${DATA_DIR}" "${HOOK_SH}"
}

@test "plan-referencing orchestrator spawn without the attestation gets the nudge (exit 0)" {
  run_gate "${PLAN_REF}"
  [[ "${status}" -eq 0 ]] || { echo "nudge must never block, status was ${status}" >&2; return 1; }
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || { echo "no nudge -- ${output}" >&2; return 1; }
}

@test "a carried [PLAN-SUBSET] attestation silences the nudge" {
  run_gate "${PLAN_REF} [PLAN-SUBSET] included=T5b-1 landed=T1 excluded=none order=T1>T5b-1"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged despite the attestation -- ${output}" >&2; return 1; }
}

@test "a nested sub-worker origin is never nudged" {
  run_gate "${PLAN_REF}" "agent-nested-001"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged a nested origin -- ${output}" >&2; return 1; }
}

@test "a non-plan spawn with an entry classification is silent" {
  run_gate "[ENTRY-CLASS] simple-task: one file. [SIZE-EST] bundles=1 tool_uses~=4 — trivial."
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged a non-plan spawn -- ${output}" >&2; return 1; }
}
