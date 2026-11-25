#!/usr/bin/env bats
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
