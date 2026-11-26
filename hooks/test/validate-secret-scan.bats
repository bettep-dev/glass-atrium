#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2154,SC2312  # BATS_* and run results are set by bats, a helper reads the run it follows; a masked status fails its comparison
# validate-secret-scan.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# PreToolUse(Write|Edit|Bash) security gate, one surface with two channels:
#   Write|Edit → scan tool_input.content + tool_input.new_string for secret
#     patterns → SEC-00x emit_error + exit 2 BLOCK.
#   Bash → dual-condition gate (secrets-file write target AND credential value
#     on the command) → SEC-016 + exit 2 BLOCK; either alone → pass.
# Benign envelopes → exit 0 pass.
#
# Run via: bats hooks/test/validate-secret-scan.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3 (fail-closed
# precondition — the hook itself exits 2 without python3).
#
# Hermetic strategy: the hook reads ONLY stdin — no file is written; content/
# command strings are pattern-scanned in place. Credential fixtures are
# SYNTHETIC and RUNTIME-ASSEMBLED from split fragments so no secret-shaped
# literal ever sits in this file (it would trip the very gate under test on
# the test file's own write). The generic-assignment fixture is assembled in
# TWO statements — its pattern tolerates quote chars between name and "=", so
# an adjacent-string split alone would not defuse it.

HOOK_SH="${BATS_TEST_DIRNAME}/../validate-secret-scan.sh"
SCANNER="${BATS_TEST_DIRNAME}/../../scripts/lib/secret-scan.sh"
# the scanner's exit contract: clean · match (stdout "<code>\t<name>", or "<line index>\t<code>" rows under the
# list-all flag); every other status is a refusal
SCAN_CLEAN=0
SCAN_MATCH=3
SCAN_LIST_FLAG="--list-all"
# the line-hash vectors the monitor's getLineHash is pinned by → the hook must hash every one the same way
VECTORS="${BATS_TEST_DIRNAME}/../../monitor/test/fixtures/scan-approval-vectors.json"
APPROVAL_LIB="${BATS_TEST_DIRNAME}/../lib/scan-approval.sh"
# shellcheck source-path=SCRIPTDIR source=lib/queue-monitor-stub.bash
source "${BATS_TEST_DIRNAME}/lib/queue-monitor-stub.bash"
SESSION_ID="5b2e8c41-9d3a-4f6e-8a1b-2c7d9e0f4a63"
REQUEST_ID="0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f"
CONSUME_ROUTE=/api/queue/scan-approvals/consume
REGISTER_ROUTE=/api/queue/scan-approvals

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  # Runtime-assembled synthetic fixtures (see header): AKIA + 16 [0-9A-Z] /
  # ghp_ + 36 alnum / a generic name=value credential assignment.
  AWS_FIXTURE="AKIA""ABCDEFGHIJKLMNOP"
  GHP_FIXTURE="ghp_""aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  CRED_FIXTURE="password"
  CRED_FIXTURE="${CRED_FIXTURE}=supersecret123"
  set_pattern_rows
}

teardown() {
  stop_stub
}

# One row per pattern class: row name · expected code · expected pattern name · synthetic text.
set_pattern_rows() {
  local upper="PASS""WORD"
  upper="${upper}: hunter2hunter2"
  ROW_NAMES=() ROW_CODES=() ROW_LABELS=() ROW_TEXTS=()
  add_row "AWS access key" SEC-001 "AWS Access Key" "const k = ${AWS_FIXTURE}"
  add_row "GitHub token" SEC-002 "GitHub Token" "const t = ${GHP_FIXTURE}"
  add_row "sk- API key" SEC-003 "API Key (sk-)" "key sk-""abcdefghijklmnopqrstu"
  add_row "JWT" SEC-004 "JWT Token" "Bearer eyJhbGciOiJIUzI1NiJ9"".""eyJzdWIiOiIxIn0"
  add_row "postgres URL with user" SEC-005 "DB connection string" "url postgres:""//app:pw@db.internal/app"
  add_row "mongodb+srv URL with user" SEC-006 "MongoDB connection string" "url mongodb+srv:""//app:pw@cluster.example"
  add_row "Google API key" SEC-007 "Google API Key" "k AIza""SyA0123456789abcdefghijklmnopqrstuv"
  add_row "Slack token" SEC-008 "Slack Token" "t xox""b-1234-abcd"
  add_row "lower-case credential assignment" SEC-013 "Generic credential assignment" "${CRED_FIXTURE}"
  add_row "upper-case credential assignment" SEC-013 "Generic credential assignment" "${upper}"
  add_row "PEM private key header" SEC-014 "PEM private key" "-----BEGIN RSA PRIVATE"" KEY-----"
  add_row "service-account private key field" SEC-015 "Service-account private key" '{"private_key": "-----''BEGIN'
  add_row "service-account type marker" SEC-015 "Service-account JSON marker" '{"type": "service''_account"}'
}

