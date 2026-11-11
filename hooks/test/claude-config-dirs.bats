#!/usr/bin/env bats
# claude-config-dirs.bats — the harness-root entry exemption predicate of lib/claude-config-dirs.sh,
#   shared by the foreground Agent-prompt gate and the critical hook: membership is per member class,
#   anchored at the remainder's first segment, and every fail-closed void wins over membership.

LIB_SH="${BATS_TEST_DIRNAME}/../lib/claude-config-dirs.sh"

setup() {
  # shellcheck source=../lib/claude-config-dirs.sh
  source "${LIB_SH}"
}

# Row: name | member classes | path as written | root-relative remainder | nocasematch (on/off) | 0 exempt, 1 not
@test "the exemption predicate admits only its member classes and fails closed on every void" {
  local rows=(
    "BASENAME file under the foreground set|basename runtime-data|/h/.claude/CLAUDE.md|CLAUDE.md|off|0"
    "BASENAME file outside the subagent set|projects job|/h/.claude-p/CLAUDE.md|CLAUDE.md|off|1"
    "case-varied BASENAME folds under an ambient nocasematch|basename runtime-data|/h/.claude/claude.MD|claude.MD|on|0"
    "case-varied BASENAME stays protected without nocasematch|basename runtime-data|/h/.claude/claude.MD|claude.MD|off|1"
    "progress file in a memory dir for the subagent set|projects job|/h/.claude/projects/p/memory/progress-x.md|projects/p/memory/progress-x.md|off|0"
    "MEMORY.md in a memory dir stays protected|projects job|/h/.claude/projects/p/memory/MEMORY.md|projects/p/memory/MEMORY.md|off|1"
    "non-progress memory file stays protected|basename runtime-data|/h/.claude/projects/p/memory/gate.sh|projects/p/memory/gate.sh|off|1"
    "transcript under projects is runtime data|projects job|/h/.claude/projects/p/s.jsonl|projects/p/s.jsonl|off|0"
    "shell snapshot outside the subagent set|projects job|/h/.claude/shell-snapshots/snapshot-zsh-x.sh|shell-snapshots/snapshot-zsh-x.sh|off|1"
    "shell snapshot inside the foreground set|basename runtime-data|/h/.claude/shell-snapshots/snapshot-zsh-x.sh|shell-snapshots/snapshot-zsh-x.sh|off|0"
    "memory segment under another runtime dir stays protected|basename runtime-data|/h/.claude/data/x/memory/progress-x.md|data/x/memory/progress-x.md|off|1"
    "job scratchpad file|projects job|/h/.claude-w/jobs/j1/tmp/a.txt|jobs/j1/tmp/a.txt|off|0"
    "job scratchpad dir itself|projects job|/h/.claude-w/jobs/j1/tmp|jobs/j1/tmp|off|0"
    "job state file outside the scratchpad|projects job|/h/.claude-w/jobs/j1/state.json|jobs/j1/state.json|off|1"
    "job scratchpad outside the foreground set|basename runtime-data|/h/.claude-w/jobs/j1/tmp/a.txt|jobs/j1/tmp/a.txt|off|1"
    "dot segment in place of the job id|projects job|/h/.claude-w/jobs/./tmp/a|jobs/./tmp/a|off|1"
    "backtrack segment in the written path|projects job|/h/.claude/jobs/j/tmp/../../../commands/y.md|jobs/j/tmp/a|off|1"
    "empty remainder names the root itself|projects job basename runtime-data|/h/.claude||off|1"
    "remainder with a leading slash is an unparsed shape|projects job|/h/.claude//jobs/j/tmp/a|/jobs/j/tmp/a|off|1"
    "config entry is in no member class|basename runtime-data projects job|/h/.claude/agents/x.md|agents/x.md|off|1"
    "case-varied home leaves the home as the first segment|projects job|/USERS/x/.claude/jobs/j/tmp/a|USERS/x/.claude/jobs/j/tmp/a|on|1"
  )
  local row name classes path rest fold want got
  for row in "${rows[@]}"; do
    IFS='|' read -r name classes path rest fold want <<<"${row}"
    if [[ "${fold}" == on ]]; then shopt -s nocasematch; else shopt -u nocasematch; fi
    got=0
    claude_config_is_exempt_entry "${classes}" "${path}" "${rest}" || got=$?
    shopt -u nocasematch
    [[ "${got}" == "${want}" ]] || { echo "row: ${name} (want ${want}, got ${got})"; return 1; }
  done
}

@test "the hardlink void refuses a multi-link regular file only when the caller sets the flag" {
  local tmp="${BATS_TEST_TMPDIR}/h/.claude/jobs/j/tmp"
  mkdir -p "${tmp}" "${BATS_TEST_TMPDIR}/h/.claude/projects/p/memory"
  printf 'm\n' >"${BATS_TEST_TMPDIR}/h/.claude/projects/p/memory/MEMORY.md"
  ln "${BATS_TEST_TMPDIR}/h/.claude/projects/p/memory/MEMORY.md" "${tmp}/m.md"
  printf 's\n' >"${tmp}/single.txt"
  local got=0
  claude_config_is_exempt_entry "projects job" "${tmp}/m.md" "jobs/j/tmp/m.md" hardlink || got=$?
  [[ "${got}" == 1 ]] || { echo "row: hardlink with the flag (got ${got})"; return 1; }
  got=0
  claude_config_is_exempt_entry "projects job" "${tmp}/m.md" "jobs/j/tmp/m.md" || got=$?
  [[ "${got}" == 0 ]] || { echo "row: hardlink without the flag (got ${got})"; return 1; }
  got=0
  claude_config_is_exempt_entry "projects job" "${tmp}/single.txt" "jobs/j/tmp/single.txt" hardlink || got=$?
  [[ "${got}" == 0 ]] || { echo "row: single-link file with the flag (got ${got})"; return 1; }
}
