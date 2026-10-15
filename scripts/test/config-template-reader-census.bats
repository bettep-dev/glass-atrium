#!/usr/bin/env bats
# config-template-reader-census.bats — every config.toml.example key has a reader, or an exemption.
#
# The template's own header forbids exposing a key with zero consumers, and the template kept
# violating it because nothing compared the declared key set against the code that reads it. This
# suite is that comparison: the census file carries one row per key, and every row must name a real
# reader — the backlog that once justified readerless rows cleared, so a new readerless key must be
# wired, not parked behind a fresh backlog id.
#
# Each row asserts a property the others cannot produce:
#   AC1  coverage           -> every template key has exactly one census row
#   AC3  reader integrity   -> a claimed reader file exists and still carries its anchor literal
#                              (on an install, only readers manifest.json ships are checked)
#   AC5  exemption scope    -> no exemptions remain; every key names a real reader
#        no orphan row      -> every census row names a key the template still declares
#        daemon stanzas     -> the [daemon.*] stanzas are exactly the active launchd roster, the set the
#                              plist renderer reads; a retired job's stanza has no reader, which AC3's
#                              per-job anchor literal cannot see
#
# Anchor scope is the TEMPLATE file only: monitor test fixtures synthesize config.toml bodies of
# their own, and pulling those into scope would red this suite on an unrelated file's fixture.
#
# BATS GATING NOTE (measured on bash 3.2.57 / 4.4.23 / 5.0.18 / 5.3.15 — bash is the variable, not
# bats): @test bodies run under errexit, but a bare non-final `[[ ]]` / `(( ))` does NOT gate on macOS
# bash 3.2.57 and DOES gate from bash 4.4 onward, CI's bash 5.3.9 included — whereas `[ ]`, `let`, a
# plain command and any final command gate on EVERY version.
# Every assertion here `return 1`s on mismatch, so each fails the test independently on every version.
#
# Run via: bats scripts/test/config-template-reader-census.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
LIB="${GA}/scripts/lib/atrium-config.sh"
TEMPLATE="${GA}/config.toml.example"
CENSUS="${BATS_TEST_DIRNAME}/config-template-reader-census.psv"

setup() {
  [[ -f "${LIB}" ]] || skip "atrium-config.sh not found: ${LIB}"
  [[ -f "${TEMPLATE}" ]] || skip "config template not found: ${TEMPLATE}"
  [[ -f "${CENSUS}" ]] || skip "census not found: ${CENSUS}"
}

# The template's declared keys, one `<section>|<key>` pair per line.
template_pairs() {
  bash -c 'source "$1"; atrium_toml_keys "$2"' _ "${LIB}" "${TEMPLATE}" | tr '\t' '|'
}

# The census rows, comments and blank lines dropped.
census_rows() {
  grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' -- "${CENSUS}" || true
}

@test "AC1 every template key has exactly one census row" {
  local pair hits rows missing=""
  rows="$(census_rows)"
  while IFS= read -r pair; do
    [[ -n "${pair}" ]] || continue
    hits="$(printf '%s\n' "${rows}" | grep -c -F -- "${pair}|" || true)"
    [[ "${hits}" -eq 1 ]] || missing="${missing}${missing:+, }${pair}(rows=${hits})"
  done < <(template_pairs)
  [[ -z "${missing}" ]] || {
    echo "template keys without exactly one census row: ${missing}" >&2
    return 1
  }
}

@test "AC3 a claimed reader file exists and still carries its anchor literal" {
  local broken="" top="" root=""
  # GA's own toplevel, never BATS_TEST_DIRNAME's → an install's scripts/test/ is its own repo
  top="$(git -C "${GA}" rev-parse --show-toplevel 2>/dev/null || true)"
  root="$(cd -P -- "${GA}" && pwd)"
  while IFS='|' read -r section key reader anchor _exempt; do
    [[ -n "${reader}" ]] || continue
    [[ "${top}" == "${root}" ]] \
      || jq -e --arg p "${reader}" '.files | index($p)' "${GA}/manifest.json" >/dev/null 2>&1 \
      || continue
    if [[ ! -f "${GA}/${reader}" ]]; then
      broken="${broken}${broken:+, }${section}.${key}(no ${reader})"
      continue
    fi
    [[ -n "${anchor}" ]] || {
      broken="${broken}${broken:+, }${section}.${key}(no anchor)"
      continue
    }
    grep -q -F -- "${anchor}" "${GA}/${reader}" \
      || broken="${broken}${broken:+, }${section}.${key}(anchor gone from ${reader})"
  done < <(census_rows)
  [[ -z "${broken}" ]] || {
    echo "census reader claims that no longer hold: ${broken}" >&2
    return 1
  }
}

# The exemption column existed for keys the template exposed before anything read them.
# The backlog cleared, so the population is now EMPTY — and staying empty is the property
# worth pinning: a new readerless key must be wired, not parked behind a fresh backlog id.
@test "AC5 no exemptions remain: every template key names a real reader" {
  local exemptions=""
  while IFS='|' read -r section key reader _anchor exempt; do
    [[ -n "${section}" ]] || continue
    [[ -z "${reader}" ]] || continue
    exemptions="${exemptions}${exemptions:+, }${section}.${key}->${exempt}"
  done < <(census_rows)
  [[ -z "${exemptions}" ]] || {
    echo "readerless census rows remain: '${exemptions}'" >&2
    return 1
  }
}

@test "every census row names a key the template still declares" {
  local pairs orphans=""
  pairs="$(template_pairs)"
  while IFS='|' read -r section key _reader _anchor _exempt; do
    [[ -n "${section}" ]] || continue
    grep -qxF -- "${section}|${key}" <<<"${pairs}" || orphans="${orphans}${orphans:+, }${section}.${key}"
  done < <(census_rows)
  [[ -z "${orphans}" ]] || {
    echo "census rows for keys the template no longer declares: ${orphans}" >&2
    return 1
  }
}

@test "the template's [daemon.*] stanzas are exactly the active launchd roster" {
  local declared active
  declared="$(template_pairs | sed -n 's/^\[daemon\.\([^]]*\)\]|.*/\1/p' | LC_ALL=C sort -u)"
  active="$(bash -c 'set -u; source "$1/lib/ga-env.sh" && ga_init_env "$1" >/dev/null 2>&1 \
    && printf "%s\n" "${LAUNCHD_JOBS[@]}"' _ "${GA}" | LC_ALL=C sort -u)" || active=""
  [[ -n "${active}" && "${declared}" == "${active}" ]] || {
    printf 'template [daemon.*] stanzas:\n%s\nLAUNCHD_JOBS:\n%s\n' "${declared}" "${active}" >&2
    return 1
  }
}
