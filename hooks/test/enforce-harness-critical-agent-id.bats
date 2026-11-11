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

# Args: $1=command text (`@H@` = FAKE_HOME, `@U@` = it upper-cased, `@S@` = scratch dir, `@N@` = a
#   newline) $2=agent_id (optional). Runs the hook on a Bash envelope carrying that command.
run_bash() {
  local cmd="${1}" upper
  upper="$(printf '%s' "${FAKE_HOME}" | tr '[:lower:]' '[:upper:]')"
  cmd="${cmd//@H@/${FAKE_HOME}}"
  cmd="${cmd//@U@/${upper}}"
  cmd="${cmd//@S@/${BATS_TEST_TMPDIR}/scratch}"
  cmd="${cmd//@N@/$'\n'}"
  run_hook Bash "$(jq -cn --arg c "${cmd}" '{command: $c}')" "${2:-}"
}

# Row: name | command | status with agent_id | status without agent_id.
@test "an agent_id Bash call passes a profile-root word only as a proven read or an exempt path" {
  plant_write_fixtures
  local rows=(
    'redirect into a non-exempt profile path|echo x > ~/.claude-personal/commands/y.md|2|0'
    'copy verb into a non-exempt profile path|cp evil ~/.claude-personal/commands/y.md|2|0'
    'copy slice mixing jobs tmp and a non-exempt path|cp ~/.claude/jobs/j/tmp/a ~/.claude-personal/x.md|2|0'
    'write to job state outside the scratchpad|echo x > ~/.claude/jobs/j/state.json|2|0'
    'append to profile CLAUDE.md|echo x >> ~/.claude-personal/CLAUDE.md|2|0'
    'redirect to profile MEMORY.md|printf x > ~/.claude-personal/MEMORY.md|2|0'
    'rm of profile CLAUDE.md|rm ~/.claude-personal/CLAUDE.md|2|0'
    'touch under a profile root|touch ~/.claude-personal/x|2|0'
    'mkdir under a profile hooks dir|mkdir -p ~/.claude-personal/hooks/x|2|0'
    'rmdir of a profile dir|rmdir ~/.claude-personal/commands|2|0'
    'unlink of a profile path|unlink ~/.claude-personal/x|2|0'
    'copy inside a for loop|for x in 1; do cp evil ~/.claude-personal/CLAUDE.md; done|2|0'
    'copy inside a brace group|{ cp evil ~/.claude-personal/CLAUDE.md; }|2|0'
    'move inside if-then|if true; then mv evil ~/.claude-personal/CLAUDE.md; fi|2|0'
    'noglob modifier|noglob cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'dash precommand modifier|true; - cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'repeat modifier|repeat 1 cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'quoted command word|"rm" ~/.claude-personal/CLAUDE.md|2|0'
    'split-quoted command word|c'"''"'p evil ~/.claude-personal/CLAUDE.md|2|0'
    'command -p prefix|command -p cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'exec -a prefix|exec -a x cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'env -i prefix|env -i cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'coproc|coproc cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'eval|eval cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'zsh short if|if [[ -n x ]] cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'zsh always block|{ true; } always { cp evil ~/.claude-personal/CLAUDE.md; }|2|0'
    'nice wrapper|nice cp evil ~/.claude-personal/CLAUDE.md|2|0'
    'sort -o output|sort -o ~/.claude-personal/CLAUDE.md x|2|0'
    'find -delete|find ~/.claude-personal/agents -delete|2|0'
    'find -fprint|find /tmp -fprint ~/.claude-personal/x|2|0'
    'uniq output operand|uniq x ~/.claude-personal/CLAUDE.md|2|0'
    'function named cat defined in the call|cat() { cp "$@"; }; cat evil ~/.claude-personal/CLAUDE.md|2|0'
    'hash rebinding cat|hash cat=/bin/cp; cat evil ~/.claude-personal/CLAUDE.md|2|0'
    'sourced file before a cat|. /tmp/defs; cat evil ~/.claude-personal/CLAUDE.md|2|0'
    'assignment-prefixed cat|X=1 cat ~/.claude-personal/CLAUDE.md|2|0'
    'python code string write|python3 -c "open('"'"'$HOME/.claude-personal/CLAUDE.md'"'"','"'"'w'"'"')"|2|0'
    'python heredoc write|python3 - <<'"'"'EOF'"'"'@N@open("~/.claude-personal/CLAUDE.md","w")@N@EOF|2|0'
    'interpreter non-script operand|python3 /tmp/w.py ~/.claude-personal/CLAUDE.md|2|0'
    'copy source a non-exempt profile path|cp ~/.claude-personal/CLAUDE.md /tmp/y|2|0'
    'cd into a root then a relative ln source|cd ~/.claude && ln settings.json /tmp/x.json|2|0'
    'jobs tmp backtrack in a copy slice|cp evil ~/.claude/jobs/j/tmp/../../../commands/y.md|2|0'
    'jobs tmp spelled with a case-varied home|echo x > @U@/.claude/jobs/j/tmp/a.txt|2|0'
    'jobs tmp path holding a variable|echo x > ~/.claude-work/jobs/$J/tmp/x|2|0'
    'zsh comment char inside the root segment|rm ~/.claude-p#ersonal/CLAUDE.md|2|0'
    'redirect through a jobs tmp link into a memory dir|echo x > ~/.claude/jobs/j/tmp/to-memory/MEMORY.md|2|0'
    'redirect through a dangling jobs tmp link|echo x > ~/.claude/jobs/j/tmp/dangling|2|0'
    'redirect to a jobs tmp hardlink of a memory file|echo x > ~/.claude/jobs/j/tmp/hard.md|2|0'
    'redirect through a scratch link to home|echo x > @S@/home/.claude-personal/CLAUDE.md|2|0'
    'redirect through a scratch link to a profile root|echo x > @S@/profile/CLAUDE.md|2|0'
    'ln of a bare root token|ln -s ~/.claude /tmp/c|2|0'
    'ln of bare home|ln -s ~ /tmp/h|2|0'
    'relative cd out of jobs tmp then a relative write|cd ~/.claude/jobs/j/tmp && cd ../../../commands && echo x > y.md|2|0'
    'cd - after an in-scope dir then a relative write|cd ~/.claude-personal && cd /tmp && cd - && echo x > y|2|0'
    'zsh clobber redirect|cat evil >! ~/.claude-personal/CLAUDE.md|2|0'
    'zsh clobber append redirect|cat evil >>| ~/.claude-personal/CLAUDE.md|2|0'
    'zsh fd clobber redirect|cat evil 2>! ~/.claude-personal/CLAUDE.md|2|0'
    'substitution in double quotes|echo "$(cp evil ~/.claude-personal/CLAUDE.md)"|2|0'
    'substitution in a quoted assignment|X="$(rm ~/.claude-personal/CLAUDE.md)"|2|0'
    'backtick inside double quotes|echo "`cp evil ~/.claude-personal/CLAUDE.md`"|2|0'
    'unquoted backtick|echo `cp evil ~/.claude-personal/CLAUDE.md`|2|0'
    'substitution in an unquoted-delimiter heredoc|cat > /tmp/x <<EOF@N@$(cp evil ~/.claude-personal/CLAUDE.md)@N@EOF|2|0'
    'bash -c nested past the depth cap|bash -c "bash -c \"bash -c '"'"'cp evil ~/.claude-personal/CLAUDE.md'"'"'\""|2|0'
    'append to a profile shell snapshot|printf x >> ~/.claude-personal/shell-snapshots/snapshot-zsh-x.sh|2|0'
    'sed in-place edit|sed -i '"''"' s/a/b/ ~/.claude-personal/CLAUDE.md|2|0'
    'sed script with a write command|sed -n '"'"'1w /tmp/x'"'"' ~/.claude-personal/CLAUDE.md|2|0'
    'HAR-002 scratch settings pin|T=$(mktemp -d); echo x > $T/.claude/settings.json|2|2'
    'progress file by tilde|echo x > ~/.claude/projects/p/memory/progress-x.md|0|0'
    'progress file by $HOME|echo x > $HOME/.claude/projects/p/memory/progress-x.md|0|0'
    'progress file by literal home|echo x > @H@/.claude/projects/p/memory/progress-x.md|0|0'
    'jobs tmp redirect by tilde|echo x > ~/.claude/jobs/j/tmp/a.txt|0|0'
    'jobs tmp redirect by ${HOME}|echo x > ${HOME}/.claude/jobs/j/tmp/a.txt|0|0'
    'jobs tmp redirect by literal home|echo x > @H@/.claude/jobs/j/tmp/a.txt|0|0'
    'touch and rm inside jobs tmp|touch ~/.claude/jobs/j/tmp/b && rm ~/.claude/jobs/j/tmp/b|0|0'
    'cd into jobs tmp then a relative write|cd ~/.claude/jobs/j/tmp && echo x > a.txt|0|0'
    'cat of profile CLAUDE.md|cat ~/.claude-personal/CLAUDE.md|0|0'
    'grep of a memory index|grep x ~/.claude/projects/p/memory/MEMORY.md|0|0'
    'ls of a bare root|ls ~/.claude|0|0'
    'cd into a root then ls|cd ~/.claude && ls|0|0'
    'read re-spelling of a copy|cat ~/.claude-personal/CLAUDE.md > /tmp/y|0|0'
    'head and wc reads in a pipeline|head -5 ~/.claude-personal/CLAUDE.md | wc -l|0|0'
    'sed line-range print|sed -n '"'"'1,40p'"'"' ~/.claude-personal/CLAUDE.md|0|0'
    'jq read of profile settings|jq -r .model ~/.claude/settings.json|0|0'
    'absolute write inside a worktree|echo x > @H@/Desktop/git/r/.claude/worktrees/wt/x.sh|0|0'
    'cd into a worktree then a relative write|cd @H@/Desktop/git/r/.claude/worktrees/wt && echo x > y|0|0'
    'relative .claude write|echo x > .claude/x.md|0|0'
    'mkdir under a neutral mktemp dir|T=$(mktemp -d); mkdir -p $T/neutral/x|0|0'
    'rm of a non-root home path|rm ~/Desktop/x/*.tmp|0|0'
    'quoted-delimiter heredoc naming a profile path|cat > /tmp/x <<'"'"'EOF'"'"'@N@$(cp evil ~/.claude-personal/CLAUDE.md)@N@EOF|0|0'
    'single-quoted mention of a profile path|echo '"'"'see ~/.claude-personal/CLAUDE.md'"'"'|0|0'
  )
  local row name cmd want_agent want_main fails=0
  for row in "${rows[@]}"; do
    name="${row%%|*}"
    want_main="${row##*|}"
    row="${row%|*}"
    want_agent="${row##*|}"
    cmd="${row%|*}"
    cmd="${cmd#*|}"
    run_bash "${cmd}" a1
    [[ "${status}" == "${want_agent}" ]] || { echo "row: ${name} agent_id status=${status}"; echo "${output}"; fails=$((fails + 1)); }
    run_bash "${cmd}"
    [[ "${status}" == "${want_main}" ]] || { echo "row: ${name} main status=${status}"; echo "${output}"; fails=$((fails + 1)); }
  done
  [[ "${fails}" == 0 ]]
}

