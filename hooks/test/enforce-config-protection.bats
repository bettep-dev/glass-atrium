#!/usr/bin/env bats
# enforce-config-protection.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# PreToolUse(Write|Edit) security gate: a config edit that WEAKENS lint/format/
# strictness on a protected basename (.eslintrc* / .prettierrc* / ruff.toml /
# biome.json → rule-off/eslint-disable · tsconfig.json → strictness key false)
# → CFG-001 emit_error + exit 2 BLOCK. Everything else → DEFAULT-ALLOW exit 0,
# including the CONFIG_PROTECTION_APPROVE=1 one-time approval bypass.
#
# Run via: bats hooks/test/enforce-config-protection.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3 (weakening detector).
#
# Hermetic strategy: the hook reads ONLY stdin (file_path is string-matched,
# never opened) — crafted envelopes drive every verdict. Envelope JSON is built
# with jq so the nested-quote config content stays well-formed.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-config-protection.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# Build a Write/Edit envelope with jq and run the hook on it.
# Args: $1=tool_name $2=file_path $3=content-field name (content|new_string) $4=content value.
run_hook_envelope() {
  local envelope
  envelope="$(jq -cn --arg tool "$1" --arg path "$2" --arg field "$3" --arg body "$4" \
    '{tool_name: $tool, tool_input: ({file_path: $path} + {($field): $body})}')"
  run bash "${HOOK_SH}" <<<"${envelope}"
}

@test "weakening: eslint rule set to off on .eslintrc.json → CFG-001 block (exit 2)" {
  run_hook_envelope "Write" "/tmp/proj/.eslintrc.json" "content" '{"rules":{"no-unused-vars":"off"}}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"CFG-001"* ]] || return 1
}

@test "weakening: tsconfig strictness flipped to false → CFG-001 block (exit 2)" {
  run_hook_envelope "Edit" "/tmp/proj/tsconfig.json" "new_string" '"strict": false'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"CFG-001"* ]] || return 1
}

@test "benign: strengthening rule level on .eslintrc.json → pass (exit 0)" {
  run_hook_envelope "Write" "/tmp/proj/.eslintrc.json" "content" '{"rules":{"no-unused-vars":"error"}}'
  [[ "${status}" -eq 0 ]] || return 1
}

@test "benign: unprotected basename with off-shaped content → pass (exit 0)" {
  # Scope limit — only the protected config basenames are inspected.
  run_hook_envelope "Write" "/tmp/proj/app-settings.json" "content" '{"rules":{"no-unused-vars":"off"}}'
  [[ "${status}" -eq 0 ]] || return 1
}

@test "approval marker: CONFIG_PROTECTION_APPROVE=1 passes a weakening edit (exit 0)" {
  local envelope
  envelope='{"tool_name":"Write","tool_input":{"file_path":"/tmp/proj/.eslintrc.json","content":"{\"rules\":{\"no-unused-vars\":\"off\"}}"}}'
  run env CONFIG_PROTECTION_APPROVE=1 bash "${HOOK_SH}" <<<"${envelope}"
  [[ "${status}" -eq 0 ]] || return 1
}
