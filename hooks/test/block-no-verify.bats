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

bats_require_minimum_version 1.5.0

HOOK_SH="${BATS_TEST_DIRNAME}/../block-no-verify.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
}

# Run the hook with an envelope on stdin. Args: $1=input JSON.
run_hook() {
  run bash "${HOOK_SH}" <<<"${1}"
}

# Forced-interrupt harness: the hook's shell owns one late child (kept through exec), its stderr pipe
# is full before the hook writes, and the reader drains only after that child has exited → on bash
# 3.2 the child's SIGCHLD interrupts a builtin write blocked in the hook's shell.
FORCED_HARNESS_PY="$(
  cat <<'PY'
import fcntl, os, subprocess, sys, time

hook, stdin_path, stdout_path = sys.argv[1:4]
read_fd, write_fd = os.pipe()
flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
fcntl.fcntl(write_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
filler = 0
try:
    while True:
        os.write(write_fd, b".")
        filler += 1
except BlockingIOError:
    pass
fcntl.fcntl(write_fd, fcntl.F_SETFL, flags)
with open(stdin_path, "rb") as stdin, open(stdout_path, "wb") as stdout:
    proc = subprocess.Popen(
        ["/bin/bash", "-c", '( sleep 0.6 ) & exec /bin/bash "$0"', hook],
        stdin=stdin, stdout=stdout, stderr=write_fd)
os.close(write_fd)
time.sleep(1.5)
drained = b""
while True:
    chunk = os.read(read_fd, 65536)
    if not chunk:
        break
    drained += chunk
sys.stdout.buffer.write(drained[filler:])
sys.exit(proc.wait())
PY
)"

# Run a hook under the forced harness, HOME and GA_DATA_ROOT inside a fresh FORCED_DIR.
# Args: $1=hook path · $2=stdin file · $3..=extra env assignments.
# Sets status · output = the hook's stderr · FORCED_DIR/stdout = the hook's stdout.
run_forced_hook() {
  local hook="${1}" stdin_file="${2}" python_bin
  shift 2
  python_bin="$(command -v python3)"
  # shellcheck disable=SC2154  # BATS_TEST_TMPDIR is assigned by the Bats runner
  FORCED_DIR="$(mktemp -d "${BATS_TEST_TMPDIR}/forced.XXXXXX")"
  mkdir -p "${FORCED_DIR}/home"
  run --separate-stderr env "HOME=${FORCED_DIR}/home" \
    "GA_DATA_ROOT=${FORCED_DIR}/home/.glass-atrium" "$@" \
    "${python_bin}" -c "${FORCED_HARNESS_PY}" "${hook}" "${stdin_file}" "${FORCED_DIR}/stdout"
}

# Fixed block state after run_forced_hook: exit 2 · needle once on stderr · stdout empty · no file
# written under HOME (no trace log). Args: $1=needle from the block text.
assert_forced_block() {
  local needle="${1}" rest written
  rest="${output#*"${needle}"}"
  written="$(find "${FORCED_DIR}/home" -type f)"
  [[ "${status}" -eq 2 ]] || {
    echo "status ${status}: ${output} ${stderr}"
    return 1
  }
  [[ "${output}" == *"${needle}"* && "${rest}" != *"${needle}"* ]] || {
    echo "needle not exactly once on stderr: ${output}"
    return 1
  }
  [[ ! -s "${FORCED_DIR}/stdout" ]] || {
    echo "stdout not empty:"
    cat "${FORCED_DIR}/stdout"
    return 1
  }
  [[ -z "${written}" ]] || {
    echo "files written under HOME: ${written}"
    return 1
  }
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

@test "malicious: an interrupted block write still exits 2 with SEC-011 once on stderr" {
  printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m msg --no-verify"}}' >"${BATS_TEST_TMPDIR}/envelope"
  run_forced_hook "${HOOK_SH}" "${BATS_TEST_TMPDIR}/envelope"
  assert_forced_block "SEC-011"
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
