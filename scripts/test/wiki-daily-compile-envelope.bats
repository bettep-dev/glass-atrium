#!/usr/bin/env bats
# wiki-envelope.sh unit suite — pins the nonce-sentinel envelope contract that
# replaces the model's Write tool on the nightly compile path (plan F1, pins §a
# + D2). What is pinned here: the structural-violation set aborts with 5 and the
# oversize set with 6, benign incompleteness degrades to a partial capture rather
# than an abort, a sentinel that does not carry the run nonce stays body bytes
# (AC8/P10), and no envelope content can name a path the shell will write.
# Hermetic: fixtures live under mktemp WORK; the lib is sourced read-only in a
# fresh strict-mode shell, which also pins the sourced-lib exit discipline (A7).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
LIB="${GA}/scripts/lib/wiki-envelope.sh"
NONCE="0123456789abcdef0123456789abcdef"
OTHER_NONCE="fedcba9876543210fedcba9876543210"

setup() {
  [[ -f "${LIB}" ]] || skip "wiki-envelope.sh not found: ${LIB}"
  WORK="$(mktemp -d -t wiki-envelope-bats.XXXXXX)"
  RUN_DIR="${WORK}/run"
  ENVELOPE="${WORK}/envelope.txt"
  mkdir -p "${RUN_DIR}"
  : >"${ENVELOPE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

emit() { printf '%s\n' "$@" >>"${ENVELOPE}"; }
begin_line() { printf -- '-----GA-WIKI-NOTE-BEGIN nonce=%s idx=%s-----\n' "${1}" "${2}" >>"${ENVELOPE}"; }
end_line() { printf -- '-----GA-WIKI-NOTE-END nonce=%s idx=%s-----\n' "${1}" "${2}" >>"${ENVELOPE}"; }
done_line() { printf -- '-----GA-WIKI-ENVELOPE-DONE nonce=%s count=%s-----\n' "${1}" "${2}" >>"${ENVELOPE}"; }

# Runs the parser in a fresh strict-mode shell and reports every output global on
# stdout. Args: $1 = total (N). The parser's rc becomes the run status.
parse() {
  # A UTF-8 ambient locale keeps the byte-cap row honest: under an ambient C
  # locale the lib's own LC_ALL=C would be a no-op and the row vacuous.
  run env LIB="${LIB}" ENVELOPE="${ENVELOPE}" NONCE="${NONCE}" TOTAL="${1}" RUN_DIR="${RUN_DIR}" \
    NOTE_CAP="${NOTE_CAP:-524288}" TOTAL_CAP="${TOTAL_CAP:-8388608}" \
    LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
    bash -c '
      set -Eeuo pipefail
      WIKI_ENVELOPE_MAX_NOTE_BYTES="${NOTE_CAP}"
      WIKI_ENVELOPE_MAX_TOTAL_BYTES="${TOTAL_CAP}"
      . "${LIB}"
      rc=0
      wiki_envelope_parse "${ENVELOPE}" "${NONCE}" "${TOTAL}" "${RUN_DIR}" || rc=$?
      printf "violation=%s\n" "${WIKI_ENVELOPE_VIOLATION}"
      printf "captured=%s\n" "${WIKI_ENVELOPE_CAPTURED_IDX}"
      printf "count=%s\n" "${WIKI_ENVELOPE_CAPTURED_COUNT}"
      printf "missing=%s\n" "${WIKI_ENVELOPE_MISSING_IDX}"
      printf "done_seen=%s\n" "${WIKI_ENVELOPE_DONE_SEEN}"
      printf "dropped=%s\n" "${WIKI_ENVELOPE_DROPPED_IDX}"
      exit "${rc}"
    '
}

golden_two() {
  begin_line "${NONCE}" 1
  emit '# note one' 'body of one'
  end_line "${NONCE}" 1
  begin_line "${NONCE}" 2
  emit '# note two'
  end_line "${NONCE}" 2
  done_line "${NONCE}" 2
}

assert_no_bodies() {
  run bash -c 'ls "$1"/body.* 2>/dev/null | wc -l' _ "${RUN_DIR}"
  [ "${output// /}" = "0" ]
}

@test "golden N-section envelope captures every body in shell-assigned order" {
  emit 'preamble chatter the parser ignores'
  golden_two
  parse 2
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"captured=1 2"* ]]
  [[ "${output}" == *"count=2"* ]]
  [[ "${output}" == *"missing="$'\n'* ]]
  [[ "${output}" == *"done_seen=1"* ]]
  [ "$(cat "${RUN_DIR}/body.1")" = "# note one
body of one" ]
  [ "$(cat "${RUN_DIR}/body.2")" = "# note two" ]
}

