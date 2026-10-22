#!/usr/bin/env bash
# forced-write.bash — forced-interrupt harness shared by the suites that pin a hook's block write
# surviving an interrupted builtin write. Callers source it at file scope.

# Forced-interrupt harness: the hook's shell owns one late child (kept through exec), its block-channel
# pipe is full before the hook writes, and the reader drains only after that child has exited → on bash
# 3.2 the child's SIGCHLD interrupts a builtin write blocked in the hook's shell.
FORCED_HARNESS_PY="$(
  cat <<'PY'
import fcntl, os, subprocess, sys, time

hook, stdin_path, other_path, channel = sys.argv[1:5]
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
with open(stdin_path, "rb") as stdin, open(other_path, "wb") as other:
    streams = {"stdout": other, "stderr": other}
    streams[channel] = write_fd
    proc = subprocess.Popen(
        ["/bin/bash", "-c", '( sleep 0.6 ) & exec /bin/bash "$0"', hook],
        stdin=stdin, stdout=streams["stdout"], stderr=streams["stderr"])
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
# Args: $1=hook path · $2=stdin file · $3..=extra env assignments. FORCED_CHANNEL=stdout fills the
# hook's stdout instead of its stderr (default), for a hook that blocks on stdout.
# Sets status · output = the hook's block channel · FORCED_DIR/other = its other channel.
run_forced_hook() {
  local hook="${1}" stdin_file="${2}" channel="${FORCED_CHANNEL:-stderr}" python_bin
  shift 2
  python_bin="$(command -v python3)"
  # shellcheck disable=SC2154  # BATS_TEST_TMPDIR is assigned by the Bats runner
  FORCED_DIR="$(mktemp -d "${BATS_TEST_TMPDIR}/forced.XXXXXX")"
  mkdir -p "${FORCED_DIR}/home"
  run --separate-stderr env "HOME=${FORCED_DIR}/home" \
    "GA_DATA_ROOT=${FORCED_DIR}/home/.glass-atrium" "$@" \
    "${python_bin}" -c "${FORCED_HARNESS_PY}" "${hook}" "${stdin_file}" "${FORCED_DIR}/other" "${channel}"
}

# Fixed block state after run_forced_hook: exit 2 · needle once on the block channel · no file written
# under HOME (no trace log) · the other channel empty, or matching $2 when the hook writes it by design,
# and never carrying the needle. Args: $1=needle from the block text · $2=glob for the other channel.
# shellcheck disable=SC2154  # status and output are assigned by the caller's Bats run
assert_forced_block() {
  local needle="${1}" other_glob="${2:-}" rest other written
  rest="${output#*"${needle}"}"
  other="$(cat -- "${FORCED_DIR}/other")"
  written="$(find "${FORCED_DIR}/home" -type f)"
  [[ "${status}" -eq 2 ]] || {
    echo "status ${status}: ${output} ${stderr}"
    return 1
  }
  [[ "${output}" == *"${needle}"* && "${rest}" != *"${needle}"* ]] || {
    echo "needle not exactly once on the block channel: ${output}"
    return 1
  }
  # shellcheck disable=SC2053  # $2 is a glob by contract
  [[ "${other}" == ${other_glob} && "${other}" != *"${needle}"* ]] || {
    echo "other channel unexpected: ${other}"
    return 1
  }
  [[ -z "${written}" ]] || {
    echo "files written under HOME: ${written}"
    return 1
  }
}
