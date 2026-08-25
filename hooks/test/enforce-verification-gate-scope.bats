#!/usr/bin/env bats
# enforce-verification-gate-scope.bats — pins the [SCOPE] presence NUDGE (surface 4).
#
# ADVISORY ONLY (stderr + exit 0). The nudge is emitted on the PASS paths, after every verdict, so
# the cases below assert both halves: it appears on a passing spawn, and a spawn that BLOCKS still
# blocks with the nudge nowhere in sight.
#
# Fixtures mirror the sibling [PLAN-SUBSET] suite: a [SIZE-EST] attestation and a pre-stamped
# qa-code-reviewer marker keep the other two surfaces from preempting this one.
#
# BATS GATING NOTE: only the LAST command gates a test — every assertion carries `|| return 1`.

HOOK_SH="${VGATE_SH:-${BATS_TEST_DIRNAME}/../enforce-verification-gate.sh}"
NUDGE_PHRASE='carries no [SCOPE] declaration'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-verification-gate.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  DATA_DIR="${BATS_TEST_TMPDIR}/data"
  mkdir -p "${DATA_DIR}/session-spawns"
  printf '%s\n' "glass-atrium-qa-code-reviewer" >"${DATA_DIR}/session-spawns/sess-scope-001"
  SIZE_EST="[SIZE-EST] bundles=1 tool_uses~=10 — small."
  SCOPE_DECL="[SCOPE] files=hooks/a.sh · deliverable=bug-fix · out=none"
}

# $1=prompt $2=agent_id (empty → orchestrator origin)
run_gate() {
  local payload
  payload="$(jq -n --arg p "${1}" --arg a "${2:-}" --arg s "sess-scope-001" \
    '{tool_name:"Agent", session_id:$s,
      tool_input:{subagent_type:"glass-atrium-dev-shell", prompt:$p}}
     + (if $a == "" then {} else {agent_id:$a} end)')"
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" VGATE_FIRED_LOG="$4" bash "$3" 2>&1' \
    _ "${payload}" "${DATA_DIR}" "${HOOK_SH}" "${BATS_TEST_TMPDIR}/fired.log"
}

@test "passing DEV spawn without a [SCOPE] declaration gets the nudge (exit 0)" {
  run_gate "Implement clauded-docs/3854. ${SIZE_EST}"
  [[ "${status}" -eq 0 ]] || { echo "nudge must never block, status was ${status}" >&2; return 1; }
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || { echo "no nudge -- ${output}" >&2; return 1; }
}

@test "a carried [SCOPE] declaration silences the nudge" {
  run_gate "Implement clauded-docs/3854. ${SIZE_EST} ${SCOPE_DECL}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged despite the declaration -- ${output}" >&2; return 1; }
}

@test "an entry-classified spawn is nudged on the simple-task pass path too" {
  run_gate "[ENTRY-CLASS] simple-task: one file. ${SIZE_EST}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || { echo "simple-task pass path not nudged -- ${output}" >&2; return 1; }
}

@test "a nested sub-worker origin is never nudged" {
  run_gate "Implement clauded-docs/3854. ${SIZE_EST}" "agent-nested-001"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged a nested origin -- ${output}" >&2; return 1; }
}

@test "missing [SCOPE] alongside a real violation: the block still wins, unaccompanied" {
  run_gate "Implement clauded-docs/3854 with no size attestation."
  [[ "${status}" -eq 2 ]] || { echo "size-est block lost, status was ${status}" >&2; return 1; }
  [[ "${output}" == *"VGATE-SIZE-001"* ]] || { echo "wrong verdict -- ${output}" >&2; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "advisory reached a block path -- ${output}" >&2; return 1; }
}

@test "entry-miss blocks unchanged when the declaration is also absent" {
  run_gate "Just do the thing. ${SIZE_EST}"
  [[ "${status}" -eq 2 ]] || { echo "entry block lost, status was ${status}" >&2; return 1; }
  [[ "${output}" == *"VGATE-ENTRY-001"* ]] || { echo "wrong verdict -- ${output}" >&2; return 1; }
}

# --- surface 5: Deep-review advisory on a carried [SCOPE] declaration -------------------------

DEEP_PHRASE='Deep (4-pass)'

# $1=count. Prints `files=` paths, none of them under a sensitive prefix.
plain_paths() {
  local n="${1}" i out=""
  for ((i = 1; i <= n; i++)); do
    out="${out}monitor/src/f${i}.ts, "
  done
  printf '%s' "${out%, }"
}

@test "a [SCOPE] under the file-count threshold stays silent about review depth" {
  run_gate "Implement clauded-docs/3854. ${SIZE_EST} [SCOPE] files=$(plain_paths 9) · deliverable=feature · out=none"
  [[ "${status}" -eq 0 ]] || { echo "advisory must never block, status was ${status}" >&2; return 1; }
  [[ "${output}" != *"${DEEP_PHRASE}"* ]] || { echo "nudged below the threshold -- ${output}" >&2; return 1; }
}

@test "a [SCOPE] at the file-count threshold asks for a Deep review" {
  run_gate "Implement clauded-docs/3854. ${SIZE_EST} [SCOPE] files=$(plain_paths 10) · deliverable=feature · out=none"
  [[ "${status}" -eq 0 ]] || { echo "advisory must never block, status was ${status}" >&2; return 1; }
  [[ "${output}" == *"${DEEP_PHRASE}"* ]] || { echo "no depth advisory -- ${output}" >&2; return 1; }
}

@test "a single sensitive-prefix path asks for a Deep review" {
  run_gate "Implement clauded-docs/3854. ${SIZE_EST} [SCOPE] files=hooks/x.sh · deliverable=bug-fix · out=none"
  [[ "${status}" -eq 0 ]] || { echo "advisory must never block, status was ${status}" >&2; return 1; }
  [[ "${output}" == *"${DEEP_PHRASE}"* ]] || { echo "no depth advisory -- ${output}" >&2; return 1; }
  [[ "${output}" == *"hooks/"* ]] || { echo "matched prefix not named -- ${output}" >&2; return 1; }
}

@test "no [SCOPE] declaration leaves the depth advisory silent" {
  run_gate "Implement clauded-docs/3854. ${SIZE_EST}"
  [[ "${status}" -eq 0 ]] || { echo "advisory must never block, status was ${status}" >&2; return 1; }
  [[ "${output}" != *"${DEEP_PHRASE}"* ]] || { echo "depth advisory without a declaration -- ${output}" >&2; return 1; }
}