add_row() {
  ROW_NAMES+=("${1}") ROW_CODES+=("${2}") ROW_LABELS+=("${3}") ROW_TEXTS+=("${4}")
}

# Run the hook with an envelope on stdin. Args: $1=input JSON.
run_hook() {
  run bash "${HOOK_SH}" <<<"${1}"
}

# A Write envelope carrying $1 as content, JSON-escaped.
get_write_envelope() {
  jq -cn --arg c "${1}" '{tool_name:"Write",tool_input:{file_path:"/tmp/x.ts",content:$c}}'
}

@test "Write channel: every pattern class blocks with its own code (exit 2)" {
  local i
  for i in "${!ROW_NAMES[@]}"; do
    run_hook "$(get_write_envelope "${ROW_TEXTS[${i}]}")"
    [[ "${status}" -eq 2 && "${output}" == *"\"${ROW_CODES[${i}]}\""* ]] \
      || { echo "${ROW_NAMES[${i}]}: ${output}"; return 1; }
  done
}

@test "Edit channel: GitHub-token-shaped new_string → SEC-002 block (exit 2)" {
  run_hook "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/x.ts\",\"new_string\":\"const t = ${GHP_FIXTURE}\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-002"* ]] || return 1
}

@test "Bash channel: credential value redirected into .env → SEC-016 block (exit 2)" {
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > .env\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-016"* ]] || return 1
}

@test "Bash benign: dual-condition gate — write target without credential value → pass" {
  run_hook '{"tool_name":"Bash","tool_input":{"command":"echo PLACEHOLDER= > .env"}}'
  [[ "${status}" -eq 0 ]] || return 1
}

