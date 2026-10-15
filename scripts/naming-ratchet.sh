#!/usr/bin/env bash
# naming-ratchet.sh — blocks NEW id_title and incident_header findings of scripts/audit-test-smells.sh
# against a committed baseline that may shrink and never grow; the auditor itself stays advisory.
# Usage: naming-ratchet.sh [--root <dir>] [--base <rev>] [--write]
#
#   --root <dir>  repo root to scan; its scripts/naming-ratchet-baseline.txt is the baseline
#   --base <rev>  fail when the baseline holds an entry the baseline at merge-base(<rev>, HEAD) lacks;
#                 skipped without this flag, exempt when the merge base has no baseline
#   --write       create the baseline when absent, otherwise drop its stale entries — never add one
#
# Key = kind + finding text, never location, compared as a multiset. A stale entry never fails a
# run, so it permits that exact text until --write drops it.
# Exit: 0 no new finding, no growth · 1 a new finding or growth · 2 usage error · 3 IO/scope error
# (auditor failure, auditor output disagreeing with its summary, missing baseline, unresolvable base)
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly BASELINE_REL='scripts/naming-ratchet-baseline.txt'
# shellcheck source=lib/path-guard.sh
source "${SCRIPT_DIR}/lib/path-guard.sh"

root_dir=""
base_rev=""
write_mode=0
work_dir=""

cleanup() {
  # shellcheck disable=SC2310  # a refused path is a skipped delete, never an error
  if ga_guard_path "${work_dir}"; then rm -rf -- "${work_dir:?}"; fi
}
trap cleanup EXIT
trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

die() {
  printf 'ERROR: %s\n' "${1}" >&2
  exit "${2}"
}

usage() {
  printf '%s\n' \
    'Usage: naming-ratchet.sh [--root <dir>] [--base <rev>] [--write]' \
    '' \
    "  --root <dir>  repo root to scan; its ${BASELINE_REL} is the baseline" \
    '  --base <rev>  fail on baseline growth since merge-base(<rev>, HEAD)' \
    '  --write       create a missing baseline, else drop stale entries only' \
    '  -h, --help    this message' \
    '' \
    'Exit: 0 pass · 1 new finding or baseline growth · 2 usage error · 3 IO/scope error'
}

parse_args() {
  while (($# > 0)); do
    case "${1}" in
      --root | --base)
        [[ -n "${2:-}" ]] || die "${1} requires a value" 2
        if [[ "${1}" == --root ]]; then root_dir="${2}"; else base_rev="${2}"; fi
        shift 2
        ;;
      --write) write_mode=1 && shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf 'ERROR: unknown argument: %s\n' "${1}" >&2
        usage >&2
        exit 2
        ;;
    esac
  done
}

resolve_root() {
  if [[ -z "${root_dir}" ]]; then
    root_dir="${SCRIPT_DIR}/.."
  elif [[ ! -d "${root_dir}" ]]; then
    die "--root directory not found: ${root_dir}" 3
  fi
  root_dir="$(cd -- "${root_dir}" && pwd)"
}

# One `KIND detail` key per finding line; a line without the `location: ` separator is dropped, so a
# changed output format surfaces as a count mismatch rather than as a silently wrong key.
extract_keys() {
  LC_ALL=C awk '
    /^(ID_TITLE|INCIDENT_HEADER) / {
      kind = $1
      rest = substr($0, length(kind) + 1)
      sub(/^ +/, "", rest)
      cut = index(rest, ": ")
      if (!cut) next
      detail = substr(rest, cut + 2)
      sub(/[ \t]+$/, "", detail)
      print kind " " detail
    }' "${1}" | LC_ALL=C sort
}

# Exits 3 unless the parsed per-kind key counts equal the auditor's own summary counts.
check_counts() {
  local raw="${1}" keys="${2}" summary="" parsed=""
  local re='id_title=([0-9]+) incident_header=([0-9]+)$'
  summary="$(tail -n 1 "${raw}")"
  [[ "${summary}" =~ ${re} ]] || die "auditor summary line missing or unreadable: ${summary}" 3
  summary="id_title=${BASH_REMATCH[1]} incident_header=${BASH_REMATCH[2]}"
  parsed="$(LC_ALL=C awk '$1 == "ID_TITLE" { t++ } $1 == "INCIDENT_HEADER" { h++ }
    END { printf "id_title=%d incident_header=%d", t, h }' "${keys}")"
  if [[ "${parsed}" != "${summary}" ]]; then
    die "auditor output does not match its summary (parsed ${parsed}, summary ${summary})" 3
  fi
}