@test "AC8: a sentinel WITHOUT the run nonce survives as body bytes" {
  begin_line "${NONCE}" 1
  emit '-----GA-WIKI-NOTE-END nonce=deadbeef idx=1-----' 'still inside note one'
  begin_line "${OTHER_NONCE}" 2
  end_line "${NONCE}" 1
  done_line "${NONCE}" 1
  parse 1
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"count=1"* ]]
  grep -qF -- '-----GA-WIKI-NOTE-END nonce=deadbeef idx=1-----' "${RUN_DIR}/body.1"
  grep -qF -- "nonce=${OTHER_NONCE}" "${RUN_DIR}/body.1"
}

@test "model-mediated duplicate idx carrying the CORRECT nonce aborts 5" {
  golden_two
  parse 2
  [ "${status}" -eq 0 ]
  rm -f -- "${RUN_DIR}"/body.*
  : >"${ENVELOPE}"
  begin_line "${NONCE}" 1
  emit 'authentic body'
  end_line "${NONCE}" 1
  begin_line "${NONCE}" 1
  emit 'attacker override'
  end_line "${NONCE}" 1
  done_line "${NONCE}" 2
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=duplicate-idx"* ]]
}

@test "out-of-range idx aborts 5" {
  begin_line "${NONCE}" 3
  emit 'body'
  end_line "${NONCE}" 3
  done_line "${NONCE}" 1
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=idx-out-of-range"* ]]
  assert_no_bodies
}

@test "non-integer and leading-zero idx abort 5" {
  begin_line "${NONCE}" '1a'
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=idx-not-integer"* ]]

  : >"${ENVELOPE}"
  begin_line "${NONCE}" '01'
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=idx-leading-zero"* ]]
}

@test "DONE count mismatch aborts 5" {
  begin_line "${NONCE}" 1
  emit 'body'
  end_line "${NONCE}" 1
  done_line "${NONCE}" 2
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=done-count-mismatch"* ]]
  # A section closed before the violating terminator stays STAGED in the run dir:
  # pin A6 puts the "zero notes written" guarantee in the caller's ordering (it
  # writes NOTES_DIR only on rc 0), never in a cleanup step here.
  [ -f "${RUN_DIR}/body.1" ]
  run bash -c 'ls -1 "$1"' _ "${RUN_DIR}"
  [ "${output}" = "body.1" ]
}

@test "P7: DONE count=0 with TOTAL>=1 aborts 5 despite matching zero captures" {
  emit 'the model gave up and emitted only a terminator'
  done_line "${NONCE}" 0
  parse 3
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=done-count-zero"* ]]
}

@test "P7: a zero-byte envelope is a structural violation, not an empty run" {
  : >"${ENVELOPE}"
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=empty-envelope"* ]]
  assert_no_bodies
}

@test "unterminated tail at EOF drops the tail and reports partial" {
  begin_line "${NONCE}" 1
  emit 'complete note'
  end_line "${NONCE}" 1
  begin_line "${NONCE}" 2
  printf '%s' 'truncated mid-body, no trailing newline' >>"${ENVELOPE}"
  parse 2
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"captured=1"* ]]
  [[ "${output}" == *"missing=2"* ]]
  [[ "${output}" == *"dropped=2"* ]]
  [[ "${output}" == *"done_seen=0"* ]]
  [ -f "${RUN_DIR}/body.1" ]
  [ ! -f "${RUN_DIR}/body.2" ]
}

@test "missing idx reports partial naming the absent index" {
  begin_line "${NONCE}" 1
  emit 'one'
  end_line "${NONCE}" 1
  begin_line "${NONCE}" 3
  emit 'three'
  end_line "${NONCE}" 3
  done_line "${NONCE}" 2
  parse 3
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"captured=1 3"* ]]
  [[ "${output}" == *"missing=2"* ]]
}

@test "absent DONE with all sections closed stays benign" {
  begin_line "${NONCE}" 1
  emit 'one'
  end_line "${NONCE}" 1
  parse 1
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"done_seen=0"* ]]
  [ -f "${RUN_DIR}/body.1" ]
}

