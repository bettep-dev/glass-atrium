#!/usr/bin/env bats
# CI paths-filter docs coverage — markdown/rule-only PRs must still run the bash
# leg, because the four drift-guard bats suites that assert rules/ content live
# under hooks/test and would otherwise never run on the very change kind they
# police.
#
# Run via: bats test/ci-paths-filter-docs.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Content anchors only — no line-number slices: the filter block shifts on any
# unrelated edit above it, which would silently pass or fail for the wrong
# reason.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
CI_YML="${GA}/.github/workflows/ci.yml"

setup() {
  [[ -f "${CI_YML}" ]] || skip "workflow not found: ${CI_YML}"
}

# Extracts the `bash:` filter body from the `filters: |` literal block — the
# range ends at `python:` so a pattern living in another filter cannot pass.
bash_filter_body() {
  awk '/^[[:space:]]+bash:[[:space:]]*$/ {inside=1; next} /^[[:space:]]+python:[[:space:]]*$/ {inside=0} inside' "${CI_YML}"
}

@test "bash filter covers rules/, agents/, scoped/, skills/ and all markdown" {
  local body pattern
  body="$(bash_filter_body)"
  [[ -n "${body}" ]]
  for pattern in 'rules/\*\*' 'agents/\*\*' 'scoped/\*\*' 'skills/\*\*' '\*\*/\*\.md'; do
    printf '%s\n' "${body}" | grep -qE "^[[:space:]]*- '${pattern}'\$"
  done
}

@test "bash filter output still has a consuming job" {
  grep -q "if: needs.detect-changes.outputs.bash" "${CI_YML}"
}

@test "no predicate-quantifier key is set (every would AND positive-only lists)" {
  ! grep -qE "^[[:space:]]*predicate-quantifier:" "${CI_YML}"
}
