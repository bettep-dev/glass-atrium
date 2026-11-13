#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2154,SC2249,SC2312  # a row's export stays inside its own bats test; BATS_* and run results are set by bats; a masked status fails its comparison; each case arm is a row
# The owner queue's turn-end check (Stop hook) against a stand-in monitor: it keeps a turn from ending once,
# naming the wait command, only while an item of this session awaits the owner and no wait of this Claude
# process runs — never twice for the same items, never with item text, and never when it cannot decide.
#
# Run via: bats hooks/test/queue-turn-end-check.bats
# Requires: bats, bash 3.2+, jq, curl, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
HOOK="${GA}/hooks/queue-turn-end-check.sh"
SESSION_ID="3f1c2b9a-7d4e-4f5a-9b6c-0e1d2c3b4a59"
ITEM_TITLE="Merge the release branch tonight?"
# the statuses a running wait cannot carry forward: the parity row ties them, with the check's own resolved and
# terminal sets, to the QueueItemStatus enum
KEPT_STATUSES="delivering held unacked expired resume_pending"
# shellcheck source-path=SCRIPTDIR source=lib/forced-write.bash
source "${BATS_TEST_DIRNAME}/lib/forced-write.bash"

setup() {
  # the ambient session's own CLAUDE_* values must never reach the hook under test
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID ATRIUM_MONITOR_PORT
  new_root
  # a live pid → its start time exists, as the session's own Claude process has one
  export CLAUDE_PID="$$"
  : >"${BATS_TEST_TMPDIR}/requests.log"
  set_reply 200 "$(item_reply open)"
}

teardown() {
  stop_stub
  if [[ -n "${WAITER_PID:-}" ]]; then
    kill "${WAITER_PID}" 2>/dev/null || true
    wait "${WAITER_PID}" 2>/dev/null || true
  fi
}

# a fresh queue data root → no row inherits another row's marks, stamp or lock
new_root() {
  ROOT_COUNT=$((${ROOT_COUNT:-0} + 1))
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root.${ROOT_COUNT}"
  AWAITING="${GA_ROOT}/data/queue/awaiting/${SESSION_ID}"
}

stop_stub() {
  if [[ -n "${STUB_PID:-}" ]]; then
    kill "${STUB_PID}" 2>/dev/null || true
    wait "${STUB_PID}" 2>/dev/null || true
  fi
  STUB_PID=""
}

# the item view the monitor's GET /api/queue/items/:id returns, in <status>
item_reply() {
  jq -nc --arg status "$1" --arg title "${ITEM_TITLE}" --arg sessionId "${SESSION_ID}" \
    '{id: 41, kind: "decision", $sessionId, $title, body: "Owner context body", $status}'
}

set_reply() {
  printf '%s\n%s' "$1" "$2" >"${BATS_TEST_TMPDIR}/reply"
}

# <n> <status> <body> → the stub's reply to its n-th request
set_nth_reply() {
  printf '%s\n%s' "$2" "$3" >"${BATS_TEST_TMPDIR}/reply.$1"
}

start_stub() {
  : >"${BATS_TEST_TMPDIR}/requests.log"
  STUB_COUNT=$((${STUB_COUNT:-0} + 1))
  local port_file="${BATS_TEST_TMPDIR}/port.${STUB_COUNT}"
  python3 -I "${GA}/hooks/test/lib/queue-monitor-stub.py" "${port_file}" \
    "${BATS_TEST_TMPDIR}/requests.log" "${BATS_TEST_TMPDIR}/reply" &
  STUB_PID=$!
  local tries=0
  while [[ ! -s "${port_file}" ]] && ((tries < 100)); do
    sleep 0.05
    tries=$((tries + 1))
  done
  ATRIUM_MONITOR_PORT="$(cat "${port_file}")"
  export ATRIUM_MONITOR_PORT
}

# <item id>... → this session's awaiting marks, as the CLI's post writes them
mark_items() {
  local id
  mkdir -p "${AWAITING}"
  for id in "$@"; do : >"${AWAITING}/${id}"; done
}

requested_paths() {
  jq -r '.path' "${BATS_TEST_TMPDIR}/requests.log"
}

stop_payload() {
  jq -nc --arg id "${SESSION_ID}" '{hook_event_name: "Stop", session_id: $id, stop_hook_active: false}'
}

