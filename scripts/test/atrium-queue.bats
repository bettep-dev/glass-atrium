#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2154,SC2249,SC2312  # each test is a subshell → its exports are its own; BATS_* and run results are set by bats; each case arm is a row; a masked status fails its comparison
# The owner queue CLI against a stand-in monitor. Protects local validation before any request, the
# session id taken from the env, the foreign-item stop, the ack verdict lines, the pull loop's printed
# commands, the register step it shares with the SessionStart hook, and the absolute-path help literal.
#
# Run via: bats scripts/test/atrium-queue.bats
# Requires: bats, bash 3.2+, jq, curl, perl, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"
CLI="${GA}/scripts/atrium-queue.sh"
REGISTER_HOOK="${GA}/hooks/queue-session-register.sh"
SESSION_ID="3f1c2b9a-7d4e-4f5a-9b6c-0e1d2c3b4a59"
FOREIGN_SESSION_ID="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
MSG_ID="6b0e7c1a-2f3d-4e5b-8a9c-1d2e3f4a5b6c"
SOCKET_AUTH="tok-81f3c2e9d0b7a6f5"
REPORT='{"title":"Nightly backup failed twice","body":"The 02:00 run hit a full disk; rerun after cleanup?","isFreeTextAllowed":true,"linkedDocIds":[43944]}'
DECISION='{"title":"Pick the retention window","body":"Backups now take 40 GB a week.","isFreeTextAllowed":false,"options":[{"code":"R1","label":"Keep 14 days","pros":"cheap","cons":"short history"},{"code":"R2","label":"Keep 30 days","pros":"longer history","cons":"twice the disk"}],"recommendedCode":"R1"}'

setup() {
  # the ambient session's own CLAUDE_* values must never reach the CLI under test
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CONFIG_DIR CLAUDE_CODE_MESSAGING_SOCKET \
    CLAUDE_CODE_MESSAGING_TOKEN ATRIUM_MONITOR_PORT CLAUDE_JOB_DIR ATRIUM_QUEUE_WAIT_POLL_S ATRIUM_QUEUE_WAIT_BOUND_S
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  # no secrets dir: a session needs nothing provisioned
  mkdir -p "${BATS_TEST_TMPDIR}/bin"
  export CLAUDE_CODE_SESSION_ID="${SESSION_ID}"
  export CLAUDE_PID=4242
  export CLAUDE_CODE_MESSAGING_SOCKET="/tmp/cc-socks/4242.sock"
  printf -v CLAUDE_CODE_MESSAGING_TOKEN '%s' "${SOCKET_AUTH}"
  export CLAUDE_CODE_MESSAGING_TOKEN
  # curl shim: records each argv, then runs the real curl unchanged
  cat >"${BATS_TEST_TMPDIR}/bin/curl" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${BATS_TEST_TMPDIR}/curl-argv.log"
exec "$(command -v curl)" "\$@"
SHIM
  chmod 755 "${BATS_TEST_TMPDIR}/bin/curl"
  export PATH="${BATS_TEST_TMPDIR}/bin:${PATH}"
  : >"${BATS_TEST_TMPDIR}/curl-argv.log"
  : >"${BATS_TEST_TMPDIR}/requests.log"
  set_reply 200 '{}'
}

teardown() {
  stop_waiters
  stop_stub
}

# every background wait and stand-in Claude process this test started
stop_waiters() {
  local pid
  for pid in ${WAITER_PIDS:-} ${OWNER_PIDS:-}; do
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  done
  WAITER_PIDS=""
  OWNER_PIDS=""
}

# a live stand-in for this session's Claude process → CLAUDE_PID
start_owner() {
  sleep 300 3>&- &
  OWNER_PID=$!
  OWNER_PIDS="${OWNER_PIDS:-} ${OWNER_PID}"
  export CLAUDE_PID="${OWNER_PID}"
}

# a one-second poll and a bound of $1 seconds, through the CLI's test seams
use_fast_wait() {
  export ATRIUM_QUEUE_WAIT_POLL_S=1 ATRIUM_QUEUE_WAIT_BOUND_S="$1"
}

# [label] → a background wait writing waiter[.label].out/.err → WAITER_PID
start_waiter() {
  local log="${BATS_TEST_TMPDIR}/waiter${1:+.$1}"
  "${CLI}" wait >"${log}.out" 2>"${log}.err" 3>&- &
  WAITER_PID=$!
  WAITER_PIDS="${WAITER_PIDS:-} ${WAITER_PID}"
}

# blocks until file $1 exists or process $2 has ended (at most 10 s)
await_file_or_exit() {
  local tries=0
  while [[ ! -e "$1" ]] && kill -0 "$2" 2>/dev/null && ((tries < 200)); do
    sleep 0.05
    tries=$((tries + 1))
  done
}

# mv and ln shims → the real tool runs first; then a process exporting QUEUE_TEST_TRACE logs each call naming the lock
# and the lock name's target, or ABSENT, after it
install_lock_step_shims() {
  local tool lock="$1" t="${BATS_TEST_TMPDIR}"
  for tool in mv ln; do
    cat >"${t}/bin/${tool}" <<SHIM
#!/usr/bin/env bash
"$(command -v "${tool}")" "\$@"
status=\$?
if [[ -n "\${QUEUE_TEST_TRACE:-}" && "\$*" == *"${lock}"* ]]; then
  printf '%s %s → %s\n' ${tool} "\$*" "\$("$(PATH="${PATH#"${t}/bin:"}" command -v readlink)" "${lock}" || echo ABSENT)" >>"${t}/trace.log"
fi
exit "\${status}"
SHIM
    chmod 755 "${t}/bin/${tool}"
  done
}

# readlink shim → a process exporting QUEUE_TEST_GATE_READ=<glob> holds once, at its first read under the waits mutex
# (fd 9 open) whose target matches the glob: it writes its own pid to in-gap, then holds until gate-open exists (at
# most 5 s, inside the CLI's 10 s mutex bound)
install_read_gate_shim() {
  local t="${BATS_TEST_TMPDIR}"
  cat >"${t}/bin/readlink" <<SHIM
#!/usr/bin/env bash
held="\$("$(PATH="${PATH#"${t}/bin:"}" command -v readlink)" "\$@")" || exit
if [[ -n "\${QUEUE_TEST_GATE_READ:-}" && "\${held}" == \${QUEUE_TEST_GATE_READ} && ! -e "${t}/in-gap" ]] \\
  && { : >&9; } 2>/dev/null; then
  printf '%s\n' "\$\$" >"${t}/in-gap.part"
  /bin/mv -f -- "${t}/in-gap.part" "${t}/in-gap"
  tries=0
  while [[ ! -e "${t}/gate-open" ]] && ((tries < 100)); do
    sleep 0.05
    tries=\$((tries + 1))
  done
fi
printf '%s\n' "\${held}"
SHIM
  chmod 755 "${t}/bin/readlink"
}

