#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2154,SC2249,SC2312  # each test is a subshell → its exports are its own; BATS_* and run results are set by bats; each case arm is a row; a masked status fails its comparison
# The owner queue's MCP adapter against a stand-in monitor. Protects the JSON-RPC framing, the fixed tool dispatch,
# the entrypoint gate, the session resolved per call, argument values passed through untouched, stdout holding
# protocol lines only, a bounded monitor call, and the end-turn markers riding a successful record alone.
#
# Run via: bats scripts/test/atrium-queue-mcp.bats
# Requires: bats, bash 3.2+, jq, curl, perl, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
ADAPTER="${GA}/scripts/atrium-queue-mcp.sh"
# shellcheck source-path=SCRIPTDIR source=../../hooks/test/lib/queue-monitor-stub.bash
source "${GA}/hooks/test/lib/queue-monitor-stub.bash"
SESSION_ID="3f1c2b9a-7d4e-4f5a-9b6c-0e1d2c3b4a59"
MSG_ID="6b0e7c1a-2f3d-4e5b-8a9c-1d2e3f4a5b6c"
# a text no response, log or stderr line may carry: each row plants it in the input it sends
MARK="q7Zmark"
END_TURN_META='{"claude/endTurn":true,"claude/endTurnHonorsStopHooks":true}'
REPORT_ARGS='{"kind":"report","title":"Nightly backup failed twice","body":"The 02:00 run hit a full disk; rerun after cleanup?","isFreeTextAllowed":true,"linkedDocIds":[43944]}'
DECISION_ARGS='{"kind":"decision","title":"Pick the retention window","body":"Backups now take 40 GB a week.","isFreeTextAllowed":false,"options":[{"code":"R1","label":"Keep 14 days","pros":"cheap","cons":"short history"},{"code":"R2","label":"Keep 30 days","pros":"longer history","cons":"twice the disk"}],"recommendedCode":"R1"}'

setup() {
  # the ambient session's own CLAUDE_* values must never reach the adapter under test
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CONFIG_DIR CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN \
    ATRIUM_QUEUE_PROBE ATRIUM_MONITOR_PORT CLAUDE_JOB_DIR
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  export HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${GA_ROOT}" "${HOME}"
  export CLAUDE_CODE_SESSION_ID="${SESSION_ID}"
  export CLAUDE_CODE_ENTRYPOINT=cli
  : >"${BATS_TEST_TMPDIR}/requests.log"
  set_reply 200 '{}'
}

teardown() {
  stop_stub
}

# <request line…> → the adapter fed those lines, then EOF; stdout in $output / $lines, stderr in $stderr
run_adapter() {
  printf '%s\n' "$@" >"${BATS_TEST_TMPDIR}/in"
  run --separate-stderr "${ADAPTER}" <"${BATS_TEST_TMPDIR}/in"
}

# <id> <tool name> <arguments JSON> → one tools/call request line
get_call() {
  jq -nc --argjson id "$1" --arg name "$2" --argjson arguments "$3" \
    '{jsonrpc: "2.0", id: $id, method: "tools/call", params: {name: $name, arguments: $arguments}}'
}

# <id> → the response line with that id from the last run
get_response() {
  jq -c --argjson id "$1" 'select(.id == $id)' <<<"${output}"
}

# <id> → the operation document a tool result with that id carries as its text
get_document() {
  get_response "$1" | jq -c '.result.content[0].text | fromjson'
}

# <function> <args…> → the same library operation run directly, as the CLI runs it → its document
get_library_document() {
  bash -c 'set -Eeuo pipefail; source "$1"; shift; "$@"' _ "${GA}/scripts/lib/queue-ops.sh" "$@" 2>/dev/null || true
}

request_body() {
  jq -r --arg p "$1" 'select(.path == $p) | .body' "${BATS_TEST_TMPDIR}/requests.log"
}

PING='{"jsonrpc":"2.0","id":90,"method":"ping"}'

