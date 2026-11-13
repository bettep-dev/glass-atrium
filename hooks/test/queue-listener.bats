#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2154,SC2312  # a row's export stays inside its own bats test; BATS_* and run results are set by bats; a masked status fails its comparison
# The owner queue's listener (SessionStart and Stop hook, bound asyncRewake) against a stand-in monitor: it runs only
# in an interactive main session, announces this session's answered items by count without claiming them, wakes the
# session with one fixed line (exit 2) at most twice per answer count per Claude process until a claim or a zero count
# starts that bound over, yields to a newer listener and to a session-run wait, and ends quietly — never with a wake —
# on a signal, its lifetime or a monitor failure.
#
# Run via: bats hooks/test/queue-listener.bats
# Requires: bats, bash 3.2+, jq, curl, python3, perl

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
HOOK="${GA}/hooks/queue-listener.sh"
CLI="${GA}/scripts/atrium-queue.sh"
SESSION_ID="3f1c2b9a-7d4e-4f5a-9b6c-0e1d2c3b4a59"
# shellcheck source-path=SCRIPTDIR source=lib/forced-write.bash
source "${BATS_TEST_DIRNAME}/lib/forced-write.bash"
# shellcheck source-path=SCRIPTDIR source=lib/queue-monitor-stub.bash
source "${BATS_TEST_DIRNAME}/lib/queue-monitor-stub.bash"

setup() {
  # the ambient session's own CLAUDE_* values must never reach the hook under test
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_JOB_DIR ATRIUM_MONITOR_PORT ATRIUM_QUEUE_WAIT_POLL_S \
    ATRIUM_QUEUE_WAIT_BOUND_S ATRIUM_QUEUE_LISTEN_LIFETIME_S ATRIUM_QUEUE_LISTEN_GRACE_S
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  export CLAUDE_CODE_ENTRYPOINT=cli
  export ATRIUM_QUEUE_WAIT_POLL_S=1 ATRIUM_QUEUE_LISTEN_LIFETIME_S=20
  WAKE_LEAD="[ATRIUM-QUEUE] harness: this is the owner-queue wake, not an error —"
  set_reply 200 '{"answeredWaiting":0,"items":[]}'
  start_owner
}

teardown() {
  local pid
  for pid in ${BG_PIDS:-} ${OWNER_PIDS:-}; do
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  done
  stop_stub
}

# [payload extra JSON] → a SessionStart payload of this session
start_payload() {
  local extra="${1:-}"
  [[ -n "${extra}" ]] || extra='{}'
  jq -nc --arg id "${SESSION_ID}" --argjson extra "${extra}" \
    '{hook_event_name: "SessionStart", session_id: $id, source: "startup", cwd: "/tmp"} + $extra'
}

run_hook() {
  run --separate-stderr "${HOOK}" <<<"${1:-$(start_payload)}"
}

# <label> → the hook in the background, its streams in <label>.out / <label>.err; BG_PID set
start_hook() {
  start_payload >"${BATS_TEST_TMPDIR}/payload"
  "${HOOK}" <"${BATS_TEST_TMPDIR}/payload" >"${BATS_TEST_TMPDIR}/$1.out" 2>"${BATS_TEST_TMPDIR}/$1.err" 3>&- &
  BG_PID=$!
  BG_PIDS="${BG_PIDS:-} ${BG_PID}"
}

lock_record() {
  readlink "${GA_ROOT}/data/queue/waits/${SESSION_ID}" 2>/dev/null || true
}

expected_wake() {
  printf '%s %s owner queue answer(s) or message(s) wait for this session — fetch them with: %s pending' \
    "${WAKE_LEAD}" "$1" "${GA_ROOT}/scripts/atrium-queue.sh"
}

