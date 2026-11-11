#!/usr/bin/env bats
# enforce-harness-critical-agent-id.bats — the critical hook's agent_id write gate and the framing
#   guards it relies on. Decision channel = exit code: 0 pass / 2 block; the block code and class
#   ride the stderr payload.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  unset GA_DATA_ROOT
  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${FAKE_HOME}/.claude/hooks" "${FAKE_HOME}/.claude-personal"
}

# Args: $1=tool $2=tool_input JSON $3=agent_id (optional).
run_hook() {
  local tool="${1}" tin="${2}" agent="${3:-}" envelope
  if [[ -n "${agent}" ]]; then
    envelope="$(jq -cn --arg t "${tool}" --arg a "${agent}" --argjson ti "${tin}" \
      '{tool_name: $t, agent_id: $a, tool_input: $ti}')"
  else
    envelope="$(jq -cn --arg t "${tool}" --argjson ti "${tin}" '{tool_name: $t, tool_input: $ti}')"
  fi
  run env "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
}

# Row: name | command JSON string body (`\u0000` = a NUL) — each runs with and without agent_id.
@test "a command carrying a NUL blocks as HAR-003 for every caller" {
  local rows=(
    'NUL inside the command word|c\u0000p evil ~/.claude/settings.json'
    'NUL between two operands|echo a\u0000b ~/.claude/x'
    'NUL after a read|ls ~/.claude\u0000'
  )
  local row name cmd agent
  for row in "${rows[@]}"; do
    IFS='|' read -r name cmd <<<"${row}"
    for agent in "" a1; do
      run_hook Bash "{\"command\":\"${cmd}\"}" "${agent}"
      [[ "${status}" == 2 && "${output}" == *HAR-003* && "${output}" == *nul-in-command* ]] \
        || { echo "row: ${name} agent_id=${agent:-none} status=${status}"; echo "${output}"; return 1; }
    done
  done
}
