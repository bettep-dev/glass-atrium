#!/usr/bin/env bats
# enforce-foreground-harness.bats — Bats suite for the PreToolUse(Agent) gate
#   enforcing Harness Path Protection Rule 2 (foreground MANDATORY for harness
#   writes when run_in_background=true).
#
# Focus (Thread C / T10-T11): the runtime-DATA false-positive fix. The hook is a
# pure TEXT scan of the delegation prompt — it cannot tell a READ reference from
# a WRITE target, so a read-only prompt that merely MENTIONS a runtime-data path
# (~/.claude/data/, ~/.claude/projects/, ~/.claude/logs/, …) was falsely forcing
# foreground. T11 excludes the runtime-DATA subdirs from the match while keeping
# CONFIG paths (agents/, hooks/, skills/, settings*.json) AND the memory dir
# (nested under projects/) fully protected.
#
# Decision channel = exit code: 0 PASS (not blocked) / 2 BLOCK (Rule-2 violation).
# 격리: 합성 JSON 을 stdin 으로 주입, 라이브 hook input 미의존.
#
# TDD note: the "runtime-DATA exemption (NEW behavior)" group is RED against the
# pre-fix hook; every "preserved protection" case is GREEN before AND after.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-foreground-harness.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-foreground-harness.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# Drive the hook as an Agent PreToolUse call. jq -n builds the payload so the
# prompt (which carries backticks, ~ and $ path chars) is safely encoded.
# Args: $1 = prompt body, $2 = run_in_background boolean literal (true/false).
run_agent() {
  local prompt="$1" bg="$2" payload
  payload="$(jq -n --arg p "${prompt}" --argjson bg "${bg}" \
    '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:$bg}}')"
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
}

# ─── Runtime-DATA exemption (NEW behavior — RED before T11, GREEN after) ───
# A read-only reference to a runtime-data subdir must NOT force foreground.

@test "tilde ~/.claude/data/ reference + bg=true → NOT blocked (case a)" {
  run_agent 'For context, read ~/.claude/data/outcomes/2026-07-07.md then summarize.' true
  [[ "${status}" -eq 0 ]]
}

@test "tilde ~/.claude/projects/ (session transcript) + bg=true → NOT blocked" {
  run_agent 'Analyze the transcript at ~/.claude/projects/-Users-x/session.jsonl (read-only).' true
  [[ "${status}" -eq 0 ]]
}

@test "tilde ~/.claude/logs/ reference + bg=true → NOT blocked" {
  run_agent 'Tail ~/.claude/logs/daemon.log and report the last error.' true
  [[ "${status}" -eq 0 ]]
}

@test "absolute-\$HOME /.claude/data/ reference + bg=true → NOT blocked (arm-invariant)" {
  run_agent "Read ${HOME}/.claude/data/learning-log.md for prior lessons." true
  [[ "${status}" -eq 0 ]]
}

@test "CWD-relative .claude/data/ reference + bg=true → NOT blocked (arm-invariant)" {
  run_agent 'From the repo root, read .claude/data/session-spawns/latest.json.' true
  [[ "${status}" -eq 0 ]]
}

# ─── Preserved CONFIG-write protection (GREEN before AND after) ───

@test "tilde ~/.claude/hooks/x.sh + bg=true → STILL blocked (case b)" {
  run_agent 'Write the new hook to ~/.claude/hooks/x.sh and register it.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude-personal/<config> + bg=true → STILL blocked (case c)" {
  run_agent 'Update ~/.claude-personal/agents/reviewer.md with the new domains.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/settings.json + bg=true → STILL blocked (settings*.json protected)" {
  run_agent 'Add the hook entry to ~/.claude/settings.json.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/skills/x/SKILL.md + bg=true → STILL blocked (skills config)" {
  run_agent 'Edit ~/.claude/skills/foo/SKILL.md description field.' true
  [[ "${status}" -eq 2 ]]
}

# ─── BASENAME exemption preserved (case d — GREEN before AND after) ───

@test "CLAUDE.md basename at harness root + bg=true → NOT blocked" {
  run_agent 'Append the project note to ~/.claude/CLAUDE.md then stop.' true
  [[ "${status}" -eq 0 ]]
}

@test "MEMORY.md basename at harness root + bg=true → NOT blocked" {
  run_agent 'Add the index line to ~/.claude/MEMORY.md and exit.' true
  [[ "${status}" -eq 0 ]]
}

@test "GLASS_ATRIUM_GLOBAL_RULES.md basename at harness root + bg=true → NOT blocked" {
  run_agent 'Update ~/.claude/GLASS_ATRIUM_GLOBAL_RULES.md thinking-budget section.' true
  [[ "${status}" -eq 0 ]]
}

# ─── Path-form arms still classify CONFIG correctly (case e — GREEN both) ───

@test "absolute-\$HOME /.claude/hooks/ config + bg=true → STILL blocked (arm intact)" {
  run_agent "Write ${HOME}/.claude/hooks/new.sh and wire it." true
  [[ "${status}" -eq 2 ]]
}

@test "CWD-relative .claude/agents/ config + bg=true → STILL blocked (arm intact)" {
  run_agent 'From the home dir, edit .claude/agents/custom.md frontmatter.' true
  [[ "${status}" -eq 2 ]]
}

# ─── Memory-dir protection under projects/ (Open Q #6 — GREEN before AND after) ───
# The memory dir is nested at projects/<proj>/memory/. projects/ is on the
# runtime-DATA denylist, so the fix MUST NOT let a memory write slip through:
# a /memory/ path segment keeps the match protected.

@test "~/.claude/projects/<proj>/memory/ write + bg=true → STILL blocked (memory guard)" {
  run_agent 'Persist ~/.claude/projects/-Users-x/memory/progress-foo.md in the background.' true
  [[ "${status}" -eq 2 ]]
}

@test "~/.claude-work/projects/<proj>/memory/feedback + bg=true → STILL blocked (memory guard)" {
  run_agent 'Write ~/.claude-work/projects/-Users-x/memory/feedback_x.md now.' true
  [[ "${status}" -eq 2 ]]
}

# ─── Mixed prompt: any non-exempt match still blocks (GREEN before AND after) ───

@test "data/ (exempt) + hooks/ (config) in one prompt + bg=true → BLOCKED" {
  run_agent 'Read ~/.claude/data/outcomes/x.md, then write ~/.claude/hooks/y.sh.' true
  [[ "${status}" -eq 2 ]]
}

# ─── Orthogonal guards intact (GREEN before AND after) ───

@test "foreground (bg=false) with a config path → NOT blocked (Rule-2 only on bg)" {
  run_agent 'Write ~/.claude/hooks/x.sh.' false
  [[ "${status}" -eq 0 ]]
}

@test "prompt with no harness path + bg=true → NOT blocked (out of scope)" {
  run_agent 'Refactor src/util/date.ts to use date-fns.' true
  [[ "${status}" -eq 0 ]]
}

@test "non-Agent tool → NOT blocked (out of scope)" {
  local payload
  payload="$(jq -n '{tool_name:"Write", tool_input:{file_path:"~/.claude/hooks/x.sh"}}')"
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
  [[ "${status}" -eq 0 ]]
}

@test "block reason names Rule 2 (contract pin)" {
  run_agent 'Write ~/.claude/hooks/x.sh.' true
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *'Rule 2'* ]]
}
