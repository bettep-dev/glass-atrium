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
  # A pin target that VANISHED is the most complete form of the drift this suite exists to
  # catch, and `skip` is exactly the wrong answer to it: bats scores a skip as `ok` and the run
  # still exits 0, so a deleted or moved pin target would make this suite go quiet and green.
  # Every path below is one the repository always ships, so its absence is drift and FAILS.
  [[ -f "${INJECTOR}" ]] || {
    printf 'injector absent: %s — the repository always ships it, so this is drift, not an optional dependency\n' \
      "${INJECTOR}" >&2
    return 1
  }
  [[ -f "${ROSTER_LIB}" ]] || {
    printf 'roster library absent: %s — the repository always ships it, so this is drift, not an optional dependency\n' \
      "${ROSTER_LIB}" >&2
    return 1
  }
  [[ -f "${MATRIX}" ]] || {
    printf 'compliance matrix absent: %s — the repository always ships it, so this is drift, not an optional dependency\n' \
      "${MATRIX}" >&2
    return 1
  }
}

# Roster prefixes declared in code, one per line (both declaration sites).
roster_prefixes() {
  sed -n 's/^readonly \([A-Z_][A-Z0-9_]*\)_AGENTS=.*/\1/p' "${INJECTOR}" "${ROSTER_LIB}"
}

# Every roster the two declaration sites are expected to carry. A NAME list, never a count: a
# count needs a hand edit on any change and names nothing when it breaks, whereas a name that
# vanishes from code names itself in the failure. Retiring a roster is a deliberate edit HERE, in
# the same change that retires its injected block — never a silent shrink of the declaration set.
# Adding a roster does not belong here: C3 already binds a new one to the matrix.
EXPECTED_ROSTERS='INJECT
MINIMALISM
NAMING
PLAN_GATE
BUDGET_DEV
BUDGET_ANALYSIS
WIKI_UNTRUSTED
STYLEREF'

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
  # NO numeric floor. A hand-maintained count of a set this suite already enumerates FROM CODE
  # fails on a legitimate retirement rather than on a defect, and stays green while a roster
  # disappears as long as the total happens to hold. What gates instead is per-NAME presence:
  # each declaration site contributes, and every expected roster is still declared somewhere.
  local from_injector from_lib declared prefix missing=""
  from_injector="$(sed -n 's/^readonly \([A-Z_][A-Z0-9_]*\)_AGENTS=.*/\1/p' "${INJECTOR}" | wc -l | tr -d ' ')"
  from_lib="$(sed -n 's/^readonly \([A-Z_][A-Z0-9_]*\)_AGENTS=.*/\1/p' "${ROSTER_LIB}" | wc -l | tr -d ' ')"
  [[ "${from_injector}" -ge 1 ]] || {
    printf 'no roster declared in %s — the scan lost the injector declaration site\n' "${INJECTOR}" >&2
    return 1
  }
  # STYLEREF moved out of the injector: a zero here means the scan lost a declaration site.
  [[ "${from_lib}" -ge 1 ]] || {
    printf 'no roster declared in %s — the scan lost the roster-lib declaration site\n' "${ROSTER_LIB}" >&2
    return 1
  }
  declared="$(roster_prefixes)"
  while IFS= read -r prefix; do
    [[ -n "${prefix}" ]] || continue
    printf '%s\n' "${declared}" | grep -qx -- "${prefix}" || missing="${missing} ${prefix}"
  done <<EOF
${EXPECTED_ROSTERS}
EOF
  [[ -z "${missing}" ]] || {
    printf 'expected roster declared nowhere in %s nor %s:%s\n' "${INJECTOR}" "${ROSTER_LIB}" "${missing}" >&2
    printf -- '--- declared ---\n%s\n' "${declared}" >&2
    return 1
  }
}

@test "C1b every enumerated roster prefix is non-empty" {
  # The enumeration is a `sed` capture, so a declaration-syntax change could yield blank lines
  # that C3 would skip silently — leaving it iterating fewer rosters than the code declares and
  # still green. Assert the capture itself before trusting what it produced.
  local prefix count=0
  while IFS= read -r prefix; do
    [[ -n "${prefix}" ]] || {
      printf 'roster enumeration produced an empty prefix — the capture is broken\n' >&2
      return 1
    }
    count=$((count + 1))
  done < <(roster_prefixes)
  [[ "${count}" -ge 1 ]]
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