@test "the listener exits at once with no monitor call for a subagent, a non-cli or unnamed entrypoint, a background job, a print-mode process or an undecidable session" {
  start_stub
  local bg_parent_file="${BATS_TEST_TMPDIR}/bg-child" row
  # a session process whose parent is a background-job pty host, as `claude --bg` runs one
  bash -c 'sleep 300 & printf "%s\n" "$!" >"$2"; wait' listener-test --bg-pty-host "${bg_parent_file}" \
    >/dev/null 2>&1 3>&- &
  BG_PIDS="${BG_PIDS:-} $!"
  poll_until 100 test -s "${bg_parent_file}"
  BG_PIDS="${BG_PIDS} $(cat "${bg_parent_file}")"
  # a headless run whose entrypoint reads cli, as a `claude -p` child of an interactive session inherits it
  bash -c 'exec -a "claude --model haiku -p" sleep 300' >/dev/null 2>&1 3>&- &
  local print_pid=$!
  BG_PIDS="${BG_PIDS} ${print_pid}"
  for row in subagent sdk-cli no-entrypoint job-dir bg-pty-host print-flag no-pid dead-pid; do
    (
      payload="$(start_payload)"
      case "${row}" in
        subagent)
          payload="$(start_payload '{"agent_id":"a1b2c3"}')"
          export CLAUDE_CODE_SESSION_ID="${SESSION_ID}"
          ;;
        sdk-cli) export CLAUDE_CODE_ENTRYPOINT=sdk-cli ;;
        no-entrypoint) unset CLAUDE_CODE_ENTRYPOINT ;;
        job-dir) export CLAUDE_JOB_DIR="${BATS_TEST_TMPDIR}/job" ;;
        bg-pty-host) CLAUDE_PID="$(cat "${bg_parent_file}")" && export CLAUDE_PID ;;
        print-flag) export CLAUDE_PID="${print_pid}" ;;
        no-pid) unset CLAUDE_PID ;;
        dead-pid) export CLAUDE_PID=999999 ;;
        *) ;;
      esac
      run_hook "${payload}"
      [[ "${status}" -eq 0 && -z "${output}" && "$(request_count)" == 0 && -z "$(lock_record)" ]] || {
        echo "row ${row}: status=${status} out=${output} err=${stderr} requests=$(request_count)"
        exit 1
      }
    ) || return 1
  done
}