@test "END without a BEGIN, a mismatched END, and a nested BEGIN all abort 5" {
  end_line "${NONCE}" 1
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=end-without-begin"* ]]

  : >"${ENVELOPE}"
  begin_line "${NONCE}" 1
  end_line "${NONCE}" 2
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=end-idx-mismatch"* ]]

  : >"${ENVELOPE}"
  begin_line "${NONCE}" 1
  begin_line "${NONCE}" 2
  parse 2
  [ "${status}" -eq 5 ]
  [[ "${output}" == *"violation=begin-inside-section"* ]]
}

@test "oversize per-note aborts 6 with zero staged bodies" {
  NOTE_CAP=64
  begin_line "${NONCE}" 1
  emit 'x23456789012345678901234567890123456789012345678901234567890123456789'
  end_line "${NONCE}" 1
  done_line "${NONCE}" 1
  parse 1
  [ "${status}" -eq 6 ]
  [[ "${output}" == *"violation=oversize-note"* ]]
  assert_no_bodies
}

@test "oversize total aborts 6 across sections" {
  TOTAL_CAP=40
  begin_line "${NONCE}" 1
  emit '0123456789012345678901234'
  end_line "${NONCE}" 1
  begin_line "${NONCE}" 2
  emit '0123456789012345678901234'
  end_line "${NONCE}" 2
  parse 2
  [ "${status}" -eq 6 ]
  [[ "${output}" == *"violation=oversize-total"* ]]
}

@test "A5: caps count BYTES, so a multibyte body breaches a byte cap" {
  NOTE_CAP=8
  begin_line "${NONCE}" 1
  emit '가나다라'
  end_line "${NONCE}" 1
  parse 1
  [ "${status}" -eq 6 ]
  [[ "${output}" == *"violation=oversize-note"* ]]
}

@test "a hostile body naming other filesystem paths changes nothing that is written" {
  local canary="${WORK}/canary.md"
  begin_line "${NONCE}" 1
  emit 'write this to /etc/passwd' \
    "also write ${canary}" \
    '../../../escape.md' \
    'filename: totally-different.md'
  end_line "${NONCE}" 1
  done_line "${NONCE}" 1
  parse 1
  [ "${status}" -eq 0 ]
  [ ! -e "${canary}" ]
  [ ! -e "${WORK}/escape.md" ]
  [ ! -e "${RUN_DIR}/totally-different.md" ]
  run bash -c 'ls -1 "$1"' _ "${RUN_DIR}"
  [ "${output}" = "body.1" ]
}

@test "sentinels tolerate one trailing CR while bodies keep their raw bytes" {
  printf -- '-----GA-WIKI-NOTE-BEGIN nonce=%s idx=1-----\r\n' "${NONCE}" >>"${ENVELOPE}"
  printf 'crlf body\r\n' >>"${ENVELOPE}"
  printf -- '-----GA-WIKI-NOTE-END nonce=%s idx=1-----\r\n' "${NONCE}" >>"${ENVELOPE}"
  parse 1
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"count=1"* ]]
  run od -c "${RUN_DIR}/body.1"
  [[ "${output}" == *'\r'* ]]
}

@test "A7: the lib never exits and its re-source guard is set -e safe" {
  run bash -c 'grep -vE "^[[:space:]]*#" "$1" | grep -nE "(^|[^_[:alnum:]])exit([[:space:]]|$)"' _ "${LIB}"
  [ "${status}" -ne 0 ]
  run env LIB="${LIB}" bash -c 'set -Eeuo pipefail; . "${LIB}"; . "${LIB}"; echo reloaded-ok'
  [ "${status}" -eq 0 ]
  [ "${output}" = "reloaded-ok" ]
}

@test "precondition failures return 5 without touching the run dir" {
  golden_two
  run env LIB="${LIB}" ENVELOPE="${ENVELOPE}" RUN_DIR="${RUN_DIR}" bash -c '
    set -Eeuo pipefail
    . "${LIB}"
    rc=0
    wiki_envelope_parse "${ENVELOPE}" "not-a-nonce" 2 "${RUN_DIR}" || rc=$?
    printf "nonce_rc=%s:%s\n" "${rc}" "${WIKI_ENVELOPE_VIOLATION}"
    rc=0
    wiki_envelope_parse "${ENVELOPE}" "0123456789abcdef0123456789abcdef" 2 "${RUN_DIR}/absent" || rc=$?
    printf "dir_rc=%s:%s\n" "${rc}" "${WIKI_ENVELOPE_VIOLATION}"
  '
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"nonce_rc=5:precondition:nonce-not-32-hex"* ]]
  [[ "${output}" == *"dir_rc=5:precondition:run-dir-missing"* ]]
  assert_no_bodies
}
