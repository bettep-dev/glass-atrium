#!/usr/bin/env bats
# track-outcome-close-consumer.bats — pins the same-cid DWC auto-close consumer that runs
# in track-outcome.sh AFTER the outcome dualwrite and BEFORE the unconditional zero exit.
#
# Contracts pinned:
#   T1 gate       — result=done + non-empty cid → ONE `PATCH /api/outcomes/close-by-cid?cid=…`
#                   set-close call (the sole closure-mutation path) and every id the route
#                   reports in `closed_ids` gets a greppable `[outcome-close] closed` line.
#   T2 inert      — result=done_with_concerns (non-done) → zero HTTP calls.
#   T3 inert      — result=done with NO cid → zero HTTP calls.
#   T4 isolation  — monitor DOWN (real curl at a closed port) → hook still exits 0 and prints
#                   the greppable `[outcome-close] miss` recovery token naming the cid.
#   T5 idempotence— a cid with nothing open (repeat close → empty `closed_ids`) still makes
#                   exactly one call and prints no closed line.
#
# Hermetic: HOME is repointed to a temp dir, PG is fail-opened via PGHOST, and every case but
# T4 replaces `curl` with a PATH-prepended shim that logs its argv — the live monitor is never
# contacted and no live row is mutated. T4 uses the REAL curl against port 1 (connection
# refused in ms), never a stopped live monitor.
#
# Run via: bats hooks/test/track-outcome-close-consumer.bats
# Requires: bats 1.5+, bash 3.2+, python3, jq

bats_require_minimum_version 1.5.0

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  CC_TMP="$(cd -- "$(mktemp -d -t ga-close-consumer.XXXXXX)" && pwd -P)"
  SANDBOX_HOME="${CC_TMP}/home"
  STUB_BIN="${CC_TMP}/bin"
  CURL_LOG="${CC_TMP}/curl.log"
  PAYLOAD_FILE="${CC_TMP}/payload.json"
  mkdir -p "${SANDBOX_HOME}/.glass-atrium/logs" "${STUB_BIN}"

  # curl shim: records every invocation and answers the set-close route from CLOSE_BODY.
  cat >"${STUB_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${CURL_LOG}"
case "$*" in
  *close-by-cid*) printf '%s' "${CLOSE_BODY:-}" ;;
esac
exit 0
STUB
  chmod +x "${STUB_BIN}/curl"
  : >"${CURL_LOG}"
}

teardown() {
  if [[ -n "${CC_TMP:-}" && -d "${CC_TMP}" ]]; then
    rm -rf -- "${CC_TMP}"
  fi
}

# bats 1.13 checks only the LAST command's status, so a bare intermediate `[[ ]]` assertion is
# silently ignored. oc/no echo a diagnostic + return non-zero so each caller's `|| return 1`
# aborts the test AT the failing assertion.
oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# $1 = result, $2 = cid (empty → the cid line is omitted entirely).
completion_block() {
  local cid_line=""
  [[ -n "${2}" ]] && cid_line="cid: ${2}"$'\n'
  printf '%s\n' \
    '[COMPLETION]' \
    "result: ${1}" \
    'task_type: feature' \
    'metric_pass: true' \
    'confidence: high' \
    'summary: the deliverable'
  printf '%s' "${cid_line}"
  printf '%s\n' '[/COMPLETION]'
}

# Drive the hook DB-free. $1 = last_assistant_message, $2 = monitor port, $3 = PATH prefix
# ("" → the real curl).
run_hook() {
  jq -nc --arg m "${1}" '{
    hook_event_name: "SubagentStop",
    agent_type: "glass-atrium-dev-shell",
    agent_id: "ccagent01",
    session_id: "sess-cc-1",
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "run the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
  run env \
    HOME="${SANDBOX_HOME}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    ATRIUM_MONITOR_PORT="${2}" \
    CURL_LOG="${CURL_LOG}" \
    CLOSE_BODY="${CLOSE_BODY:-}" \
    PATH="${3:+${3}:}${PATH}" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "T1 done + cid closes the same-cid open DWC rows through the set-close route" {
  CLOSE_BODY='{"cid":"cid-alpha","closed_ids":[4242,4243]}'
  run_hook "$(completion_block 'done' cid-alpha)" 16145 "${STUB_BIN}"
  [ "${status}" -eq 0 ] || return 1
  local calls
  calls="$(cat "${CURL_LOG}")"
  [ "$(wc -l <"${CURL_LOG}")" -eq 1 ] || { printf 'expected ONE curl call, got:\n%s\n' "${calls}" >&2; return 1; }
  oc "PATCH" "${calls}" || return 1
  oc "/api/outcomes/close-by-cid" "${calls}" || return 1
  oc "cid=cid-alpha" "${calls}" || return 1
  oc "[outcome-close] closed cid=cid-alpha id=4242" "${output}" || return 1
  oc "[outcome-close] closed cid=cid-alpha id=4243" "${output}" || return 1
}

@test "T2 a non-done result leaves the consumer inert (zero HTTP calls)" {
  CLOSE_BODY='{"cid":"cid-alpha","closed_ids":[4242]}'
  run_hook "$(completion_block done_with_concerns cid-alpha)" 16145 "${STUB_BIN}"
  [ "${status}" -eq 0 ] || return 1
  [ ! -s "${CURL_LOG}" ] || { printf 'expected NO curl calls, got:\n%s\n' "$(cat "${CURL_LOG}")" >&2; return 1; }
}

@test "T3 done with an empty cid leaves the consumer inert (zero HTTP calls)" {
  CLOSE_BODY='{"cid":"cid-alpha","closed_ids":[4242]}'
  run_hook "$(completion_block 'done' '')" 16145 "${STUB_BIN}"
  [ "${status}" -eq 0 ] || return 1
  [ ! -s "${CURL_LOG}" ] || { printf 'expected NO curl calls, got:\n%s\n' "$(cat "${CURL_LOG}")" >&2; return 1; }
}

@test "T4 monitor DOWN keeps the hook exit code at zero and prints the recovery token" {
  # Real curl against a closed port — connection refused, never a stopped live monitor.
  CLOSE_BODY=""
  run_hook "$(completion_block 'done' cid-down)" 1 ""
  [ "${status}" -eq 0 ] || return 1
  oc "[outcome-close] miss cid=cid-down" "${output}" || return 1
  # The outcome record itself is untouched by the close failure.
  oc '"result":"done"' "${output}" || return 1
}

@test "T5 a cid with nothing open makes one call and prints no closed line" {
  CLOSE_BODY='{"cid":"cid-alpha","closed_ids":[]}'
  run_hook "$(completion_block 'done' cid-alpha)" 16145 "${STUB_BIN}"
  [ "${status}" -eq 0 ] || return 1
  [ "$(wc -l <"${CURL_LOG}")" -eq 1 ] || { printf 'expected ONE curl call, got:\n%s\n' "$(cat "${CURL_LOG}")" >&2; return 1; }
  no "[outcome-close] closed" "${output}" || return 1
}