@test "answered items wake the session with exit 2 and the fixed count line on stderr, never item text, and nothing is claimed" {
  start_stub
  set_reply 200 '{"answeredWaiting":3,"title":"Merge the release branch tonight?"}'
  run_hook
  [[ "${status}" -eq 2 && "${stderr}" == "$(expected_wake 3)" && -z "${output}" ]] || {
    echo "status=${status} out=${output} err=${stderr}"
    return 1
  }
  local paths bodies
  paths="$(jq -r '.path' "${BATS_TEST_TMPDIR}/requests.log" | sort -u)"
  bodies="$(jq -r '.body' "${BATS_TEST_TMPDIR}/requests.log" | jq -Sc . | sort -u)"
  [[ "${paths}" == /api/queue/pending/count &&
    "${bodies}" == "$(jq -nSc --arg s "${SESSION_ID}" --argjson p "${CLAUDE_PID}" '{sessionId: $s, pid: $p}')" &&
    -z "$(lock_record)" ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "with nothing answered the listener polls quietly and ends itself at its lifetime with exit 0, its lock released" {
  start_stub
  # the lifetime is read in whole seconds → 3 s fits two 1 s polls wherever in a second the run starts
  export ATRIUM_QUEUE_LISTEN_LIFETIME_S=3
  run_hook
  [[ "${status}" -eq 0 && -z "${output}" && -z "${stderr}" && "$(request_count)" -ge 2 && -z "$(lock_record)" ]] || {
    echo "status=${status} out=${output} err=${stderr} requests=$(request_count) lock=$(lock_record)"
    return 1
  }
}

@test "a zero poll seam falls back to the default poll interval, as the wait's does, instead of polling back to back" {
  start_stub
  export ATRIUM_QUEUE_WAIT_POLL_S=0 ATRIUM_QUEUE_LISTEN_LIFETIME_S=2
  run_hook
  [[ "${status}" -eq 0 && -z "${stderr}" && "$(request_count)" -eq 1 ]] || {
    echo "status=${status} err=${stderr} requests=$(request_count)"
    return 1
  }
}

@test "a TERM ends the listener and its child at once with exit 0, no wake and its lock released" {
  start_stub
  export ATRIUM_QUEUE_WAIT_POLL_S=60
  start_hook listener
  await_requests 1
  local child
  poll_until 100 pgrep -P "${BG_PID}" sleep
  child="$(pgrep -P "${BG_PID}" sleep || true)"
  [[ -n "${child}" ]] || {
    echo "no sleep child under the listener"
    return 1
  }
  local started="${SECONDS}"
  kill -TERM "${BG_PID}"
  await_exit "${BG_PID}"
  [[ "${AWAITED_STATUS}" == 0 && $((SECONDS - started)) -le 2 && ! -s "${BATS_TEST_TMPDIR}/listener.err" ]] || {
    echo "status=${AWAITED_STATUS} after $((SECONDS - started)) s: $(cat "${BATS_TEST_TMPDIR}/listener.err")"
    return 1
  }
  sleep 0.2
  ! kill -0 "${child}" 2>/dev/null && [[ -z "$(lock_record)" ]]
}

@test "the newest listener of a Claude process takes over and the older one ends silently with no wake" {
  start_stub
  start_hook older
  local older="${BG_PID}"
  await_requests 1
  start_hook newer
  local newer="${BG_PID}"
  await_exit "${older}"
  [[ "${AWAITED_STATUS}" == 0 && ! -s "${BATS_TEST_TMPDIR}/older.err" && ! -s "${BATS_TEST_TMPDIR}/older.out" ]] || {
    echo "older: status=${AWAITED_STATUS} $(cat "${BATS_TEST_TMPDIR}/older.err")"
    return 1
  }
  [[ "$(lock_record)" == "${newer}|"*"|${CLAUDE_PID}|"*"|listen" ]] || {
    echo "lock=$(lock_record) newer=${newer}"
    return 1
  }
}

@test "a session-run wait takes over from a listener, which ends without a wake, and a listener meeting a running wait ends at once" {
  start_stub
  export ATRIUM_QUEUE_WAIT_BOUND_S=30
  start_hook listener
  local listener="${BG_PID}"
  await_requests 1
  CLAUDE_CODE_SESSION_ID="${SESSION_ID}" "${CLI}" wait >"${BATS_TEST_TMPDIR}/wait.out" 2>"${BATS_TEST_TMPDIR}/wait.err" 3>&- &
  local waiter=$!
  BG_PIDS="${BG_PIDS:-} ${waiter}"
  await_exit "${listener}"
  [[ "${AWAITED_STATUS}" == 0 && ! -s "${BATS_TEST_TMPDIR}/listener.err" ]] || {
    echo "listener: status=${AWAITED_STATUS} $(cat "${BATS_TEST_TMPDIR}/listener.err")"
    return 1
  }
  [[ "$(lock_record)" == "${waiter}|"* && "$(lock_record)" != *"|listen" ]] || {
    echo "lock=$(lock_record) waiter=${waiter}"
    return 1
  }
  local before
  before="$(jq -r 'select(.path == "/api/queue/pending/count") | .path' "${BATS_TEST_TMPDIR}/requests.log" | wc -l)"
  run_hook
  [[ "${status}" -eq 0 && -z "${output}" && "$(lock_record)" == "${waiter}|"* ]] || {
    echo "second listener: status=${status} err=${stderr} lock=$(lock_record)"
    return 1
  }
  [[ "$(jq -r 'select(.path == "/api/queue/pending/count") | .path' "${BATS_TEST_TMPDIR}/requests.log" | wc -l)" == "${before}" ]]
}

@test "the same answers are announced at most twice per Claude process, while a changed count or another process is announced anew" {
  start_stub
  export ATRIUM_QUEUE_LISTEN_LIFETIME_S=2
  set_reply 200 '{"answeredWaiting":2}'
  local row expected
  for row in first:2 second:2 capped:0 changed-count:2 another-process:2; do
    case "${row%%:*}" in
      changed-count) set_reply 200 '{"answeredWaiting":4}' ;;
      another-process) start_owner ;;
      *) ;;
    esac
    run_hook
    expected=""
    if [[ "${row##*:}" == 2 ]]; then expected="$(expected_wake "$(jq -r '.answeredWaiting' <<<"$(tail -n +2 "${BATS_TEST_TMPDIR}/reply")")")"; fi
    [[ "${status}" -eq "${row##*:}" && "${stderr}" == "${expected}" ]] || {
      echo "row ${row}: status=${status} err=${stderr}"
      return 1
    }
  done
}

