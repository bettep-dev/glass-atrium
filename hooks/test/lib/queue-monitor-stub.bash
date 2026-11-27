#!/usr/bin/env bash
# queue-monitor-stub.bash — drives queue-monitor-stub.py for the owner-queue suites: replies, the stub's start and
# stop, a stand-in Claude process, and bounded polls on what the stub logged. Callers source it at file scope;
# everything lives in BATS_TEST_TMPDIR.
# shellcheck disable=SC2154,SC2312  # BATS_TEST_TMPDIR is assigned by the Bats runner; a masked count fails its compare

QUEUE_STUB_PY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/queue-monitor-stub.py"

# <status> <body> → the stub's reply to every request without its own n-th reply
set_reply() {
  printf '%s\n%s' "$1" "$2" >"${BATS_TEST_TMPDIR}/reply"
}

# <n> <status> <body> → the stub's reply to its n-th request only
set_nth_reply() {
  printf '%s\n%s' "$2" "$3" >"${BATS_TEST_TMPDIR}/reply.$1"
}

# the stub on a free port → STUB_PID, ATRIUM_MONITOR_PORT; a fresh port file per start → a stopped stub's port is
# never read back, and requests.log keeps every earlier request
start_stub() {
  STUB_COUNT=$((${STUB_COUNT:-0} + 1))
  local port_file="${BATS_TEST_TMPDIR}/port.${STUB_COUNT}"
  : >>"${BATS_TEST_TMPDIR}/requests.log"
  python3 -I "${QUEUE_STUB_PY}" "${port_file}" \
    "${BATS_TEST_TMPDIR}/requests.log" "${BATS_TEST_TMPDIR}/reply" >/dev/null 2>&1 3>&- &
  STUB_PID=$!
  poll_until 100 test -s "${port_file}"
  ATRIUM_MONITOR_PORT="$(cat "${port_file}")"
  export ATRIUM_MONITOR_PORT
}

stop_stub() {
  if [[ -n "${STUB_PID:-}" ]]; then
    kill "${STUB_PID}" 2>/dev/null || true
    wait "${STUB_PID}" 2>/dev/null || true
  fi
  STUB_PID=""
}

# a live stand-in for the session's own Claude process → OWNER_PID, CLAUDE_PID
start_owner() {
  sleep 300 >/dev/null 2>&1 3>&- &
  OWNER_PID=$!
  OWNER_PIDS="${OWNER_PIDS:-} ${OWNER_PID}"
  export CLAUDE_PID="${OWNER_PID}"
}

request_count() {
  wc -l <"${BATS_TEST_TMPDIR}/requests.log" | tr -d ' '
}

# blocks until the stub has logged $1 requests (at most 10 s)
await_requests() {
  poll_until 200 has_requests "$1"
}

has_requests() {
  (($(request_count) >= $1))
}

# the exit status of background process $1 once it ends (at most 10 s) → AWAITED_STATUS, else "running"
# shellcheck disable=SC2034  # read by the suites that source this file
await_exit() {
  poll_until 200 is_ended "$1"
  AWAITED_STATUS=running
  if kill -0 "$1" 2>/dev/null; then return 0; fi
  AWAITED_STATUS=0
  wait "$1" || AWAITED_STATUS=$?
}

is_ended() {
  ! kill -0 "$1" 2>/dev/null
}

# <polls> <command…> → runs the command 50 ms apart until it succeeds or the polls run out; the caller checks the
# state it waited for
poll_until() {
  local polls="$1" n=0
  shift
  until "$@" || ((n >= polls)); do
    sleep 0.05
    n=$((n + 1))
  done
}
