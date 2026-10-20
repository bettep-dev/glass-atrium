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

bats_require_minimum_version 1.5.0

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

@test "weakening: an interrupted block write still exits 2 with CFG-001 once on stderr, not the ERR trap's allow" {
  jq -cn --arg body '{"rules":{"no-unused-vars":"off"}}' \
    '{tool_name: "Write", tool_input: {file_path: "/tmp/proj/.eslintrc.json", content: $body}}' \
    >"${BATS_TEST_TMPDIR}/envelope"
  run_forced_hook "${HOOK_SH}" "${BATS_TEST_TMPDIR}/envelope"
  assert_forced_block "CFG-001"
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