@test "initialize carries the server instructions, which name every listed tool and point at a section the role file holds" {
  run_adapter '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.1.325"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  [[ "${status}" -eq 0 && "${#lines[@]}" -eq 2 ]] || {
    echo "status=${status} ${output} ${stderr}"
    return 1
  }
  local init tools name
  init="$(get_response 1)"
  tools="$(get_response 2 | jq -c '[.result.tools[].name] | sort')"
  [[ "$(jq -r '.result.protocolVersion' <<<"${init}")" == 2025-11-25 && "$(jq -r '.result.serverInfo.name' <<<"${init}")" == atrium-queue && "$(jq -c '.result.capabilities.tools' <<<"${init}")" == '{}' ]] || {
    echo "initialize: ${init}"
    return 1
  }
  [[ "${tools}" == '["claim","post","record","relay","sessions"]' ]] || {
    echo "tools: ${tools}"
    return 1
  }
  for name in claim post record relay sessions; do
    jq -e --arg n "${name}" '.result.instructions | contains("- " + $n + ": ")' <<<"${init}" >/dev/null || {
      echo "the instructions name no tool ${name}"
      return 1
    }
  done
  jq -e '.result.instructions | contains("the `## Owner Queue` section of ~/.glass-atrium/skills/glass-atrium-ops-orchestrator-role.md")' <<<"${init}" >/dev/null \
    && grep -qx '## Owner Queue' "${GA}/skills/glass-atrium-ops-orchestrator-role.md" || {
    echo "the instructions point at no section the role file holds"
    return 1
  }
}