run_hook() {
  local payload="${1:-}"
  [[ -n "${payload}" ]] || payload="$(stop_payload)"
  run --separate-stderr "${HOOK}" <<<"${payload}"
}

# <pid> → its start time as the wait lock records it
get_recorded_start() {
  local started
  started="$(LC_ALL=C ps -p "$1" -o lstart=)"
  started="${started#"${started%%[![:space:]]*}"}"
  printf '%s\n' "${started%"${started##*[![:space:]]}"}"
}

# <live|stale> → this session's wait lock held by a running waiter of this Claude process, or by a gone one
hold_wait_lock() {
  local waiter_pid waiter_start
  mkdir -p "${GA_ROOT}/data/queue/waits"
  sleep 30 &
  WAITER_PID=$!
  waiter_pid="${WAITER_PID}"
  waiter_start="$(get_recorded_start "${waiter_pid}")"
  if [[ "$1" == stale ]]; then
    kill "${WAITER_PID}" && wait "${WAITER_PID}" 2>/dev/null || true
    WAITER_PID=""
  fi
  ln -sn -- "${waiter_pid}|${waiter_start}|${CLAUDE_PID}|$(get_recorded_start "${CLAUDE_PID}")" \
    "${GA_ROOT}/data/queue/waits/${SESSION_ID}"
}

# the continuation the hook returns: a block decision whose reason names the absolute wait command
assert_continuation() {
  local reason
  reason="$(jq -r 'select(.decision == "block") | .reason' <<<"${output}" 2>/dev/null)" || reason=""
  [[ "${status}" -eq 0 && "${reason}" == *"[ATRIUM-QUEUE]"*" ${GA_ROOT}/scripts/atrium-queue.sh wait"* ]] || {
    echo "$1: status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
  [[ "${output}" != *"${ITEM_TITLE}"* && "${output}" != *"Owner context body"* ]] || {
    echo "$1: item text reached the session: ${output}"
    return 1
  }
}

assert_silent_turn_end() {
  [[ "${status}" -eq 0 && -z "${output}" && -z "${stderr}" ]] || {
    echo "$1: status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
}

@test "an awaiting item a wait resolves, with no wait running, keeps the turn going with the wait command and no item text" {
  start_stub
  local row rows=() lock expected_status
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/queue-session.sh
  for expected_status in $(source "${GA}/scripts/lib/queue-session.sh" && printf '%s' "${QUEUE_WAIT_RESOLVED_STATUSES}"); do
    rows+=("${expected_status}|none")
  done
  for row in "${rows[@]}" "open|stale"; do
    IFS='|' read -r expected_status lock <<<"${row}"
    new_root
    mark_items 41
    if [[ "${lock}" == stale ]]; then hold_wait_lock stale; fi
    set_reply 200 "$(item_reply "${expected_status}")"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_hook
    assert_continuation "row ${row}" || return 1
    [[ "$(requested_paths)" == "/api/queue/items/41?sessionId=${SESSION_ID}" ]] || {
      echo "row ${row}: $(requested_paths)"
      return 1
    }
  done
}

@test "a Stop payload whose final message runs past 64 KiB is read whole and still keeps the turn going" {
  start_stub
  mark_items 41
  local message payload
  # about 25k Korean characters → 75 KB of UTF-8 in last_assistant_message alone
  message="$(printf '%25000s' '' | sed 's/ /결/g')"
  payload="$(jq -nc --arg id "${SESSION_ID}" --arg message "${message}" '{hook_event_name: "Stop",
    last_assistant_message: $message, background_tasks: [], session_id: $id, stop_hook_active: false}')"
  ((${#payload} > 25000)) || {
    echo "payload is only ${#payload} characters"
    return 1
  }
  run_hook "${payload}"
  assert_continuation "75 KB payload"
}

@test "with no awaiting mark the turn ends silently and the monitor is never asked" {
  start_stub
  run_hook
  assert_silent_turn_end "no mark"
  [[ ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
    requested_paths
    return 1
  }
}

@test "the turn ends silently with no monitor call for a running wait, a continued stop, a subagent, no pid or no session" {
  start_stub
  local row name payload
  for row in "running wait" "continued stop" "subagent" "no pid" "no session"; do
    new_root
    mark_items 41
    export CLAUDE_PID="$$"
    payload="$(stop_payload)"
    case "${row}" in
      "running wait") hold_wait_lock live ;;
      "continued stop") payload="$(jq -c '.stop_hook_active = true' <<<"${payload}")" ;;
      subagent) payload="$(jq -c '.agent_id = "a1b2c3" | .agent_type = "glass-atrium-dev-shell"' <<<"${payload}")" ;;
      "no pid") unset CLAUDE_PID ;;
      "no session") payload="$(jq -c 'del(.session_id)' <<<"${payload}")" ;;
    esac
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_hook "${payload}"
    name="${row}"
    assert_silent_turn_end "row ${name}" || return 1
    [[ ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
      echo "row ${name}: $(requested_paths)"
      return 1
    }
  done
}

@test "a terminal or unknown item drops its mark, an item a wait cannot resolve keeps it, and neither keeps the turn going" {
  start_stub
  local row rows=("404||no") reply_status item_status kept
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/queue-session.sh
  for item_status in $(source "${GA}/scripts/lib/queue-session.sh" && printf '%s' "${QUEUE_TERMINAL_STATUSES}"); do
    rows+=("200|${item_status}|no")
  done
  for item_status in ${KEPT_STATUSES}; do rows+=("200|${item_status}|yes"); done
  for row in "${rows[@]}"; do
    IFS='|' read -r reply_status item_status kept <<<"${row}"
    new_root
    mark_items 41
    if [[ "${reply_status}" == 404 ]]; then
      set_reply 404 '{"error":"unknown_item"}'
    else
      set_reply 200 "$(item_reply "${item_status}")"
    fi
    run_hook
    assert_silent_turn_end "row ${row}" || return 1
    [[ "$([[ -f "${AWAITING}/41" ]] && echo yes || echo no)" == "${kept}" ]] || {
      echo "row ${row}: mark kept should be ${kept}"
      return 1
    }
  done
}

@test "the check asks about at most three items, newest first, and stops at the first one a wait resolves" {
  start_stub
  mark_items 7 12 31 44 58
  set_reply 200 "$(item_reply delivered)"
  run_hook
  assert_silent_turn_end "five terminal marks"
  [[ "$(requested_paths | sed 's/?.*//' | tr '\n' ' ')" == "/api/queue/items/58 /api/queue/items/44 /api/queue/items/31 " ]] || {
    requested_paths
    return 1
  }
  stop_stub
  start_stub
  set_nth_reply 1 200 "$(item_reply held)"
  set_nth_reply 2 200 "$(item_reply answered)"
  run_hook
  assert_continuation "second item answered" || return 1
  [[ "$(requested_paths | sed 's/?.*//' | tr '\n' ' ')" == "/api/queue/items/12 /api/queue/items/7 " ]] || {
    requested_paths
    return 1
  }
}

@test "after a continuation the same items are not named again to the same Claude process until the interval passes" {
  start_stub
  mark_items 41
  run_hook
  assert_continuation "first turn end"
  local row
  for row in "same items, wait failed fast|silent" "a newer item posted|continue" "same items again|silent" \
    "interval passed|continue" "another Claude process|continue"; do
    case "${row}" in
      "a newer item posted"*) mark_items 42 ;;
      "interval passed"*) touch -t 200001010000 "${AWAITING}/.nudged" ;;
      "another Claude process"*) export CLAUDE_PID=1 ;;
    esac
    run_hook
    if [[ "${row##*|}" == silent ]]; then
      assert_silent_turn_end "row ${row}" || return 1
    else
      assert_continuation "row ${row}" || return 1
    fi
  done
}

