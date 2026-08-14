#!/usr/bin/env bash
# wiki-envelope.sh — nonce-sentinel envelope parser for the nightly wiki compile.
# Sourced, not executable.
#
# The compile model returns note bodies wrapped in per-run nonce sentinels; this
# lib validates that envelope and stages each body under the caller's run dir,
# keyed by the SHELL-assigned integer index. Model output is never consulted for
# a filename or a path (pin: F1 injection boundary) — the caller derives every
# note path from its own input array and writes into NOTES_DIR only after this
# parser returns 0. That ORDERING, not any cleanup step, is what guarantees zero
# notes written on abort (pin A6); a section closed before a later violation
# stays staged in the run dir and is simply never promoted.
#
# Contract (pin A7 — sourced-lib exit discipline: this lib MUST NOT call `exit`,
# which would kill the sourcing script; the caller maps the return to
# exit + stderr + PG row):
#
#   wiki_envelope_parse <envelope_file> <nonce> <total> <run_dir>
#     0 → accepted; benign misses reported in WIKI_ENVELOPE_MISSING_IDX
#     5 → structural violation (hostile-or-confused signal) or a failed staging
#         write, which is fail-closed to the same abort: the caller invokes this
#         parser as `... || rc=$?`, which suppresses errexit inside the function,
#         so an unguarded write would truncate a body and still return 0 — the
#         caller would then promote and stamp the truncated note, and the raw
#         never gets recompiled.
#     6 → oversize
#
#   Outputs (globals, reset on every call):
#     WIKI_ENVELOPE_VIOLATION       violation kind, empty on success
#     WIKI_ENVELOPE_CAPTURED_IDX    space-separated idx list, capture order
#     WIKI_ENVELOPE_CAPTURED_COUNT  count of fully validated sections
#     WIKI_ENVELOPE_MISSING_IDX     space-separated 1..total not captured — a
#                                   log/diagnostic convenience, not the only
#                                   source: a caller walking its own input array
#                                   may equally re-derive the miss set from the
#                                   absence of <run_dir>/body.<idx>, which is the
#                                   same fact one file-existence test away
#     WIKI_ENVELOPE_DONE_SEEN       1 when the DONE terminator was present
#     WIKI_ENVELOPE_DROPPED_IDX     idx of an unterminated tail dropped at EOF
#     WIKI_ENVELOPE_CHATTER_BYTES   bytes of outside-section text (log signal);
#                                   deliberately uncapped — a cap here would
#                                   change the envelope contract, and chatter is
#                                   bounded from outside by the CLI output
#                                   ceiling and the caller's captured-file gate
#   Bodies land at <run_dir>/body.<idx> — the caller's sole read surface.
#
# A violation kind never interpolates model-controlled text: idx/count fields are
# attacker-shaped, so only the fixed kind name reaches stderr and the PG row.
#
# Byte caps are RUNAWAY GUARDS, not the real output limiter (pin P1): the model /
# CLI max-output-token ceiling bites long before 512 KiB per note or 8 MiB total,
# so the true output-size ceiling is the caller's chunking concern, not these.
# Overridable so the suite can breach them without generating half a megabyte.
#
# bash 3.2 (macOS system bash): no mapfile, no associative arrays, no `[[ =~ ]]`.
#
# shellcheck disable=SC2034  # the WIKI_ENVELOPE_* globals are the output contract, read by the sourcing script

if [[ -n "${WIKI_ENVELOPE_LIB_LOADED:-}" ]]; then
  return 0
fi
WIKI_ENVELOPE_LIB_LOADED=1

: "${WIKI_ENVELOPE_MAX_NOTE_BYTES:=524288}"
: "${WIKI_ENVELOPE_MAX_TOTAL_BYTES:=8388608}"

wiki_envelope_reset() {
  WIKI_ENVELOPE_VIOLATION=""
  WIKI_ENVELOPE_CAPTURED_IDX=""
  WIKI_ENVELOPE_CAPTURED_COUNT=0
  WIKI_ENVELOPE_MISSING_IDX=""
  WIKI_ENVELOPE_DONE_SEEN=0
  WIKI_ENVELOPE_DROPPED_IDX=""
  WIKI_ENVELOPE_CHATTER_BYTES=0
}