@test "each tool's input schema is an object that requires exactly the fields its operation cannot run without" {
  run_adapter '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  local row name required got
  for row in "post|[\"body\",\"kind\",\"title\"]" "claim|[]" "record|[\"form\"]" "sessions|[]" "relay|[\"recipients\",\"text\"]"; do
    IFS='|' read -r name required <<<"${row}"
    got="$(get_response 2 | jq -c --arg n "${name}" '.result.tools[] | select(.name == $n) | .inputSchema
      | if .type == "object" and (.properties | type) == "object" then (.required // []) | sort else "not an object schema" end')"
    [[ "${got}" == "${required}" ]] || {
      echo "row ${name}: ${got}"
      return 1
    }
  done
}

@test "a session that does not face the owner gets no instructions, lists no tools and has every call refused before the monitor" {
  export CLAUDE_CODE_ENTRYPOINT=sdk-cli
  start_stub
  run_adapter '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$(get_call 3 sessions '{}')"
  [[ "$(get_response 1 | jq -c '.result | has("instructions")')" == false && "$(get_response 2 | jq -c '.result.tools')" == '[]' ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(get_response 3 | jq -r '.error.code')" == -32602 && ! -s "${BATS_TEST_TMPDIR}/requests.log" ]] || {
    echo "call: ${output}"
    return 1
  }
}

@test "a malformed line gets its matching error without echoing the input, a notification gets none, and the next call succeeds" {
  local row label code line want_lines got
  for row in \
    "invalid JSON|-32700|{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"ping\",\"x\":\"${MARK}\"" \
    "non-object|-32600|[\"${MARK}\"]" \
    "no method|-32600|{\"jsonrpc\":\"2.0\",\"id\":7,\"params\":\"${MARK}\"}" \
    "unknown method|-32601|{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"${MARK}/x\"}" \
    "no tool name|-32602|{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"arguments\":{\"x\":\"${MARK}\"}}}" \
    "arguments not an object|-32602|{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"sessions\",\"arguments\":\"${MARK}\"}}" \
    "notification|none|{\"jsonrpc\":\"2.0\",\"method\":\"notifications/${MARK}\"}"; do
    IFS='|' read -r label code line <<<"${row}"
    run_adapter "${line}" "${PING}"
    want_lines=2
    [[ "${code}" != none ]] || want_lines=1
    got="$(jq -sr 'map(select(.id != 90)) | .[0].error.code // "none"' <<<"${output}")"
    [[ "${status}" -eq 0 && "${#lines[@]}" -eq "${want_lines}" && "${got}" == "${code}" ]] || {
      echo "row ${label}: status=${status} ${output} ${stderr}"
      return 1
    }
    [[ "${output}${stderr}" != *"${MARK}"* && "$(get_response 90 | jq -c '.result')" == '{}' ]] || {
      echo "row ${label}: the input was echoed, or the next call failed: ${output} ${stderr}"
      return 1
    }
  done
}

@test "a request line over the cap is refused unparsed and reaches nothing, and the next call is answered" {
  start_stub
  local title
  title="$(head -c 1048576 /dev/zero | tr '\0' a)"
  # built by the printf builtin: no exec argument limit
  run_adapter "$(printf '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"post","arguments":{"kind":"report","title":"%s","body":"b"}}}' "${title}")" "${PING}"
  [[ "${status}" -eq 0 && "${#lines[@]}" -eq 2 && "$(jq -sc '.[0] | [.id, .error.code]' <<<"${output}")" == '[null,-32600]' ]] || {
    echo "status=${status} ${output:0:300}"
    return 1
  }
  [[ ! -s "${BATS_TEST_TMPDIR}/requests.log" && "$(get_response 90 | jq -c '.result')" == '{}' ]] || {
    echo "the line reached the monitor, or the next call failed: ${output:0:300}"
    return 1
  }
}

@test "each tool returns the document its library operation prints, as a result that is no error" {
  start_stub
  local row tool arguments reply want
  for row in \
    "sessions|{}|200|{\"peers\":[{\"sessionIdPrefix\":\"0a1b2c3d\",\"name\":\"docs\",\"profileLabel\":\"work\",\"cwdTail\":\"git/docs\",\"state\":\"live\",\"isWaiting\":false}]}" \
    "post|${REPORT_ARGS}|201|{\"id\":17}" \
    "relay|{\"recipients\":[\"0a1b2c3d\",\"docs\"],\"text\":\"the build is green\",\"linkedDocIds\":[44099]}|201|{\"sendId\":\"7d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a\",\"hop\":0,\"copies\":[{\"id\":31,\"sessionIdPrefix\":\"0a1b2c3d\"}]}" \
    "claim|{}|200|{\"items\":[]}" \
    "record|{\"form\":\"nothing\"}|200|{}"; do
    IFS='|' read -r tool arguments reply <<<"${row}"
    set_reply "${reply%%|*}" "${reply#*|}"
    case "${tool}" in
      sessions) want="$(get_library_document queue_get_peers)" ;;
      post) want="$(get_library_document queue_create_item report "${arguments}")" ;;
      relay) want="$(get_library_document queue_create_relay "the build is green" 44099 0a1b2c3d docs)" ;;
      claim) want="$(get_library_document queue_claim_items)" ;;
      record) want="$(get_library_document queue_create_record nothing)" ;;
    esac
    run_adapter "$(get_call 4 "${tool}" "${arguments}")"
    [[ "${status}" -eq 0 && "${#lines[@]}" -eq 1 && "$(get_response 4 | jq -c '.result.isError')" == false ]] || {
      echo "row ${tool}: status=${status} ${output} ${stderr}"
      return 1
    }
    [[ -n "${want}" && "$(get_document 4)" == "$(jq -c . <<<"${want}")" ]] || {
      echo "row ${tool}: $(get_document 4) is not the library's ${want}"
      return 1
    }
  done
}

@test "an operation that fails returns an error result carrying its document, and the server answers the next call" {
  start_stub
  set_reply 400 '{"error":"invalid","reason":"title is required"}'
  run_adapter "$(get_call 4 post '{"kind":"report","body":"b"}')" "${PING}"
  [[ "${status}" -eq 0 && "$(get_response 4 | jq -c '.result.isError')" == true && "$(get_document 4 | jq -r '.error')" == refused ]] || {
    echo "refused: status=${status} ${output} ${stderr}"
    return 1
  }
  stop_stub
  run_adapter "$(get_call 5 claim '{}')" "${PING}"
  [[ "$(get_response 5 | jq -c '.result.isError')" == true && "$(get_document 5 | jq -r '.error')" == unreachable && "$(get_response 90 | jq -c '.result')" == '{}' ]] || {
    echo "down: ${output} ${stderr}"
    return 1
  }
}

