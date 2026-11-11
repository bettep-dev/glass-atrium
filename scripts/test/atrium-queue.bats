#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2249,SC2312  # BATS_* and run results are set by bats; each case arm is a row; a masked status fails its comparison
# The owner queue CLI against a stand-in monitor. Protects local validation before any request, the
# session id taken from the env, the foreign-item stop, the ack verdict lines, the pull loop's printed
# commands, the register step it shares with the SessionStart hook, and the absolute-path help literal.
#
# Run via: bats scripts/test/atrium-queue.bats
# Requires: bats, bash 3.2+, jq, curl, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
CLI="${GA}/scripts/atrium-queue.sh"
REGISTER_HOOK="${GA}/hooks/queue-session-register.sh"
SESSION_ID="3f1c2b9a-7d4e-4f5a-9b6c-0e1d2c3b4a59"
FOREIGN_SESSION_ID="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
MSG_ID="6b0e7c1a-2f3d-4e5b-8a9c-1d2e3f4a5b6c"
QUEUE_AUTH="k3yV4lue_0123456789abcdefABCDEF-xyz"
SOCKET_AUTH="tok-81f3c2e9d0b7a6f5"
REPORT='{"title":"Nightly backup failed twice","body":"The 02:00 run hit a full disk; rerun after cleanup?","isFreeTextAllowed":true,"linkedDocIds":[43944]}'
DECISION='{"title":"Pick the retention window","body":"Backups now take 40 GB a week.","isFreeTextAllowed":false,"options":[{"code":"R1","label":"Keep 14 days","pros":"cheap","cons":"short history"},{"code":"R2","label":"Keep 30 days","pros":"longer history","cons":"twice the disk"}],"recommendedCode":"R1"}'

setup() {
  # the ambient session's own CLAUDE_* values must never reach the CLI under test
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CONFIG_DIR CLAUDE_CODE_MESSAGING_SOCKET \
    CLAUDE_CODE_MESSAGING_TOKEN ATRIUM_QUEUE_ACCEPT_WRAPPER ATRIUM_MONITOR_PORT
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  mkdir -p "${GA_ROOT}/secrets" "${BATS_TEST_TMPDIR}/bin"
  chmod 700 "${GA_ROOT}/secrets"
  printf '%s\n' "${QUEUE_AUTH}" >"${GA_ROOT}/secrets/queue-key"
  chmod 600 "${GA_ROOT}/secrets/queue-key"
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
  stop_stub
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

@test "pending refuses a claim whose ids are malformed and prints no command for it" {
  start_stub
  set_reply 200 '{"items":[{"id":{"item":"17; touch /tmp/x","msg":"not-a-uuid"}}]}'
  run_cli pending
  [[ "${status}" -eq 1 && "${output}" != *"ack"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

@test "the CLI register sends the same body as the SessionStart hook and copies the token the same way" {
  start_stub
  set_reply 200 '{"answeredWaiting":0}'
  run --separate-stderr "${REGISTER_HOOK}" <<<'{"hook_event_name":"SessionStart","source":"resume"}'
  local hook_body cli_body
  hook_body="$(request_body /api/queue/sessions/register | jq -Sc .)"
  # a second token value → the file can only hold it if the CLI itself rewrote it
  printf -v CLAUDE_CODE_MESSAGING_TOKEN '%s' "${SOCKET_AUTH}-rotated"
  : >"${BATS_TEST_TMPDIR}/requests.log"
  run_cli register
  cli_body="$(request_body /api/queue/sessions/register | jq -Sc .)"
  [[ "${status}" -eq 0 && -n "${hook_body}" && "${cli_body}" == "${hook_body}" ]] || {
    echo "status=${status} ${stderr} hook=${hook_body} cli=${cli_body}"
    return 1
  }
  [[ "$(cat "${GA_ROOT}/data/queue/tokens/${SESSION_ID}")" == "${SOCKET_AUTH}-rotated" ]] || {
    ls -la "${GA_ROOT}/data/queue/tokens"
    return 1
  }
}

@test "register names the waiting count and the absolute pending command when answers wait" {
  start_stub
  set_reply 200 '{"answeredWaiting":3}'
  run_cli register
  [[ "${status}" -eq 0 && "${output}" == *"3 answered"* && "${output}" == *"${GA_ROOT}/scripts/atrium-queue.sh pending"* ]] || {
    echo "status=${status} ${output}${stderr}"
    return 1
  }
}

@test "the queue key and the messaging token never reach curl's argv" {
  start_stub
  set_reply 200 '{"answeredWaiting":0}'
  run_cli register
  run_cli get 17
  [[ -s "${BATS_TEST_TMPDIR}/curl-argv.log" ]] && ! grep -qF -e "${QUEUE_AUTH}" -e "${SOCKET_AUTH}" "${BATS_TEST_TMPDIR}/curl-argv.log" || {
    cat "${BATS_TEST_TMPDIR}/curl-argv.log"
    return 1
  }
  [[ "$(jq -r '.headers["x-atrium-queue-key"]' "${BATS_TEST_TMPDIR}/requests.log" | sort -u)" == "${QUEUE_AUTH}" ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "a monitor that is down, slow or unprovisioned fails with exit 1 and a message, within the timeout" {
  local row condition started elapsed
  for row in down slow unprovisioned; do
    condition="${row}"
    stop_stub
    case "${condition}" in
      down) export ATRIUM_MONITOR_PORT=1 ;;
      slow) set_reply hang '' && start_stub ;;
      unprovisioned) mv "${GA_ROOT}/secrets/queue-key" "${BATS_TEST_TMPDIR}/key.aside" && start_stub ;;
    esac
    : >"${BATS_TEST_TMPDIR}/requests.log"
    started=${SECONDS}
    run_cli get 17
    elapsed=$((SECONDS - started))
    [[ "${status}" -eq 1 && -n "${stderr}" && -z "${output}" && "${elapsed}" -le 15 ]] || {
      echo "row ${row}: status=${status} elapsed=${elapsed}s ${output}${stderr}"
      return 1
    }
  done
}

@test "with no session id in the env every session command exits 64 before any request" {
  unset CLAUDE_CODE_SESSION_ID
  start_stub
  local row
  for row in "get 17" "pending" "withdraw 17" "ack 17 ${MSG_ID}" "register"; do
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
  for cmd in report decision get pending ack withdraw register; do
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
