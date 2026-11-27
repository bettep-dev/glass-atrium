#!/usr/bin/env bats
# Section-order rule of skills/glass-atrium-design-md-lint/lint.sh: a file in template order draws no
# warning, and a heading out of canonical order draws exactly one.
#
# Run via: bats scripts/test/design-md-lint-section-order.bats
# Requires: bats >= 1.5.0, python3, bash 3.2+

# shellcheck disable=SC2154  # bats sets BATS_TEST_DIRNAME, BATS_TEST_TMPDIR, status and output
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
LINT="${GA}/skills/glass-atrium-design-md-lint/lint.sh"
TEMPLATE="${GA}/agents/templates/DESIGN.md"

@test "the shipped template draws no section-order warning" {
  run bash "${LINT}" "${TEMPLATE}"

  # exit 1 = a broken-ref finding, another rule's verdict; exit 2 = the lint never measured
  [[ "${status}" -ne 2 ]] || {
    echo "${output}"
    return 1
  }
  # engine crash also exits 1 → the Verdict line proves the rules ran
  grep -q '^Verdict: ' <<<"${output}" || {
    echo "${output}"
    return 1
  }
  [[ "${output}" != *"section-order:"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "section-order warns only when a heading sits before an earlier canonical section" {
  # name|expected warnings|first heading|second heading
  local -a rows=(
    "a Voice & Brand heading stays in section 8 after section 7|0|## 7. Motion & Interaction|## 8. Voice & Brand"
    "a heading containing the letters anti is no anti-pattern section|0|## Semantic Tokens|## 2. Color"
    "section 2 after section 3 warns|1|## 3. Typography|## 2. Color"
    "an anti- heading before section 2 warns|1|## Anti-Slop Rules|## 2. Color"
    "a hyphenless anti pattern heading before section 2 warns|1|## Anti Patterns|## 2. Color"
  )
  local design="${BATS_TEST_TMPDIR}/DESIGN.md"
  local row name expected first second warnings

  for row in "${rows[@]}"; do
    IFS='|' read -r name expected first second <<<"${row}"
    printf '%s\n\n%s\n' "${first}" "${second}" >"${design}"

    run bash "${LINT}" "${design}"

    [[ "${status}" -eq 0 ]] || {
      echo "${name}"
      echo "${output}"
      return 1
    }
    warnings="$(grep -c 'section-order:' <<<"${output}" || true)"
    [[ "${warnings}" -eq "${expected}" ]] || {
      echo "${name}"
      echo "${output}"
      return 1
    }
  done
}