@test "a call takes the session the owner record of the adapter's parent process names, not the id the adapter started with" {
  local cleared="af77637b-1c2d-4e3f-8a9b-0c1d2e3f4a5b"
  start_stub
  set_reply 200 '{"peers":[]}'
  get_call 4 sessions '{}' >"${BATS_TEST_TMPDIR}/in"
  # the parent registers a new id as a /clear's SessionStart does, then starts the adapter as its child
  # shellcheck disable=SC2016  # the inner script expands its own arguments
  run --separate-stderr bash -c 'source "$1"; queue_put_owner_record "$2" "$$"; "$3" <"$4"; exit $?' _ \
    "${GA}/scripts/lib/queue-session.sh" "${cleared}" "${ADAPTER}" "${BATS_TEST_TMPDIR}/in"
  [[ "${status}" -eq 0 && "$(request_body /api/queue/peers | jq -r '.sessionId')" == "${cleared}" ]] || {
    echo "status=${status} ${output} ${stderr}"
    cat "${BATS_TEST_TMPDIR}/requests.log"
    return 1
  }
}

@test "hostile tool argument values reach the monitor byte-identical and run nothing" {
  start_stub
  cd "${BATS_TEST_TMPDIR}"
  : >glob-hit
  local text arguments
  # shellcheck disable=SC1003,SC2016  # the literal hostile text, nothing to expand
  text='-n $(touch pwned) `touch pwned` * %s%n %%d ${PATH} '"'q'"' "d" \'$'\n'
  set_reply 201 '{"sendId":"7d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a","hop":0,"copies":[]}'
  # shellcheck disable=SC2016  # the literal hostile values, nothing to expand
  arguments="$(jq -nc --arg t "${text}" '{text: $t, recipients: ["-n", "$(touch pwned)", "*", "%s", $t]}')"
  run_adapter "$(get_call 4 relay "${arguments}")"
  [[ "$(get_response 4 | jq -c '.result.isError')" == false && "$(request_body /api/queue/relay | jq -c '{text, recipients}')" == "$(jq -c '{text, recipients}' <<<"${arguments}")" ]] || {
    echo "relay: ${output} ${stderr}"
    cat requests.log
    return 1
  }
  set_reply 201 '{"id":18}'
  arguments="$(jq -c --arg t "${text}" '.title = $t | .options[1].label = $t' <<<"${DECISION_ARGS}")"
  run_adapter "$(get_call 5 post "${arguments}")"
  [[ "$(request_body /api/queue/items | jq -c '[.title, .options[1].label]')" == "$(jq -nc --arg t "${text}" '[$t, $t]')" ]] || {
    echo "post: ${output} ${stderr}"
    return 1
  }
  : >requests.log
  # shellcheck disable=SC2016  # the literal hostile values, nothing to expand
  run_adapter "$(get_call 6 claim "$(jq -nc --arg m "${MSG_ID}" '{itemId: "x[$(touch pwned)]", msgId: $m}')")" \
    "$(get_call 7 record '{"form":"posted","itemIds":["x[$(touch pwned)]"]}')"
  [[ "$(get_document 6 | jq -r '.error')" == invalid && "$(get_document 7 | jq -r '.error')" == invalid && ! -s requests.log ]] || {
    echo "ids: ${output}"
    return 1
  }
  [[ ! -e pwned ]] || {
    echo "a hostile value ran a command"
    return 1
  }
}

@test "a call naming a CLI-only step, a path or a name with a space is refused unechoed and reaches nothing" {
  start_stub
  local name
  for name in wait listen register withdraw "../atrium-queue.sh" "/bin/sh" "post x" "queue_create_item"; do
    run_adapter "$(get_call 4 "${name}" '{}')" "${PING}"
    [[ "$(get_response 4 | jq -r '.error.code')" == -32602 && "$(get_response 90 | jq -c '.result')" == '{}' ]] || {
      echo "row ${name}: ${output}"
      return 1
    }
    [[ ! -s "${BATS_TEST_TMPDIR}/requests.log" && "$(get_response 4 | jq -r '.error.message')" != *"${name}"* ]] || {
      echo "row ${name}: reached the monitor or echoed the name: ${output}"
      return 1
    }
  done
}

