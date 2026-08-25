#!/usr/bin/env bash
# wiki-staleness.sh — reports wiki notes whose last-touch date is past the staleness threshold.
#
# Date resolution per note, first hit wins:
#   1. frontmatter `updated:`   2. frontmatter `created:`   3. filesystem mtime
# A field that is PRESENT but unparseable short-circuits to "unknown age" instead of falling
# through to mtime: an unreadable date is a defect in the note, not an absent date, and quietly
# substituting mtime would hide it. mtime-derived ages get their own bucket because a compile or
# a sync rewrites mtime without the note's content having been reviewed — a weaker signal.
#
# Read-only by design: nothing under the wiki store is written. Carrying the output into the
# healthcheck document is the curator's duty (core-wiki-reference.md — curator-only wiki writes).
#
# Usage:
#     wiki-staleness.sh                      # scan ${WIKI_ROOT}/notes
#     wiki-staleness.sh --notes-dir PATH     # override the notes directory (testing)
#     wiki-staleness.sh --threshold-days N   # override the 90-day threshold
#     wiki-staleness.sh --top N              # override the per-bucket enumeration cap
#
# Env (a flag wins over the env): WIKI_ROOT · WIKI_STALE_DAYS · WIKI_STALE_TOP_N.
#
# Exit codes:
#   0 = scan completed (staleness is a report, never a failure)
#   2 = usage error
#   3 = notes directory not found
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME='wiki-staleness.sh'
# Non-whitespace record separator: a whitespace IFS collapses consecutive delimiters, which would
# drop an empty date field on read-back and misclassify the note.
readonly SEP=$'\x1f'

WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
NOTES_DIR="${WIKI_ROOT}/notes"
# Threshold role (90-day `updated:` vs 1-year `collected:`): see core-wiki-reference.md.
THRESHOLD_DAYS="${WIKI_STALE_DAYS:-90}"
TOP_N="${WIKI_STALE_TOP_N:-10}"

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# The EXIT trap fires outside main's scope, so the scratch dir cannot be one of its locals.
WORK_DIR=""

cleanup() {
  if [[ -n "${WORK_DIR}" ]]; then
    rm -rf -- "${WORK_DIR}"
  fi
}
trap cleanup EXIT

usage() {
  printf 'usage: %s [--notes-dir PATH] [--threshold-days N] [--top N]\n' "${SCRIPT_NAME}" >&2
}

require_value() {
  if [[ -z "${2:-}" ]]; then
    printf 'ERROR: %s requires a value\n' "${1}" >&2
    usage
    exit 2
  fi
}

require_count() {
  if [[ ! "${2}" =~ ^[0-9]+$ ]]; then
    printf 'ERROR: %s must be a non-negative integer: %s\n' "${1}" "${2}" >&2
    exit 2
  fi
}

# BSD and GNU date take incompatible flags; probe once rather than per note.
if date -j -f '%Y-%m-%d' '2000-01-01' '+%s' >/dev/null 2>&1; then
  readonly DATE_FLAVOUR='bsd'
else
  readonly DATE_FLAVOUR='gnu'
fi

# Prints the epoch of a YYYY-MM-DD date; empty output means the caller must treat the age as unknown.
epoch_of_ymd() {
  local ymd="${1}"
  [[ "${ymd}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 0
  if [[ "${DATE_FLAVOUR}" == 'bsd' ]]; then
    date -j -f '%Y-%m-%d' "${ymd}" '+%s' 2>/dev/null || true # GA-ABSORB[handled@epoch_of_ymd caller]: a rejected date yields empty output and routes the note to the unknown-age bucket
  else
    date -d "${ymd}" '+%s' 2>/dev/null || true # GA-ABSORB[handled@epoch_of_ymd caller]: same empty-output routing on the GNU branch
  fi
}

epoch_of_mtime() {
  stat -f '%m' "${1}" 2>/dev/null || stat -c '%Y' "${1}" 2>/dev/null || true # GA-ABSORB[benign]: BSD stat rejects the GNU flag and vice versa, so the first failure IS the portability branch
}

# Bucket rows are `epoch SEP label SEP age SEP basename`, sorted oldest-first at report time.
record() {
  local bucket="${1}" epoch="${2}" label="${3}" age="${4}" name="${5}"
  printf '%s%s%s%s%s%s%s\n' "${epoch}" "${SEP}" "${label}" "${SEP}" "${age}" "${SEP}" "${name}" >>"${bucket}"
}

report_bucket() {
  local title="${1}" bucket="${2}" count
  count="$(wc -l <"${bucket}" | tr -d '[:space:]')"
  printf '## %s\n' "${title}"
  printf 'count: %s\n' "${count}"
  if [[ "${count}" -gt 0 && "${TOP_N}" -gt 0 ]]; then
    sort -t "${SEP}" -k1,1n -k4,4 "${bucket}" >"${bucket}.sorted"
    local epoch label age name shown=0
    while IFS="${SEP}" read -r epoch label age name; do
      printf '  %-10s  %6s  %s\n' "${label}" "${age}" "${name}"
      shown=$((shown + 1))
      if [[ "${shown}" -ge "${TOP_N}" ]]; then
        break
      fi
    done <"${bucket}.sorted"
    if [[ "${count}" -gt "${TOP_N}" ]]; then
      printf '  ... %s more not listed\n' "$((count - TOP_N))"
    fi
  fi
  printf '\n'
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "${1}" in
      --notes-dir)
        require_value "${1}" "${2:-}"
        NOTES_DIR="${2}"
        shift 2
        ;;
      --threshold-days)
        require_value "${1}" "${2:-}"
        require_count "${1}" "${2}"
        THRESHOLD_DAYS="${2}"
        shift 2
        ;;
      --top)
        require_value "${1}" "${2:-}"
        require_count "${1}" "${2}"
        TOP_N="${2}"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf 'ERROR: unknown argument: %s\n' "${1}" >&2
        usage
        exit 2
        ;;
    esac
  done
}