@test "a nudge stamp that cannot be written ends the turn with one stderr line and no continuation" {
  start_stub
  mark_items 41
  # a directory in the stamp's place → the write fails as on a read-only data root
  mkdir -p "${AWAITING}/.nudged"
  run_hook
  [[ "${status}" -eq 0 && -z "${output}" && "${stderr}" == "queue-turn-end-check: no nudge stamp"* &&
    "${stderr}" != *$'\n'* ]] || {
    echo "status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
}

@test "the hook reached through a hook-farm symlink still loads its library and keeps the turn going" {
  start_stub
  mark_items 41
  mkdir -p "${BATS_TEST_TMPDIR}/farm"
  ln -s "${HOOK}" "${BATS_TEST_TMPDIR}/farm/queue-turn-end-check.sh"
  HOOK="${BATS_TEST_TMPDIR}/farm/queue-turn-end-check.sh"
  run_hook
  assert_continuation "through the farm symlink"
}

@test "a down, slow, refusing or garbled monitor and a malformed payload end the turn with one stderr line" {
  local row started elapsed payload
  for row in down slow refusing garbled payload; do
    stop_stub
    new_root
    mark_items 41 40
    payload="$(stop_payload)"
    case "${row}" in
      down) export ATRIUM_MONITOR_PORT=1 ;;
      slow) set_reply hang '' && start_stub ;;
      refusing) set_reply 500 '{"error":"internal"}' && start_stub ;;
      garbled) set_reply 200 'not json' && start_stub ;;
      payload) payload='Stop {not json' && start_stub ;;
    esac
    started=${SECONDS}
    run_hook "${payload}"
    elapsed=$((SECONDS - started))
    [[ "${status}" -eq 0 && -z "${output}" && "${stderr}" == queue-turn-end-check:* ]] || {
      echo "row ${row}: status=${status} stdout=${output} stderr=${stderr}"
      return 1
    }
    [[ "${stderr}" != *$'\n'* && "${elapsed}" -le 3 && -f "${AWAITING}/41" ]] || {
      echo "row ${row}: elapsed=${elapsed}s stderr=${stderr}"
      return 1
    }
  done
}

