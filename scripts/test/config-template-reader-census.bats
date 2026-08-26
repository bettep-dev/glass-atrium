#!/usr/bin/env bats
# config-template-reader-census.bats — every config.toml.example key has a reader, or an exemption.
#
# The template's own header forbids exposing a key with zero consumers, and the template kept
# violating it because nothing compared the declared key set against the code that reads it. This
# suite is that comparison: the census file carries one row per key, and a key may be readerless
# ONLY behind a backlog id naming the item that will wire it — which is what stops the exemption
# column from becoming a silent pass for dead keys.
#
# Each row asserts a property the others cannot produce:
#   AC1  coverage           -> every template key has exactly one census row
#   AC2  no fossils         -> every census row names a key the template still declares
#   AC3  reader integrity   -> a claimed reader file exists and still carries its anchor literal
#   AC4  exemption integrity-> a readerless row carries a `G-<n>` backlog id, never a blank
#   AC5  exemption scope    -> exactly one exemption, and it is [paths].backup_dir -> G-05
#
# Anchor scope is the TEMPLATE file only: monitor test fixtures synthesize config.toml bodies of
# their own, and pulling those into scope would red this suite on an unrelated file's fixture.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict — every assertion here
# `return 1`s on mismatch so each fails the test independently.
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

@test "AC2 every census row names a key the template still declares" {
  local row pairs fossils=""
  pairs="$(template_pairs)"
  while IFS='|' read -r section key _reader _anchor _exempt; do
    [[ -n "${section}" ]] || continue
    printf '%s\n' "${pairs}" | grep -q -x -F -- "${section}|${key}" \
      || fossils="${fossils}${fossils:+, }${section}.${key}"
  done < <(census_rows)
  [[ -z "${fossils}" ]] || {
    echo "census rows for keys the template no longer declares: ${fossils}" >&2
    return 1
  }
}

@test "AC3 a claimed reader file exists and still carries its anchor literal" {
  local broken=""
  while IFS='|' read -r section key reader anchor _exempt; do
    [[ -n "${reader}" ]] || continue
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

@test "AC4 a readerless row carries a G-<n> backlog id, never a blank" {
  local blanks=""
  while IFS='|' read -r section key reader _anchor exempt; do
    [[ -n "${section}" ]] || continue
    [[ -z "${reader}" ]] || continue
    [[ "${exempt}" =~ ^G-[0-9]+$ ]] || blanks="${blanks}${blanks:+, }${section}.${key}(id='${exempt}')"
  done < <(census_rows)
  [[ -z "${blanks}" ]] || {
    echo "readerless census rows without a backlog id: ${blanks}" >&2
    return 1
  }
}

@test "AC5 exactly one exemption, and it is [paths].backup_dir -> G-05" {
  local exemptions=""
  while IFS='|' read -r section key reader _anchor exempt; do
    [[ -n "${section}" ]] || continue
    [[ -z "${reader}" ]] || continue
    exemptions="${exemptions}${exemptions:+, }${section}.${key}->${exempt}"
  done < <(census_rows)
  [[ "${exemptions}" == "[paths].backup_dir->G-05" ]] || {
    echo "exemption population is not the single planned row: '${exemptions}'" >&2
    return 1
  }
}
