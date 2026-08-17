#!/usr/bin/env bats
# orchestrator-skill-schema-example.bats — the orchestrator skill file must not DEMONSTRATE the
# schema-cap defect it warns about, and must carry the five positive schema-cap rules.
#
# WHY: the workflow retry-cap-exceeded failure was already "fixed once" — as documentation only.
# Two things defeated that fix. (1) No mechanical check existed anywhere. (2) The guidance's own
# worked example in the Analysis-Track Right-Sizing section declared a CAPPED `findings` property
# sitting immediately beside an UNCAPPED `completion_block` — the reference material demonstrated
# the defect it warned against, so an author copying the skeleton reproduced the failure. This
# suite pins the corrected example and the corrected rules so the next edit cannot silently erode
# them back. Repository precedent for a doc-consistency pin: emit-discipline-doc-consistency.bats.
#
# SCOPE (deliberately narrow — read before adding an assertion):
#   * This is NOT a ban on the word `maxLength` / `maxItems` in this file. The guidance
#     LEGITIMATELY discusses cap failures in prose, in helper comments, and inside a delegation
#     template literal (the validator contract "respect every maxLength/maxItems cap"). A word ban
#     would be both unsatisfiable and wrong. Only the specific DEFECT SHAPES are pinned:
#       - the literal capped-property notation from the analysis-schema worked example, and
#       - the withdrawn per-row / per-item cap-sizing floor (distinguishing literal "300-400").
#   * This suite asserts DOCUMENT CONTENT only. It invokes no hook and asserts nothing about
#     runtime behaviour — the mechanical half is the schema-cap advisory in
#     hooks/enforce-workflow-verify-stage.sh, which covers a DISJOINT half of the defect (the
#     shorthand notation used by the worked example carries no numeric literal and is structurally
#     invisible to that raw-text scan). Neither half subsumes the other.
#   * No `bash <hook>` prefix concern applies here: nothing is executed, so the direct-invocation
#     constraint on new hook assertions is not engaged.
#
# Run via: bats hooks/test/orchestrator-skill-schema-example.bats
# Requires: bats (brew install bats-core), grep. No monitor/DB touched.

REPO_ROOT="${BATS_TEST_DIRNAME}/../.."
SKILL="${REPO_ROOT}/skills/glass-atrium-ops-orchestrator.md"

# The exact capped-property notation the defective worked example declared.
DEFECT_LITERAL="findings: 'string(maxLength)'"
# The withdrawn per-row / per-item cap-sizing floor, keyed on its distinguishing literal.
WITHDRAWN_FLOOR_LITERAL="300-400"

setup() {
  [[ -f "${SKILL}" ]] || skip "skill file not found: ${SKILL}"
}

# helper: fixed-string, case-insensitive presence assertion with a legible failure message
assert_present() {
  local needle="$1"
  grep -Fiq -- "${needle}" "${SKILL}" || {
    printf 'required marker absent from %s:\n  %s\n' "${SKILL}" "${needle}" >&2
    return 1
  }
}

# helper: fixed-string absence assertion that reports the surviving occurrences
assert_absent() {
  local needle="$1" hits
  hits="$(grep -Fc -- "${needle}" "${SKILL}" || true)"
  [[ "${hits}" == "0" ]] || {
    printf 'forbidden literal still present in %s (%s occurrence(s)):\n  %s\n' \
      "${SKILL}" "${hits}" "${needle}" >&2
    grep -Fn -- "${needle}" "${SKILL}" >&2 || true
    return 1
  }
}

# ── D1: the worked example no longer declares the capped property ────────────────────────

@test "D1 the defective capped-property notation is absent from the analysis-schema example" {
  assert_absent "${DEFECT_LITERAL}"
}

@test "D2 the analysis-schema example declares its properties UNCAPPED" {
  assert_present "const AnalysisSchema = {"
  assert_present "findings: 'string'"
  assert_present "completion_block: 'string'"
}

# ── D3: no surviving per-array-element / per-item cap-sizing endorsement ─────────────────

@test "D3 the withdrawn per-row cap-sizing floor is gone (no per-element cap endorsement)" {
  assert_absent "${WITHDRAWN_FLOOR_LITERAL}"
}

# ── R1-R5: the five positive rules are stated explicitly ─────────────────────────────────
# Each is keyed on a short stable marker, not on the full sentence, so wording edits around the
# marker do not break the pin. Matching is case-insensitive for the same reason.

@test "R1 rule stated: no maxLength anywhere on a workflow output schema" {
  assert_present "no \`maxLength\` anywhere on a workflow output schema"
}

@test "R2 rule stated: never cap completion_block" {
  assert_present "never cap \`completion_block\`"
}

@test "R3 rule stated: per-array-element caps are forbidden" {
  assert_present "per-array-element caps are FORBIDDEN"
}

@test "R4 rule stated: hand bulk content to a file" {
  assert_present "hand bulk content to a FILE"
}

@test "R5 rule stated: a retry must change strategy" {
  assert_present "a retry must CHANGE STRATEGY"
}

# ── Aggregate: all five rules present (consistency gate) ─────────────────────────────────

@test "ALL five positive schema-cap rules are present (consistency gate)" {
  local rule missing=0
  local rules=(
    "no \`maxLength\` anywhere on a workflow output schema"
    "never cap \`completion_block\`"
    "per-array-element caps are FORBIDDEN"
    "hand bulk content to a FILE"
    "a retry must CHANGE STRATEGY"
  )
  for rule in "${rules[@]}"; do
    if ! grep -Fiq -- "${rule}" "${SKILL}"; then
      printf 'rule marker absent: %s\n' "${rule}" >&2
      missing=$((missing + 1))
    fi
  done
  [[ "${missing}" -eq 0 ]]
}

# ── Pointer to the promotion condition (recorded in the hook header, NOT restated here) ──

@test "POINTER the promotion-to-blocking condition is referenced, not restated" {
  assert_present "promotion-to-blocking condition"
  assert_present "enforce-workflow-verify-stage.sh"
}

# ── AC13: the declared-property exemplar carries completion_block as a schema MEMBER ─────
# Membership, not a count: the assertion extracts the ONE fenced block that declares
# AnalysisSchema and requires the reserved property to appear as a declared member INSIDE that
# fence. A prose mention elsewhere in the file — or a comment inside the fence — cannot satisfy
# it, which is what makes the exemplar decidable as a reference form rather than as narration.

# helper: print the js fence containing the given needle (first match only)
fence_with() {
  awk -v needle="$1" '
    /^```/ { if (infence) { if (hit) { printf "%s", buf; exit } ; infence=0; buf=""; hit=0 } else { infence=1 } ; next }
    infence { buf = buf $0 "\n"; if (index($0, needle)) hit=1 }
  ' "${SKILL}"
}

@test "AC13 the exemplar fence declares completion_block as a schema member, not prose" {
  local fence
  fence="$(fence_with "const AnalysisSchema")"
  [[ -n "${fence}" ]] || {
    printf 'no fenced block declaring AnalysisSchema found in %s\n' "${SKILL}" >&2
    return 1
  }
  # strip full-line comments so a commented mention cannot satisfy membership
  local code
  code="$(printf '%s\n' "${fence}" | grep -v '^[[:space:]]*//' || true)"
  printf '%s\n' "${code}" | grep -Eq "completion_block:[[:space:]]*'string'" || {
    printf 'completion_block is not a declared member of the exemplar schema:\n%s\n' "${fence}" >&2
    return 1
  }
}