# Writes the sorted finding keys of the advisory scope run to $1.
scan_findings() {
  local out="${1}" raw="${work_dir}/auditor.out" rc=0
  bash "${SCRIPT_DIR}/audit-test-smells.sh" --root "${root_dir}" --advisory >"${raw}" || rc=$?
  ((rc == 0)) || die "audit-test-smells.sh exited ${rc}" 3
  extract_keys "${raw}" >"${out}"
  check_counts "${raw}" "${out}"
}

# Sorted, blank-free copy of baseline text read from stdin.
normalize_baseline() {
  sed '/^[[:space:]]*$/d' | LC_ALL=C sort
}

# Creates the baseline from the findings when absent; otherwise keeps only entries still found.
write_baseline() {
  local baseline="${1}" findings="${2}" next="${work_dir}/baseline.next"
  [[ -d "${baseline%/*}" ]] || die "baseline directory not found: ${baseline%/*}" 3
  if [[ -f "${baseline}" ]]; then
    normalize_baseline <"${baseline}" | LC_ALL=C comm -12 - "${findings}" >"${next}"
  else
    cp "${findings}" "${next}"
  fi
  cp "${next}" "${baseline}"
}

# Writes to $1 the baseline at merge-base(--base, HEAD); returns 1 when the check is skipped or exempt.
read_base_baseline() {
  local out="${1}" merge_base=""
  if [[ -z "${base_rev}" ]]; then
    printf 'NOTICE: growth check skipped — no --base given\n' >&2
    return 1
  fi
  merge_base="$(git -C "${root_dir}" merge-base "${base_rev}" HEAD 2>/dev/null)" \
    || die "cannot resolve the merge base of ${base_rev} and HEAD" 3
  if ! git -C "${root_dir}" cat-file -e "${merge_base}:${BASELINE_REL}" 2>/dev/null; then
    printf 'NOTICE: no baseline at merge base %s — the creating change is exempt\n' "${merge_base}" >&2
    return 1
  fi
  # shellcheck disable=SC2310  # pipefail carries a git, sed or sort failure into the || below
  git -C "${root_dir}" show "${merge_base}:${BASELINE_REL}" | normalize_baseline >"${out}" \
    || die "cannot read the baseline at merge base ${merge_base}" 3
}

count_lines() {
  LC_ALL=C awk 'END { print NR }' "${1}"
}

# Prints each line of $2 prefixed by the label $1.
report_lines() {
  local label="${1}" line=""
  while IFS= read -r line; do
    printf '%-6s %s\n' "${label}" "${line}"
  done <"${2}"
}

# Prints the summary line for the new, stale, grown, baseline and findings files, in that order.
summarize() {
  local new_n stale_n grown_n baseline_n findings_n
  new_n="$(count_lines "${1}")"
  stale_n="$(count_lines "${2}")"
  grown_n="$(count_lines "${3}")"
  baseline_n="$(count_lines "${4}")"
  findings_n="$(count_lines "${5}")"
  printf 'new=%d stale=%d grown=%d baseline=%d findings=%d\n' \
    "${new_n}" "${stale_n}" "${grown_n}" "${baseline_n}" "${findings_n}"
}

# Compares the findings against the baseline and the baseline against the merge base; exits 1 on
# a new finding or a grown entry.
compare() {
  local findings="${1}" current="${2}" new="${work_dir}/new" stale="${work_dir}/stale"
  local base="${work_dir}/base" grown="${work_dir}/grown" summary=""
  LC_ALL=C comm -23 "${findings}" "${current}" >"${new}"
  LC_ALL=C comm -13 "${findings}" "${current}" >"${stale}"
  : >"${grown}"
  # shellcheck disable=SC2310  # status 1 is the skipped or exempt check; a real failure exits 3 inside
  if read_base_baseline "${base}"; then
    LC_ALL=C comm -13 "${base}" "${current}" >"${grown}"
  fi
  report_lines NEW "${new}"
  report_lines STALE "${stale}"
  report_lines GROWN "${grown}"
  summary="$(summarize "${new}" "${stale}" "${grown}" "${current}" "${findings}")"
  printf '%s\n' "${summary}"
  if [[ -s "${new}" || -s "${grown}" ]]; then
    printf 'FAIL: %s — rephrase the new ID title or header line; the baseline never grows\n' "${summary}" >&2
    exit 1
  fi
}

main() {
  local findings="" current="" baseline=""
  parse_args "$@"
  resolve_root
  work_dir="$(mktemp -d)"
  findings="${work_dir}/findings"
  current="${work_dir}/baseline"
  baseline="${root_dir}/${BASELINE_REL}"
  scan_findings "${findings}"
  if ((write_mode == 1)); then
    write_baseline "${baseline}" "${findings}"
  fi
  [[ -f "${baseline}" ]] || die "baseline missing: ${baseline} — create it with --write" 3
  normalize_baseline <"${baseline}" >"${current}"
  compare "${findings}" "${current}"
}

main "$@"
