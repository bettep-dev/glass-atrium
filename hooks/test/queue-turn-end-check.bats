#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031,SC2154,SC2249,SC2312  # backticked tool and command names are literal text; a row's export stays inside its own bats test; BATS_* and run results are set by bats; a masked status fails its comparison; each case arm is a row
# The owner queue's turn-end check (Stop hook) against a stand-in monitor: it keeps a turn from ending at most once
# per turn, asking an interactive or background session's tool-using turn for its queue record, naming the
# wait command while an item of this session awaits the owner, no wait or listener of this Claude process runs and
# none of its listeners ever started, or both in one block — never twice for the same items, never with item text,
# and never when it cannot decide.
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
# shellcheck source-path=SCRIPTDIR source=lib/turn-transcript.bash
source "${BATS_TEST_DIRNAME}/lib/turn-transcript.bash"

setup() {
  # the ambient session's own CLAUDE_* values must never reach the hook under test
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID ATRIUM_MONITOR_PORT
  new_root
  # a live pid → its start time exists, as the session's own Claude process has one
  export CLAUDE_PID="$$"
  # an interactive or background session, the kinds the record check asks
  export CLAUDE_CODE_ENTRYPOINT=cli
  : >"${BATS_TEST_TMPDIR}/requests.log"
  set_reply 200 "$(item_reply open)"
  TRANSCRIPT="${BATS_TEST_TMPDIR}/transcript.jsonl"
  write_turn_transcript "${TRANSCRIPT}" start:t-1 text
}

teardown() {
  stop_stub
  stop_waiter
}