# KILLs pid $1 and each ancestor up to and including pid $2 → a crash of a whole wait, children and all; refuses a
# chain that never reaches $2
kill_chain_up_to() {
  local pid="$1" chain=""
  while [[ "${pid}" =~ ^[0-9]+$ ]] && ((pid > 1)); do
    chain="${chain} ${pid}"
    if [[ "${pid}" == "$2" ]]; then
      # shellcheck disable=SC2086  # the chain is a space-separated pid list, split on purpose
      kill -KILL ${chain}
      return 0
    fi
    pid="$(ps -o ppid= -p "${pid}")"
    pid="${pid//[[:space:]]/}"
  done
  echo "pid $1 is no descendant of $2"
  return 1
}

# the start time the CLI records for pid $1
get_recorded_start() {
  local started
  started="$(LC_ALL=C ps -p "$1" -o lstart=)"
  started="${started#"${started%%[![:space:]]*}"}"
  printf '%s\n' "${started%"${started##*[![:space:]]}"}"
}

# blocks until the stub has logged $1 requests (at most 10 s)
await_requests() {
  local tries=0
  while (($(wc -l <"${BATS_TEST_TMPDIR}/requests.log") < $1)) && ((tries < 200)); do
    sleep 0.05
    tries=$((tries + 1))
  done
}

# the exit status of background process $1 once it ends (at most 10 s) → AWAITED_STATUS, else "running"
await_exit() {
  local tries=0
  while kill -0 "$1" 2>/dev/null && ((tries < 200)); do
    sleep 0.05
    tries=$((tries + 1))
  done
  AWAITED_STATUS=running
  if kill -0 "$1" 2>/dev/null; then return 0; fi
  AWAITED_STATUS=0
  wait "$1" || AWAITED_STATUS=$?
}

stop_stub() {
  if [[ -n "${STUB_PID:-}" ]]; then
    kill "${STUB_PID}" 2>/dev/null || true
    wait "${STUB_PID}" 2>/dev/null || true
  fi
  STUB_PID=""
}

set_reply() {
  printf '%s\n%s' "$1" "$2" >"${BATS_TEST_TMPDIR}/reply"
}

# the reply to the n-th request only
set_nth_reply() {
  printf '%s\n%s' "$2" "$3" >"${BATS_TEST_TMPDIR}/reply.$1"
}

start_stub() {
  # a fresh port file per start → a stopped stub's port is never read back
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

request_body() {
  jq -r --arg p "$1" 'select(.path == $p) | .body' "${BATS_TEST_TMPDIR}/requests.log"
}

run_cli() {
  run --separate-stderr "${CLI}" "$@"
}

@test "report and decision post the item with this session's id and kind, and print the new item id" {
  start_stub
  set_reply 201 '{"id":17}'
  local row kind item
  for row in "report|${REPORT}" "decision|${DECISION}"; do
    kind="${row%%|*}"
    item="${row#*|}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    printf '%s' "${item}" >"${BATS_TEST_TMPDIR}/item.json"
    run_cli "${kind}" "${BATS_TEST_TMPDIR}/item.json"
    [[ "${status}" -eq 0 && "${output}" == *"item 17"* ]] || {
      echo "row ${kind}: status=${status} ${output}${stderr}"
      return 1
    }
    [[ "$(request_body /api/queue/items | jq -Sc .)" == "$(jq -Sc --arg k "${kind}" --arg s "${SESSION_ID}" '. + {kind: $k, sessionId: $s}' <<<"${item}")" ]] || {
      echo "row ${kind}: $(cat "${BATS_TEST_TMPDIR}/requests.log")"
      return 1
    }
  done
}

@test "an item read from stdin posts the same body as one read from a file" {
  start_stub
  set_reply 201 '{"id":18}'
  run --separate-stderr "${CLI}" report - <<<"${REPORT}"
  [[ "${status}" -eq 0 && "$(request_body /api/queue/items | jq -c '{title, kind}')" == '{"title":"Nightly backup failed twice","kind":"report"}' ]] || {
    echo "status=${status} ${stderr}"
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "an item the monitor would reject is refused locally with exit 64 and no request" {
  start_stub
  local row kind item
  for row in \
    "not-json|report|{\"title\":" \
    "not-an-object|report|[1,2]" \
    "unknown-field|report|$(jq -c '. + {priority: 1}' <<<"${REPORT}")" \
    "session-id-supplied|report|$(jq -c --arg s "${FOREIGN_SESSION_ID}" '. + {sessionId: $s}' <<<"${REPORT}")" \
    "blank-title|report|$(jq -c '.title = "   "' <<<"${REPORT}")" \
    "long-title|report|$(jq -c '.title = ("x" * 201)' <<<"${REPORT}")" \
    "free-text-flag-missing|report|$(jq -c 'del(.isFreeTextAllowed)' <<<"${REPORT}")" \
    "fractional-doc-id|report|$(jq -c '.linkedDocIds = [1.5]' <<<"${REPORT}")" \
    "repeated-doc-id|report|$(jq -c '.linkedDocIds = [7, 7]' <<<"${REPORT}")" \
    "options-on-a-report|report|$(jq -c '. + {options: []}' <<<"${REPORT}")" \
    "one-option|decision|$(jq -c '.options |= .[:1]' <<<"${DECISION}")" \
    "repeated-code|decision|$(jq -c '.options[1].code = "R1"' <<<"${DECISION}")" \
    "bad-code|decision|$(jq -c '.options[1].code = "R0"' <<<"${DECISION}")" \
    "option-extra-field|decision|$(jq -c '.options[0].note = "x"' <<<"${DECISION}")" \
    "recommended-not-an-option|decision|$(jq -c '.recommendedCode = "R3"' <<<"${DECISION}")"; do
    IFS='|' read -r _ kind item <<<"${row}"
    printf '%s' "${item}" >"${BATS_TEST_TMPDIR}/item.json"
    run_cli "${kind}" "${BATS_TEST_TMPDIR}/item.json"
    [[ "${status}" -eq 64 && -n "${stderr}" && ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
      echo "row ${row%%|*}: status=${status} ${stderr}"
      return 1
    }
  done
}

@test "get fetches the item by id for this session and prints it" {
  start_stub
  set_reply 200 "{\"id\":17,\"sessionId\":\"${SESSION_ID}\",\"answer\":{\"code\":\"R2\",\"text\":null}}"
  run_cli get 17
  [[ "${status}" -eq 0 && "$(jq -c '.answer' <<<"${output}")" == '{"code":"R2","text":null}' ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
  [[ "$(jq -r '.path' "${BATS_TEST_TMPDIR}/requests.log")" == "/api/queue/items/17?sessionId=${SESSION_ID}" ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "get prints one provenance line before an owner message and none before a report or decision" {
  start_stub
  local row kind first rest
  for row in message report decision; do
    kind="${row}"
    set_reply 200 "{\"id\":17,\"kind\":\"${kind}\",\"sessionId\":\"${SESSION_ID}\",\"body\":\"Rebase onto main, then rerun the suite.\",\"answer\":{\"code\":null,\"text\":null}}"
    run_cli get 17
    first="${lines[0]:-}"
    rest="$(sed '1d' <<<"${output}")"
    case "${kind}" in
      message)
        [[ "${status}" -eq 0 && "${first}" == "provenance: item 17 is an owner message"* && "${first}" == *"never an approval"* \
          && "$(jq -r '.kind' <<<"${rest}")" == message ]] || {
          echo "row ${row}: status=${status} ${output}${stderr}"
          return 1
        }
        ;;
      *)
        [[ "${status}" -eq 0 && "$(jq -r '.kind' <<<"${output}")" == "${kind}" ]] || {
          echo "row ${row}: status=${status} ${output}${stderr}"
          return 1
        }
        ;;
    esac
  done
}

@test "get prints after the item the path of each attached image in the image folder, and no other path" {
  start_stub
  local dir="${GA_ROOT}/data/queue/images" row label attachments expected
  local png="${dir}/5d1f0c3e-8a2b-4c7d-9e6f-1a2b3c4d5e6f.png" jpg="${dir}/b7e2a9c4-3f1d-4e8a-a6b5-0c9d8e7f6a5b.jpg"
  local webp="${dir}/0e9f8a7b-6c5d-4e3f-8a1b-2c3d4e5f6a7b.webp"
  local foreign="Images not shown (%s) — the monitor named no file of this install's queue image folder."
  for row in \
    "none|[]|" \
    "two in the folder|[\"${png}\",\"${jpg}\"]|Attached images (2) — local files; read each one before acting.
${png}
${jpg}" \
    "folder and foreign mixed|[\"/tmp/x/5d1f0c3e-8a2b-4c7d-9e6f-1a2b3c4d5e6f.png\",\"${webp}\",\"${dir}/../5d1f0c3e-8a2b-4c7d-9e6f-1a2b3c4d5e6f.png\",\"${dir}/screenshot.png\",\"${dir}/5d1f0c3e-8a2b-4c7d-9e6f-1a2b3c4d5e6f.svg\",null,\"${png}\\n/etc/passwd\"]|Attached images (1) — local files; read each one before acting.
${webp}
${foreign/\%s/6}" \
    "only foreign|[\"/Users/someone/secret.png\"]|${foreign/\%s/1}"; do
    label="${row%%|*}"
    attachments="${row#*|}"
    expected="${attachments#*|}"
    attachments="${attachments%%|*}"
    set_reply 200 "{\"id\":17,\"kind\":\"message\",\"sessionId\":\"${SESSION_ID}\",\"body\":\"Match the screenshots.\",\"attachments\":$(jq -c 'map({id: "5d1f0c3e-8a2b-4c7d-9e6f-1a2b3c4d5e6f", name: "../../etc/passwd", type: "png", bytes: 48213, width: 1440, height: 900, path: .})' <<<"${attachments}")}"
    run_cli get 17
    [[ "${status}" -eq 0 && "$(sed '1,/^}$/d' <<<"${output}")" == "${expected}" ]] || {
      echo "row ${label}: status=${status} ${output}${stderr}"
      return 1
    }
    [[ "$(sed -n '2,/^}$/p' <<<"${output}" | jq '[.attachments[] | has("path")] | any')" == false ]] || {
      echo "row ${label}: the item JSON still carries a path: ${output}"
      return 1
    }
  done
}

@test "a fetched item naming another session stops with exit 3 and prints none of it" {
  start_stub
  set_reply 200 "{\"id\":17,\"sessionId\":\"${FOREIGN_SESSION_ID}\",\"answer\":{\"code\":\"R2\",\"text\":\"merge-it-now\"}}"
  run_cli get 17
  [[ "${status}" -eq 3 && -z "${output}" && "${stderr}" != *"merge-it-now"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

@test "ack prints first or already handled as the monitor decided, and a refused ack exits 2" {
  start_stub
  local row reply_status reply expected_status expected_output
  for row in "first|200|{\"result\":\"first\"}|0|first" \
    "already-handled|200|{\"result\":\"already_handled\"}|0|already handled" \
    "unknown-msg-id|404|{\"error\":\"unknown_msg_id\",\"reason\":\"msg id belongs to no delivery of this item\"}|2|"; do
    IFS='|' read -r _ reply_status reply expected_status expected_output <<<"${row}"
    set_reply "${reply_status}" "${reply}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_cli ack 17 "${MSG_ID}"
    [[ "${status}" -eq "${expected_status}" && "${output}" == "${expected_output}" ]] || {
      echo "row ${row%%|*}: status=${status} ${output}${stderr}"
      return 1
    }
    [[ "$(request_body /api/queue/items/17/ack | jq -Sc .)" == "{\"msgId\":\"${MSG_ID}\",\"sessionId\":\"${SESSION_ID}\"}" ]] || {
      echo "row ${row%%|*}: $(cat "${BATS_TEST_TMPDIR}/requests.log")"
      return 1
    }
  done
}

@test "a malformed item id or msg id is refused with exit 64 and no request" {
  start_stub
  local row
  for row in "ack|0|${MSG_ID}" "ack|17|not-a-uuid" "get|17;id|" "withdraw|-3|" "get||"; do
    IFS='|' read -r cmd id msg <<<"${row}"
    if [[ -n "${msg}" ]]; then run_cli "${cmd}" "${id}" "${msg}"; else run_cli "${cmd}" "${id}"; fi
    [[ "${status}" -eq 64 && ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
      echo "row ${row}: status=${status} ${stderr}"
      return 1
    }
  done
}

@test "withdraw sends this session's id and a conflict exits 2 with the monitor's reason" {
  start_stub
  set_reply 409 '{"error":"not_withdrawable","reason":"item in state delivering cannot be withdrawn"}'
  run_cli withdraw 17
  [[ "${status}" -eq 2 && "${stderr}" == *"delivering cannot be withdrawn"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
  [[ "$(request_body /api/queue/items/17/withdraw)" == "{\"sessionId\":\"${SESSION_ID}\"}" ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "pending pulls until a pull claims nothing and prints the absolute fetch and ack commands per item" {
  start_stub
  set_nth_reply 1 200 "{\"items\":[{\"id\":{\"item\":17,\"msg\":\"${MSG_ID}\"}}]}"
  set_nth_reply 2 200 '{"items":[{"id":{"item":18,"msg":"7c1f8d2b-3a4e-4f6c-9b0d-2e3f4a5b6c7d"}}]}'
  set_reply 200 '{"items":[]}'
  run_cli pending
  [[ "${status}" -eq 0 ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
  local paths
  paths="$(jq -r '.path' "${BATS_TEST_TMPDIR}/requests.log")"
  [[ "${paths}" == $'/api/queue/pending\n/api/queue/pending\n/api/queue/pending' ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
  local cli_path="${GA_ROOT}/scripts/atrium-queue.sh"
  local commands="${cli_path} get 17|${cli_path} ack 17 ${MSG_ID}|${cli_path} ack 18 7c1f8d2b-3a4e-4f6c-9b0d-2e3f4a5b6c7d"
  local command
  IFS='|' read -r -a expected <<<"${commands}"
  for command in "${expected[@]}"; do
    [[ "${output}" == *"${command}"* ]] || {
      echo "missing ${command}: ${output}"
      return 1
    }
  done
}

@test "pending names answers or messages and never prints item text" {
  start_stub
  local row
  local nth_reply="${BATS_TEST_TMPDIR}/reply.1"
  for row in one-claim no-claim; do
    if ga_guard_path "${nth_reply}"; then rm -f -- "${nth_reply:?}"; fi
    : >"${BATS_TEST_TMPDIR}/requests.log"
    stop_stub
    if [[ "${row}" == one-claim ]]; then
      set_nth_reply 1 200 "{\"items\":[{\"id\":{\"item\":17,\"msg\":\"${MSG_ID}\"},\"kind\":\"message\",\"body\":\"ship-it-on-friday\"}]}"
    fi
    set_reply 200 '{"items":[]}'
    start_stub
    run_cli pending
    [[ "${status}" -eq 0 && "${output}" == *"answer or message"* && "${output}" != *"ship-it-on-friday"* ]] || {
      echo "row ${row}: status=${status} ${output}${stderr}"
      return 1
    }
  done
}

@test "pending refuses a claim whose ids are malformed and prints no command for it" {
  start_stub
  set_reply 200 '{"items":[{"id":{"item":"17; touch /tmp/x","msg":"not-a-uuid"}}]}'
  run_cli pending
  [[ "${status}" -eq 1 && "${output}" != *"ack"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

@test "wait polls with this session's id, its pid and the wait flag, and prints the fetch and ack steps once a poll claims" {
  start_stub
  start_owner
  use_fast_wait 20
  set_nth_reply 1 200 '{"items":[]}'
  set_reply 200 "{\"items\":[{\"id\":{\"item\":17,\"msg\":\"${MSG_ID}\"}}]}"
  run_cli wait
  local cli_path="${GA_ROOT}/scripts/atrium-queue.sh"
  [[ "${status}" -eq 0 && "${output}" == *"${cli_path} get 17"* && "${output}" == *"${cli_path} ack 17 ${MSG_ID}"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
  local poll poll_body expected_bodies="" poll_count=2
  poll_body="$(printf '{"pid":%s,"sessionId":"%s","wait":true}' "${OWNER_PID}" "${SESSION_ID}")"
  for ((poll = 1; poll <= poll_count; poll++)); do expected_bodies+="${poll_body}"$'\n'; done
  [[ "$(request_body /api/queue/pending | jq -Sc .)" == "${expected_bodies%$'\n'}" ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "wait ends with exit 4 and a start-again line when the bound passes with nothing claimed" {
  start_stub
  start_owner
  use_fast_wait 2
  set_reply 200 '{"items":[]}'
  run_cli wait
  [[ "${status}" -eq 4 && "${output}" == *"start the wait again"* && -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

@test "wait retries a failing or unreachable monitor and exits 1 only when the bound passes with no reply" {
  start_owner
  local row name expected
  for row in "failing-then-claims|0" "unreachable|1"; do
    IFS='|' read -r name expected <<<"${row}"
    stop_stub
    : >"${BATS_TEST_TMPDIR}/requests.log"
    if [[ "${name}" == unreachable ]]; then
      use_fast_wait 2
      export ATRIUM_MONITOR_PORT=1
    else
      use_fast_wait 20
      set_nth_reply 1 503 '{"error":"restarting"}'
      set_reply 200 "{\"items\":[{\"id\":{\"item\":17,\"msg\":\"${MSG_ID}\"}}]}"
      start_stub
    fi
    run_cli wait
    [[ "${status}" -eq "${expected}" ]] || {
      echo "row ${name}: status=${status} ${output}${stderr}"
      return 1
    }
  done
}

@test "a refusal ends the wait at once with exit 2 and the monitor's reason" {
  start_stub
  start_owner
  use_fast_wait 20
  set_reply 409 '{"error":"session_not_live","reason":"the session row is not live for this pid"}'
  run_cli wait
  [[ "${status}" -eq 2 && "${stderr}" == *"session_not_live"* && "$(wc -l <"${BATS_TEST_TMPDIR}/requests.log" | tr -d ' ')" == 1 ]] || {
    echo "status=${status} ${output}${stderr}"
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "a second wait of the same Claude process exits 5 while the first runs" {
  start_stub
  start_owner
  use_fast_wait 30
  set_reply 200 '{"items":[]}'
  start_waiter
  await_requests 1
  run_cli wait
  [[ "${status}" -eq 5 && "${stderr}" == *"another wait"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

@test "a wait takes over a lock whose waiter is gone or whose owner is another Claude process" {
  start_stub
  set_reply 200 '{"items":[]}'
  local row name
  for row in waiter-killed owner-replaced; do
    name="${row}"
    start_owner
    use_fast_wait 30
    start_waiter
    await_requests 1
    if [[ "${name}" == waiter-killed ]]; then
      kill -KILL "${WAITER_PID}"
      wait "${WAITER_PID}" 2>/dev/null || true
    else
      start_owner
    fi
    use_fast_wait 2
    run_cli wait
    [[ "${status}" -eq 4 ]] || {
      echo "row ${name}: second wait status=${status} ${stderr}"
      return 1
    }
    if [[ "${name}" == owner-replaced ]]; then
      await_exit "${WAITER_PID}"
      [[ "${AWAITED_STATUS}" == 5 ]] || {
        echo "row ${name}: first wait status=${AWAITED_STATUS} $(cat "${BATS_TEST_TMPDIR}/waiter.err")"
        return 1
      }
    fi
  done
}

@test "a wait that ends after another wait took its lock over neither moves nor re-creates the newcomer's lock" {
  start_stub
  start_owner
  use_fast_wait 20
  set_reply 200 "{\"items\":[{\"id\":{\"item\":17,\"msg\":\"${MSG_ID}\"}}]}"
  local lock="${GA_ROOT}/data/queue/waits/${SESSION_ID}" newcomer="31337|Thu Nov 12 21:30:07 2026|5151|Thu Nov 12 21:29:58 2026"
  local t="${BATS_TEST_TMPDIR}"
  # curl shim: the claiming poll → a newcomer of another Claude process renames its record onto the lock first
  cat >"${t}/bin/curl" <<SHIM
#!/usr/bin/env bash
if [[ ! -e "${t}/swapped" ]]; then
  : >"${t}/swapped"
  "$(command -v ln)" -sn -- '${newcomer}' "${lock}.newcomer"
  "$(command -v mv)" -f -- "${lock}.newcomer" "${lock}"
  printf 'SWAP\n' >>"${t}/trace.log"
fi
exec "$(PATH="${PATH#"${t}/bin:"}" command -v curl)" "\$@"
SHIM
  install_lock_step_shims "${lock}"
  export QUEUE_TEST_TRACE=1
  run_cli wait
  local after_swap
  after_swap="$(sed -n '/^SWAP$/,$p' "${t}/trace.log")"
  [[ "${status}" -eq 0 && "$(readlink "${lock}")" == "${newcomer}" && "${after_swap}" == SWAP ]] || {
    echo "status=${status} lock=$(readlink "${lock}") ${stderr}"
    cat "${t}/trace.log"
    return 1
  }
}

@test "a wait of another Claude process keeps the lock it took over while the wait it displaced ends" {
  start_stub
  set_reply 200 '{"items":[]}'
  local t="${BATS_TEST_TMPDIR}" lock="${GA_ROOT}/data/queue/waits/${SESSION_ID}"
  install_lock_step_shims "${lock}"
  install_read_gate_shim
  local row old_owner new_owner old_pid new_pid third_pid old_status leftover
  # each row → what happens while the displaced wait releases; a gap row holds that release inside drop_wait_lock,
  # under the waits mutex, at its read of the newcomer's record, and starts a third wait of the newcomer's Claude
  # process there
  for row in release-completes third-wait-in-gap releaser-killed-in-gap; do
    stop_waiters
    for leftover in "${t}/in-gap" "${t}/gate-open" "${t}/trace.log" "${lock}"; do
      if ga_guard_path "${leftover}"; then rm -f -- "${leftover:?}"; fi
    done
    start_owner
    old_owner="${OWNER_PID}"
    start_owner
    new_owner="${OWNER_PID}"
    export CLAUDE_PID="${old_owner}"
    use_fast_wait 30
    if [[ "${row}" != release-completes ]]; then export QUEUE_TEST_GATE_READ="*|${new_owner}|*"; fi
    start_waiter old
    unset QUEUE_TEST_GATE_READ
    old_pid="${WAITER_PID}"
    await_requests "$(($(wc -l <"${t}/requests.log") + 1))"
    export CLAUDE_PID="${new_owner}"
    use_fast_wait 6
    export QUEUE_TEST_TRACE=1
    start_waiter new
    unset QUEUE_TEST_TRACE
    new_pid="${WAITER_PID}"
    old_status=5
    if [[ "${row}" != release-completes ]]; then
      await_file_or_exit "${t}/in-gap" "${old_pid}"
      [[ -s "${t}/in-gap" ]] && kill -0 "${old_pid}" 2>/dev/null || {
        echo "row ${row}: the displaced wait never held inside its release ($(cat "${t}/waiter.old.err"))"
        return 1
      }
      use_fast_wait 2
      start_waiter third
      third_pid="${WAITER_PID}"
      # the third wait reaches the waits mutex and waits there on the held release
      sleep 1
      kill -0 "${third_pid}" 2>/dev/null || {
        echo "row ${row}: the third wait ended before the release did: $(cat "${t}/waiter.third.err")"
        return 1
      }
      if [[ "${row}" == releaser-killed-in-gap ]]; then
        kill_chain_up_to "$(cat "${t}/in-gap")" "${old_pid}"
        old_status=137
      else
        : >"${t}/gate-open"
      fi
      await_exit "${third_pid}"
      [[ "${AWAITED_STATUS}" == 5 && "$(cat "${t}/waiter.third.err")" == *"already runs"* ]] || {
        echo "row ${row}: third wait status=${AWAITED_STATUS} $(cat "${t}/waiter.third.err")"
        return 1
      }
    fi
    await_exit "${old_pid}"
    [[ "${AWAITED_STATUS}" == "${old_status}" ]] || {
      echo "row ${row}: displaced wait status=${AWAITED_STATUS} $(cat "${t}/waiter.old.err")"
      return 1
    }
    kill -0 "${new_pid}" 2>/dev/null && [[ "$(readlink "${lock}")" == "${new_pid}|"* ]] || {
      echo "row ${row}: newcomer alive=$(kill -0 "${new_pid}" 2>/dev/null && echo yes) lock=$(readlink "${lock}")"
      cat "${t}/waiter.new.err"
      return 1
    }
    await_exit "${new_pid}"
    [[ "${AWAITED_STATUS}" == 4 ]] || {
      echo "row ${row}: newcomer status=${AWAITED_STATUS} $(cat "${t}/waiter.new.err")"
      return 1
    }
    # the newcomer's own release empties the waits dir: no lock name and no private name is left
    [[ -z "$(ls -A "${lock%/*}")" ]] || {
      echo "row ${row}: names left in the waits dir: $(ls -A "${lock%/*}")"
      return 1
    }
    ! grep -q 'ABSENT' "${t}/trace.log" || {
      echo "row ${row}: the takeover left the lock name empty"
      cat "${t}/trace.log"
      return 1
    }
  done
}

@test "two waits reclaiming one dead record leave one running and the other ends as already running" {
  start_stub
  set_reply 200 '{"items":[]}'
  start_owner
  use_fast_wait 10
  local t="${BATS_TEST_TMPDIR}" lock="${GA_ROOT}/data/queue/waits/${SESSION_ID}" dead_pid stale
  true &
  dead_pid=$!
  wait "${dead_pid}"
  stale="${dead_pid}|Thu Nov 12 21:30:07 2026|${OWNER_PID}|$(get_recorded_start "${OWNER_PID}")"
  mkdir -p "${lock%/*}"
  ln -sn -- "${stale}" "${lock}"
  install_read_gate_shim
  # the first wait holds at its read of the dead record inside take_wait_lock, under the waits mutex, until gate-open;
  # the second wait starts meanwhile and reaches the mutex while the first still holds it
  export QUEUE_TEST_GATE_READ="${stale}"
  start_waiter first
  unset QUEUE_TEST_GATE_READ
  local first_pid="${WAITER_PID}" second_pid ended="" survivor tries=0
  await_file_or_exit "${t}/in-gap" "${first_pid}"
  [[ -s "${t}/in-gap" ]] || {
    echo "the first wait never held at its read of the dead record: $(cat "${t}/waiter.first.err")"
    return 1
  }
  start_waiter second
  second_pid="${WAITER_PID}"
  sleep 0.5
  : >"${t}/gate-open"
  while [[ -z "${ended}" ]] && ((tries < 200)); do
    kill -0 "${first_pid}" 2>/dev/null || ended=first
    kill -0 "${second_pid}" 2>/dev/null || ended=second
    sleep 0.05
    tries=$((tries + 1))
  done
  survivor="$([[ "${ended}" == first ]] && echo "${second_pid}" || echo "${first_pid}")"
  await_requests "$(($(wc -l <"${t}/requests.log") + 2))"
  await_exit "$([[ "${ended}" == first ]] && echo "${first_pid}" || echo "${second_pid}")"
  [[ -n "${ended}" && "${AWAITED_STATUS}" == 5 && "$(cat "${t}/waiter.${ended}.err")" == *"already runs"* ]] || {
    echo "ended=${ended:-none} status=${AWAITED_STATUS} $(cat "${t}/waiter.first.err" "${t}/waiter.second.err")"
    return 1
  }
  kill -0 "${survivor}" 2>/dev/null && [[ "$(readlink "${lock}")" == "${survivor}|"* ]] || {
    echo "survivor ${survivor} alive=$(kill -0 "${survivor}" 2>/dev/null && echo yes) lock=$(readlink "${lock}")"
    return 1
  }
}

@test "a wait whose takeover rename fails exits 1 and leaves no private name in the waits dir" {
  start_stub
  set_reply 200 '{"items":[]}'
  start_owner
  use_fast_wait 2
  local t="${BATS_TEST_TMPDIR}" lock="${GA_ROOT}/data/queue/waits/${SESSION_ID}" dead_pid stale
  true &
  dead_pid=$!
  wait "${dead_pid}"
  stale="${dead_pid}|Thu Nov 12 21:30:07 2026|${OWNER_PID}|$(get_recorded_start "${OWNER_PID}")"
  mkdir -p "${lock%/*}"
  ln -sn -- "${stale}" "${lock}"
  # mv shim: the rename of the built record onto the lock name fails
  cat >"${t}/bin/mv" <<SHIM
#!/usr/bin/env bash
if [[ "\$*" == *"${lock}.take"* ]]; then exit 1; fi
exec "$(command -v mv)" "\$@"
SHIM
  chmod 755 "${t}/bin/mv"
  run_cli wait
  [[ "${status}" -eq 1 && "${stderr}" == *"cannot replace the stale wait lock"* ]] || {
    echo "status=${status} ${stderr}"
    return 1
  }
  [[ "$(ls -A "${lock%/*}")" == "${SESSION_ID}" && "$(readlink "${lock}")" == "${stale}" ]] || {
    echo "waits dir: $(ls -A "${lock%/*}") lock=$(readlink "${lock}")"
    return 1
  }
}

@test "a wait that finds its lock name empty keeps polling and puts its own record back" {
  start_stub
  start_owner
  use_fast_wait 6
  set_reply 200 '{"items":[]}'
  local lock="${GA_ROOT}/data/queue/waits/${SESSION_ID}"
  start_waiter
  await_requests 1
  if ga_guard_path "${lock}"; then rm -f -- "${lock:?}"; fi
  await_requests 3
  kill -0 "${WAITER_PID}" 2>/dev/null && [[ "$(readlink "${lock}")" == "${WAITER_PID}|"* ]] || {
    echo "alive=$(kill -0 "${WAITER_PID}" 2>/dev/null && echo yes) lock=$(readlink "${lock}") $(cat "${BATS_TEST_TMPDIR}/waiter.err")"
    return 1
  }
  await_exit "${WAITER_PID}"
  [[ "${AWAITED_STATUS}" == 4 ]] || {
    echo "status=${AWAITED_STATUS} $(cat "${BATS_TEST_TMPDIR}/waiter.err")"
    return 1
  }
}

@test "a wait ended by a signal exits 143 and the next wait of the session starts" {
  start_stub
  start_owner
  use_fast_wait 30
  set_reply 200 '{"items":[]}'
  start_waiter
  await_requests 1
  kill -TERM "${WAITER_PID}"
  await_exit "${WAITER_PID}"
  [[ "${AWAITED_STATUS}" == 143 ]] || {
    echo "status=${AWAITED_STATUS} $(cat "${BATS_TEST_TMPDIR}/waiter.err")"
    return 1
  }
  use_fast_wait 1
  run_cli wait
  [[ "${status}" -eq 4 ]] || {
    echo "status=${status} ${stderr}"
    return 1
  }
}

@test "a wait ends silently once its owning Claude process is gone" {
  start_stub
  start_owner
  use_fast_wait 30
  set_reply 200 '{"items":[]}'
  start_waiter
  await_requests 1
  kill "${OWNER_PID}"
  await_exit "${WAITER_PID}"
  [[ "${AWAITED_STATUS}" == 4 && ! -s "${BATS_TEST_TMPDIR}/waiter.out" && ! -s "${BATS_TEST_TMPDIR}/waiter.err" ]] || {
    echo "status=${AWAITED_STATUS} $(cat "${BATS_TEST_TMPDIR}/waiter.out" "${BATS_TEST_TMPDIR}/waiter.err")"
    return 1
  }
}

@test "wait refuses any argument but --max-minutes 1 to 240, or a missing pid, with exit 64 and no request" {
  start_stub
  start_owner
  local row name pid_mode
  local -a rows=("session-id|${SESSION_ID}" "zero|--max-minutes|0" "over-max|--max-minutes|241"
    "not-a-number|--max-minutes|abc" "no-value|--max-minutes" "extra|--max-minutes|5|extra" "no-pid")
  for row in "${rows[@]}"; do
    IFS='|' read -r -a argv <<<"${row}"
    name="${argv[0]}"
    pid_mode=set
    if [[ "${name}" == no-pid ]]; then pid_mode=unset; fi
    if [[ "${pid_mode}" == unset ]]; then unset CLAUDE_PID; else export CLAUDE_PID="${OWNER_PID}"; fi
    run_cli wait "${argv[@]:1}"
    [[ "${status}" -eq 64 && ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
      echo "row ${name}: status=${status} ${stderr}"
      return 1
    }
  done
}

@test "the CLI register sends the same body as the SessionStart hook and neither writes a token file" {
  start_stub
  set_reply 200 '{"answeredWaiting":0}'
  run --separate-stderr "${REGISTER_HOOK}" <<<'{"hook_event_name":"SessionStart","source":"resume"}'
  local hook_body cli_body
  hook_body="$(request_body /api/queue/sessions/register | jq -Sc .)"
  : >"${BATS_TEST_TMPDIR}/requests.log"
  run_cli register
  cli_body="$(request_body /api/queue/sessions/register | jq -Sc .)"
  [[ "${status}" -eq 0 && -n "${hook_body}" && "${cli_body}" == "${hook_body}" ]] || {
    echo "status=${status} ${stderr} hook=${hook_body} cli=${cli_body}"
    return 1
  }
  [[ ! -e "${GA_ROOT}/data/queue/tokens" ]] || {
    ls -laR "${GA_ROOT}/data/queue"
    return 1
  }
}

@test "the SessionStart hook and the CLI register both write back the awaiting marks the register reply lists" {
  start_stub
  set_reply 200 '{"answeredWaiting":0,"awaitingItemIds":[57,41]}'
  local row marks
  for row in hook cli; do
    export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root.${row}"
    if [[ "${row}" == hook ]]; then
      run --separate-stderr "${REGISTER_HOOK}" <<<'{"hook_event_name":"SessionStart","source":"resume"}'
    else
      run_cli register
    fi
    marks="$(awaiting_items | paste -sd ' ' -)"
    [[ "${status}" -eq 0 && "${marks}" == "57 41" ]] || {
      echo "row ${row}: status=${status} marks=[${marks}] ${output}${stderr}"
      return 1
    }
  done
}

@test "register --name sends the name with control characters as spaces, cut to the monitor's name limit" {
  start_stub
  set_reply 200 '{"answeredWaiting":0}'
  local limit wide i sent
  # the monitor's own limit, in code points as its schema and column count → a drift in number or unit fails here
  limit="$(sed -n 's/^const SESSION_NAME_MAX = \([0-9][0-9]*\);$/\1/p' "${GA}/monitor/src/server/queue/schemas.ts")"
  [[ "${limit}" =~ ^[0-9]+$ ]] || {
    echo "no SESSION_NAME_MAX in schemas.ts"
    return 1
  }
  wide="$(printf "%$((limit - 1))s" '' | tr ' ' 'x')"
  local -a names=("nightly backup" $'queue\tsessions\x1b[0m' "  ${wide}yz" "${wide}😀" "${wide}y😀")
  local -a expected=("nightly backup" "queue sessions [0m" "${wide}y" "${wide}😀" "${wide}y")
  for ((i = 0; i < ${#names[@]}; i++)); do
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_cli register --name "${names[i]}"
    sent="$(request_body /api/queue/sessions/register | jq -r '.name')"
    [[ "${status}" -eq 0 && "${sent}" == "${expected[i]}" ]] || {
      echo "row ${i}: status=${status} sent=[${sent}] ${stderr}"
      return 1
    }
  done
}

@test "register refuses a blank or missing --name, or an unknown argument, with exit 64 and no request" {
  start_stub
  local i
  local -a rows=("--name|   " $'--name|\xe3\x80\x80' "--name|" "--nickname|backup")
  for ((i = 0; i < ${#rows[@]}; i++)); do
    if [[ -n "${rows[i]#*|}" ]]; then run_cli register "${rows[i]%%|*}" "${rows[i]#*|}"; else run_cli register "${rows[i]%%|*}"; fi
    [[ "${status}" -eq 64 && ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
      echo "row ${rows[i]}: status=${status} ${stderr}"
      return 1
    }
  done
}

@test "register names the waiting count and the absolute pending command when answers wait" {
  start_stub
  set_reply 200 '{"answeredWaiting":3}'
  run_cli register
  [[ "${status}" -eq 0 && "${output}" == *"3 owner queue answer(s) or message(s) wait"* && "${output}" == *"${GA_ROOT}/scripts/atrium-queue.sh pending"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

# the one line the CLI prints to start this session's wait, and the one it prints while a wait of this session runs
start_wait_line() {
  printf 'next: start the wait as a background command: %s/scripts/atrium-queue.sh wait — owner answers and messages reach this session only through it\n' "${GA_ROOT}"
}
WAIT_RUNS_LINE="next: a wait of this session already runs — owner answers and messages reach this session through it; start no other wait"

@test "a decision or a report allowing a reply prints the start-wait line after the id line; a no-reply report only the id" {
  start_stub
  set_reply 201 '{"id":17}'
  local row kind item expected start_line
  start_line="$(start_wait_line)"
  local no_reply_report="${REPORT/\"isFreeTextAllowed\":true/\"isFreeTextAllowed\":false}"
  for row in "decision|${DECISION}|2" "report|${REPORT}|2" "report|${no_reply_report}|1"; do
    IFS='|' read -r kind item expected <<<"${row}"
    run_cli "${kind}" - <<<"${item}"
    [[ "${status}" -eq 0 && "${lines[0]}" == "posted ${kind} item 17" && "${#lines[@]}" -eq "${expected}" ]] || {
      echo "row ${kind}/${expected}: status=${status} ${output}${stderr}"
      return 1
    }
    if ((expected == 2)); then
      [[ "${lines[1]}" == "${start_line}" ]] || {
        echo "row ${kind}: second line [${lines[1]}]"
        return 1
      }
    fi
  done
}

# session $1's (default this one) awaiting items through the lib reader the turn-end check reads
awaiting_items() {
  bash -c 'source "$1/scripts/lib/queue-session.sh" && queue_get_awaiting_items "$2"' _ "${GA}" "${1:-${SESSION_ID}}"
}

# marks item $1 awaiting for session $2 (default this one) through the lib writer a post uses
mark_awaiting() {
  bash -c 'source "$1/scripts/lib/queue-session.sh" && queue_create_awaiting_item "$2" "$3"' _ "${GA}" "${2:-${SESSION_ID}}" "$1"
}

@test "a post leaves its item awaiting exactly when the monitor's register rule lists it, newest first" {
  local rule
  # the monitor's rule as JSON: [{ kind: "decision" }, ...] → [{"kind":"decision"}, ...]
  rule="$(sed -n 's/^export const AWAITING_WHERE = { OR: \(\[.*\]\) } satisfies .*;$/\1/p' \
    "${GA}/monitor/src/server/queue/registry.ts" | sed -E 's/([A-Za-z]+):/"\1":/g')"
  jq -e 'type == "array" and length > 0' <<<"${rule}" >/dev/null || {
    echo "no AWAITING_WHERE in registry.ts: [${rule}]"
    return 1
  }
  start_stub
  local row kind id flag item expected=""
  for row in "decision|9|false" "decision|10|true" "report|17|true" "report|18|false"; do
    IFS='|' read -r kind id flag <<<"${row}"
    if [[ "${kind}" == decision ]]; then item="${DECISION}"; else item="${REPORT}"; fi
    item="$(jq -c --argjson flag "${flag}" '.isFreeTextAllowed = $flag' <<<"${item}")"
    set_reply 201 "{\"id\":${id}}"
    run_cli "${kind}" - <<<"${item}"
    [[ "${status}" -eq 0 ]] || {
      echo "row ${kind}/${flag}: status=${status} ${output}${stderr}"
      return 1
    }
    if jq -e --argjson rule "${rule}" --arg kind "${kind}" --argjson flag "${flag}" \
      '{kind: $kind, isFreeTextAllowed: $flag} as $item | any($rule[]; to_entries | all(.value == $item[.key]))' \
      <<<'null' >/dev/null; then
      expected="${id}${expected:+$'\n'}${expected}"
    fi
  done
  [[ "$(awaiting_items)" == "${expected}" ]] || {
    echo "awaiting: [$(awaiting_items)] · monitor rule ${rule} lists: [${expected}]"
    return 1
  }
}

@test "a post whose awaiting mark cannot be written still exits 0 with the id line first and warns on stderr" {
  start_stub
  set_reply 201 '{"id":17}'
  mkdir -p "${GA_ROOT}/data/queue"
  : >"${GA_ROOT}/data/queue/awaiting"
  run_cli decision - <<<"${DECISION}"
  [[ "${status}" -eq 0 && "${lines[0]}" == "posted decision item 17" && "${stderr}" == *"item 17"*"awaiting mark"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

@test "ack on first or already handled and an accepted withdraw end the item's awaiting; a refused one keeps it" {
  start_stub
  local row name cmd reply_status reply expected
  for row in "ack-first|ack|200|{\"result\":\"first\"}|9" \
    "ack-already-handled|ack|200|{\"result\":\"already_handled\"}|9" \
    "ack-refused|ack|404|{\"error\":\"unknown_msg_id\",\"reason\":\"msg id belongs to no delivery of this item\"}|17 9" \
    "withdraw-accepted|withdraw|200|{}|9" \
    "withdraw-refused|withdraw|409|{\"error\":\"not_withdrawable\",\"reason\":\"item in state delivering cannot be withdrawn\"}|17 9"; do
    IFS='|' read -r name cmd reply_status reply expected <<<"${row}"
    mark_awaiting 17
    mark_awaiting 9
    set_reply "${reply_status}" "${reply}"
    if [[ "${cmd}" == ack ]]; then run_cli ack 17 "${MSG_ID}"; else run_cli withdraw 17; fi
    [[ "$(awaiting_items | tr '\n' ' ')" == "${expected} " ]] || {
      echo "row ${name}: status=${status} awaiting [$(awaiting_items)] ${output}${stderr}"
      return 1
    }
  done
}

@test "a post drops other sessions' awaiting sets untouched for over 30 days and keeps fresher ones and its own" {
  start_stub
  set_reply 201 '{"id":17}'
  local awaiting="${GA_ROOT}/data/queue/awaiting" fresh_session="5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f"
  mark_awaiting 5
  mark_awaiting 3 "${FOREIGN_SESSION_ID}"
  mark_awaiting 4 "${fresh_session}"
  # shellcheck disable=SC2016  # a perl program, not a shell expansion
  perl -e 'my $t = time - 40 * 86400; utime $t, $t, @ARGV or exit 1' "${awaiting}/${SESSION_ID}/5" \
    "${awaiting}/${SESSION_ID}" "${awaiting}/${FOREIGN_SESSION_ID}/3" "${awaiting}/${FOREIGN_SESSION_ID}"
  run_cli decision - <<<"${DECISION}"
  [[ "${status}" -eq 0 && ! -e "${awaiting}/${FOREIGN_SESSION_ID}" && "$(awaiting_items "${fresh_session}")" == 4 \
    && "$(awaiting_items)" == $'17\n5' ]] || {
    echo "status=${status} ${stderr}"
    ls -laR "${awaiting}"
    return 1
  }
}

@test "pending and register end with the start-wait line when no wait of this session runs" {
  start_stub
  start_owner
  local row start_line nth_reply="${BATS_TEST_TMPDIR}/reply.1"
  start_line="$(start_wait_line)"
  # a dead waiter's record of this Claude process, and a live waiter's record of another one → neither is this wait
  mkdir -p "${GA_ROOT}/data/queue/waits"
  ln -sn -- "99999999|Thu Nov 12 21:30:07 2026|${OWNER_PID}|$(get_recorded_start "${OWNER_PID}")" \
    "${GA_ROOT}/data/queue/waits/${SESSION_ID}"
  for row in pending-claim pending-none register; do
    if ga_guard_path "${nth_reply}"; then rm -f -- "${nth_reply:?}"; fi
    if [[ "${row}" == pending-claim ]]; then
      set_nth_reply 1 200 "{\"items\":[{\"id\":{\"item\":17,\"msg\":\"${MSG_ID}\"}}]}"
    fi
    set_reply 200 '{"items":[],"answeredWaiting":0}'
    stop_stub
    start_stub
    run_cli "${row%%-*}"
    [[ "${status}" -eq 0 && "${lines[${#lines[@]} - 1]}" == "${start_line}" && "${output}" != *"already runs"* ]] || {
      echo "row ${row}: status=${status} ${output}${stderr}"
      return 1
    }
  done
  ln -sfn -- "$$|$(get_recorded_start "$$")|1|$(get_recorded_start 1)" "${GA_ROOT}/data/queue/waits/${SESSION_ID}"
  run_cli register
  [[ "${status}" -eq 0 && "${lines[${#lines[@]} - 1]}" == "${start_line}" ]] || {
    echo "another Claude process's wait: status=${status} ${output}${stderr}"
    return 1
  }
}

@test "while a wait of this session runs, a post, pending and register say so instead of starting another" {
  start_stub
  start_owner
  use_fast_wait 30
  # one reply every route reads → the running wait keeps claiming nothing
  set_reply 200 '{"id":17,"items":[],"answeredWaiting":0}'
  start_waiter
  await_requests 1
  local row
  for row in decision pending register; do
    if [[ "${row}" == decision ]]; then run_cli decision - <<<"${DECISION}"; else run_cli "${row}"; fi
    [[ "${status}" -eq 0 && "${lines[${#lines[@]} - 1]}" == "${WAIT_RUNS_LINE}" && "${output}" != *"start the wait"* ]] || {
      echo "row ${row}: status=${status} ${output}${stderr}"
      return 1
    }
  done
  kill -0 "${WAITER_PID}" || {
    echo "the running wait ended: $(cat "${BATS_TEST_TMPDIR}/waiter.err")"
    return 1
  }
}

@test "requests carry no queue key header and the messaging token never reaches curl's argv" {
  start_stub
  set_reply 200 '{"answeredWaiting":0}'
  run_cli register
  run_cli get 17
  [[ -s "${BATS_TEST_TMPDIR}/curl-argv.log" ]] && ! grep -qF "${SOCKET_AUTH}" "${BATS_TEST_TMPDIR}/curl-argv.log" || {
    cat "${BATS_TEST_TMPDIR}/curl-argv.log"
    return 1
  }
  [[ "$(jq -c '[.path, (.headers | has("x-atrium-queue-key"))]' "${BATS_TEST_TMPDIR}/requests.log")" == "$(printf '%s\n' '["/api/queue/sessions/register",false]' "[\"/api/queue/items/17?sessionId=${SESSION_ID}\",false]")" ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "a monitor that is down or slow fails with exit 1 and a message naming no provisioning, within the timeout" {
  local row condition started elapsed
  for row in down slow; do
    condition="${row}"
    stop_stub
    case "${condition}" in
      down) export ATRIUM_MONITOR_PORT=1 ;;
      slow) set_reply hang '' && start_stub ;;
    esac
    : >"${BATS_TEST_TMPDIR}/requests.log"
    started=${SECONDS}
    run_cli get 17
    elapsed=$((SECONDS - started))
    [[ "${status}" -eq 1 && -n "${stderr}" && "${stderr}" != *provision* && -z "${output}" && "${elapsed}" -le 15 ]] || {
      echo "row ${row}: status=${status} elapsed=${elapsed}s ${output}${stderr}"
      return 1
    }
  done
}

@test "with no session id in the env every session command exits 64 before any request" {
  unset CLAUDE_CODE_SESSION_ID
  start_stub
  local row
  for row in "get 17" "pending" "wait" "withdraw 17" "ack 17 ${MSG_ID}" "register"; do
    IFS=' ' read -r -a argv <<<"${row}"
    run_cli "${argv[@]}"
    [[ "${status}" -eq 64 && ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
      echo "row ${row}: status=${status} ${stderr}"
      return 1
    }
  done
}

@test "help names every command and the allow rule with the absolute installed CLI path and no interpreter or env prefix" {
  run_cli help
  local cli_path="${GA_ROOT}/scripts/atrium-queue.sh" cmd
  [[ "${status}" -eq 0 ]] || {
    echo "status=${status} ${stderr}"
    return 1
  }
  for cmd in report decision get pending wait ack withdraw register; do
    grep -qE "^  ${cli_path//./[.]} ${cmd}( |\$)" <<<"${output}" || {
      echo "command ${cmd}: ${output}"
      return 1
    }
  done
  # the settings proposal copies this rule → its prefix is the literal the pointer line and pending print
  grep -qxF "  Bash(${cli_path}:*)" <<<"${output}" || {
    echo "allow rule: ${output}"
    return 1
  }
  [[ "${output}" != *"queue key"* && "${output}" != *provision* ]] || {
    echo "help still names a provisioning step: ${output}"
    return 1
  }
}

@test "an unknown command or no command prints usage and exits 64" {
  local row
  for row in "unknown|frobnicate" "none|"; do
    if [[ -n "${row#*|}" ]]; then run_cli "${row#*|}"; else run_cli; fi
    [[ "${status}" -eq 64 && "${stderr}" == *"Usage"* ]] || {
      echo "row ${row%%|*}: status=${status} ${stderr}"
      return 1
    }
  done
}
