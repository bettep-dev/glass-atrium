#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2154,SC2249,SC2312  # a row's export stays inside its own bats test; BATS_* and run results are set by bats; a masked status fails its comparison; each case arm is a row
# The owner queue's session side: the SessionStart register hook and the SessionEnd deregister hook
# against a stand-in monitor. Protects the wire fields (pid only, never a start time), the secrecy of
# the messaging token, the pointer line, and the fail-open exit.
#
# Run via: bats hooks/test/queue-session.bats
# Requires: bats, bash 3.2+, jq, curl, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REGISTER_HOOK="${GA}/hooks/queue-session-register.sh"
DEREGISTER_HOOK="${GA}/hooks/queue-session-deregister.sh"
SESSION_ID="3f1c2b9a-7d4e-4f5a-9b6c-0e1d2c3b4a59"
SOCKET_AUTH="tok-81f3c2e9d0b7a6f5"

setup() {
  # the ambient session's own CLAUDE_* values must never reach a hook under test
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CONFIG_DIR CLAUDE_CODE_MESSAGING_SOCKET ATRIUM_QUEUE_PROBE \
    CLAUDE_CODE_MESSAGING_TOKEN ATRIUM_MONITOR_PORT CLAUDE_JOB_DIR
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  # the profile config the shadowing check reads → never the running user's own
  export HOME="${BATS_TEST_TMPDIR}/home"
  export GA_DATA_ROOT="${HOME}/.glass-atrium"
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
  set_reply 200 '{"answeredWaiting":0}'
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

start_stub() {
  : >"${BATS_TEST_TMPDIR}/requests.log"
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

# the JSON body of the request the stub saw on <path>, or nothing
request_body() {
  jq -r --arg p "$1" 'select(.path == $p) | .body' "${BATS_TEST_TMPDIR}/requests.log"
}

run_register() {
  local payload="${1:-}"
  [[ -n "${payload}" ]] || payload='{"hook_event_name":"SessionStart","source":"startup"}'
  run --separate-stderr "${REGISTER_HOOK}" <<<"${payload}"
}

run_deregister() {
  local payload="${1:-}"
  [[ -n "${payload}" ]] || payload='{"hook_event_name":"SessionEnd","reason":"exit"}'
  run --separate-stderr "${DEREGISTER_HOOK}" <<<"${payload}"
}

@test "register sends the session id, pid and cwd, and no socket path or start time" {
  start_stub
  run_register
  [[ "${status}" -eq 0 ]] || {
    echo "${output}${stderr}"
    return 1
  }
  local body
  body="$(request_body /api/queue/sessions/register)"
  [[ "$(jq -c '{sessionId, pid, hasSocketPath: has("socketPath")}' <<<"${body}")" == "{\"sessionId\":\"${SESSION_ID}\",\"pid\":4242,\"hasSocketPath\":false}" ]] || {
    echo "${body}"
    return 1
  }
  [[ "$(jq -r '.cwd' <<<"${body}")" == "${PWD}" ]] || {
    echo "${body}"
    return 1
  }
  jq -e '[keys[] | ascii_downcase | select(test("start"))] | length == 0' <<<"${body}" >/dev/null || {
    echo "${body}"
    return 1
  }
}

@test "register takes the cwd and session id the hook payload names, else the process cwd and the session env" {
  start_stub
  local start_dir="${BATS_TEST_TMPDIR}/session-start-dir" other_id="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
  mkdir -p "${start_dir}"
  local row name cwd id expected body
  for row in "payload values|${start_dir}|${other_id}|${start_dir} ${other_id}" \
    "relative cwd, id not a uuid|session-start-dir|not-a-uuid|${PWD} ${SESSION_ID}" \
    "cwd no longer a directory, no id|${BATS_TEST_TMPDIR}/gone||${PWD} ${SESSION_ID}"; do
    IFS='|' read -r name cwd id expected <<<"${row}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_register "$(jq -nc --arg cwd "${cwd}" --arg id "${id}" \
      '{hook_event_name: "SessionStart", source: "startup", cwd: $cwd, session_id: $id}')"
    body="$(request_body /api/queue/sessions/register)"
    [[ "$(jq -r '"\(.cwd) \(.sessionId)"' <<<"${body}")" == "${expected}" ]] || {
      echo "row ${name}: ${body}"
      return 1
    }
  done
}

@test "register sends configDir only when CLAUDE_CONFIG_DIR is set" {
  start_stub
  local row set_value expected
  for row in "set|${HOME}/.claude-work|${HOME}/.claude-work" "unset||null"; do
    IFS='|' read -r _ set_value expected <<<"${row}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    if [[ -n "${set_value}" ]]; then export CLAUDE_CONFIG_DIR="${set_value}"; else unset CLAUDE_CONFIG_DIR; fi
    run_register
    [[ "$(request_body /api/queue/sessions/register | jq -r '.configDir')" == "${expected}" ]] || {
      echo "row ${row%%|*}"
      return 1
    }
  done
}

@test "register passes a known permission mode from the hook payload as the hint and drops an unknown one" {
  start_stub
  local row mode expected
  for row in "known|default|default" "unknown|sideways|null"; do
    IFS='|' read -r _ mode expected <<<"${row}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_register "{\"hook_event_name\":\"SessionStart\",\"permission_mode\":\"${mode}\"}"
    [[ "$(request_body /api/queue/sessions/register | jq -r '.permissionHint')" == "${expected}" ]] || {
      echo "row ${row%%|*}"
      return 1
    }
  done
}

@test "register sends the session's job name, else its last transcript title, as a derived name, and none when no source holds one" {
  start_stub
  local foreign="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" job_dir="${BATS_TEST_TMPDIR}/job"
  local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl" row expected sent
  local ai_title="{\"type\":\"ai-title\",\"aiTitle\":\"Fix the flaky sweep test\",\"sessionId\":\"${SESSION_ID}\"}"
  local chatter="{\"type\":\"user\",\"message\":{\"content\":\"name it \\\"custom-title\\\"\"}}"
  for row in "no-source|" "job-resumed-as-this-session|nightly-backup" "job-of-another-session|" \
    "renamed-transcript|queue sessions" "ai-titled-transcript|Fix the flaky sweep test" \
    "job-and-transcript|nightly-backup" "blank-title|"; do
    expected="${row#*|}"
    unset CLAUDE_JOB_DIR
    mkdir -p "${job_dir}"
    : >"${transcript}"
    case "${row%%|*}" in
      job-resumed-as-this-session | job-and-transcript)
        export CLAUDE_JOB_DIR="${job_dir}"
        printf '{"sessionId":"%s","resumeSessionId":"%s","name":"nightly-backup","nameSource":"user"}\n' "${foreign}" "${SESSION_ID}" >"${job_dir}/state.json"
        ;;
      job-of-another-session)
        export CLAUDE_JOB_DIR="${job_dir}"
        printf '{"sessionId":"%s","name":"someone-else","nameSource":"user"}\n' "${foreign}" >"${job_dir}/state.json"
        ;;
    esac
    case "${row%%|*}" in
      renamed-transcript | job-and-transcript)
        printf '%s\n' "${ai_title}" "${chatter}" "{\"type\":\"custom-title\",\"customTitle\":\"queue work\",\"sessionId\":\"${SESSION_ID}\"}" \
          "{\"type\":\"custom-title\",\"customTitle\":\"queue sessions\",\"sessionId\":\"${SESSION_ID}\"}" >"${transcript}"
        ;;
      ai-titled-transcript) printf '%s\n' "${chatter}" "${ai_title}" >"${transcript}" ;;
      blank-title) printf '{"type":"custom-title","customTitle":"   ","sessionId":"%s"}\n' "${SESSION_ID}" >"${transcript}" ;;
    esac
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_register "{\"hook_event_name\":\"SessionStart\",\"source\":\"resume\",\"transcript_path\":\"${transcript}\"}"
    # derivedName, never name: only an explicit `register --name` may replace an explicit name
    sent="$(request_body /api/queue/sessions/register | jq -r 'if has("name") then "explicit:" + .name else .derivedName // "" end')"
    [[ "${status}" -eq 0 && "${sent}" == "${expected}" ]] || {
      echo "row ${row%%|*}: status=${status} sent=[${sent}] $(cat "${BATS_TEST_TMPDIR}/requests.log")"
      return 1
    }
  done
}

