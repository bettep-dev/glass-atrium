#!/usr/bin/env bats
# enforce-workflow-verify-stage-scope.bats — pins the [SCOPE] presence ADVISORY (fourth advisory pass).
#
# ADVISORY ONLY (stderr + exit 0), emitted on the PASS arm so it can mask no verdict: the blocking
# fixture below asserts the block still wins with the nudge absent. The --lint case pins AC6 —
# the offline preview stays side-effect-free (zero trace lines) while still printing the nudge.
#
# BATS GATING NOTE: only the LAST command gates a test — every assertion carries `|| return 1`.

HOOK_SH="${WFGATE_SH:-${BATS_TEST_DIRNAME}/../enforce-workflow-verify-stage.sh}"
NUDGE_PHRASE='ADVISORY (scope declaration, non-blocking)'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  TRACE_LOG="${BATS_TEST_TMPDIR}/workflow-gate-fired.log"
  DECL_TEAM="/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */"
  SIZE_EST="[SIZE-EST] bundles=1 tool_uses~=10 — small."
  DEV_BODY="log('plan-ref: clauded-docs/55')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
}

run_hook() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" bash "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

run_lint() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    printf "%s" "${script}" | WORKFLOW_GATE_FIRED_LOG="${trace}" bash "${hook}" --lint
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

@test "passing DEV workflow with no [SCOPE] declaration → advisory, exit 0, tagged on the pass trace" {
  run_hook "${DECL_TEAM}
${DEV_BODY}"
  [[ "${status}" -eq 0 ]] || { echo "advisory must never block, status ${status}" >&2; return 1; }
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || { echo "no nudge -- ${output}" >&2; return 1; }
  grep -q 'advisory=[^ ]*scope' "${TRACE_LOG}" || { echo "not traced: $(cat "${TRACE_LOG}")" >&2; return 1; }
}

@test "a carried [SCOPE] declaration silences the advisory" {
  run_hook "${DECL_TEAM}
log('[SCOPE] files=hooks/a.sh · deliverable=bug-fix · out=none')
${DEV_BODY}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged despite the declaration -- ${output}" >&2; return 1; }
}

@test "a non-DEV workflow is never nudged (no DEV spawn to scope)" {
  run_hook "agent('glass-atrium-intel-researcher',{goal:'research only'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged a non-DEV workflow -- ${output}" >&2; return 1; }
}

@test "a blocking DEV workflow still blocks, with the advisory absent" {
  run_hook "${DEV_BODY}"
  [[ "${status}" -eq 2 ]] || { echo "block lost, status ${status}" >&2; return 1; }
  [[ "${output}" == *"missing composition declaration"* ]] || { echo "wrong verdict -- ${output}" >&2; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "advisory reached a block path -- ${output}" >&2; return 1; }
}

@test "--lint prints the advisory and still writes zero trace lines" {
  run_lint "${DECL_TEAM}
${DEV_BODY}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || { echo "lint preview lost the nudge -- ${output}" >&2; return 1; }
  [[ ! -s "${TRACE_LOG}" ]] || { echo "lint wrote a trace line: $(cat "${TRACE_LOG}")" >&2; return 1; }
}