@test "an agent_id copy keeps the byte-identical relabel of a protected copy source" {
  local agent
  for agent in "" a1; do
    run_bash 'cp ~/.claude/hooks/x.sh /tmp/y' "${agent}"
    [[ "${status}" == 2 && "${output}" == *bash-source-position* ]] \
      || { echo "row: tilde source agent_id=${agent:-none} status=${status}"; echo "${output}"; return 1; }
    run_bash 'cp $HOME/.claude/hooks/x.sh /tmp/y' "${agent}"
    [[ "${status}" == 2 && "${output}" == *bash-mutation* ]] \
      || { echo "row: \$HOME source agent_id=${agent:-none} status=${status}"; echo "${output}"; return 1; }
  done
}

# Row: name | perl substitution applied to a copy of the hook's triple emit. The unpatched copy
#   passes the same call, so each block comes from the misaligned stream alone.
@test "a misaligned agent_id triple stream blocks as HAR-003" {
  local rows=(
    'count larger than the triples emitted|s/str\(len\(triples\)\)/str(len(triples) + 1)/'
    'a triple missing a field|s/for value in triple\)/for value in triple[:2])/'
  )
  local copy row name expr cmd n=0
  mkdir -p "${FAKE_HOME}/.claude/jobs/j/tmp"
  cmd='echo x > ~/.claude/jobs/j/tmp/a.txt'
  for row in "${rows[@]}"; do
    IFS='|' read -r name expr <<<"${row}"
    n=$((n + 1))
    copy="${BATS_TEST_TMPDIR}/hookcopy-${n}"
    mkdir -p "${copy}"
    cp -R "${BATS_TEST_DIRNAME}/../lib" "${copy}/lib"
    cp "${BATS_TEST_DIRNAME}/../hook-utils.sh" "${copy}/hook-utils.sh"
    cp "${HOOK_SH}" "${copy}/hook.sh"
    HOOK_SH="${copy}/hook.sh" run_bash "${cmd}" a1
    [[ "${status}" == 0 ]] || { echo "row: ${name} unpatched status=${status}"; echo "${output}"; return 1; }
    perl -pi -e "${expr}" "${copy}/hook.sh"
    HOOK_SH="${copy}/hook.sh" run_bash "${cmd}" a1
    [[ "${status}" == 2 && "${output}" == *HAR-003* ]] \
      || { echo "row: ${name} status=${status}"; echo "${output}"; return 1; }
  done
}
