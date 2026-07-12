#!/usr/bin/env bats
# telemetry-activation.bats — proves the DETACHED fire-and-forget POST in
# telemetry-activation.sh:
#   1. NON-BLOCKING — a slow/hanging curl shim does NOT delay the hook's exit. The
#      detached worker's fds are severed from the hook's inherited stdout/stderr, so
#      the harness reading the hook's stdout sees EOF the instant the hook exits and
#      never waits on curl (nor its --max-time window). Proven timing-robustly by the
#      worker-completion marker being ABSENT when the hook returns, plus a wall-time
#      bound.
#   2. BOTH SOURCE RECORDS — PreToolUse(Agent) (source=orchestrator) and SubagentStart
#      (source=subagent) each still emit a distinct POST; they are NOT deduped/collapsed.
#   3. DIAGNOSTIC PRESERVED — the http_code outcome (formerly a stderr line, gone once
#      detached) lands in the log sink: 201 -> ok, real failure code preserved, empty ->
#      monitor unreachable.
#
# Isolation: curl is PATH-shimmed (real loopback POST fully mocked — no live monitor);
# ATRIUM_MONITOR_PORT short-circuits the port resolver; TELEMETRY_ACTIVATION_LOG_DIR
# redirects the log sink into a per-test tmp dir (production ~/.claude/logs untouched).
# jq / base64 / date stay real.

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
HOOK_SH="${BATS_TEST_DIRNAME}/../telemetry-activation.sh"

# Stdin fixtures — one Task-tool orchestrator spawn, one subagent start.
PRE_JSON='{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"glass-atrium-dev-shell","prompt":"CID: 2026-07-11T0145_x_ab12 go"}}'
SUB_JSON='{"hook_event_name":"SubagentStart","agent_type":"glass-atrium-dev-shell","agent_id":"deadbeefhash"}'

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/telem-bats.XXXXXX")"
  SHIM_DIR="${TEST_TMP}/bin"
  LOG_DIR="${TEST_TMP}/logs"
  LOG_FILE="${LOG_DIR}/telemetry-activation.log"
  PAYLOAD_LOG="${TEST_TMP}/curl-payloads.txt"
  mkdir -p "${SHIM_DIR}"

  # curl shim: record the -d payload, optionally stall / mark done, then emit the
  # http_code the worker captures via -w. CURL_SHIM_HTTP_CODE uses ${VAR-default} so an
  # explicit empty value models an unreachable monitor while unset defaults to 201.
  cat >"${SHIM_DIR}/curl" <<'SHIM'
#!/usr/bin/env bash
payload=""
prev=""
for a in "$@"; do
  [ "${prev}" = "-d" ] && payload="${a}"
  prev="${a}"
done
[ -n "${CURL_PAYLOAD_LOG:-}" ] && printf '%s\n' "${payload}" >>"${CURL_PAYLOAD_LOG}"
[ -n "${CURL_SHIM_SLEEP:-}" ] && sleep "${CURL_SHIM_SLEEP}"
[ -n "${CURL_SHIM_DONE_MARKER:-}" ] && : >"${CURL_SHIM_DONE_MARKER}"
printf '%s' "${CURL_SHIM_HTTP_CODE-201}"
SHIM
  chmod +x "${SHIM_DIR}/curl"
}

teardown() {
  rm -rf "${TEST_TMP}"
}

# Fire the hook once with stdin JSON $1; any extra NAME=VALUE args become env for the
# hook process (per-test shim controls). Sets $status / $output via bats `run`.
_fire() {
  local stdin_json="${1}"
  shift
  run env "PATH=${SHIM_DIR}:${PATH}" \
    ATRIUM_MONITOR_PORT="19999" \
    "TELEMETRY_ACTIVATION_LOG_DIR=${LOG_DIR}" \
    "CURL_PAYLOAD_LOG=${PAYLOAD_LOG}" \
    "$@" \
    bash -c 'printf "%s" "$1" | bash "$2"' _ "${stdin_json}" "${HOOK_SH}"
}

# Poll until file $1 has >= $2 lines (async detached workers), up to $3 seconds.
_wait_lines() {
  local file="${1}" want="${2}" limit="${3:-5}" i=0 max n
  max=$((limit * 10))
  while [ "${i}" -lt "${max}" ]; do
    if [ -f "${file}" ]; then
      n="$(wc -l <"${file}" 2>/dev/null | tr -d ' ')"
      [ -n "${n}" ] && [ "${n}" -ge "${want}" ] && return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# Poll until file $1 matches ERE pattern $2, up to $3 seconds.
_wait_grep() {
  local file="${1}" pat="${2}" limit="${3:-5}" i=0 max
  max=$((limit * 10))
  while [ "${i}" -lt "${max}" ]; do
    { [ -f "${file}" ] && grep -qE "${pat}" "${file}" 2>/dev/null; } && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

@test "detached POST does not block the hook exit (slow curl shim)" {
  local done_marker="${TEST_TMP}/curl-done"
  local t0 t1 elapsed
  t0="$(date +%s)"
  # Shim stalls 3s before completing; a synchronous POST could not let the hook return
  # until the shim finished (done_marker would already exist).
  _fire "${PRE_JSON}" CURL_SHIM_SLEEP=3 "CURL_SHIM_DONE_MARKER=${done_marker}"
  t1="$(date +%s)"
  elapsed=$((t1 - t0))

  [ "${status}" -eq 0 ] || return 1
  # Timing-robust core proof: the worker is still stalling, so its completion marker
  # cannot exist yet — the hook returned WITHOUT waiting on curl.
  [ ! -f "${done_marker}" ] || return 1
  # Wall-time bound (shim sleeps 3s): a detached hook returns in well under 2s.
  [ "${elapsed}" -lt 2 ] || return 1
}

@test "both source records are emitted (orchestrator + subagent, not collapsed)" {
  # Fast shim (immediate 201). Each fire's detached worker appends its payload.
  _fire "${PRE_JSON}"
  [ "${status}" -eq 0 ] || return 1
  _fire "${SUB_JSON}"
  [ "${status}" -eq 0 ] || return 1

  # Wait for BOTH async POSTs to record their payload.
  _wait_lines "${PAYLOAD_LOG}" 2 5 || return 1

  grep -q '"source":"orchestrator"' "${PAYLOAD_LOG}" || return 1
  grep -q '"source":"subagent"' "${PAYLOAD_LOG}" || return 1
  # Two distinct selected records — neither deduped nor merged.
  [ "$(grep -c '"selected":true' "${PAYLOAD_LOG}")" -eq 2 ] || return 1
}

@test "http_code 201 diagnostic lands in the log sink" {
  _fire "${PRE_JSON}"
  [ "${status}" -eq 0 ] || return 1
  _wait_grep "${LOG_FILE}" 'ok event=PreToolUse source=orchestrator' 5 || return 1
}

@test "actual failure http_code is preserved in the log sink" {
  _fire "${PRE_JSON}" CURL_SHIM_HTTP_CODE=500
  [ "${status}" -eq 0 ] || return 1
  _wait_grep "${LOG_FILE}" 'post failed http=500' 5 || return 1
}

@test "monitor-unreachable (empty http_code) is recorded in the log sink" {
  _fire "${PRE_JSON}" CURL_SHIM_HTTP_CODE=
  [ "${status}" -eq 0 ] || return 1
  _wait_grep "${LOG_FILE}" 'monitor unreachable' 5 || return 1
}
