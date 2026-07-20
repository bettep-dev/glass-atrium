#!/usr/bin/env bats
# enforce-delegation.bats — Bats suite for the PreToolUse(Write|Edit) delegation
#   gate. Pins the block-ALL-orchestrator-direct-writes contract (path-independent;
#   basename + */memory/* session-state exempt), with focus on the FIX-MEM tightening: a "memory/" segment nested
#   directly under a protected harness dir (agents/, rules/, hooks/, skills/,
#   autoagent/, monitor/, scripts/) MUST stay BLOCKED, while a legitimate
#   session-state memory root still PASSES.
#
# Decision channel = exit code only (PreToolUse): exit 0 PASS / exit 2 BLOCK.
# 격리: agent_id 부재 → 메인 세션(오케스트레이터)로 평가. stdin 으로 합성 JSON 주입.
#   라이브 hook input 미의존.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-delegation.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-delegation.sh not found: ${HOOK_SH}"
  source "${BATS_TEST_DIRNAME}/lib/no-python3.bash"
}

# Drive the hook as the orchestrator (no agent_id) with a synthetic Write input.
# Args: $1 = file_path. Captures the exit status via Bats `run`.
write_as_orchestrator() {
  run bash -c '
    printf "%s" "{\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2"
  ' _ "${1}" "${HOOK_SH}"
}

# BLOCKED: protected harness dir with a nested memory/ segment (FIX-MEM)

@test "agents/memory/x.md → BLOCKED (agent prompt surface, not session-state)" {
  write_as_orchestrator "/Users/x/.claude/agents/memory/x.md"
  [[ "${status}" -ne 0 ]]
}

@test "rules/memory/x.md → BLOCKED (rule SoT surface)" {
  write_as_orchestrator "/Users/x/.claude/rules/memory/x.md"
  [[ "${status}" -ne 0 ]]
}

@test "hooks/memory/x.sh → BLOCKED (hook surface)" {
  write_as_orchestrator "/Users/x/.claude/hooks/memory/x.sh"
  [[ "${status}" -ne 0 ]]
}

@test "skills/memory/x.md → BLOCKED (skill surface)" {
  write_as_orchestrator "/Users/x/.claude/skills/memory/x.md"
  [[ "${status}" -ne 0 ]]
}

@test "autoagent/memory/x.py → BLOCKED (self-improvement core surface)" {
  write_as_orchestrator "/Users/x/.claude/autoagent/memory/x.py"
  [[ "${status}" -ne 0 ]]
}

@test "monitor/memory/x.ts → BLOCKED (monitor surface)" {
  write_as_orchestrator "/Users/x/.claude/monitor/memory/x.ts"
  [[ "${status}" -ne 0 ]]
}

@test "scripts/memory/x.sh → BLOCKED (scripts surface)" {
  write_as_orchestrator "/Users/x/.claude/scripts/memory/x.sh"
  [[ "${status}" -ne 0 ]]
}

# BLOCKED: traversal cannot spoof a session-state memory root

@test "agents/memory/../x.md traversal → BLOCKED (normalizes to agents/x.md)" {
  write_as_orchestrator "/Users/x/.claude/agents/memory/../scope-dev.md"
  [[ "${status}" -ne 0 ]]
}

@test "memory/../hooks/x.sh traversal → BLOCKED (segment cannot be forged via ..)" {
  write_as_orchestrator "/Users/x/.claude/memory/../hooks/enforce-delegation.sh"
  [[ "${status}" -ne 0 ]]
}

# PASS: legitimate session-state memory roots stay allowed

@test "personal-dir memory/MEMORY.md → PASS (session-state root)" {
  write_as_orchestrator "/Users/x/.claude-personal/projects/-Users-x/memory/MEMORY.md"
  [[ "${status}" -eq 0 ]]
}

@test "project-level memory/progress.md → PASS (session-state root)" {
  write_as_orchestrator "/Users/x/some-project/memory/progress.md"
  [[ "${status}" -eq 0 ]]
}

@test "memory/ nested under a non-protected dir → PASS (e.g. src/memory/cache.md)" {
  write_as_orchestrator "/Users/x/some-project/src/memory/cache.md"
  [[ "${status}" -eq 0 ]]
}

# BLOCKED: a plain harness-config write (no memory segment) — regression guard

@test "rules/scope-dev.md → BLOCKED (plain harness config, no memory exception)" {
  write_as_orchestrator "/Users/x/.claude/rules/scope-dev.md"
  [[ "${status}" -ne 0 ]]
}

# PASS: allowed basenames + subagent context (orthogonal guards intact)

@test "CLAUDE.md basename → PASS regardless of harness dir" {
  write_as_orchestrator "/Users/x/.claude/agents/CLAUDE.md"
  [[ "${status}" -eq 0 ]]
}

@test "subagent (agent_id present) → PASS on a protected memory path" {
  run bash -c '
    printf "%s" "{\"agent_id\":\"a1\",\"tool_input\":{\"file_path\":\"/Users/x/.claude/agents/memory/x.md\"}}" | bash "$1"
  ' _ "${HOOK_SH}"
  [[ "${status}" -eq 0 ]]
}

# H-3: python3-absent fail-closed (extraction degrades to EMPTY)
# Without python3, hook_get_tool_input returns empty → the legacy
# `[[ -z FILE_PATH ]] && exit 0` would ALLOW an orchestrator harness write. The
# fix blocks on non-trivial input but must NOT over-block genuinely-empty input.

# Shared fixture: lib/no-python3.bash (sourced in setup). Args: $1 = raw JSON stdin.
run_with_no_python3() { run_hook_with_no_python3 "${HOOK_SH}" "${1}"; }

@test "python3 absent + orchestrator harness write → BLOCKED (H-3 fail-closed)" {
  run_with_no_python3 '{"tool_input":{"file_path":"/Users/x/.claude/rules/scope-dev.md"}}'
  [[ "${status}" -ne 0 ]]
}

@test "python3 absent + empty stdin → PASS (no over-block of empty input)" {
  run_with_no_python3 ''
  [[ "${status}" -eq 0 ]]
}

@test "python3 absent + '{}' input → PASS (no over-block of empty object)" {
  run_with_no_python3 '{}'
  [[ "${status}" -eq 0 ]]
}
