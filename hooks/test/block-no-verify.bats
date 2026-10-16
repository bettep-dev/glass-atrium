#!/usr/bin/env bats
# block-no-verify.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# PreToolUse(Bash) security gate: a git hook-bypass flag (--no-verify /
# --no-gpg-sign) in tool_input.command → SEC-011 emit_error + exit 2 BLOCK;
# a normal git commit → exit 0 pass.
#
# Run via: bats hooks/test/block-no-verify.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3 (hook input parsing).
#
# Hermetic strategy: the hook reads ONLY stdin — no git repo is touched; the
# command string is never executed, only pattern-scanned.

HOOK_SH="${BATS_TEST_DIRNAME}/../block-no-verify.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
}

# Run the hook with an envelope on stdin. Args: $1=input JSON.
run_hook() {
  run bash "${HOOK_SH}" <<<"${1}"
}

@test "malicious: git commit --no-verify → SEC-011 block (exit 2)" {
  run_hook '{"tool_name":"Bash","tool_input":{"command":"git commit -m msg --no-verify"}}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-011"* ]] || return 1
}

@test "malicious: git commit --no-gpg-sign → SEC-011 block (exit 2)" {
  run_hook '{"tool_name":"Bash","tool_input":{"command":"git commit --no-gpg-sign -m msg"}}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-011"* ]] || return 1
}

# ~160 KiB of JSON-escaped lines: above the 64 KiB pipe capacity, so a reader that stops at a
# line-1 match leaves its writer to die of SIGPIPE, which pipefail reports as "no match".
pipe_overflow_padding() {
  seq -f 'padding line %05g of an ordinary build log' 1 4000 | awk '{ printf "%s\\n", $0 }'
}

@test "malicious: --no-verify on line 1 of a command larger than the pipe buffer still blocks (exit 2)" {
  local padding
  padding="$(pipe_overflow_padding)"
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m msg --no-verify\\n${padding}\"}}"
  [[ "${status}" -eq 2 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"SEC-011"* ]] || { echo "${output}"; return 1; }
}

@test "benign: normal git commit → pass (exit 0, silent)" {
  run_hook '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"normal message\""}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

@test "fail-safe: empty stdin → pass (exit 0)" {
  run bash "${HOOK_SH}" </dev/null
  [[ "${status}" -eq 0 ]] || return 1
}