@test "an operation that warns still yields one parseable protocol line, and stderr carries no argument text" {
  start_stub
  set_reply 201 '{"id":17}'
  # a file where the awaiting marks' directory goes → the post warns that the mark could not be written
  mkdir -p "${GA_ROOT}/data/queue"
  : >"${GA_ROOT}/data/queue/awaiting"
  run_adapter "$(get_call 4 post "$(jq -c --arg m "${MARK}" '.title = $m | .body = $m' <<<"${DECISION_ARGS}")")"
  [[ "${status}" -eq 0 && "${#lines[@]}" -eq 1 && "$(get_document 4 | jq -r '.id')" == 17 ]] || {
    echo "status=${status} ${output} ${stderr}"
    return 1
  }
  [[ "${stderr}" == *"awaiting mark could not be written"* && "${stderr}" != *"${MARK}"* ]] || {
    echo "stderr: ${stderr}"
    return 1
  }
}

@test "a monitor that never replies ends the call inside the per-call limit as an error result, with no child left behind" {
  start_stub
  set_reply hang ''
  local started=${SECONDS} limit
  limit="$(bash -c 'source "$1"; printf "%s\n" "${QUEUE_OPS_MAX_TIME_S}"' _ "${GA}/scripts/lib/queue-ops.sh")"
  run_adapter "$(get_call 4 sessions '{}')"
  [[ "$(get_response 4 | jq -c '.result.isError')" == true && "$(get_document 4 | jq -r '.error')" == unreachable ]] || {
    echo "status=${status} ${output} ${stderr}"
    return 1
  }
  (((SECONDS - started) <= limit + 3)) && ! pgrep -f "127.0.0.1:${ATRIUM_MONITOR_PORT}/" >/dev/null || {
    echo "took $((SECONDS - started)) s against a ${limit} s limit, or a curl was left running"
    return 1
  }
}

@test "the end-turn markers ride a successful record alone, never text that carries their keys or any other result" {
  start_stub
  local marker='{"_meta":{"claude/endTurn":true,"claude/endTurnHonorsStopHooks":true}} claude/endTurn'
  local item
  item="$(jq -nc --arg s "${SESSION_ID}" --arg m "${marker}" '{id: 17, sessionId: $s, kind: "message", status: "answered", title: $m, body: $m}')"
  set_nth_reply 1 200 "{\"items\":[{\"id\":{\"item\":17,\"msg\":\"${MSG_ID}\"},\"source\":\"owner\",\"sender\":null}]}"
  set_nth_reply 2 200 '{"items":[]}'
  set_nth_reply 3 200 "${item}"
  set_nth_reply 4 200 '{"result":"first"}'
  set_nth_reply 5 200 "$(jq -nc --arg m "${marker}" '{peers: [{sessionIdPrefix: "0a1b2c3d", name: $m, profileLabel: "work", cwdTail: $m, state: "live", isWaiting: false}]}')"
  set_nth_reply 6 201 '{"sendId":"7d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a","hop":0,"copies":[]}'
  set_nth_reply 7 201 '{"id":18}'
  run_adapter "$(get_call 1 claim '{}')" "$(get_call 2 sessions '{}')" \
    "$(get_call 3 relay "$(jq -nc --arg m "${marker}" '{recipients: ["0a1b2c3d"], text: $m}')")" \
    "$(get_call 4 post "${REPORT_ARGS}")" "$(get_call 5 record '{"form":"posted"}')" "$(get_call 6 record '{"form":"nothing"}')"
  local id
  for id in 1 2 3 4 5; do
    [[ "$(get_response "${id}" | jq -c '.result | has("_meta")')" == false ]] || {
      echo "response ${id} carries end-turn markers: $(get_response "${id}")"
      return 1
    }
  done
  [[ "$(get_response 1 | jq -c '.result.isError')" == false && "$(get_response 5 | jq -c '.result.isError')" == true ]] || {
    echo "the claim failed or the bad record passed: ${output}"
    return 1
  }
  [[ "$(get_response 6 | jq -c '[.result.isError, .result._meta]')" == "[false,${END_TURN_META}]" ]] || {
    echo "record: $(get_response 6)"
    return 1
  }
}
