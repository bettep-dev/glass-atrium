#!/usr/bin/env bash
# ga-split-verify.sh — byte-identity verifier for the launcher module split
# (Track A stage 2). Reusable across split waves 1-4.
#
# Proves that every top-level function's definition block survives a module split
# byte-for-byte, whether it now lives in the loader (glass-atrium) or a sibling
# (lib/ga-tui-*.sh). Two independent proofs are provided:
#   * source-text hash  (`hash-all`)  — extract each `name() { ... }` block via awk
#                        and sha256 it. Extraction-uniform, so a consistent awk
#                        normalization applies identically to baseline + post.
#   * per-fn definition   (extract)    — dump one block for manual inspection.
#
# The single-line one-liner form (`name() { ...; }`) is detected by a trailing `}`
# so it is captured on ONE line (never over-run to the next `^}` like a naive
# matcher). The hash is taken through a PIPE, never `$(...)`, so a one-liner's
# trailing newline is not stripped (the newline-artifact trap).
#
# Pure bash 3.2 + awk + shasum (BSD/macOS). No GNU coreutils.
# shellcheck disable=SC2312  # the extract_fn|_hash pipes deliberately consume the piped output AS the value (the sha256); masking the pipe exit is the design
set -Eeuo pipefail
IFS=$'\n\t'

usage() {
  cat >&2 <<'EOF'
usage:
  ga-split-verify.sh names   <file>              list every top-level fn name
  ga-split-verify.sh extract <file> <name>       print one fn definition block
  ga-split-verify.sh hash-all <namesfile> <file>...   name<TAB>sha256<TAB>srcfile
  ga-split-verify.sh verify  <baseline-hashfile> <file>...   compare + report
EOF
  exit 2
}

# extract_fn <file> <name> — print the exact `name() { ... }` block (empty if absent).
# Multi-line: from `^name() {` through the next `^}`. Single-line: the opener line
# alone when its last non-blank char is `}`.
extract_fn() {
  local file="$1" name="$2"
  awk -v fn="${name}" '
    !started && index($0, fn "() ") == 1 {
      started = 1
      print
      line = $0
      sub(/[ \t]+$/, "", line)
      if (substr(line, length(line), 1) == "}") { exit }
      next
    }
    started {
      print
      if ($0 == "}") { exit }
    }
  ' "${file}"
}

# names <file> — every top-level function name (from `^name() {`).
names() {
  grep -oE '^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{' "$1" | sed 's/() {//'
}

# _hash — sha256 of stdin via a pipe (a one-liner's trailing newline MUST survive).
_hash() { shasum -a 256 | awk '{ print $1 }'; }

# hash-all <namesfile> <file>... — for each name, locate its block in EXACTLY one
# of the given files (def-count==1 guard), hash it, emit `name<TAB>hash<TAB>file`.
# Missing/duplicate is emitted as a sentinel so `verify` can flag it.
hash_all() {
  local namesfile="$1"
  shift
  local name found_file found_count block f
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    found_file=""
    found_count=0
    for f in "$@"; do
      block="$(extract_fn "${f}" "${name}")"
      if [[ -n "${block}" ]]; then
        found_file="${f}"
        found_count=$((found_count + 1))
      fi
    done
    if [[ "${found_count}" -eq 0 ]]; then
      printf '%s\t%s\t%s\n' "${name}" "MISSING" "-"
    elif [[ "${found_count}" -gt 1 ]]; then
      printf '%s\t%s\t%s\n' "${name}" "DUPLICATE" "${found_count}files"
    else
      printf '%s\t%s\t%s\n' "${name}" "$(extract_fn "${found_file}" "${name}" | _hash)" "${found_file}"
    fi
  done <"${namesfile}"
}

# verify <baseline-hashfile> <file>... — compare each baseline name/hash against the
# post-split tree. Exit 0 only when ALL match AND none missing/duplicate.
verify() {
  local baseline="$1"
  shift
  local name bhash rest phash block f found_count found_file
  local total=0 ok=0 mismatch=0 missing=0 dup=0
  while IFS=$'\t' read -r name bhash rest; do
    [[ -n "${name}" ]] || continue
    total=$((total + 1))
    found_count=0
    found_file=""
    for f in "$@"; do
      block="$(extract_fn "${f}" "${name}")"
      [[ -n "${block}" ]] && {
        found_count=$((found_count + 1))
        found_file="${f}"
      }
    done
    if [[ "${found_count}" -eq 0 ]]; then
      printf 'MISSING   %s (not in any post-split file)\n' "${name}"
      missing=$((missing + 1))
      continue
    fi
    if [[ "${found_count}" -gt 1 ]]; then
      printf 'DUPLICATE %s (defined in %s files — def-count!=1)\n' "${name}" "${found_count}"
      dup=$((dup + 1))
      continue
    fi
    phash="$(extract_fn "${found_file}" "${name}" | _hash)"
    if [[ "${phash}" == "${bhash}" ]]; then
      ok=$((ok + 1))
    else
      printf 'MISMATCH  %s  base=%s  post=%s  (%s)\n' "${name}" "${bhash:0:12}" "${phash:0:12}" "${found_file}"
      mismatch=$((mismatch + 1))
    fi
  done <"${baseline}"
  printf '\n== byte-identity: %s/%s identical · %s mismatch · %s missing · %s duplicate ==\n' \
    "${ok}" "${total}" "${mismatch}" "${missing}" "${dup}"
  [[ "${mismatch}" -eq 0 && "${missing}" -eq 0 && "${dup}" -eq 0 ]]
}

main() {
  [[ $# -ge 1 ]] || usage
  local mode="$1"
  shift
  case "${mode}" in
    names)
      [[ $# -eq 1 ]] || usage
      names "$1"
      ;;
    extract)
      [[ $# -eq 2 ]] || usage
      extract_fn "$1" "$2"
      ;;
    hash-all)
      [[ $# -ge 2 ]] || usage
      hash_all "$@"
      ;;
    verify)
      [[ $# -ge 2 ]] || usage
      verify "$@"
      ;;
    *) usage ;;
  esac
}

main "$@"
