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

# Links and a hardlink planted before the call, under FAKE_HOME and a scratch dir outside it.
plant_write_fixtures() {
  local p="${FAKE_HOME}/.claude-personal" tmp="${FAKE_HOME}/.claude/jobs/j/tmp"
  mkdir -p "${tmp}" "${FAKE_HOME}/.claude/projects/p/memory" "${p}" "${BATS_TEST_TMPDIR}/scratch"
  printf 'm\n' >"${FAKE_HOME}/.claude/projects/p/memory/MEMORY.md"
  ln -s "${FAKE_HOME}/.claude/projects/p/memory" "${tmp}/to-memory"
  ln -s "${FAKE_HOME}/.claude/projects/p/memory/new.md" "${tmp}/dangling"
  ln "${FAKE_HOME}/.claude/projects/p/memory/MEMORY.md" "${tmp}/hard.md"
  ln -s "${p}" "${BATS_TEST_TMPDIR}/scratch/profile"
  ln -s "${FAKE_HOME}" "${BATS_TEST_TMPDIR}/scratch/home"
}

# Args: $1=tool $2=file_path. Prints a tool_input JSON object for that tool.
write_input() {
  case "${1}" in
    Write) jq -cn --arg f "${2}" '{file_path: $f, content: "x"}' ;;
    Edit) jq -cn --arg f "${2}" '{file_path: $f, old_string: "a", new_string: "b"}' ;;
    MultiEdit) jq -cn --arg f "${2}" '{file_path: $f, edits: [{old_string: "a", new_string: "b"}]}' ;;
    *) return 1 ;;
  esac
}

# Row: name | tool | file_path (`H` = FAKE_HOME, `S` = scratch dir, `U` = FAKE_HOME upper-cased)
#   | status with agent_id | status without agent_id.
@test "an agent_id write lands under a profile root only in its job scratchpad or a progress file" {
  plant_write_fixtures
  local rows=(
    "non-exempt profile path|Write|H/.claude-personal/commands/y.md|2|0"
    "non-exempt profile path by Edit|Edit|H/.claude-personal/commands/y.md|2|0"
    "non-exempt profile path by MultiEdit|MultiEdit|H/.claude-personal/commands/y.md|2|0"
    "profile CLAUDE.md, no BASENAME exception for agents|Write|H/.claude-personal/CLAUDE.md|2|0"
    "profile MEMORY.md|Write|H/.claude-personal/MEMORY.md|2|0"
    "job state outside the scratchpad|Write|H/.claude/jobs/j/state.json|2|0"
    "jobs tmp backtrack into a non-exempt entry|Write|H/.claude/jobs/j/tmp/../../../commands/y.md|2|0"
    "jobs tmp spelled with a case-varied home|Write|U/.claude/jobs/j/tmp/a.txt|2|0"
    "link under jobs tmp into a memory dir|Write|H/.claude/jobs/j/tmp/to-memory/MEMORY.md|2|0"
    "dangling link under jobs tmp to a memory file not yet created|Write|H/.claude/jobs/j/tmp/dangling|2|0"
    "hardlink under jobs tmp to a memory file|Write|H/.claude/jobs/j/tmp/hard.md|2|0"
    "scratch link to a profile root, no .claude in the text|Write|S/profile/CLAUDE.md|2|0"
    "scratch link to home|Write|S/home/.claude-personal/CLAUDE.md|2|0"
    "bare profile root token|Write|H/.claude-personal|2|0"
    "progress file|Write|H/.claude/projects/p/memory/progress-x.md|0|0"
    "progress file by tilde|Write|~/.claude/projects/p/memory/progress-x.md|0|0"
    "job scratchpad file|Write|H/.claude/jobs/j/tmp/a.txt|0|0"
    "job scratchpad file by tilde|Edit|~/.claude-work/jobs/j2/tmp/a.txt|0|0"
    "worktree under a repo in home|Write|H/Desktop/git/r/.claude/worktrees/wt/x.sh|0|0"
    "relative .claude path|Write|.claude/x.md|0|0"
  )
  local upper row name tool path want_agent want_main
  upper="$(printf '%s' "${FAKE_HOME}" | tr '[:lower:]' '[:upper:]')"
  for row in "${rows[@]}"; do
    IFS='|' read -r name tool path want_agent want_main <<<"${row}"
    case "${path}" in
      H/*) path="${FAKE_HOME}/${path#H/}" ;;
      S/*) path="${BATS_TEST_TMPDIR}/scratch/${path#S/}" ;;
      U/*) path="${upper}/${path#U/}" ;;
      *) : ;;
    esac
    run_hook "${tool}" "$(write_input "${tool}" "${path}")" a1
    [[ "${status}" == "${want_agent}" ]] || { echo "row: ${name} agent_id status=${status}"; echo "${output}"; return 1; }
    run_hook "${tool}" "$(write_input "${tool}" "${path}")"
    [[ "${status}" == "${want_main}" ]] || { echo "row: ${name} main status=${status}"; echo "${output}"; return 1; }
  done
}

@test "an agent_id write is judged against a HOME reached through a link" {
  ln -s "${FAKE_HOME}" "${BATS_TEST_TMPDIR}/home-link"
  local saved="${FAKE_HOME}"
  FAKE_HOME="${BATS_TEST_TMPDIR}/home-link"
  run_hook Write "$(write_input Write "${saved}/.claude-personal/CLAUDE.md")" a1
  [[ "${status}" == 2 ]] || { echo "row: physical spelling under a linked HOME status=${status}"; echo "${output}"; return 1; }
  run_hook Write "$(write_input Write "${saved}/.claude/jobs/j/tmp/a.txt")" a1
  [[ "${status}" == 0 ]] || { echo "row: scratchpad under a linked HOME status=${status}"; echo "${output}"; return 1; }
}