@test "a claim or a count read back at zero restarts the bound, so each new lone answer wakes the session again" {
  start_stub
  export ATRIUM_QUEUE_LISTEN_LIFETIME_S=2
  local row round wake
  for row in claim read-zero; do
    for round in 1 2 3; do
      set_reply 200 '{"answeredWaiting":1,"items":[]}'
      for wake in first re-announce; do
        run_hook
        [[ "${status}" -eq 2 && "${stderr}" == "$(expected_wake 1)" ]] || {
          echo "row ${row} round ${round} ${wake}: status=${status} err=${stderr}"
          return 1
        }
      done
      if [[ "${row}" == claim ]]; then
        set_nth_reply "$(($(request_count) + 1))" 200 \
          '{"items":[{"id":{"item":"4107","msg":"5b0e7c2d-9a41-4c3e-8f6d-2e7a1b9c0d34"}}]}'
        CLAUDE_CODE_SESSION_ID="${SESSION_ID}" run "${CLI}" pending
        [[ "${status}" -eq 0 && "${output}" == *"item 4107"* ]] || {
          echo "row ${row} round ${round} claim: status=${status} out=${output}"
          return 1
        }
      else
        set_reply 200 '{"answeredWaiting":0,"items":[]}'
        run_hook
        [[ "${status}" -eq 0 && -z "${stderr}" ]] || {
          echo "row ${row} round ${round} read-zero: status=${status} err=${stderr}"
          return 1
        }
      fi
    done
  done
}

@test "an unreachable, failing, refusing or garbled monitor ends the listener with exit 0 and one stderr line" {
  local row
  export ATRIUM_QUEUE_LISTEN_GRACE_S=0
  for row in unreachable:- failing:500 refusing:409 unknown:404 garbled:200; do
    if [[ "${row%%:*}" == unreachable ]]; then
      export ATRIUM_MONITOR_PORT=9
    else
      [[ -n "${STUB_PID:-}" ]] || start_stub
      set_reply "${row##*:}" '{"error":"session_not_live"}'
    fi
    run_hook
    [[ "${status}" -eq 0 && -z "${output}" && "$(wc -l <<<"${stderr}")" -eq 1 && "${stderr}" == "atrium-queue: "* &&
    "${stderr}" != *"${WAKE_LEAD}"* && -z "$(lock_record)" ]] || {
      echo "row ${row}: status=${status} out=${output} err=${stderr}"
      return 1
    }
  done
}

@test "a refusal right after the start, before the session is registered, is retried and a later count still wakes" {
  start_stub
  set_nth_reply 1 404 '{"error":"unknown_session"}'
  set_nth_reply 2 409 '{"error":"session_not_live"}'
  set_reply 200 '{"answeredWaiting":1}'
  run_hook
  [[ "${status}" -eq 2 && "${stderr}" == "$(expected_wake 1)" && "$(request_count)" -eq 3 ]] || {
    echo "status=${status} err=${stderr} requests=$(request_count)"
    return 1
  }
}

@test "the wake line reaches stderr whole with exit 2 when an interrupt lands on the write" {
  start_stub
  set_reply 200 '{"answeredWaiting":5}'
  start_payload >"${BATS_TEST_TMPDIR}/payload"
  # /bin first → the CLI the hook execs runs under the same stock bash as the hook, where an interrupted write fails
  run_forced_hook "${HOOK}" "${BATS_TEST_TMPDIR}/payload" "GA_ROOT=${GA_ROOT}" "CLAUDE_PID=${CLAUDE_PID}" \
    "CLAUDE_CODE_ENTRYPOINT=cli" "ATRIUM_MONITOR_PORT=${ATRIUM_MONITOR_PORT}" "PATH=/bin:${PATH}"
  assert_forced_block "$(expected_wake 5)" ""
  [[ "${output}" != *"write error"* ]]
}
