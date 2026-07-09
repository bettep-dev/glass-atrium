#!/usr/bin/env bash
# ga-split-extract.sh — mechanical function-mover for the launcher module split
# (Track A stage 2). Reusable across split waves 1-4.
#
# Given a loader file + a list of function names, copies each function's EXACT byte
# range (its `name() { ... }` block plus the contiguous `#` comment lines directly
# above it) into a sibling file and deletes it from the loader. A mechanical byte
# copy guarantees the moved body is byte-identical (proven by ga-split-verify.sh).
#
# Boundary rules (match the codebase — all defs are column-0 `name() {`):
#   * opener  = `^name() {`  (single-line form ends its line with `}`)
#   * end     = the opener line itself for a one-liner, else the next `^}` line
#   * comment = the run of `^[[:space:]]*#` lines immediately above the opener,
#               back to the first blank / non-comment line (a const-attached banner
#               therefore stays with its const, never travels with a function)
# One trailing blank line after each moved block is consumed from the loader so no
# double-blank seam is left behind.
#
# Usage:
#   ga-split-extract.sh <loader-in> <loader-out> <sibling-append> <name>...
#     loader-out      : reduced loader (loader-in minus the moved blocks) — WRITTEN
#     sibling-append  : moved blocks are APPENDED here (pre-create it with a header)
#
# Pure bash 3.2 + awk. No GNU coreutils. Emits a summary line to stderr.
set -Eeuo pipefail
IFS=$'\n\t'

[[ $# -ge 4 ]] || {
  printf 'usage: %s <loader-in> <loader-out> <sibling-append> <name>...\n' "${0##*/}" >&2
  exit 2
}

loader_in="$1"
loader_out="$2"
sibling_append="$3"
shift 3
targets="$*"

[[ -f "${loader_in}" ]] || {
  printf 'FATAL: loader-in not found: %s\n' "${loader_in}" >&2
  exit 3
}

# Single AWK pass: index every target's [comment_start .. end] range, then emit the
# moved blocks to the sibling stream and the surviving lines to the loader stream.
awk -v targets="${targets}" \
  -v sibling="${sibling_append}" \
  -v loaderout="${loader_out}" '
  BEGIN {
    ntok = split(targets, arr, " ")
    for (i = 1; i <= ntok; i++) tset[arr[i]] = 1
  }
  { line[NR] = $0 }
  END {
    total = NR
    moved = 0
    # index the move ranges
    for (i = 1; i <= total; i++) {
      L = line[i]
      if (L ~ /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{/) {
        nm = L
        sub(/\(\) \{.*/, "", nm)
        if (nm in tset) {
          start = i
          t = L
          sub(/[ \t]+$/, "", t)
          if (substr(t, length(t), 1) == "}") {
            endln = i
          } else {
            endln = 0
            for (j = i + 1; j <= total; j++) {
              if (line[j] == "}") { endln = j; break }
            }
            if (endln == 0) {
              printf "FATAL: no ^} terminator for %s (opener line %d)\n", nm, start > "/dev/stderr"
              exit 4
            }
          }
          cs = start
          for (j = start - 1; j >= 1; j--) {
            if (line[j] ~ /^[ \t]*#/) cs = j; else break
          }
          iscs[cs] = 1
          blockend[cs] = endln
          if (cs > lastcs) lastcs = cs
          # mark [cs..endln] removed from the loader
          for (k = cs; k <= endln; k++) removed[k] = 1
          # consume ONE trailing blank line (tidy seam)
          if (line[endln + 1] == "") removed[endln + 1] = 1
          moved++
        }
      }
    }
    if (moved != ntok) {
      printf "FATAL: matched %d of %d requested functions\n", moved, ntok > "/dev/stderr"
      exit 5
    }
    # emit moved blocks (in original file order) to the sibling, blank-separated —
    # NO trailing blank after the final block (the append target already ends with
    # a header separator, so the result ends on the last function`s `}` line).
    for (i = 1; i <= total; i++) {
      if (iscs[i]) {
        for (k = i; k <= blockend[i]; k++) print line[k] >> sibling
        if (i != lastcs) print "" >> sibling
      }
    }
    # emit surviving lines to the reduced loader
    for (i = 1; i <= total; i++) {
      if (!removed[i]) print line[i] > loaderout
    }
    printf "moved %d function(s) to %s\n", moved, sibling > "/dev/stderr"
  }
' "${loader_in}"