# Integer guard then range guard (pin A3): decimal 1..total, no sign, no leading
# zero. Digits are proven by `case` BEFORE any `-lt`/`-gt`, whose arithmetic
# context would otherwise re-evaluate an attacker-shaped operand; the length
# pre-check short-circuits a 30-digit idx out of the comparison entirely.
wiki_envelope_check_idx() {
  local idx="${1}" total="${2}"
  case "${idx}" in
    '' | *[!0-9]*)
      WIKI_ENVELOPE_VIOLATION="idx-not-integer"
      return 1
      ;;
    0*)
      WIKI_ENVELOPE_VIOLATION="idx-leading-zero"
      return 1
      ;;
    *) ;;
  esac
  if [[ "${#idx}" -gt 9 ]] || [[ "${idx}" -lt 1 ]] || [[ "${idx}" -gt "${total}" ]]; then
    WIKI_ENVELOPE_VIOLATION="idx-out-of-range"
    return 1
  fi
  return 0
}

wiki_envelope_parse() {
  local envelope_file="${1:-}" nonce="${2:-}" total="${3:-}" run_dir="${4:-}"
  # Byte-accurate caps (pins A5/P6): without C collation `${#line}` counts
  # characters, and a Korean note under-counts roughly 3x. `local` restores the
  # caller's locale on return.
  local LC_ALL=C
  local line="" probe="" idx="" begin_pfx="" end_pfx="" done_pfx=""
  local open_idx="" done_count="" note_bytes=0 total_bytes=0 line_bytes=0 i=1
  local captured
  captured=()

  wiki_envelope_reset

  case "${nonce}" in
    *[!0-9a-f]* | '')
      WIKI_ENVELOPE_VIOLATION="precondition:nonce-not-32-hex"
      return 5
      ;;
    *) ;;
  esac
  if [[ "${#nonce}" -ne 32 ]]; then
    WIKI_ENVELOPE_VIOLATION="precondition:nonce-not-32-hex"
    return 5
  fi
  case "${total}" in
    '' | *[!0-9]*)
      WIKI_ENVELOPE_VIOLATION="precondition:total-not-integer"
      return 5
      ;;
    *) ;;
  esac
  if [[ ! -d "${run_dir}" ]]; then
    WIKI_ENVELOPE_VIOLATION="precondition:run-dir-missing"
    return 5
  fi
  if [[ ! -f "${envelope_file}" ]]; then
    WIKI_ENVELOPE_VIOLATION="precondition:envelope-file-missing"
    return 5
  fi
  # A zero-byte envelope is structural, never a benign zero-section run (pin P7).
  if [[ ! -s "${envelope_file}" ]]; then
    WIKI_ENVELOPE_VIOLATION="empty-envelope"
    return 5
  fi

  begin_pfx="-----GA-WIKI-NOTE-BEGIN nonce=${nonce} idx="
  end_pfx="-----GA-WIKI-NOTE-END nonce=${nonce} idx="
  done_pfx="-----GA-WIKI-ENVELOPE-DONE nonce=${nonce} count="

  # `|| [[ -n "${line}" ]]` recovers a final line with no trailing newline.
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # One optional CR stripped for the sentinel test only — body keeps raw bytes.
    probe="${line%$'\r'}"
    case "${probe}" in
      "${begin_pfx}"*-----)
        if [[ "${WIKI_ENVELOPE_DONE_SEEN}" -eq 1 ]]; then
          WIKI_ENVELOPE_VIOLATION="section-after-done"
          return 5
        fi
        if [[ -n "${open_idx}" ]]; then
          WIKI_ENVELOPE_VIOLATION="begin-inside-section"
          return 5
        fi
        idx="${probe#"${begin_pfx}"}"
        idx="${idx%-----}"
        wiki_envelope_check_idx "${idx}" "${total}" || return 5
        # First valid pair per idx is authoritative; a later duplicate aborts
        # rather than overriding it (pin P8 — last-wins would hand a
        # model-mediated attacker a content override).
        if [[ -n "${captured[${idx}]:-}" ]]; then
          WIKI_ENVELOPE_VIOLATION="duplicate-idx"
          return 5
        fi
        open_idx="${idx}"
        note_bytes=0
        # Staging IO is fail-closed to a structural abort: a silently short body
        # is promoted, stamped and counted processed forever, so aborting the run
        # (raw stays unprocessed, retried next night) is the recoverable side.
        if ! : >"${run_dir}/part.${idx}"; then
          WIKI_ENVELOPE_VIOLATION="stage-write-failed"
          return 5
        fi
        ;;
      "${end_pfx}"*-----)
        if [[ "${WIKI_ENVELOPE_DONE_SEEN}" -eq 1 ]]; then
          WIKI_ENVELOPE_VIOLATION="section-after-done"
          return 5
        fi
        idx="${probe#"${end_pfx}"}"
        idx="${idx%-----}"
        wiki_envelope_check_idx "${idx}" "${total}" || return 5
        if [[ -z "${open_idx}" ]]; then
          WIKI_ENVELOPE_VIOLATION="end-without-begin"
          return 5
        fi
        if [[ "${idx}" != "${open_idx}" ]]; then
          WIKI_ENVELOPE_VIOLATION="end-idx-mismatch"
          return 5
        fi
        if ! mv -f -- "${run_dir}/part.${idx}" "${run_dir}/body.${idx}"; then
          WIKI_ENVELOPE_VIOLATION="stage-close-failed"
          return 5
        fi
        captured[idx]=1
        WIKI_ENVELOPE_CAPTURED_IDX="${WIKI_ENVELOPE_CAPTURED_IDX}${WIKI_ENVELOPE_CAPTURED_IDX:+ }${idx}"
        WIKI_ENVELOPE_CAPTURED_COUNT=$((WIKI_ENVELOPE_CAPTURED_COUNT + 1))
        open_idx=""
        note_bytes=0
        ;;
      "${done_pfx}"*-----)
        done_count="${probe#"${done_pfx}"}"
        done_count="${done_count%-----}"
        case "${done_count}" in
          '' | *[!0-9]*)
            WIKI_ENVELOPE_VIOLATION="done-count-not-integer"
            return 5
            ;;
          0?*)
            WIKI_ENVELOPE_VIOLATION="done-count-leading-zero"
            return 5
            ;;
          *) ;;
        esac
        if [[ "${#done_count}" -gt 9 ]]; then
          WIKI_ENVELOPE_VIOLATION="done-count-not-integer"
          return 5
        fi
        if [[ -n "${open_idx}" ]]; then
          WIKI_ENVELOPE_VIOLATION="done-inside-section"
          return 5
        fi
        if [[ "${WIKI_ENVELOPE_DONE_SEEN}" -eq 1 ]]; then
          WIKI_ENVELOPE_VIOLATION="duplicate-done"
          return 5
        fi
        WIKI_ENVELOPE_DONE_SEEN=1
        if [[ "${done_count}" -ne "${WIKI_ENVELOPE_CAPTURED_COUNT}" ]]; then
          WIKI_ENVELOPE_VIOLATION="done-count-mismatch"
          return 5
        fi
        # count=0 against a non-empty input list slips a naive M == captured
        # check (0 == 0), so it is pinned structural on its own (pin P7).
        if [[ "${done_count}" -eq 0 ]] && [[ "${total}" -ge 1 ]]; then
          WIKI_ENVELOPE_VIOLATION="done-count-zero"
          return 5
        fi
        ;;
      *)
        if [[ -n "${open_idx}" ]]; then
          line_bytes=$((${#line} + 1))
          note_bytes=$((note_bytes + line_bytes))
          total_bytes=$((total_bytes + line_bytes))
          # Checked every line so a runaway stream is bounded on disk too.
          if [[ "${note_bytes}" -gt "${WIKI_ENVELOPE_MAX_NOTE_BYTES}" ]]; then
            WIKI_ENVELOPE_VIOLATION="oversize-note"
            return 6
          fi
          if [[ "${total_bytes}" -gt "${WIKI_ENVELOPE_MAX_TOTAL_BYTES}" ]]; then
            WIKI_ENVELOPE_VIOLATION="oversize-total"
            return 6
          fi
          if ! printf '%s\n' "${line}" >>"${run_dir}/part.${open_idx}"; then
            WIKI_ENVELOPE_VIOLATION="stage-write-failed"
            return 5
          fi
        else
          WIKI_ENVELOPE_CHATTER_BYTES=$((WIKI_ENVELOPE_CHATTER_BYTES + ${#line} + 1))
        fi
        ;;
    esac
  done <"${envelope_file}"

  # Benign incompleteness (D2 row 3): an unterminated tail is the budget-truncation
  # shape — drop it, keep every fully validated section, and name the misses so the
  # caller can log one line per basename.
  if [[ -n "${open_idx}" ]]; then
    rm -f -- "${run_dir}/part.${open_idx}"
    WIKI_ENVELOPE_DROPPED_IDX="${open_idx}"
  fi
  i=1
  while [[ "${i}" -le "${total}" ]]; do
    if [[ -z "${captured[${i}]:-}" ]]; then
      WIKI_ENVELOPE_MISSING_IDX="${WIKI_ENVELOPE_MISSING_IDX}${WIKI_ENVELOPE_MISSING_IDX:+ }${i}"
    fi
    i=$((i + 1))
  done
  return 0
}