@test "the pointer line names the waiting count of answers or messages and the absolute CLI pending command, never their text" {
  start_stub
  set_reply 200 '{"answeredWaiting":2,"answerText":"ship-it-on-friday"}'
  run_register
  [[ "${status}" -eq 0 ]] || {
    echo "${output}${stderr}"
    return 1
  }
  [[ "${#lines[@]}" -eq 1 && "${output}" == *" 2 "* && "${output}" == *"answer(s) or message(s)"* && "${output}" == *"${GA_ROOT}/scripts/atrium-queue.sh pending"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" != *"ship-it-on-friday"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "no answered item waiting prints nothing" {
  start_stub
  run_register
  [[ "${status}" -eq 0 && -z "${output}" && -z "${stderr}" ]] || {
    echo "${output}${stderr}"
    return 1
  }
}

@test "register writes no token file, and the token reaches neither the hook output nor the wire" {
  start_stub
  run_register
  [[ "${status}" -eq 0 && ! -e "${GA_ROOT}/data/queue/tokens" ]] || {
    ls -laR "${GA_ROOT}/data/queue"
    return 1
  }
  [[ "${output}${stderr}" != *"${SOCKET_AUTH}"* ]] || {
    echo "token on hook output"
    return 1
  }
  ! grep -qF "${SOCKET_AUTH}" "${BATS_TEST_TMPDIR}/curl-argv.log" "${BATS_TEST_TMPDIR}/requests.log" || {
    echo "token on argv or the wire"
    return 1
  }
}

@test "both hooks reach the monitor with no queue key header" {
  start_stub
  run_register
  run_deregister
  [[ "$(jq -c '[.path, (.headers | has("x-atrium-queue-key"))]' "${BATS_TEST_TMPDIR}/requests.log")" == $'["/api/queue/sessions/register",false]\n["/api/queue/sessions/deregister",false]' ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "with no pid in the session env, register sends nothing and exits 0" {
  unset CLAUDE_PID
  start_stub
  run_register
  [[ "${status}" -eq 0 && -z "${output}" && ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
    echo "${output}"
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "both hooks exit 0 silently within the timeout when the monitor is down, slow or refusing" {
  local row condition hook started elapsed
  for row in "down|register" "down|deregister" "slow|register" "slow|deregister" "refusing|register"; do
    IFS='|' read -r condition hook <<<"${row}"
    stop_stub
    case "${condition}" in
      down) export ATRIUM_MONITOR_PORT=1 ;;
      slow) set_reply hang '' && start_stub ;;
      refusing) set_reply 403 '{"error":"forbidden_host"}' && start_stub ;;
    esac
    started=${SECONDS}
    if [[ "${hook}" == register ]]; then run_register; else run_deregister; fi
    elapsed=$((SECONDS - started))
    [[ "${status}" -eq 0 && -z "${output}" && -z "${stderr}" && "${elapsed}" -le 5 ]] || {
      echo "row ${row}: status=${status} elapsed=${elapsed}s ${output}${stderr}"
      return 1
    }
  done
}

@test "deregister identifies the process by pid, else by socket path, else by session id alone, with no start time" {
  start_stub
  local row pid socket expected
  for row in "pid|4242|/tmp/cc-socks/4242.sock|{\"pid\":4242,\"sessionId\":\"${SESSION_ID}\"}" \
    "socket-only||/tmp/cc-socks/4242.sock|{\"sessionId\":\"${SESSION_ID}\",\"socketPath\":\"/tmp/cc-socks/4242.sock\"}" \
    "neither|||{\"sessionId\":\"${SESSION_ID}\"}"; do
    IFS='|' read -r _ pid socket expected <<<"${row}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    if [[ -n "${pid}" ]]; then export CLAUDE_PID="${pid}"; else unset CLAUDE_PID; fi
    if [[ -n "${socket}" ]]; then export CLAUDE_CODE_MESSAGING_SOCKET="${socket}"; else unset CLAUDE_CODE_MESSAGING_SOCKET; fi
    run_deregister
    [[ "$(request_body /api/queue/sessions/deregister | jq -Sc .)" == "${expected}" ]] || {
      echo "row ${row%%|*}: $(cat "${BATS_TEST_TMPDIR}/requests.log")"
      return 1
    }
  done
}

@test "deregister names the session the hook payload names, else the session env" {
  start_stub
  local other_id="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" row name id expected
  for row in "payload id|${other_id}|${other_id}" "id not a uuid|not-a-uuid|${SESSION_ID}"; do
    IFS='|' read -r name id expected <<<"${row}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_deregister "$(jq -nc --arg id "${id}" '{hook_event_name: "SessionEnd", reason: "other", session_id: $id}')"
    [[ "$(request_body /api/queue/sessions/deregister | jq -r '.sessionId')" == "${expected}" ]] || {
      echo "row ${name}: $(cat "${BATS_TEST_TMPDIR}/requests.log")"
      return 1
    }
  done
}

@test "deregister removes this session's token file and no other" {
  start_stub
  local dir="${GA_ROOT}/data/queue/tokens" other="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
  mkdir -p "${dir}"
  printf '%s' "${SOCKET_AUTH}" >"${dir}/${SESSION_ID}"
  printf '%s' "other" >"${dir}/${other}"
  run_deregister
  [[ ! -e "${dir}/${SESSION_ID}" && -f "${dir}/${other}" ]] || {
    ls -la "${dir}"
    return 1
  }
}

@test "register writes back an awaiting mark for each item id the reply lists, and none for a reply listing none" {
  start_stub
  local row name reply expected marks
  for row in 'lists two|{"answeredWaiting":0,"awaitingItemIds":[57,41]}|57 41' \
    'lists none|{"answeredWaiting":0,"awaitingItemIds":[]}|' \
    'older monitor, no list|{"answeredWaiting":1}|' \
    'entries that are no item id|{"answeredWaiting":0,"awaitingItemIds":[41,"../x",0,-3,1.5]}|41'; do
    IFS='|' read -r name reply expected <<<"${row}"
    export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root.${name// /-}"
    set_reply 200 "${reply}"
    run_register
    marks="$(find "${GA_ROOT}/data/queue" -type f -exec basename {} \; 2>/dev/null | sort -rn | paste -sd ' ' -)"
    [[ "${status}" -eq 0 && "${marks}" == "${expected}" ]] || {
      echo "row ${name}: status=${status} marks=[${marks}] ${output}${stderr}"
      return 1
    }
  done
}

@test "deregister removes this session's awaiting set only once the monitor says the session ended and the env holds a pid" {
  local other="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" row name expected actual
  local dir="${GA_ROOT}/data/queue/awaiting"
  for row in "monitor says it ended, pid set|removed" "monitor says another process still runs it|kept" \
    "older monitor reply without the fact|kept" "no pid in the session env|kept" "monitor down|kept" \
    "monitor refusing|kept"; do
    IFS='|' read -r name expected <<<"${row}"
    stop_stub
    export CLAUDE_PID=4242
    mkdir -p "${dir}/${SESSION_ID}" "${dir}/${other}"
    : >"${dir}/${SESSION_ID}/41"
    : >"${dir}/${other}/7"
    case "${name}" in
      "monitor says it ended"*) set_reply 200 '{"ok":true,"isEnded":true}' && start_stub ;;
      "monitor says another"*) set_reply 200 '{"ok":true,"isEnded":false}' && start_stub ;;
      "older monitor"*) set_reply 200 '{"ok":true}' && start_stub ;;
      "no pid"*) unset CLAUDE_PID && set_reply 200 '{"ok":true,"isEnded":true}' && start_stub ;;
      "monitor down") export ATRIUM_MONITOR_PORT=1 ;;
      "monitor refusing") set_reply 403 '{"error":"forbidden_host"}' && start_stub ;;
    esac
    run_deregister
    actual=kept
    [[ -e "${dir}/${SESSION_ID}" ]] || actual=removed
    [[ "${status}" -eq 0 && "${actual}" == "${expected}" && -f "${dir}/${other}/7" ]] || {
      echo "row ${name}: status=${status} set ${actual}"
      ls -laR "${dir}"
      return 1
    }
  done
}

