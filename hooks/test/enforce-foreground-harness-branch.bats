#!/usr/bin/env bats
# enforce-foreground-harness-branch.bats — Bats suite for the profile-branch COVERAGE of the
#   PreToolUse(Agent) Rule-2 gate. The hook used to enumerate `-work` and `-personal` literally, so a
#   full profile branch on disk (`~/.claude-work-dev/`) — settings.json, agents/, its own daemon —
#   slipped the gate entirely. Coverage now derives from the single-sited root grammar in
#   lib/claude-config-dirs.sh; policy semantics are unchanged.
#
# Decision channel = exit code: 0 PASS (not blocked) / 2 BLOCK (Rule-2 violation).
# 격리: 합성 JSON 을 stdin 으로 주입, 라이브 hook input 미의존.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-foreground-harness.sh"
BACKUP_DIR=".claude-pre-glass-atrium-backup-20260603T043853Z"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-foreground-harness.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# Args: $1 = prompt body, $2 = run_in_background boolean literal (true/false).
run_agent() {
  local prompt="$1" bg="$2" payload
  payload="$(jq -n --arg p "${prompt}" --argjson bg "${bg}" \
    '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:$bg}}')"
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
}

# AC1 — the branch that motivated the fix

@test "~/.claude-work-dev/settings.json + bg=true → BLOCKED (AC1)" {
  run_agent 'Add the hook entry to ~/.claude-work-dev/settings.json.' true
  [[ "${status}" -eq 2 ]]
}

@test "~/.claude-work-dev/hooks/x.sh + bg=true → BLOCKED (AC1)" {
  run_agent 'Write the new hook to ~/.claude-work-dev/hooks/x.sh.' true
  [[ "${status}" -eq 2 ]]
}

@test "absolute-\$HOME .claude-work-dev/agents/ + bg=true → BLOCKED (arm-invariant)" {
  run_agent "Edit ${HOME}/.claude-work-dev/agents/custom.md frontmatter." true
  [[ "${status}" -eq 2 ]]
}

@test "CWD-relative .claude-work-dev/skills/ + bg=true → BLOCKED (arm-invariant)" {
  run_agent 'From the home dir, edit .claude-work-dev/skills/foo/SKILL.md.' true
  [[ "${status}" -eq 2 ]]
}

# AC4 — dormant backup dir: intentional fail-safe over-coverage

@test "dormant backup dir config path + bg=true → BLOCKED (AC4)" {
  run_agent "Restore ~/${BACKUP_DIR}/hooks/old.sh into place." true
  [[ "${status}" -eq 2 ]]
}

# AC2 — BASENAME exception holds on every branch × root form

@test "BASENAME CLAUDE.md on a branch root (tilde) + bg=true → NOT blocked (AC2)" {
  run_agent 'Append the project note to ~/.claude-work-dev/CLAUDE.md then stop.' true
  [[ "${status}" -eq 0 ]]
}

@test "BASENAME MEMORY.md on a branch root (absolute-\$HOME) + bg=true → NOT blocked (AC2)" {
  run_agent "Add the index line to ${HOME}/.claude-personal/MEMORY.md then exit." true
  [[ "${status}" -eq 0 ]]
}

@test "BASENAME GLASS_ATRIUM_GLOBAL_RULES.md on a branch root (bare) + bg=true → NOT blocked (AC2)" {
  run_agent 'From the home dir, update .claude-work-dev/GLASS_ATRIUM_GLOBAL_RULES.md now.' true
  [[ "${status}" -eq 0 ]]
}

@test "BASENAME CLAUDE.md on the backup dir + bg=true → NOT blocked (AC2)" {
  run_agent "Read ~/${BACKUP_DIR}/CLAUDE.md for the old wording." true
  [[ "${status}" -eq 0 ]]
}

# AC3 — runtime-DATA exclusions keep their CURRENT membership on branch roots

@test "~/.claude-work-dev/data/ reference + bg=true → NOT blocked (AC3)" {
  run_agent 'For context, read ~/.claude-work-dev/data/outcomes/2026-08-14.md.' true
  [[ "${status}" -eq 0 ]]
}

@test "~/.claude-personal/logs/ reference + bg=true → NOT blocked (AC3)" {
  run_agent 'Tail ~/.claude-personal/logs/daemon.log and report the last error.' true
  [[ "${status}" -eq 0 ]]
}

@test "~/.claude-work-dev/shell-snapshots/ reference + bg=true → NOT blocked (AC3)" {
  run_agent 'List ~/.claude-work-dev/shell-snapshots/latest.sh for the env dump.' true
  [[ "${status}" -eq 0 ]]
}

@test "~/.claude-work-dev/projects/<proj>/memory/ write + bg=true → STILL blocked (AC3 memory guard)" {
  run_agent 'Persist ~/.claude-work-dev/projects/-Users-x/memory/progress-foo.md now.' true
  [[ "${status}" -eq 2 ]]
}

@test "~/.claude-work-dev/jobs/ + bg=true → BLOCKED (current runtime-DATA membership pinned, no jobs member)" {
  run_agent 'Queue the run via ~/.claude-work-dev/jobs/pending.json.' true
  [[ "${status}" -eq 2 ]]
}

# Root-grammar negatives: a lookalike name is not a config root

@test "~/.claudex/ lookalike + bg=true → NOT blocked (suffix must open with '-')" {
  run_agent 'Read ~/.claudex/settings.json for the third-party tool config.' true
  [[ "${status}" -eq 0 ]]
}

@test "~/.claude-/ empty suffix + bg=true → NOT blocked (suffix must open with an alnum)" {
  run_agent 'Inspect ~/.claude-/settings.json leftovers.' true
  [[ "${status}" -eq 0 ]]
}

@test "dot-less claude-work/ + bg=true → NOT blocked (leading-dot discipline)" {
  run_agent 'Open claude-work/settings.json in the repo checkout.' true
  [[ "${status}" -eq 0 ]]
}

@test "git checkout hooks path + bg=true → NOT blocked (AC11)" {
  run_agent 'Edit /Users/x/git/glass-atrium/hooks/enforce-foreground-harness.sh.' true
  [[ "${status}" -eq 0 ]]
}

@test "case-varied .Claude-Work + bg=true → NOT blocked (this hook is case-sensitive by design)" {
  run_agent 'Write ~/.Claude-Work/hooks/x.sh.' true
  [[ "${status}" -eq 0 ]]
}

# Block-message generalization (D4) — the Rule-2 pin in the base suite still holds alongside this

@test "block reason names the profile-branch generalization" {
  run_agent 'Write ~/.claude-work-dev/hooks/x.sh.' true
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *'Rule 2'* ]] && [[ "${output}" == *'profile branch'* ]]
}
