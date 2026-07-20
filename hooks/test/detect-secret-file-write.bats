#!/usr/bin/env bats
# detect-secret-file-write.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# PostToolUse(Bash) credential-content TRIPWIRE — the one security-six hook with
# NO block channel: PostToolUse runs AFTER the write, so the hook ALWAYS exits 0
# and the violating outcome is the SEC-017 stderr ALERT (path + pattern-type
# label, NEVER the value), not an exit-2 block. The plan AC's "blocking outcome"
# therefore realizes here as the deny-decision ALERT emission; the benign AC is
# silence within the same always-0 exit contract.
#
# Run via: bats hooks/test/detect-secret-file-write.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3 (hook input parsing).
#
# Hermetic strategy: the content scan reads only files named on the command
# string — every path points into a mktemp sandbox pre-seeded to simulate the
# post-write state. The credential fixture is SYNTHETIC and RUNTIME-ASSEMBLED
# so no secret-shaped literal sits in this file (it would trip the PreToolUse
# secret gate on the test file's own write).

HOOK_SH="${BATS_TEST_DIRNAME}/../detect-secret-file-write.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  SANDBOX="$(mktemp -d -t ga-secdetect-bats.XXXXXX)"
  AWS_FIXTURE="AKIA""ABCDEFGHIJKLMNOP"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Run the hook with an envelope on stdin. Args: $1=input JSON.
run_hook() {
  run bash "${HOOK_SH}" <<<"${1}"
}

@test "violating: credential content behind a .env write channel → SEC-017 alert, exit 0" {
  printf '%s\n' "${AWS_FIXTURE}" >"${SANDBOX}/leak.env"
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo x > ${SANDBOX}/leak.env\"}}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SEC-017"* ]] || return 1
  # SECURITY invariant: the alert names path + pattern TYPE only — never the value.
  [[ "${output}" != *"${AWS_FIXTURE}"* ]] || return 1
}

@test "benign content: credential-free .env write → silent, exit 0" {
  printf 'FOO=bar\n' >"${SANDBOX}/clean.env"
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo x > ${SANDBOX}/clean.env\"}}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

@test "scope gate: read-only mention of a credential-bearing .env → silent, exit 0" {
  # No WRITE channel on the command → stage-1 gate exits before any content scan,
  # even though the named file DOES contain a credential pattern.
  printf '%s\n' "${AWS_FIXTURE}" >"${SANDBOX}/leak.env"
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat ${SANDBOX}/leak.env\"}}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

@test "trigger gate: non-Bash tool envelope → silent, exit 0" {
  run_hook '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.env","content":"irrelevant"}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}