@test "the hooks reached through a hook-farm symlink still load their library and reach the monitor" {
  start_stub
  mkdir -p "${BATS_TEST_TMPDIR}/farm"
  ln -s "${REGISTER_HOOK}" "${BATS_TEST_TMPDIR}/farm/queue-session-register.sh"
  ln -s "${DEREGISTER_HOOK}" "${BATS_TEST_TMPDIR}/farm/queue-session-deregister.sh"
  REGISTER_HOOK="${BATS_TEST_TMPDIR}/farm/queue-session-register.sh"
  DEREGISTER_HOOK="${BATS_TEST_TMPDIR}/farm/queue-session-deregister.sh"
  run_register
  run_deregister
  [[ "$(jq -r '.path' "${BATS_TEST_TMPDIR}/requests.log")" == $'/api/queue/sessions/register\n/api/queue/sessions/deregister' ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "after a register names a new session id for this Claude process, the session id resolves to it, not to the session env" {
  start_stub
  local new_id="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" row label pid expected got
  sleep 300 3>&- &
  local owner=$!
  sleep 300 3>&- &
  local other=$!
  export CLAUDE_PID="${owner}"
  run_register "$(jq -nc --arg id "${new_id}" '{hook_event_name: "SessionStart", source: "clear", session_id: $id}')"
  for row in "same process|${owner}|${new_id}" "another process|${other}|${SESSION_ID}"; do
    IFS='|' read -r label pid expected <<<"${row}"
    got="$(CLAUDE_PID="${pid}" bash -c 'source "$1"; queue_get_session_id' _ "${GA}/scripts/lib/queue-session.sh")"
    [[ "${got}" == "${expected}" ]] || {
      echo "row ${label}: ${got}"
      kill "${owner}" "${other}"
      return 1
    }
  done
  kill "${owner}" "${other}"
}

# <function> <args…> → one queue-session.sh function, run in a strict shell as its sourcing hooks run it
run_lib() {
  # shellcheck disable=SC2016  # the inner script expands its own arguments
  run --separate-stderr bash -c 'set -Eeuo pipefail; source "$1"; shift; "$@"' _ "${GA}/scripts/lib/queue-session.sh" "$@"
}

@test "register sends the SessionStart payload's transcript path, and declares a probe only when the probe variable is 1" {
  start_stub
  local transcript="${BATS_TEST_TMPDIR}/projects/p/${SESSION_ID}.jsonl" row label value expected sent
  for row in "unset||false" "set to 1|1|true" "set to another value|yes|false"; do
    IFS='|' read -r label value expected <<<"${row}"
    if [[ -n "${value}" ]]; then export ATRIUM_QUEUE_PROBE="${value}"; else unset ATRIUM_QUEUE_PROBE; fi
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_register "$(jq -nc --arg t "${transcript}" '{hook_event_name: "SessionStart", source: "startup", transcript_path: $t}')"
    sent="$(request_body /api/queue/sessions/register | jq -c '[.transcriptPath, .isProbe]')"
    [[ "${sent}" == "[\"${transcript}\",${expected}]" ]] || {
      echo "row ${label}: ${sent}"
      return 1
    }
  done
}

@test "the item status read names a posted item's status, gone for one the session did not post, and fails apart on no reply and an unusable one" {
  local row label code body expected_status expected_out
  local own="{\"id\":41,\"kind\":\"decision\",\"sessionId\":\"${SESSION_ID}\",\"status\":\"answered\"}"
  for row in "posted item|200|${own}|0|answered" "unknown item|404|{\"error\":\"unknown_item\"}|0|gone" \
    "another session's item|200|${own/${SESSION_ID}/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d}|0|gone" \
    "an owner message|200|${own/decision/message}|0|gone" "a relay|200|${own/decision/relay}|0|gone" \
    "a failing monitor|500|{\"error\":\"internal\"}|2|" "a garbled reply|200|not json|2|" "a down monitor|down||1|"; do
    IFS='|' read -r label code body expected_status expected_out <<<"${row}"
    stop_stub
    if [[ "${code}" == down ]]; then
      export ATRIUM_MONITOR_PORT=1
    else
      set_reply "${code}" "${body}"
      start_stub
    fi
    run_lib queue_get_item_status "${SESSION_ID}" 41
    [[ "${status}" -eq "${expected_status}" && "${output}" == "${expected_out}" ]] || {
      echo "row ${label}: status=${status} output=${output} stderr=${stderr}"
      return 1
    }
  done
  [[ "$(jq -r '.path' "${BATS_TEST_TMPDIR}/requests.log")" == "/api/queue/items/41?sessionId=${SESSION_ID}" ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "the turn record lands in this session's set with a write time no earlier than the call, and a non-UUID id names no record file" {
  local before written
  before="$(perl -MTime::HiRes=time -MPOSIX=strftime -e '$t = time; printf "%s.%03dZ\n", strftime("%Y-%m-%dT%H:%M:%S", gmtime $t), ($t - int $t) * 1000')"
  run_lib queue_put_record "${SESSION_ID}" posted 41 42
  [[ "${status}" -eq 0 ]] || {
    echo "${stderr}"
    return 1
  }
  written="$(bash -c 'source "$1"; queue_get_record_time "$2"' _ "${GA}/scripts/lib/queue-session.sh" "${SESSION_ID}")"
  [[ "${written}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ && ! "${written}" < "${before}" ]] || {
    echo "written=${written} before=${before}"
    return 1
  }
  local id
  for id in "../../escape" "not-a-uuid" ""; do
    run_lib queue_put_record "${id}" nothing
    [[ "${status}" -ne 0 && -z "$(find "${GA_ROOT}/.." -name '*record*' -not -path "*/awaiting/${SESSION_ID}/*" 2>/dev/null)" ]] || {
      echo "id [${id}]: status=${status} $(find "${GA_ROOT}/.." -name '*record*')"
      return 1
    }
  done
}

@test "a turn end sends the transcript's title as a name-only update, once per title, and nothing while no title exists" {
  start_stub
  local transcript="${BATS_TEST_TMPDIR}/transcript.jsonl" row label title sent
  : >"${transcript}"
  for row in "no title|" "a first title|Fix the flaky sweep test" "the same title again|" "a renamed session|queue sessions"; do
    IFS='|' read -r label title <<<"${row}"
    case "${label}" in
      "a first title") printf '{"type":"ai-title","aiTitle":"Fix the flaky sweep test","sessionId":"%s"}\n' "${SESSION_ID}" >>"${transcript}" ;;
      "a renamed session") printf '{"type":"custom-title","customTitle":"queue sessions","sessionId":"%s"}\n' "${SESSION_ID}" >>"${transcript}" ;;
    esac
    : >"${BATS_TEST_TMPDIR}/requests.log"
    run_lib queue_put_session_name "${transcript}" "${SESSION_ID}"
    sent="$(request_body /api/queue/sessions/register)"
    if [[ -z "${title}" ]]; then
      [[ "${status}" -eq 0 && -z "${sent}" ]] || {
        echo "row ${label}: status=${status} sent=${sent}"
        return 1
      }
    else
      [[ "${status}" -eq 0 && "$(jq -c . <<<"${sent}")" == "{\"sessionId\":\"${SESSION_ID}\",\"pid\":4242,\"derivedName\":\"${title}\"}" ]] || {
        echo "row ${label}: status=${status} sent=${sent}"
        return 1
      }
    fi
  done
}

@test "the pointer line names peer relays apart from owner answers or messages, and a relay alone never as the owner's" {
  start_stub
  local row label reply want lacks
  for row in "owner only|{\"answeredWaiting\":2,\"relayWaiting\":0}|2 owner queue answer(s) or message(s) wait|peer relay" \
    "relay only|{\"answeredWaiting\":1,\"relayWaiting\":1}|1 peer relay(s)|owner queue answer(s) or message(s)" \
    "both|{\"answeredWaiting\":3,\"relayWaiting\":1}|2 owner queue answer(s) or message(s) and 1 peer relay(s) wait|[ATRIUM-QUEUE] 3 "; do
    IFS='|' read -r label reply want lacks <<<"${row}"
    set_reply 200 "${reply}"
    run_register
    [[ "${status}" -eq 0 && "${#lines[@]}" -eq 1 && "${output}" == *"${want}"* && "${output}" != *"${lacks}"* ]] || {
      echo "row ${label}: ${output}"
      return 1
    }
  done
}

@test "a start directory whose project or local MCP config names a server atrium-queue prints one shadowing line, and no other config does" {
  start_stub
  local dir="${BATS_TEST_TMPDIR}/project" row label lines_want
  export CLAUDE_CONFIG_DIR="${BATS_TEST_TMPDIR}/profile"
  for row in "project file naming it|1" "local config naming it|1" "project file naming another server|0" "no config|0"; do
    IFS='|' read -r label lines_want <<<"${row}"
    mkdir -p "${dir}" "${CLAUDE_CONFIG_DIR}"
    printf '{}\n' >"${CLAUDE_CONFIG_DIR}/.claude.json"
    printf '{"mcpServers":{}}\n' >"${dir}/.mcp.json"
    case "${label}" in
      "project file naming it") printf '{"mcpServers":{"atrium-queue":{"command":"x"}}}\n' >"${dir}/.mcp.json" ;;
      "local config naming it") jq -nc --arg d "${dir}" '{projects: {($d): {mcpServers: {"atrium-queue": {command: "x"}}}}}' \
        >"${CLAUDE_CONFIG_DIR}/.claude.json" ;;
      "project file naming another server") printf '{"mcpServers":{"atrium-queue-dev":{"command":"x"}}}\n' >"${dir}/.mcp.json" ;;
    esac
    run_register "$(jq -nc --arg cwd "${dir}" '{hook_event_name: "SessionStart", source: "startup", cwd: $cwd}')"
    [[ "${status}" -eq 0 && "$(grep -c 'shadows' <<<"${output}")" == "${lines_want}" ]] || {
      echo "row ${label}: status=${status} ${output}"
      return 1
    }
  done
  printf '{"mcpServers":{"atrium-queue":{"command":"x"}}}\n' >"${dir}/.mcp.json"
  stop_stub
  export ATRIUM_MONITOR_PORT=1
  run_register "$(jq -nc --arg cwd "${dir}" '{hook_event_name: "SessionStart", source: "startup", cwd: $cwd}')"
  [[ "${status}" -eq 0 && "${output}" == "[ATRIUM-QUEUE] harness:"*"shadows"*"${GA_ROOT}/scripts/atrium-queue.sh"* ]] || {
    echo "monitor down: ${output}"
    return 1
  }
}
