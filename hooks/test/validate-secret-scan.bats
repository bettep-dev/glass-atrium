#!/usr/bin/env bats
# validate-secret-scan.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# PreToolUse(Write|Edit|Bash) security gate, one surface with two channels:
#   Write|Edit → scan tool_input.content + tool_input.new_string for secret
#     patterns → SEC-00x emit_error + exit 2 BLOCK.
#   Bash → dual-condition gate (secrets-file write target AND credential value
#     on the command) → SEC-016 + exit 2 BLOCK; either alone → pass.
# Benign envelopes → exit 0 pass.
#
# Run via: bats hooks/test/validate-secret-scan.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3 (fail-closed
# precondition — the hook itself exits 2 without python3).
#
# Hermetic strategy: the hook reads ONLY stdin — no file is written; content/
# command strings are pattern-scanned in place. Credential fixtures are
# SYNTHETIC and RUNTIME-ASSEMBLED from split fragments so no secret-shaped
# literal ever sits in this file (it would trip the very gate under test on
# the test file's own write). The generic-assignment fixture is assembled in
# TWO statements — its pattern tolerates quote chars between name and "=", so
# an adjacent-string split alone would not defuse it.

HOOK_SH="${BATS_TEST_DIRNAME}/../validate-secret-scan.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  # Runtime-assembled synthetic fixtures (see header): AKIA + 16 [0-9A-Z] /
  # ghp_ + 36 alnum / a generic name=value credential assignment.
  AWS_FIXTURE="AKIA""ABCDEFGHIJKLMNOP"
  GHP_FIXTURE="ghp_""aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  CRED_FIXTURE="password"
  CRED_FIXTURE="${CRED_FIXTURE}=supersecret123"
}

# Run the hook with an envelope on stdin. Args: $1=input JSON.
run_hook() {
  run bash "${HOOK_SH}" <<<"${1}"
}

@test "Write channel: AWS-key-shaped content → SEC-001 block (exit 2)" {
  run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/x.ts\",\"content\":\"const k = ${AWS_FIXTURE}\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-001"* ]] || return 1
}

@test "Edit channel: GitHub-token-shaped new_string → SEC-002 block (exit 2)" {
  run_hook "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/x.ts\",\"new_string\":\"const t = ${GHP_FIXTURE}\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-002"* ]] || return 1
}

@test "Bash channel: credential value redirected into .env → SEC-016 block (exit 2)" {
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > .env\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-016"* ]] || return 1
}

@test "Bash benign: dual-condition gate — write target without credential value → pass" {
  run_hook '{"tool_name":"Bash","tool_input":{"command":"echo PLACEHOLDER= > .env"}}'
  [[ "${status}" -eq 0 ]] || return 1
}

@test "Bash benign: credential value without a secrets-file target → pass" {
  # Dual-condition gate, other half: the value alone (no .env-class write
  # target — a log file) must NOT block.
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > out.log\"}}"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "Write benign: ordinary source content → pass (exit 0, silent)" {
  run_hook '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.ts","content":"export const answer = 42"}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}