# ends the fake waiter hold_wait_lock started, if any
stop_waiter() {
  if [[ -n "${WAITER_PID:-}" ]]; then
    kill "${WAITER_PID}" 2>/dev/null || true
    wait "${WAITER_PID}" 2>/dev/null || true
  fi
  WAITER_PID=""
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

# [final message] → a first Stop fire of this session's turn in TRANSCRIPT
stop_payload() {
  jq -nc --arg id "${SESSION_ID}" --arg transcript "${TRANSCRIPT}" --arg message "${1-The build passed.}" \
    '{hook_event_name: "Stop", session_id: $id, transcript_path: $transcript, last_assistant_message: $message,
      stop_hook_active: false}'
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

# <live|stale|listener> [owner pid] [owner start] → this session's wait lock held by a running waiter, a gone one or
# a running listener, of that owner (default this Claude process, with its own start)
hold_wait_lock() {
  local waiter_pid waiter_start owner_pid="${2:-${CLAUDE_PID:-}}" owner_start="${3:-}"
  [[ -n "${owner_start}" ]] || owner_start="$(get_recorded_start "${owner_pid}")"
  mkdir -p "${GA_ROOT}/data/queue/waits"
  sleep 30 &
  WAITER_PID=$!
  waiter_pid="${WAITER_PID}"
  waiter_start="$(get_recorded_start "${waiter_pid}")"
  if [[ "$1" == stale ]]; then stop_waiter; fi
  # a listener's record ends with its holder kind
  if [[ "$1" == listener ]]; then owner_start+="|listen"; fi
  ln -sn -- "${waiter_pid}|${waiter_start}|${owner_pid}|${owner_start}" \
    "${GA_ROOT}/data/queue/waits/${SESSION_ID}"
}

# <owner pid> → the listening mark a listener of that Claude process leaves when it takes the session's lock
put_listening_mark() {
  local owner
  owner="$1|$(get_recorded_start "$1")"
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/queue-session.sh
  (source "${GA}/scripts/lib/queue-session.sh" && queue_put_listening_mark "${SESSION_ID}" "${owner}")
}

# <offset s> → the UTC time that far from now, in the transcript's timestamp form
get_utc_ms() {
  perl -MTime::HiRes=time -MPOSIX=strftime -e '$t = time + $ARGV[0];
    printf "%s.%03dZ\n", strftime("%Y-%m-%dT%H:%M:%S", gmtime $t), ($t - int $t) * 1000' -- "$1"
}

# this session's turn record, written now by the session library
put_record() {
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/queue-session.sh
  (source "${GA}/scripts/lib/queue-session.sh" && queue_put_record "${SESSION_ID}" nothing)
}

# the reason of the block decision in the hook's stdout; non-zero when that stdout is not JSON
get_block_reason() {
  jq -r 'select(.decision == "block") | .reason' <<<"${output}" 2>/dev/null
}

# <row name> → the hook's stdout carries neither the item's title nor its body
assert_no_item_text() {
  [[ "${output}" != *"${ITEM_TITLE}"* && "${output}" != *"Owner context body"* ]] || {
    echo "$1: item text reached the session: ${output}"
    return 1
  }
}

# the continuation the hook returns: a block decision whose reason names the absolute wait command
assert_continuation() {
  local reason
  reason="$(get_block_reason)" || reason=""
  [[ "${status}" -eq 0 && "${reason}" == *"[ATRIUM-QUEUE]"*" ${GA_ROOT}/scripts/atrium-queue.sh wait"* ]] || {
    echo "$1: status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
  assert_no_item_text "$1"
}

# <row name> → one record ask, naming the record tool and the CLI's record forms, with no item text
assert_record_ask() {
  local reason cli="${GA_ROOT}/scripts/atrium-queue.sh"
  reason="$(get_block_reason)" || reason=""
  [[ "${status}" -eq 0 && "${output}" != *$'\n'* && "${reason}" == "Queue record (harness): "* &&
    "${reason}" == *'`record` tool'* && "${reason}" == *"\`${cli} record nothing\`"* &&
    "${reason}" == *"\`${cli} record posted <id>...\`"* ]] || {
    echo "$1: status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
  assert_no_item_text "$1"
}

# <row name> → one record ask naming only the CLI's record forms and the shadowing, never the server's record tool
assert_cli_record_ask() {
  local reason cli="${GA_ROOT}/scripts/atrium-queue.sh"
  reason="$(get_block_reason)" || reason=""
  [[ "${status}" -eq 0 && "${output}" != *$'\n'* && "${reason}" == "Queue record (harness): "* &&
    "${reason}" != *'`record` tool'* && "${reason}" == *"shadows"* && "${reason}" == *"\`${cli} record nothing\`"* &&
    "${reason}" == *"\`${cli} record posted <id>...\`"* ]] || {
    echo "$1: status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
}

# <start dir> → this session's start run through the SessionStart hook, its monitor refusing → only local state lands
register_start() {
  jq -nc --arg id "${SESSION_ID}" --arg cwd "$1" \
    '{hook_event_name: "SessionStart", source: "startup", session_id: $id, cwd: $cwd}' \
    | ATRIUM_MONITOR_PORT=1 "${GA}/hooks/queue-session-register.sh" >/dev/null 2>&1
}

assert_silent_turn_end() {
  [[ "${status}" -eq 0 && -z "${output}" && -z "${stderr}" ]] || {
    echo "$1: status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
}

@test "an awaiting item a wait resolves, with no wait or listener of this Claude process running, keeps the turn going with the wait command and no item text" {
  start_stub
  local row rows=() lock expected_status
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/queue-session.sh
  for expected_status in $(source "${GA}/scripts/lib/queue-session.sh" && printf '%s' "${QUEUE_WAIT_RESOLVED_STATUSES}"); do
    rows+=("${expected_status}|none")
  done
  # another-listened: a listening mark names another Claude process → no listener of this one is starting
  for row in "${rows[@]}" "open|stale" "open|another-listened"; do
    IFS='|' read -r expected_status lock <<<"${row}"
    new_root
    mark_items 41
    case "${lock}" in
      none) ;;
      another-listened) put_listening_mark 1 ;;
      *) hold_wait_lock "${lock}" ;;
    esac
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

@test "the turn ends silently with no monitor call for a running wait and for a listener of this Claude process holding or taking the lock, and for a continued stop, a subagent or no session even on a tool-using turn with no record" {
  start_stub
  local row name payload
  for row in "running wait" "listener holding the lock" "listener taking the lock" "continued stop" "subagent" \
    "no session"; do
    new_root
    mark_items 41
    export CLAUDE_PID="$$"
    write_turn_transcript "${TRANSCRIPT}" start:t-1 tool result text
    if [[ "${row}" == "running wait" || "${row}" == listener* ]]; then write_turn_transcript "${TRANSCRIPT}" start:t-1 text; fi
    payload="$(stop_payload)"
    case "${row}" in
      "running wait") hold_wait_lock live ;;
      "listener holding the lock") hold_wait_lock listener ;;
      # the turn's own Stop starts the listener beside this check, in no set order: its mark stands for it
      "listener taking the lock") put_listening_mark "${CLAUDE_PID}" ;;
      "continued stop") payload="$(jq -c '.stop_hook_active = true' <<<"${payload}")" ;;
      subagent) payload="$(jq -c '.agent_id = "a1b2c3" | .agent_type = "glass-atrium-dev-shell"' <<<"${payload}")" ;;
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

