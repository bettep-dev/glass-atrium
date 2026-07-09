#!/usr/bin/env bash
# T0 comment/code classifier + canonical-baseline emitter (Track B stage 0).
# Classifies each line of a .sh/.bats/.ts file as comment / code / blank and tags the
# four preserve counters (shellcheck / SECURITY / extref / banner). The line state
# machine lives in the sibling classify.awk — a lexer-lite (not naive full-line-hash
# counting) so shell param-expansion hashes, heredoc bodies, and in-string # / // / /*
# are NOT miscounted as comments. This is the single-classifier authority every
# reduction batch measures its before/after delta against (plan §7, D3).
#
# Usage:
#   comment-classifier.sh classify FILE [FILE...]   # one TSV row per file to stdout
#   comment-classifier.sh baseline [--out PATH]     # emit the canonical baseline artifact
#
# TSV columns: path comment_lines code_lines ratio shellcheck_count security_count extref_count banner_count
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly AWK_PROG="${SCRIPT_DIR}/classify.awk"
readonly DEFAULT_OUT="${SCRIPT_DIR}/canonical-baseline.tsv"

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# Classify one file; the label string is written verbatim into the row's path column.
classify_file() {
  local file="$1" label="$2" mode
  case "${file}" in
    *.ts) mode="ts" ;;
    *) mode="shell" ;;
  esac
  awk -v path="${label}" -v mode="${mode}" -f "${AWK_PROG}" "${file}"
}

tsv_header() {
  printf 'path\tcomment_lines\tcode_lines\tratio\tshellcheck_count\tsecurity_count\textref_count\tbanner_count\n'
}

# The corrected D3 in-scope surface (plan §2 ledger): 94 shell + 31 bats + 54 TS = 179.
# lib/ga-tui-*.sh and the launcher are Track A; scripts/agent_lifecycle is pure Python
# (Non-Goal); monitor/src/generated/prisma is Prisma-generated — all excluded. Emits
# paths relative to REPO_ROOT (the caller cd's there first).
build_surface() {
  local f
  for f in lib/ga-*.sh; do
    [[ "${f}" == lib/ga-tui-* ]] && continue
    printf '%s\n' "${f}"
  done
  for f in hooks/*.sh; do printf '%s\n' "${f}"; done
  for f in hooks/lib/*.sh; do printf '%s\n' "${f}"; done
  for f in scripts/*.sh; do printf '%s\n' "${f}"; done
  for f in scripts/lib/*.sh; do printf '%s\n' "${f}"; done
  printf '%s\n' 'monitor/scripts/oss-db-setup.sh'
  printf '%s\n' 'build-glass-atrium.sh' 'install.sh'
  for f in hooks/test/*.bats; do printf '%s\n' "${f}"; done
  for f in scripts/test/*.bats; do printf '%s\n' "${f}"; done
  find monitor/src/server -name '*.ts' ! -name '*.d.ts' ! -name '*.spec.ts' | LC_ALL=C sort
}

cmd_classify() {
  local file
  for file in "$@"; do
    classify_file "${file}" "${file}"
  done
}

cmd_baseline() {
  local out="${DEFAULT_OUT}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out)
        out="$2"
        shift 2
        ;;
      *)
        echo "unknown baseline arg: $1" >&2
        return 2
        ;;
    esac
  done

  local tmp list
  tmp="$(mktemp -t comment-baseline.XXXXXX)"
  list="$(mktemp -t comment-surface.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -f -- '${tmp}' '${list}'" RETURN

  local rel
  (cd -- "${REPO_ROOT}" && build_surface) >"${list}"
  {
    tsv_header
    while IFS= read -r rel; do
      [[ -z "${rel}" ]] && continue
      classify_file "${REPO_ROOT}/${rel}" "${rel}"
    done <"${list}"
  } >"${tmp}"

  # Aggregate from the emitted integer columns only (never grep -c — so no empty-string
  # coercion and no grep-count-of-zero double-line trap; §7 preserve-count zero-safety).
  local summary
  summary="$(awk -F'\t' '
    NR == 1 { next }
    {
      files++; C += $2; K += $3; SC += $5; SEC += $6; XR += $7; BN += $8
      if ($1 ~ /\.bats$/) { bfiles++; bC += $2; bK += $3 }
      else if ($1 ~ /\.ts$/) { tfiles++; tC += $2; tK += $3 }
      else { sfiles++; sC += $2; sK += $3 }
    }
    END {
      printf "TOTAL\t%d\t%d\t%s\t%d\t%d\t%d\t%d\tfiles=%d\n", C, K, (K==0?"comment-only":sprintf("%.4f", C/K)), SC, SEC, XR, BN, files
      printf "SHELL\t%d\t%d\t%s\tfiles=%d\n", sC, sK, (sK==0?"comment-only":sprintf("%.4f", sC/sK)), sfiles
      printf "BATS\t%d\t%d\t%s\tfiles=%d\n", bC, bK, (bK==0?"comment-only":sprintf("%.4f", bC/bK)), bfiles
      printf "TS\t%d\t%d\t%s\tfiles=%d\n", tC, tK, (tK==0?"comment-only":sprintf("%.4f", tC/tK)), tfiles
    }
  ' "${tmp}")"

  # Artifact = header + per-file rows + the aggregate TOTAL row (batches consume this).
  local total_row
  total_row="$(printf '%s\n' "${summary}" | awk -F'\t' 'NR==1')"
  {
    cat -- "${tmp}"
    printf '%s\n' "${total_row}"
  } >"${out}"

  printf 'Canonical baseline emitted: %s\n' "${out}" >&2
  printf '%s\n' "${summary}" >&2
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift
  case "${sub}" in
    classify) cmd_classify "$@" ;;
    baseline) cmd_baseline "$@" ;;
    *)
      echo "usage: comment-classifier.sh {classify FILE... | baseline [--out PATH]}" >&2
      return 2
      ;;
  esac
}

main "$@"
