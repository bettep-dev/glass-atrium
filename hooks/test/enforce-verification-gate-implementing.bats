#!/usr/bin/env bats
# enforce-verification-gate-implementing.bats — pins the `implementing` stage NUDGE (surface 6).
#
# ADVISORY ONLY (stderr + exit 0). The leg reads each cited document's author and stage from the
# monitor, so every case points VGATE_MONITOR_URL at a file:// fixture dir (one JSON file per id) or
# at a refused loopback port — no case reaches the live monitor.
#
# Fixtures carry a [SIZE-EST] attestation, a line-opening [SCOPE] declaration and a pre-stamped
# qa-code-reviewer marker, so a plan-referencing spawn reaches the pass arm the leg lives on.

HOOK_SH="${VGATE_SH:-${BATS_TEST_DIRNAME}/../enforce-verification-gate.sh}"
NUDGE_PHRASE='is still at doc_review'
REFUSED_URL='http://127.0.0.1:9/api/clauded-docs'
REVIEWED_SESSION='sess-impl-001'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-verification-gate.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v curl >/dev/null 2>&1 || skip "curl not on PATH"
  DATA_DIR="${BATS_TEST_TMPDIR}/data"
  mkdir -p "${DATA_DIR}/session-spawns"
  printf '%s\n' "glass-atrium-qa-code-reviewer" >"${DATA_DIR}/session-spawns/${REVIEWED_SESSION}"
  FIXTURE_DIR="${BATS_TEST_TMPDIR}/clauded-docs"
  mkdir -p "${FIXTURE_DIR}"
  write_doc 101 glass-atrium-intel-planner doc_review
  write_doc 102 glass-atrium-intel-reporter doc_review
  write_doc 103 glass-atrium-intel-planner implementing
  export VGATE_MONITOR_URL="file://${FIXTURE_DIR}"
  ATTESTATIONS="[SIZE-EST] bundles=1 tool_uses~=10 — small."$'\n'"[SCOPE] files=monitor/src/a.ts · deliverable=bug-fix · out=none"
}

# $1=id $2=author $3=doc_status
write_doc() {
  jq -n --argjson id "${1}" --arg a "${2}" --arg s "${3}" \
    '{id:$id, author:$a, doc_status:$s}' >"${FIXTURE_DIR}/${1}"
}

# $1=prompt $2=agent_id (empty → orchestrator origin) $3=session_id $4=hook_event_name (empty → absent)
run_gate() {
  local payload
  payload="$(jq -n --arg p "${1}" --arg a "${2:-}" --arg s "${3:-${REVIEWED_SESSION}}" --arg e "${4:-}" \
    '{tool_name:"Agent", session_id:$s,
      tool_input:{subagent_type:"glass-atrium-dev-shell", prompt:$p}}
     + (if $a == "" then {} else {agent_id:$a} end)
     + (if $e == "" then {} else {hook_event_name:$e} end)')"
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" VGATE_FIRED_LOG="$4" bash "$3" 2>&1' \
    _ "${payload}" "${DATA_DIR}" "${HOOK_SH}" "${BATS_TEST_TMPDIR}/fired.log"
}

# Prints the plan id the nudge names, one per nudge line; nothing when there is no nudge.
get_nudged_ids() {
  printf '%s\n' "${output}" | sed -n "s|.*Plan clauded-docs/\([0-9]*\) ${NUDGE_PHRASE}.*|\1|p"
}

@test "the nudge names the first planner-authored document still at doc_review, and only it" {
  local -a rows=(
    "planner plan at doc_review|clauded-docs/101|101"
    "reporter document at doc_review only|clauded-docs/102|none"
    "reporter first, planner second|clauded-docs/102 then clauded-docs/101|101"
    "planner plan already implementing|clauded-docs/103|none"
    "walk stops at the first planner document|clauded-docs/103 then clauded-docs/101|none"
    "walk stops at the first failed GET|clauded-docs/104 then clauded-docs/101|none"
  )
  local row name refs expected named
  for row in "${rows[@]}"; do
    IFS='|' read -r name refs expected <<<"${row}"
    run_gate "Implement ${refs}. ${ATTESTATIONS}"
    [[ "${status}" -eq 0 ]] || { echo "${name}: the nudge must never block, status ${status} -- ${output}"; return 1; }
    named="$(get_nudged_ids)"
    [[ "${named:-none}" == "${expected}" ]] || { echo "${name}: nudge named '${named:-none}', expected '${expected}' -- ${output}"; return 1; }
  done
}

@test "the nudge stays off every spawn but an orchestrator-origin PreToolUse" {
  local -a rows=(
    "nested sub-worker origin|agent-nested-001|"
    "PostToolUse stamp event||PostToolUse"
  )
  local row name agent_id event
  for row in "${rows[@]}"; do
    IFS='|' read -r name agent_id event <<<"${row}"
    run_gate "Implement clauded-docs/101. ${ATTESTATIONS}" "${agent_id}" "${REVIEWED_SESSION}" "${event}"
    [[ "${status}" -eq 0 ]] || { echo "${name}: status ${status} -- ${output}"; return 1; }
    [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "${name}: nudged -- ${output}"; return 1; }
  done
}

@test "a refused monitor fails the leg open: the pass stands with no nudge and no internal error" {
  VGATE_MONITOR_URL="${REFUSED_URL}"
  run_gate "Implement clauded-docs/101. ${ATTESTATIONS}"
  [[ "${status}" -eq 0 ]] || { echo "status ${status} -- ${output}"; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged with the monitor refused -- ${output}"; return 1; }
  [[ "${output}" != *"internal error"* ]] || { echo "the leg tripped the ERR trap -- ${output}"; return 1; }
}

@test "a reviewer-less plan spawn still blocks with VGATE-REVIEWER-001 and no nudge, monitor refused or reachable" {
  local -a rows=(
    "monitor refused|${REFUSED_URL}"
    "monitor citing a planner plan at doc_review|file://${FIXTURE_DIR}"
  )
  local row name url
  for row in "${rows[@]}"; do
    IFS='|' read -r name url <<<"${row}"
    VGATE_MONITOR_URL="${url}"
    run_gate "Implement clauded-docs/101. ${ATTESTATIONS}" "" "sess-impl-unreviewed"
    [[ "${status}" -eq 2 ]] || { echo "${name}: block lost, status ${status} -- ${output}"; return 1; }
    [[ "${output}" == *"VGATE-REVIEWER-001"* ]] || { echo "${name}: wrong verdict -- ${output}"; return 1; }
    [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "${name}: the nudge reached a block path -- ${output}"; return 1; }
  done
}