@test "with no pid in the hook env, a wait counts as running only while the lock's recorded waiter and owner both run" {
  start_stub
  local row dead_pid
  # an exited process's pid → no process runs under it
  dead_pid="$(bash -c 'printf "%s" "$$"')"
  for row in "no lock|continue" "waiter gone|continue" "owner gone|continue" "owner pid recycled|continue" \
    "waiter and owner run|silent"; do
    new_root
    mark_items 41
    unset CLAUDE_PID
    case "${row}" in
      "waiter gone"*) hold_wait_lock stale "$$" ;;
      "owner gone"*) hold_wait_lock live "${dead_pid}" "Thu Jan  1 00:00:00 1970" ;;
      "owner pid recycled"*) hold_wait_lock live "$$" "Thu Jan  1 00:00:00 1970" ;;
      "waiter and owner run"*) hold_wait_lock live "$$" ;;
    esac
    run_hook
    if [[ "${row##*|}" == silent ]]; then
      assert_silent_turn_end "row ${row}" || return 1
    else
      assert_continuation "row ${row}" || return 1
    fi
    stop_waiter
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

@test "the check asks newest first, past any number of marks a wait cannot resolve, and stops at the first it resolves" {
  start_stub
  mark_items 7 12 31 44 58
  set_reply 200 "$(item_reply delivered)"
  run_hook
  assert_silent_turn_end "five terminal marks"
  [[ "$(requested_paths | sed 's/?.*//' | tr '\n' ' ')" == "/api/queue/items/58 /api/queue/items/44 /api/queue/items/31 /api/queue/items/12 /api/queue/items/7 " ]] || {
    requested_paths
    return 1
  }
  stop_stub
  new_root
  mark_items 7 12 31 44 58
  start_stub
  set_nth_reply 1 200 "$(item_reply held)"
  set_nth_reply 2 200 "$(item_reply unacked)"
  set_nth_reply 3 200 "$(item_reply expired)"
  set_nth_reply 4 200 "$(item_reply open)"
  run_hook
  assert_continuation "an open item behind three kept marks" || return 1
  [[ "$(requested_paths | sed 's/?.*//' | tr '\n' ' ')" == "/api/queue/items/58 /api/queue/items/44 /api/queue/items/31 /api/queue/items/12 " ]] || {
    requested_paths
    return 1
  }
}

@test "a monitor slow on every item ends the turn within the check's time budget with one stderr line" {
  # The budget is proven by the hook stopping early (fewer than 20 of 0.5 s fetches asked) and naming the
  # budget in its one stderr line — not by wall-clock time, which a loaded parallel suite run stretches.
  local id asked
  for id in $(seq 101 120); do mark_items "${id}"; done
  set_reply "200 0.5" "$(item_reply held)"
  start_stub
  run_hook
  asked="$(requested_paths | wc -l | tr -d ' ')"
  [[ "${status}" -eq 0 && -z "${output}" && "${stderr}" == queue-turn-end-check:*"check budget ran out"* && "${stderr}" != *$'\n'* ]] || {
    echo "status=${status} stdout=${output} stderr=${stderr}"
    return 1
  }
  ((asked < 20)) || {
    echo "asked ${asked} of 20 items"
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
    "interval passed|continue" "another Claude process|continue" "no pid in the hook env|continue" \
    "no pid, same items again|silent"; do
    case "${row}" in
      "a newer item posted"*) mark_items 42 ;;
      "interval passed"*) touch -t 200001010000 "${AWAITING}/.nudged" ;;
      "another Claude process"*) export CLAUDE_PID=1 ;;
      "no pid in the hook env"*) unset CLAUDE_PID ;;
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