@test "Bash benign: credential value without a secrets-file target → pass" {
  # Dual-condition gate, other half: the value alone (no .env-class write
  # target — a log file) must NOT block.
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > out.log\"}}"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "Write benign: ordinary source content → pass (exit 0, silent)" {
  run_hook '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.ts","content":"export const answer = 42"}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

# ~160 KiB of JSON-escaped lines → a multi-write writer, which races a reader that stops at a line-1
# match at any size; a writer left with a write dies of SIGPIPE, which pipefail reports as "no match".
pipe_overflow_padding() {
  seq -f 'padding line %05g of ordinary source text' 1 4000 | awk '{ printf "%s\\n", $0 }'
}

@test "Write channel: a secret on line 1 of content larger than the pipe buffer still blocks, exit 2" {
  local padding
  padding="$(pipe_overflow_padding)"
  run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/x.ts\",\"content\":\"const k = ${AWS_FIXTURE}\\n${padding}\"}}"
  [[ "${status}" -eq 2 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"SEC-001"* ]] || { echo "${output}"; return 1; }
}

@test "Bash channel: a .env credential write on line 1 of a command larger than the pipe buffer still blocks, exit 2" {
  local padding
  padding="$(pipe_overflow_padding)"
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > .env\\n${padding}\"}}"
  [[ "${status}" -eq 2 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"SEC-016"* ]] || { echo "${output}"; return 1; }
}

@test "scanner stdin entry: every pattern class replies its code and name, never the text" {
  local i
  for i in "${!ROW_NAMES[@]}"; do
    run "${SCANNER}" <<<"${ROW_TEXTS[${i}]}"
    [[ "${status}" -eq "${SCAN_MATCH}" ]] || { echo "${ROW_NAMES[${i}]}: status ${status}: ${output}"; return 1; }
    [[ "${output}" == "${ROW_CODES[${i}]}"$'\t'"${ROW_LABELS[${i}]}" ]] \
      || { echo "${ROW_NAMES[${i}]}: ${output}"; return 1; }
  done
}

# Each row's text on its own line after a CRLF filler line, then one line carrying two classes and an invalid
# UTF-8 byte (GNU grep's binary-file notice would replace its rows). Sets LIST_TEXT and LIST_EXPECTED, the sorted
# "<line index>\t<code>" rows the list-all entry owes.
set_list_fixture() {
  local i line=0
  LIST_TEXT="" LIST_EXPECTED=""
  for i in "${!ROW_NAMES[@]}"; do
    LIST_TEXT+="export const filler = ${i}"$'\r\n'"${ROW_TEXTS[${i}]}"$'\n'
    line=$((line + 2))
    LIST_EXPECTED+="${line}"$'\t'"${ROW_CODES[${i}]}"$'\n'
  done
  LIST_TEXT+="const k = ${AWS_FIXTURE} ${CRED_FIXTURE} "$'\xff'
  line=$((line + 1))
  LIST_EXPECTED+="${line}"$'\tSEC-001\n'"${line}"$'\tSEC-013'
  LIST_EXPECTED="$(sort <<<"${LIST_EXPECTED}")"
}

@test "scanner list-all entry: every matching line is listed with its LF-counted index and each code, never the text" {
  set_list_fixture
  run "${SCANNER}" "${SCAN_LIST_FLAG}" <<<"${LIST_TEXT}"
  [[ "${status}" -eq "${SCAN_MATCH}" ]] || { echo "status ${status}: ${output}"; return 1; }
  [[ "$(sort <<<"${output}")" == "${LIST_EXPECTED}" ]] || { echo "${output}"; return 1; }
}

# File-size limit 0 → any write of the text to a file (a here-string's temp file) kills the scanner with SIGXFSZ;
# text past the 64 KiB pipe buffer → newer bash also takes the temp-file path for a here-string.
@test "scanner list-all entry puts the scanned text in no file: it lists the same rows with no file-size allowance" {
  local text
  text="$(seq -f 'padding line %05g of ordinary source text' 1 4000)"$'\n'"const k = ${AWS_FIXTURE}"
  run bash -c 'ulimit -f 0 && exec "$@"' _ "${SCANNER}" "${SCAN_LIST_FLAG}" <<<"${text}"
  [[ "${status}" -eq "${SCAN_MATCH}" && "${output}" == "4001"$'\tSEC-001' ]] \
    || { echo "status ${status}: ${output}"; return 1; }
}

@test "scanner no-argument entry replies only the first pattern in table order, wherever it sits in the text" {
  local text="" i
  for ((i = ${#ROW_TEXTS[@]} - 1; i >= 0; i--)); do text+="${ROW_TEXTS[${i}]}"$'\n'; done
  run "${SCANNER}" <<<"${text}"
  [[ "${status}" -eq "${SCAN_MATCH}" && "${output}" == "${ROW_CODES[0]}"$'\t'"${ROW_LABELS[0]}" ]] \
    || { echo "status ${status}: ${output}"; return 1; }
}

# Protects the pattern table as a reviewed security contract: a change to it is a decision, never a side effect.
@test "scanner pattern table is byte-identical to the reviewed table" {
  local digest
  digest="$(awk '/^readonly -a PATTERNS=\(/ { on = 1 } on { print } on && /^readonly -a NAMES=\(/ { names = 1 }
    names && /^\)$/ { exit }' "${SCANNER}" | shasum -a 256)"
  [[ "${digest%% *}" == "5100262d7912252cb209a23f2fd4a42f54fcfd96f98dc66fdf744adce429afee" ]] \
    || { echo "${digest}"; return 1; }
}

@test "scanner stdin entry: text matching no pattern is clean, with no reply" {
  local short="password" names=() texts=() flag i
  short="${short}=short12"
  names=("ordinary source" "assignment value under eight characters" "no input")
  texts=("export const answer = 42" "${short}" "")
  for flag in "" "${SCAN_LIST_FLAG}"; do
    for i in "${!names[@]}"; do
      run "${SCANNER}" ${flag:+"${flag}"} <<<"${texts[${i}]}"
      [[ "${status}" -eq "${SCAN_CLEAN}" && -z "${output}" ]] \
        || { echo "${flag:-no flag} · ${names[${i}]}: status ${status}: ${output}"; return 1; }
    done
  done
}

@test "scanner refuses every argument but the list-all flag alone, so text is taken from stdin only" {
  local names=() rows=() args=() i
  names=("the text as an argument" "the list-all flag beside the text" "an unknown flag")
  rows=("${AWS_FIXTURE}" "${SCAN_LIST_FLAG}|${AWS_FIXTURE}" "--list")
  for i in "${!names[@]}"; do
    IFS='|' read -r -a args <<<"${rows[${i}]}"
    run "${SCANNER}" "${args[@]}" </dev/null
    [[ "${status}" -ne "${SCAN_CLEAN}" && "${status}" -ne "${SCAN_MATCH}" && "${output}" != *"${AWS_FIXTURE}"* ]] \
      || { echo "${names[${i}]}: status ${status}: ${output}"; return 1; }
  done
}

@test "scanner whose matcher cannot run refuses instead of replying clean" {
  local bin="${BATS_TEST_TMPDIR}/bin" flag
  mkdir -p "${bin}"
  ln -s "$(command -v cat)" "${bin}/cat"
  for flag in "" "${SCAN_LIST_FLAG}"; do
    PATH="${bin}" run /bin/bash "${SCANNER}" ${flag:+"${flag}"} <<<"export const answer = 42"
    [[ "${status}" -ne "${SCAN_CLEAN}" && "${status}" -ne "${SCAN_MATCH}" ]] \
      || { echo "${flag:-no flag}: status ${status}: ${output}"; return 1; }
  done
}

# A row stage exiting 1 on a line grep matched → pipefail alone would read it as grep's "no match".
@test "scanner list-all entry refuses instead of replying clean when a stage after the matcher fails" {
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${bin}"
  ln -s "$(command -v cat)" "${bin}/cat"
  ln -s "$(command -v grep)" "${bin}/grep"
  printf '#!/bin/sh\nexit 1\n' >"${bin}/awk"
  chmod +x "${bin}/awk"
  PATH="${bin}" run /bin/bash "${SCANNER}" "${SCAN_LIST_FLAG}" <<<"const k = ${AWS_FIXTURE}"
  [[ "${status}" -ne "${SCAN_CLEAN}" && "${status}" -ne "${SCAN_MATCH}" ]] || { echo "status ${status}: ${output}"; return 1; }
}

# A hook copy beside a scanner stand-in. Args: $1=layout root · $2=stand-in body, or "" for no scanner file.
make_hook_layout() {
  local root="${1}"
  mkdir -p "${root}/hooks/lib" "${root}/scripts/lib"
  cp "${HOOK_SH}" "${BATS_TEST_DIRNAME}/../hook-utils.sh" "${root}/hooks/"
  cp "${BATS_TEST_DIRNAME}/../lib/pipe-drain.sh" "${root}/hooks/lib/"
  if [[ -n "${2}" ]]; then printf '%s\n' "${2}" >"${root}/scripts/lib/secret-scan.sh"; fi
  printf '%s\n' "${root}/hooks/validate-secret-scan.sh"
}

@test "hook blocks on every scanner outcome but clean" {
  local names=() bodies=() codes=() i hook envelope
  names=("scanner missing" "scanner exits 1" "scanner killed" "match code with no reply" "scanner clean")
  bodies=("" "exit 1" 'kill -TERM $$' "exit ${SCAN_MATCH}" "exit ${SCAN_CLEAN}")
  codes=(SEC-017 SEC-017 SEC-017 SEC-017 "")
  envelope="$(get_write_envelope "export const answer = 42")"
  for i in "${!names[@]}"; do
    hook="$(make_hook_layout "${BATS_TEST_TMPDIR}/install-${i}" "${bodies[${i}]}")"
    run bash "${hook}" <<<"${envelope}"
    if [[ -z "${codes[${i}]}" ]]; then
      [[ "${status}" -eq 0 && -z "${output}" ]] || { echo "${names[${i}]}: ${output}"; return 1; }
    else
      [[ "${status}" -eq 2 && "${output}" == *"\"${codes[${i}]}\""* ]] \
        || { echo "${names[${i}]}: status ${status}: ${output}"; return 1; }
    fi
  done
}

@test "line hash: every shared vector hashes to the monitor's pinned SHA-256, as one line" {
  local count i name expected actual
  # shellcheck source-path=SCRIPTDIR source=../lib/scan-approval.sh
  source "${APPROVAL_LIB}"
  count="$(jq '.lines | length' "${VECTORS}")"
  [[ "${count}" -gt 0 ]] || {
    echo "no vectors in ${VECTORS}"
    return 1
  }
  for ((i = 0; i < count; i++)); do
    name="$(jq -r --argjson i "${i}" '.lines[$i].name' "${VECTORS}")"
    expected="$(jq -r --argjson i "${i}" '.lines[$i].sha256' "${VECTORS}")"
    # shellcheck disable=SC2312  # a failed jq feeds no text → the comparison below fails
    actual="$(jq -j --argjson i "${i}" '.lines[$i].text' "${VECTORS}" | get_line_hashes)"
    [[ "${actual}" == "${expected}" ]] || {
      echo "${name}: got ${actual}"
      return 1
    }
  done
}

@test "line hash: a text of many lines yields one hash per LF-separated line, in order" {
  local expected actual
  # shellcheck source-path=SCRIPTDIR source=../lib/scan-approval.sh
  source "${APPROVAL_LIB}"
  expected="$(jq -r '.lines[].sha256' "${VECTORS}")"
  # shellcheck disable=SC2312  # a failed jq feeds no text → the comparison below fails
  actual="$(jq -j '[.lines[].text] | join("\n")' "${VECTORS}" | get_line_hashes)"
  [[ "${actual}" == "${expected}" ]] || {
    printf 'expected:\n%s\nactual:\n%s\n' "${expected}" "${actual}"
    return 1
  }
}

# A stand-in monitor of the test's own and every root under the test's tmp → never the live monitor, its port or log.
# Sets TARGET, the write's path, whose parent's real path the hook resolves.
use_monitor_stub() {
  export HOME="${BATS_TEST_TMPDIR}/home" GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  export GA_DATA_ROOT="${HOME}/.glass-atrium"
  mkdir -p "${BATS_TEST_TMPDIR}/project" "${HOME}"
  TARGET="$(cd -P -- "${BATS_TEST_TMPDIR}/project" && pwd -P)/app.ts"
  start_stub
}

# A main-session Write envelope carrying $1 as content to TARGET.
get_session_envelope() {
  jq -cn --arg c "${1}" --arg p "${TARGET}" --arg s "${SESSION_ID}" \
    '{session_id:$s,tool_name:"Write",tool_input:{file_path:$p,content:$c}}'
}

# Today's refusal for SEC-013, the hook's first stderr line.
get_cred_refusal() {
  jq -cnS '{hook:"validate-secret-scan",error_code:"SEC-013",severity:"block",
    message:"Secret pattern detected: Generic credential assignment",
    suggestion:"Replace the hardcoded secret with an environment-variable reference (core-security.md -> Secret Management)",
    context:{pattern:"SEC-013"}}'
}

# The body the stub received on route $1 (the n-th such request with $2, default the first), sorted keys.
get_request_body() {
  jq -cs --arg r "${1}" --argjson n "${2:-1}" '[.[] | select(.path == $r)][$n - 1].body // empty' \
    "${BATS_TEST_TMPDIR}/requests.log" | jq -r 'select(. != null)' | jq -cS .
}

# The canonical line hash of $1 (the vectors pin get_line_hashes).
get_hash() {
  # shellcheck source-path=SCRIPTDIR source=../lib/scan-approval.sh
  source "${APPROVAL_LIB}"
  printf '%s' "${1}" | get_line_hashes
}

@test "an approved SEC-013 write passes once: consume carries the tuple and the line hash, the log only ids and hashes" {
  local hash expected log
  use_monitor_stub
  set_reply 200 "{\"decision\":\"pass\",\"requestId\":\"${REQUEST_ID}\"}"
  hash="$(get_hash "${CRED_FIXTURE}")"
  run_hook "$(get_session_envelope "const a = 1"$'\n'"${CRED_FIXTURE}"$'\n'"const b = 2")"
  [[ "${status}" -eq 0 && -z "${output}" ]] || { echo "status ${status}: ${output}"; return 1; }
  expected="$(jq -cnS --arg s "${SESSION_ID}" --arg p "${TARGET}" --arg h "${hash}" \
    '{sessionId:$s,path:$p,rule:"SEC-013",hashes:[$h]}')"
  [[ "$(get_request_body "${CONSUME_ROUTE}")" == "${expected}" && "$(request_count)" -eq 1 ]] \
    || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
  log="$(cat "${GA_DATA_ROOT}/logs/validate-secret-scan.log")"
  [[ "${log}" == *"${REQUEST_ID}"* && "${log}" == *"${hash}"* && "${log}" != *"${CRED_FIXTURE}"* ]] \
    || { echo "log: ${log}"; return 1; }
}

@test "an unapproved SEC-013 write is refused as today, naming the registered request id and the one route, never the line" {
  local hash expected
  use_monitor_stub
  set_nth_reply 1 409 '{"error":"scan_approval_refused","decision":"refuse"}'
  set_nth_reply 2 200 "{\"requestId\":\"${REQUEST_ID}\"}"
  hash="$(get_hash "${CRED_FIXTURE}")"
  run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
  [[ "${status}" -eq 2 && "${#lines[@]}" -eq 2 ]] || { echo "status ${status}: ${output}"; return 1; }
  [[ "$(jq -cS . <<<"${lines[0]}")" == "$(get_cred_refusal)" ]] || { echo "${lines[0]}"; return 1; }
  [[ "${lines[1]}" == *"${REQUEST_ID}"* && "${lines[1]}" == *"secret-approval"* && "${output}" != *"${CRED_FIXTURE}"* ]] \
    || { echo "${output}"; return 1; }
  expected="$(jq -cnS --arg s "${SESSION_ID}" --arg p "${TARGET}" --arg t "${CRED_FIXTURE}" --arg h "${hash}" \
    '{sessionId:$s,path:$p,rule:"SEC-013",agent:{id:"",type:""},lines:[{text:$t,hash:$h}]}')"
  [[ "$(get_request_body "${REGISTER_ROUTE}")" == "${expected}" ]] || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
}

@test "a SEC-013 write that another rule also matches is refused as today with nothing sent to the monitor" {
  local names=() texts=() pem="-----BEGIN RSA PRIVATE"" KEY-----" marker='{"type": "service''_account"}' i
  use_monitor_stub
  names=("a PEM header on the same line" "a service-account marker on another line")
  texts=("${CRED_FIXTURE} ${pem}" "${CRED_FIXTURE}"$'\n'"${marker}")
  for i in "${!names[@]}"; do
    run_hook "$(get_session_envelope "${texts[${i}]}")"
    [[ "${status}" -eq 2 && "$(jq -cS . <<<"${lines[0]}")" == "$(get_cred_refusal)" && "$(request_count)" -eq 0 ]] \
      || { echo "${names[${i}]}: status ${status}: ${output}"; return 1; }
  done
}

@test "a write of several SEC-013 lines asks for an approval of every one, so an approval of fewer never covers it" {
  local upper="PASS""WORD" first second expected
  upper="${upper}: hunter2hunter2"
  use_monitor_stub
  set_nth_reply 1 409 '{"error":"scan_approval_refused","decision":"refuse"}'
  set_nth_reply 2 200 "{\"requestId\":\"${REQUEST_ID}\"}"
  first="$(get_hash "${CRED_FIXTURE}")"
  second="$(get_hash "${upper}")"
  run_hook "$(get_session_envelope "${CRED_FIXTURE}"$'\n'"const a = 1"$'\n'"${upper}")"
  [[ "${status}" -eq 2 ]] || { echo "status ${status}: ${output}"; return 1; }
  expected="$(jq -cn --arg a "${first}" --arg b "${second}" '[$a, $b]')"
  [[ "$(get_request_body "${CONSUME_ROUTE}" | jq -c .hashes)" == "${expected}" ]] \
    || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
}

@test "the repeat of a write that passed is asked about again and refused once the monitor has nothing to consume" {
  local envelope
  use_monitor_stub
  set_nth_reply 1 200 "{\"decision\":\"pass\",\"requestId\":\"${REQUEST_ID}\"}"
  set_nth_reply 2 409 '{"error":"scan_approval_refused","decision":"refuse"}'
  set_nth_reply 3 200 "{\"requestId\":\"${REQUEST_ID}\"}"
  envelope="$(get_session_envelope "${CRED_FIXTURE}")"
  run_hook "${envelope}"
  [[ "${status}" -eq 0 ]] || { echo "first: status ${status}: ${output}"; return 1; }
  run_hook "${envelope}"
  [[ "${status}" -eq 2 && "${lines[1]}" == *"${REQUEST_ID}"* ]] || { echo "repeat: status ${status}: ${output}"; return 1; }
  [[ -n "$(get_request_body "${CONSUME_ROUTE}" 2)" ]] || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
}

@test "with no monitor running a SEC-013 write is refused exactly as today plus one cause line" {
  use_monitor_stub
  stop_stub
  run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
  [[ "${status}" -eq 2 && "${#lines[@]}" -eq 2 ]] || { echo "status ${status}: ${output}"; return 1; }
  [[ "$(jq -cS . <<<"${lines[0]}")" == "$(get_cred_refusal)" && "${lines[1]}" == *"monitor"* ]] \
    || { echo "${output}"; return 1; }
}

# Today's SEC-013 refusal plus exactly one added line holding $2, never the line → else prints row $1 and fails.
check_cause_refusal() {
  [[ "${status}" -eq 2 && "${#lines[@]}" -eq 2 && "$(jq -cS . <<<"${lines[0]}")" == "$(get_cred_refusal)" ]] \
    && [[ "${lines[1]}" == "SEC-013 approval: "*"${2}"* && "${output}" != *"${CRED_FIXTURE}"* ]] \
    || { echo "${1}: status ${status}: ${output}"; return 1; }
}

# A directory linking every command on PATH but $1 → the hook runs as on a host without that command.
make_path_without() {
  local bin="${BATS_TEST_TMPDIR}/without-${1}" dir entry
  local -a dirs=()
  mkdir -p "${bin}"
  IFS=: read -r -a dirs <<<"${PATH}"
  for dir in "${dirs[@]}"; do
    for entry in "${dir}"/*; do
      if [[ "${entry##*/}" != "${1}" && -x "${entry}" && ! -e "${bin}/${entry##*/}" ]]; then
        ln -s "${entry}" "${bin}/${entry##*/}"
      fi
    done
  done
  printf '%s\n' "${bin}"
}

@test "a consume reply that is not exactly a 200 pass or a 409 refusal refuses the write with one cause line and registers nothing" {
  local names=() codes=() bodies=() pass="\"requestId\":\"${REQUEST_ID}\"" i sent=0
  use_monitor_stub
  names=("a reply that is not JSON" "a JSON reply without the decision field" "a pass under HTTP 201"
    "a pass under HTTP 500" "a decision in another case" "a decision with a trailing line break"
    "a decision that is not a string" "a 409 without the refuse decision" "a pass whose request id is not a UUID")
  codes=(200 200 201 500 200 200 200 409 200)
  bodies=("decision=pass" "{${pass}}" "{\"decision\":\"pass\",${pass}}" "{\"decision\":\"pass\",${pass}}"
    "{\"decision\":\"Pass\",${pass}}" "{\"decision\":\"pass\\n\",${pass}}" "{\"decision\":true,${pass}}"
    '{"error":"scan_approval_refused"}' '{"decision":"pass","requestId":"not-a-uuid"}')
  for i in "${!names[@]}"; do
    set_reply "${codes[${i}]}" "${bodies[${i}]}"
    run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
    sent=$((sent + 1))
    check_cause_refusal "${names[${i}]}" "consume reply" || return 1
    [[ "$(request_count)" -eq "${sent}" ]] || { echo "${names[${i}]}: a register followed"; return 1; }
  done
}

@test "a register the monitor does not answer with a request id refuses the write with one cause line naming why" {
  local names=() codes=() bodies=() causes=() i
  use_monitor_stub
  names=("a hash the monitor computes differently" "a request over the size limit" "the session's request cap"
    "a reply that is not JSON" "a request id that is not a UUID")
  codes=(400 422 429 200 200)
  bodies=('{"error":"secret_line_hash_mismatch"}' '{"error":"secret_request_size"}' '{"error":"secret_request_cap"}'
    "request=${REQUEST_ID}" '{"requestId":"not-a-uuid"}')
  causes=("HTTP 400, secret_line_hash_mismatch" "HTTP 422, secret_request_size" "HTTP 429, secret_request_cap"
    "HTTP 200, no readable code" "register reply was malformed")
  for i in "${!names[@]}"; do
    set_nth_reply $((2 * i + 1)) 409 '{"error":"scan_approval_refused","decision":"refuse"}'
    set_nth_reply $((2 * i + 2)) "${codes[${i}]}" "${bodies[${i}]}"
    run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
    check_cause_refusal "${names[${i}]}" "${causes[${i}]}" || return 1
  done
}

@test "a payload with no usable session id or no real target directory refuses the write with one cause line and sends nothing" {
  local names=() envelopes=() causes=() i
  use_monitor_stub
  names=("no session_id" "an empty session_id" "a session_id that is not a string"
    "a target whose parent directory does not exist" "a relative target path")
  envelopes=(
    "$(jq -cn --arg c "${CRED_FIXTURE}" --arg p "${TARGET}" '{tool_name:"Write",tool_input:{file_path:$p,content:$c}}')"
    "$(get_session_envelope "${CRED_FIXTURE}" | jq -c '.session_id = ""')"
    "$(get_session_envelope "${CRED_FIXTURE}" | jq -c '.session_id = 42')"
    "$(get_session_envelope "${CRED_FIXTURE}" | jq -c --arg p "${TARGET%/*}/missing/app.ts" '.tool_input.file_path = $p')"
    "$(get_session_envelope "${CRED_FIXTURE}" | jq -c '.tool_input.file_path = "project/app.ts"')"
  )
  causes=(session_id session_id session_id "real parent directory" "real parent directory")
  for i in "${!names[@]}"; do
    run_hook "${envelopes[${i}]}"
    check_cause_refusal "${names[${i}]}" "${causes[${i}]}" || return 1
  done
  [[ "$(request_count)" -eq 0 ]] || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
}

# Another session's, another path's or an expired approval is the monitor's refusal (its store pins each); the hook's
# half is the tuple it asks about — the payload's session and the target's real path, never the environment's.
@test "the consume asks about the payload's session and the target's real path, so the monitor's refusal of any other approval refuses the write" {
  local expected
  use_monitor_stub
  ln -s "${TARGET%/*}" "${BATS_TEST_TMPDIR}/linked"
  set_nth_reply 1 409 '{"error":"scan_approval_refused","decision":"refuse"}'
  set_nth_reply 2 200 "{\"requestId\":\"${REQUEST_ID}\"}"
  CLAUDE_CODE_SESSION_ID="9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f" run_hook "$(get_session_envelope "${CRED_FIXTURE}" \
    | jq -c --arg p "${BATS_TEST_TMPDIR}/linked/app.ts" '.tool_input.file_path = $p | .agent_id = "a1" | .agent_type = "dev"')"
  check_cause_refusal "monitor refusal" "${REQUEST_ID}" || return 1
  expected="$(jq -cn --arg s "${SESSION_ID}" --arg p "${TARGET}" '[$s, $p]')"
  [[ "$(get_request_body "${CONSUME_ROUTE}" | jq -c '[.sessionId, .path]')" == "${expected}" \
    && "$(get_request_body "${REGISTER_ROUTE}" | jq -c '[.sessionId, .path]')" == "${expected}" ]] \
    || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
}

@test "a monitor that hangs refuses the write with one cause line, and a call outliving its own timeouts ends at the deadline with no child left" {
  local bin="${BATS_TEST_TMPDIR}/bin" mark="29.${RANDOM}" started
  use_monitor_stub
  set_reply hang ""
  started="${SECONDS}"
  run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
  check_cause_refusal "a monitor holding the request open" "did not answer" || return 1
  mkdir -p "${bin}"
  printf '#!/bin/sh\nexec sleep %s\n' "${mark}" >"${bin}/curl"
  chmod +x "${bin}/curl"
  PATH="${bin}:${PATH}" run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
  check_cause_refusal "a monitor call that never returns" "deadline" || return 1
  ((SECONDS - started < 20)) || { echo "took $((SECONDS - started)) s"; return 1; }
  run pgrep -f "sleep ${mark}"
  [[ "${status}" -eq 1 ]] || { echo "the stalled call outlived the hook: ${output}"; return 1; }
}

@test "with curl absent a SEC-013 write is refused as today plus one cause line" {
  local bin
  use_monitor_stub
  bin="$(make_path_without curl)"
  PATH="${bin}" run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
  check_cause_refusal "curl absent" "curl" || return 1
  [[ "$(request_count)" -eq 0 ]] || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
}

@test "with python3 absent a SEC-013 write is refused by the existing SEC-017 refusal with nothing sent" {
  local bin
  use_monitor_stub
  bin="$(make_path_without python3)"
  PATH="${bin}" run_hook "$(get_session_envelope "${CRED_FIXTURE}")"
  [[ "${status}" -eq 2 && "${output}" == *'"SEC-017"'* && "${output}" != *"${CRED_FIXTURE}"* ]] \
    || { echo "status ${status}: ${output}"; return 1; }
  [[ "$(request_count)" -eq 0 ]] || { cat "${BATS_TEST_TMPDIR}/requests.log"; return 1; }
}

@test "a captured line reaches only the monitor's register: never the hook's log, its stderr, a process argument list or a data directory" {
  local bin="${BATS_TEST_TMPDIR}/bin" ps_log="${BATS_TEST_TMPDIR}/ps.log" sentinel line refused passed
  use_monitor_stub
  export TMPDIR="${BATS_TEST_TMPDIR}/tmp"
  mkdir -p "${bin}" "${TMPDIR}"
  sentinel="Qx${RANDOM}${RANDOM}sentinel"
  line="pass""word=${sentinel}"
  # every monitor call snapshots every process's argument list first
  printf '#!/bin/sh\nps -A -ww -o args= >>"%s"\nexec "%s" "$@"\n' "${ps_log}" "$(command -v curl)" >"${bin}/curl"
  chmod +x "${bin}/curl"
  set_nth_reply 1 409 '{"error":"scan_approval_refused","decision":"refuse"}'
  set_nth_reply 2 200 "{\"requestId\":\"${REQUEST_ID}\"}"
  set_nth_reply 3 200 "{\"decision\":\"pass\",\"requestId\":\"${REQUEST_ID}\"}"
  PATH="${bin}:${PATH}" run_hook "$(get_session_envelope "${line}")"
  refused="${status} ${output}"
  PATH="${bin}:${PATH}" run_hook "$(get_session_envelope "${line}")"
  passed="${status} ${output}"
  [[ "${refused}" == "2 "* && "${passed}" == "0 " && "$(get_request_body "${REGISTER_ROUTE}")" == *"${sentinel}"* ]] \
    || { printf 'refused: %s\npassed: %s\n' "${refused}" "${passed}"; return 1; }
  [[ "${refused}" != *"${sentinel}"* && "$(wc -l <"${ps_log}")" -gt 3 && -s "${GA_DATA_ROOT}/logs/validate-secret-scan.log" ]] \
    || { echo "${refused}"; return 1; }
  mkdir -p "${GA_ROOT}"
  # status 1 alone → searched and not found; 2 (an unreadable root) is no evidence
  run grep -rl -- "${sentinel}" "${ps_log}" "${HOME}" "${TMPDIR}" "${GA_ROOT}"
  [[ "${status}" -eq 1 ]] || { echo "status ${status}: ${output}"; return 1; }
}
