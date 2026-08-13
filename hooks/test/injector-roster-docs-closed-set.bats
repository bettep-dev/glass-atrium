#!/usr/bin/env bats
# Docs↔code closed-set invariant for the SubagentStart injector rosters.
#
# The injector's roster set is a CLOSED, curated allowlist and the compliance matrix is its
# governance record — a roster that exists in code but is named nowhere in the matrix makes the
# matrix silently under-report the injection surface. This suite enumerates the roster
# declarations FROM CODE (both declaration sites) and asserts each one is named in the matrix.
#
# Membership only: deliberately distinct from the marker-presence suites, which assert that the
# AGENT-INJECT blocks exist in their source files — not that the matrix documents the rosters.
#
# Run via: bats hooks/test/injector-roster-docs-closed-set.bats

INJECTOR="${BATS_TEST_DIRNAME}/../inject-scope-rules.sh"
ROSTER_LIB="${BATS_TEST_DIRNAME}/../lib/styleref-roster.sh"
MATRIX="${BATS_TEST_DIRNAME}/../../rules/glass-atrium/core-compliance-matrix.md"

setup() {
  [[ -f "${INJECTOR}" ]] || skip "injector not found: ${INJECTOR}"
  [[ -f "${ROSTER_LIB}" ]] || skip "roster library not found: ${ROSTER_LIB}"
  [[ -f "${MATRIX}" ]] || skip "compliance matrix not found: ${MATRIX}"
}

# Roster prefixes declared in code, one per line (both declaration sites).
roster_prefixes() {
  sed -n 's/^readonly \([A-Z_][A-Z0-9_]*\)_AGENTS=.*/\1/p' "${INJECTOR}" "${ROSTER_LIB}"
}

# The AGENT-INJECT block name owned by a roster, read from its marker constant. The
# comment-logging roster owns the plain marker (no prefix), every other roster a distinct one.
get_marker_block() {
  local prefix="$1" name
  name="$(sed -n "s/^readonly ${prefix}_MARKER_START='<!-- \\(AGENT-INJECT[A-Z:-]*\\):START -->'.*/\\1/p" "${INJECTOR}")"
  [[ -n "${name}" ]] ||
    name="$(sed -n "s/^readonly MARKER_START='<!-- \\(AGENT-INJECT[A-Z:-]*\\):START -->'.*/\\1/p" "${INJECTOR}")"
  printf '%s\n' "${name}"
}

# A roster is mirrored when the matrix names either its variable or its block.
matrix_names_roster() {
  local prefix="$1" block
  grep -qF -- "${prefix}_AGENTS" "${MATRIX}" && return 0
  block="$(get_marker_block "${prefix}")"
  [[ -n "${block}" ]] && grep -qF -- "${block}" "${MATRIX}"
}

@test "C0 setup_suite discovery sentinel is exported" {
  [[ "${GA_BATS_SUITE_SETUP:-}" == "1" ]]
}

@test "C1 the closed set is enumerated from both declaration sites" {
  local from_injector from_lib
  from_injector="$(sed -n 's/^readonly \([A-Z_][A-Z0-9_]*\)_AGENTS=.*/\1/p' "${INJECTOR}" | wc -l | tr -d ' ')"
  from_lib="$(sed -n 's/^readonly \([A-Z_][A-Z0-9_]*\)_AGENTS=.*/\1/p' "${ROSTER_LIB}" | wc -l | tr -d ' ')"
  [[ "${from_injector}" -ge 6 ]] || return 1
  # STYLEREF moved out of the injector: a zero here means the scan lost a declaration site.
  [[ "${from_lib}" -ge 1 ]] || return 1
  roster_prefixes | grep -qx 'STYLEREF'
}

@test "C2 already-reconciled pair pre-check: STYLEREF is single-sited and mirrored" {
  # Per-pair existing-owner check — a pair whose ownership is already reconciled is asserted
  # here, not re-added as a second pair to the closed-set assertion below.
  grep -q '^readonly STYLEREF_AGENTS=' "${ROSTER_LIB}" || return 1
  grep -q '^readonly STYLEREF_AGENTS=' "${INJECTOR}" && return 1
  matrix_names_roster "STYLEREF"
}

@test "C3 every roster declared in code is named in the compliance matrix" {
  local unmirrored="" prefix
  while IFS= read -r prefix; do
    [[ -n "${prefix}" ]] || continue
    matrix_names_roster "${prefix}" || unmirrored="${unmirrored} ${prefix}"
  done < <(roster_prefixes)
  [[ -z "${unmirrored}" ]] || {
    printf 'rosters declared in code but named nowhere in %s:%s\n' "${MATRIX}" "${unmirrored}" >&2
    return 1
  }
}