# One awk pass over the whole corpus: a per-file fork costs more than the scan itself.
collect_fields() {
  local notes=() note
  find "${NOTES_DIR}" -maxdepth 1 -type f -name '*.md' | sort >"${WORK_DIR}/notes.list"
  while IFS= read -r note; do
    notes+=("${note}")
  done <"${WORK_DIR}/notes.list"

  # Bash 3.2 expands an empty array as unbound under `set -u`, so an empty corpus skips the pass.
  if [[ "${#notes[@]}" -eq 0 ]]; then
    return 0
  fi
  awk -v sep="${SEP}" '
    function flush() { if (cur != "") { printf "%s%s%s%s%s\n", cur, sep, updated, sep, created } }
    FNR == 1 { flush(); seen[FILENAME]; cur = FILENAME; updated = ""; created = ""; fm = ($0 == "---") ? 1 : 0; next }
    fm && $0 == "---" { fm = 0; next }
    fm && sub(/^updated:[[:space:]]*/, "") { updated = $0; sub(/[[:space:]]+$/, "", updated); next }
    fm && sub(/^created:[[:space:]]*/, "") { created = $0; sub(/[[:space:]]+$/, "", created); next }
    # awk never fires FNR==1 on a zero-byte note, so such a file emits no row and would drop out of
    # every bucket and count. Re-add the unseen paths with empty date fields — they then take the
    # mtime fallback, the same route as any note carrying no date field.
    END { flush(); for (i = 1; i < ARGC; i++) { if (!(ARGV[i] in seen)) { printf "%s%s%s\n", ARGV[i], sep, sep } } }
  ' "${notes[@]}" >"${WORK_DIR}/fields"
}

classify_notes() {
  local now path updated created name field epoch age
  now="$(date '+%s')"
  while IFS="${SEP}" read -r path updated created; do
    name="${path##*/}"
    field="${updated}"
    if [[ -z "${field}" ]]; then
      field="${created}"
    fi
    if [[ -n "${field}" ]]; then
      epoch="$(epoch_of_ymd "${field}")"
      if [[ -z "${epoch}" ]]; then
        record "${WORK_DIR}/unknown" 0 '-' '-' "${name}"
        continue
      fi
      age=$(((now - epoch) / 86400))
      if [[ "${age}" -ge "${THRESHOLD_DAYS}" ]]; then
        record "${WORK_DIR}/stale" "${epoch}" "${field}" "${age}d" "${name}"
      fi
      continue
    fi
    epoch="$(epoch_of_mtime "${path}")"
    if [[ -z "${epoch}" ]]; then
      record "${WORK_DIR}/unknown" 0 '-' '-' "${name}"
      continue
    fi
    age=$(((now - epoch) / 86400))
    if [[ "${age}" -ge "${THRESHOLD_DAYS}" ]]; then
      record "${WORK_DIR}/mtime" "${epoch}" 'mtime' "${age}d" "${name}"
    fi
  done <"${WORK_DIR}/fields"
}

main() {
  parse_args "$@"

  if [[ ! -d "${NOTES_DIR}" ]]; then
    printf 'ERROR: notes directory not found: %s\n' "${NOTES_DIR}" >&2
    exit 3
  fi

  WORK_DIR="$(mktemp -d -t wiki-staleness.XXXXXX)"
  : >"${WORK_DIR}/fields"
  : >"${WORK_DIR}/stale"
  : >"${WORK_DIR}/mtime"
  : >"${WORK_DIR}/unknown"

  printf 'wiki staleness | notes: %s | threshold: %s days | up to %s oldest per bucket\n\n' \
    "${NOTES_DIR}" "${THRESHOLD_DAYS}" "${TOP_N}"

  collect_fields
  classify_notes

  report_bucket "Stale (>= ${THRESHOLD_DAYS} days)" "${WORK_DIR}/stale"
  report_bucket 'mtime-derived (no date field, low confidence)' "${WORK_DIR}/mtime"
  report_bucket 'unknown age (date field will not parse)' "${WORK_DIR}/unknown"
}

main "$@"
