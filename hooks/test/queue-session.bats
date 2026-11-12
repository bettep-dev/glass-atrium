#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2249,SC2312  # BATS_* and run results are set by bats; a masked status fails its comparison; each case arm is a row
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
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CONFIG_DIR CLAUDE_CODE_MESSAGING_SOCKET \
    CLAUDE_CODE_MESSAGING_TOKEN ATRIUM_QUEUE_ACCEPT_WRAPPER ATRIUM_MONITOR_PORT CLAUDE_JOB_DIR
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

@test "register sends the session id, pid, cwd and socket path, and no start time" {
  start_stub
  run_register
  [[ "${status}" -eq 0 ]] || {
    echo "${output}${stderr}"
    return 1
  }
  local body
  body="$(request_body /api/queue/sessions/register)"
  [[ "$(jq -c '{sessionId, pid, socketPath}' <<<"${body}")" == "{\"sessionId\":\"${SESSION_ID}\",\"pid\":4242,\"socketPath\":\"/tmp/cc-socks/4242.sock\"}" ]] || {
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

@test "a session with no messaging socket still registers, with no socketPath" {
  unset CLAUDE_CODE_MESSAGING_SOCKET
  start_stub
  run_register
  [[ "$(request_body /api/queue/sessions/register | jq -c 'has("socketPath"), .pid')" == $'false\n4242' ]] || {
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "register sends the accept-wrapper launch hint only under the wrapper's env marker" {
  start_stub
  local row marker expected
  for row in "marked|1|accept_wrapper" "unmarked||null"; do
    IFS='|' read -r _ marker expected <<<"${row}"
    : >"${BATS_TEST_TMPDIR}/requests.log"
    if [[ -n "${marker}" ]]; then export ATRIUM_QUEUE_ACCEPT_WRAPPER="${marker}"; else unset ATRIUM_QUEUE_ACCEPT_WRAPPER; fi
    run_register
    [[ "$(request_body /api/queue/sessions/register | jq -r '.launchHint')" == "${expected}" ]] || {
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

@test "register sends the session's job name, else its last transcript title, and no name when no source holds one" {
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
    sent="$(request_body /api/queue/sessions/register | jq -r 'if has("name") then .name else "" end')"
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

@test "register copies the messaging token to a 0600 file in a 0700 directory and nowhere else" {
  start_stub
  run_register
  local dir="${GA_ROOT}/data/queue/tokens"
  [[ "$(cat "${dir}/${SESSION_ID}")" == "${SOCKET_AUTH}" ]] || {
    ls -la "${dir}"
    return 1
  }
  [[ "$(stat -f '%Lp' "${dir}") $(stat -f '%Lp' "${dir}/${SESSION_ID}")" == "700 600" ]] || {
    ls -la "${dir}"
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