@test "a record-ask stamp that cannot be written ends the turn with one stderr line and no record ask" {
  start_stub
  write_turn_transcript "${TRANSCRIPT}" start:t-1 tool result text
  # a directory in the stamp's place → the write fails as on a read-only data root
  mkdir -p "${AWAITING}/.record-asked"
  run_hook
  [[ "${status}" -eq 0 && -z "${output}" && "${stderr}" == "queue-turn-end-check: no record-ask stamp"* &&
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
  monitor_set="$(sed -n 's/^export const TERMINAL: QueueItemStatus\[\] = \[\(.*\)\];$/\1/p' \
    "${GA}/monitor/src/server/queue/registry.ts" | tr -d '" ' | tr ',' '\n' | sort | tr '\n' ' ')"
  [[ -n "${monitor_set}" ]] || {
    echo "no TERMINAL in registry.ts"
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

@test "a tool-using turn ends silently only when its last tool call is a record call and the record was written at or after the turn's start" {
  start_stub
  local row name tokens record message expect payload
  # Row shape: name|tokens|record (none, fresh: written after the turn's start, stale: before it)|final message (yes or
  # none: the end-turn path)|silent or ask
  for row in \
    'no record|start:t-1 tool result text|none|yes|ask' \
    'record tool last|start:t-1 tool result text record result|fresh|yes|silent' \
    'CLI record last|start:t-1 tool result clirecord result|fresh|yes|silent' \
    'record tool last with no final message|start:t-1 tool result record result|fresh|none|silent' \
    'record of an earlier turn|start:t-1 tool result record result|stale|yes|ask' \
    'a tool call after the record|start:t-1 record result tool result text|fresh|yes|ask' \
    'no final message and no record call|start:t-1 tool result|fresh|none|ask' \
    'another CLI subcommand last|start:t-1 clirecord result clipending result|fresh|yes|ask' \
    'last-act post last|start:t-1 tool result lastpost result|fresh|none|silent' \
    'last-act post of an earlier turn|start:t-1 tool result lastpost result|stale|none|ask' \
    'post without the last-act flag last|start:t-1 record result post result|fresh|none|ask'; do
    IFS='|' read -r name tokens record message expect <<<"${row}"
    IFS=' ' read -r -a tokens <<<"${tokens}"
    new_root
    case "${record}" in
      fresh) TURN_STARTED_AT="$(get_utc_ms -60)" && put_record ;;
      stale) put_record && TURN_STARTED_AT="$(get_utc_ms 60)" ;;
    esac
    write_turn_transcript "${TRANSCRIPT}" "${tokens[@]}"
    payload="$(stop_payload)"
    if [[ "${message}" == none ]]; then payload="$(jq -c 'del(.last_assistant_message)' <<<"${payload}")"; fi
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_hook "${payload}"
    if [[ "${expect}" == silent ]]; then
      assert_silent_turn_end "row ${name}" || return 1
    else
      assert_record_ask "row ${name}" || return 1
    fi
    [[ ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
      echo "row ${name}: $(requested_paths)"
      return 1
    }
  done
}

@test "in a session whose start found a server shadowing the queue server's name, the record ask names only the CLI and that server's record tool never counts as the record" {
  start_stub
  local project="${BATS_TEST_TMPDIR}/project" row name starts start tokens expect
  local -a start_list
  export CLAUDE_CONFIG_DIR="${BATS_TEST_TMPDIR}/profile"
  mkdir -p "${project}" "${CLAUDE_CONFIG_DIR}"
  printf '{}\n' >"${CLAUDE_CONFIG_DIR}/.claude.json"
  # Row shape: name|starts in order (shadowed: the start dir's project file names the server, plain: it names
  # none)|tokens|cli-ask or silent; every row's record is written after its turn's start
  for row in \
    'shadowed, no record call|shadowed|start:t-1 tool result text|cli-ask' \
    'shadowed, server record tool last|shadowed|start:t-1 tool result record result|cli-ask' \
    'shadowed, CLI record last|shadowed|start:t-1 tool result clirecord result|silent' \
    'resumed with the shadowing gone, server record tool last|shadowed plain|start:t-1 tool result record result|silent'; do
    IFS='|' read -r name starts tokens expect <<<"${row}"
    IFS=' ' read -r -a tokens <<<"${tokens}"
    IFS=' ' read -r -a start_list <<<"${starts}"
    new_root
    for start in "${start_list[@]}"; do
      printf '{"mcpServers":{}}\n' >"${project}/.mcp.json"
      if [[ "${start}" == shadowed ]]; then
        printf '{"mcpServers":{"atrium-queue":{"command":"x"}}}\n' >"${project}/.mcp.json"
      fi
      register_start "${project}"
    done
    TURN_STARTED_AT="$(get_utc_ms -60)" && put_record
    write_turn_transcript "${TRANSCRIPT}" "${tokens[@]}"
    run_hook
    if [[ "${expect}" == silent ]]; then
      assert_silent_turn_end "row ${name}" || return 1
    else
      assert_cli_record_ask "row ${name}" || return 1
    fi
  done
}

@test "a turn that called no tool owes no record, a notification turn after a tool turn included" {
  start_stub
  local row name tokens
  for row in 'tool-free turn|start:t-1 text' \
    'notification turn after a tool turn|start:t-1 tool result text notify:n-1 text'; do
    IFS='|' read -r name tokens <<<"${row}"
    IFS=' ' read -r -a tokens <<<"${tokens}"
    new_root
    write_turn_transcript "${TRANSCRIPT}" "${tokens[@]}"
    run_hook
    assert_silent_turn_end "row ${name}" || return 1
  done
}

@test "a headless claude -p run or a host naming no entrypoint is never asked for a record, even on a tool-using turn" {
  start_stub
  local row name entrypoint
  for row in 'headless -p run|sdk-cli' 'no entrypoint|-'; do
    IFS='|' read -r name entrypoint <<<"${row}"
    new_root
    write_turn_transcript "${TRANSCRIPT}" start:t-1 tool result text
    unset CLAUDE_CODE_ENTRYPOINT
    if [[ "${entrypoint}" != - ]]; then export CLAUDE_CODE_ENTRYPOINT="${entrypoint}"; fi
    run_hook
    assert_silent_turn_end "row ${name}" || return 1
  done
}

@test "a missing record and an awaiting item with no wait end the turn in one block carrying both lines" {
  start_stub
  mark_items 41
  write_turn_transcript "${TRANSCRIPT}" start:t-1 tool result text
  run_hook
  assert_continuation "both due" || return 1
  [[ "$(get_block_reason)" == "Queue record (harness): "*$'\n'"[ATRIUM-QUEUE]"* ]] || {
    echo "both due: ${output}"
    return 1
  }
}

@test "a turn is asked for its record once: a later fire of the same turn is silent and the next tool-using turn is asked again" {
  start_stub
  write_turn_transcript "${TRANSCRIPT}" start:t-1 tool result text
  run_hook
  assert_record_ask "first fire" || return 1
  local row name tokens
  for row in 'same turn, its continuation ran a tool|start:t-1 tool result text feedback tool result text|silent' \
    'same turn, compacted after the ask|start:t-1 tool result text feedback compact:c-1 tool result text|silent' \
    'next tool-using turn|start:t-1 tool result text start:t-2 tool result text|ask' \
    'same next turn again|start:t-1 tool result text start:t-2 tool result text|silent'; do
    IFS='|' read -r name tokens expect <<<"${row}"
    IFS=' ' read -r -a tokens <<<"${tokens}"
    write_turn_transcript "${TRANSCRIPT}" "${tokens[@]}"
    run_hook
    if [[ "${expect}" == silent ]]; then
      assert_silent_turn_end "row ${name}" || return 1
    else
      assert_record_ask "row ${name}" || return 1
    fi
  done
}

@test "an unreadable turn or one whose start has no time ends the turn with one stderr line and no record ask" {
  local row payload
  for row in "unreadable transcript" "no transcript path" "no turn start" "no start time"; do
    stop_stub
    new_root
    mark_items 41
    start_stub
    write_turn_transcript "${TRANSCRIPT}" start:t-1 tool result text
    payload="$(stop_payload)"
    case "${row}" in
      "unreadable transcript") TRANSCRIPT="${BATS_TEST_TMPDIR}/no-such.jsonl" && payload="$(stop_payload)" ;;
      "no transcript path") payload="$(jq -c 'del(.transcript_path)' <<<"${payload}")" ;;
      "no turn start") write_turn_transcript "${TRANSCRIPT}" tool result text ;;
      "no start time") TURN_STARTED_AT="" && write_turn_transcript "${TRANSCRIPT}" start:t-1 tool result text ;;
    esac
    # an item awaits with no wait → the wait line alone
    run_hook "${payload}"
    [[ "${status}" -eq 0 && "${stderr}" == queue-turn-end-check:* && "${stderr}" != *$'\n'* &&
      "$(get_block_reason)" == "[ATRIUM-QUEUE]"* ]] || {
      echo "row ${row}: status=${status} stdout=${output} stderr=${stderr}"
      return 1
    }
    TRANSCRIPT="${BATS_TEST_TMPDIR}/transcript.jsonl"
  done
}
