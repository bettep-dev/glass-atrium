#!/usr/bin/env bash
# inject-scope-part-10.sh — the SubagentStart slot that carries part 10 of the split
# scope-rule channel. One basename per part; slot 1 of the twelve is inject-scope-rules.sh,
# which carries the kept marker blocks and no part.
#
# WHY THE PART INDEX IS IN THE BASENAME: a binding row is event/basename/matcher
# (lib/ga-env.sh -> EXPECTED_HOOK_BINDINGS) and carries no argument field, so there is no seam
# an index could travel through. The basename IS the bound command wire_hooks emits, so the
# name this file reads at runtime is the name the binding names — a rename yields no digits
# and is reported as a seam fault, never a silently wrong part.
#
# WHY THIS FILE IS A SHIM: selection, packing, counting and every constant live in
# lib/inject-chunk.sh and lib/inject_chunk.py, so all twelve slots compute one plan from one
# copy. The abort logger below is the single sanctioned duplication — it has to work in the
# state where the library does not load, so it cannot come from the library.
set -Eeuo pipefail
IFS=$'\n\t'
# Installed BEFORE the source: a spawn that loses its scope rules is survivable, a spawn its
# own hook kills is not.
trap 'exit 0' ERR

# Record a load abort on the sink the library and the core share. Claude Code DISCARDS
# SubagentStart hook stderr, so a stderr-only abort leaves no trace of a slot that ran and
# delivered nothing. Externals stay behind guards: on a broken PATH this must still append.
_ga_slot_fail() {
  local sink detail="${1}" stamp
  sink="${GA_CHUNK_SINK:-${GA_CHUNK_RULES_ROOT:-${HOME}/.glass-atrium}/logs/inject-scope-chunk.diag.log}"
  printf '[inject-scope-chunk] SEAMFAULT agent=unknown %s\n' "${detail}" >&2
  [[ -d "${sink%/*}" ]] || mkdir -p "${sink%/*}" 2>/dev/null || return 0
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  printf '%s [inject-scope-chunk] SEAMFAULT agent=unknown %s\n' "${stamp}" "${detail}" >>"${sink}" 2>/dev/null || true
  return 0
}

_ga_chunk_lib="${BASH_SOURCE[0]%/*}/lib/inject-chunk.sh"
if [[ ! -r "${_ga_chunk_lib}" ]]; then
  _ga_slot_fail "library unreadable: ${_ga_chunk_lib}; slot skipped (part=10)"
  exit 0
fi
# shellcheck source-path=SCRIPTDIR source=lib/inject-chunk.sh
source "${_ga_chunk_lib}" || {
  _ga_slot_fail "library source failed: ${_ga_chunk_lib}; slot skipped (part=10)"
  exit 0
}

ga_chunk_inject
