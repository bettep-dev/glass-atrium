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
# the scanner's exit contract: clean · match (stdout "<code>\t<name>"); every other status is a refusal
SCAN_CLEAN=0
SCAN_MATCH=3

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

@test "scanner stdin entry: text matching no pattern is clean, with no reply" {
  local short="password" names=() texts=() i
  short="${short}=short12"
  names=("ordinary source" "assignment value under eight characters" "no input")
  texts=("export const answer = 42" "${short}" "")
  for i in "${!names[@]}"; do
    run "${SCANNER}" <<<"${texts[${i}]}"
    [[ "${status}" -eq "${SCAN_CLEAN}" && -z "${output}" ]] \
      || { echo "${names[${i}]}: status ${status}: ${output}"; return 1; }
  done
}

@test "scanner refuses any argument, so text is taken from stdin only" {
  run "${SCANNER}" "${AWS_FIXTURE}" </dev/null
  [[ "${status}" -ne "${SCAN_CLEAN}" && "${status}" -ne "${SCAN_MATCH}" ]] || { echo "${output}"; return 1; }
  [[ "${output}" != *"${AWS_FIXTURE}"* ]] || { echo "${output}"; return 1; }
}

@test "scanner whose matcher cannot run refuses instead of replying clean" {
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${bin}"
  ln -s "$(command -v cat)" "${bin}/cat"
  PATH="${bin}" run /bin/bash "${SCANNER}" <<<"export const answer = 42"
  [[ "${status}" -ne "${SCAN_CLEAN}" && "${status}" -ne "${SCAN_MATCH}" ]] || { echo "${output}"; return 1; }
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