@test "the terminal statuses the check drops marks for are the monitor's own terminal set" {
  local monitor_set check_set
  monitor_set="$(sed -n 's/^const TERMINAL: QueueItemStatus\[\] = \[\(.*\)\];$/\1/p' \
    "${GA}/monitor/src/server/queue/owner-views.ts" | tr -d '" ' | tr ',' '\n' | sort | tr '\n' ' ')"
  [[ -n "${monitor_set}" ]] || {
    echo "no TERMINAL in owner-views.ts"
    return 1
  }
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/queue-session.sh
  check_set="$(source "${GA}/scripts/lib/queue-session.sh" && printf '%s' "${QUEUE_TERMINAL_STATUSES}" \
    | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ')"
  [[ "${check_set}" == "${monitor_set}" ]] || {
    echo "check: ${check_set} · monitor: ${monitor_set}"
    return 1
  }
}

@test "every status the monitor's enum holds is one the check resolves by a wait, drops as terminal or keeps" {
  local enum_set check_set
  enum_set="$(sed -n '/^enum QueueItemStatus {$/,/^}$/p' "${GA}/monitor/prisma/schema.prisma" \
    | sed -n 's/^  \([a-z_]*\)$/\1/p' | sort | tr '\n' ' ')"
  [[ -n "${enum_set}" ]] || {
    echo "no QueueItemStatus enum in schema.prisma"
    return 1
  }
  # each list splits into one status per word
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/queue-session.sh disable=SC2086
  check_set="$(source "${GA}/scripts/lib/queue-session.sh" \
    && printf '%s\n' ${QUEUE_WAIT_RESOLVED_STATUSES} ${QUEUE_TERMINAL_STATUSES} ${KEPT_STATUSES} | sort | tr '\n' ' ')"
  [[ "${check_set}" == "${enum_set}" ]] || {
    echo "check: ${check_set} · enum: ${enum_set}"
    return 1
  }
}

@test "the continuation reaches stdout whole, with no write error, when an interrupt lands on the write" {
  start_stub
  mark_items 41
  stop_payload >"${BATS_TEST_TMPDIR}/payload.json"
  FORCED_CHANNEL=stdout run_forced_hook "${HOOK}" "${BATS_TEST_TMPDIR}/payload.json" "GA_ROOT=${GA_ROOT}" \
    "CLAUDE_PID=$$" "ATRIUM_MONITOR_PORT=${ATRIUM_MONITOR_PORT}"
  local rest="${output#*\"decision\":\"block\"}" other
  other="$(cat -- "${FORCED_DIR}/other")"
  # an interrupted in-shell write reports itself on stderr, and a longer one loses its bytes
  [[ "${status}" -eq 0 && "${output}" == *'"decision":"block"'* && "${rest}" != *'"decision"'* && -z "${other}" ]] || {
    echo "status=${status} stdout=${output} other=${other}"
    return 1
  }
}
