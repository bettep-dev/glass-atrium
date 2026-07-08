#!/usr/bin/env bats
# code-based-grader.sh unit suite — pins the deterministic 3-state verdict
# contract of the Code-Based eval tier (core-outcome-record.md grader_verdict
# guide). The lib is sourced exactly as the production hook sources it
# (track-outcome.sh), then driven via the caller-scope variables it reads:
#   TASK_TYPE / METRIC_PASS / RESULT / ATTRIBUTION_SOURCE /
#   GRADER_BODY_TEXT / GRADER_FILES_FIELD.
#
# Verdict tokens (stdout, single token):
#   verified_pass — metric_pass=true claim corroborated by block-resident evidence
#   unverified    — the DEFAULT (infra row · non-success result · non-code type ·
#                   metric_pass≠true · off-surface / absent structured signal)
#   verified_fail — the SINGLE narrow LLM09 zero-evidence path ONLY
#
# Contract invariants pinned here:
#   * the function always exits 0 (verdict is stdout-only)
#   * it READs caller-scope variables — never mutates them
#   * verified_fail is reachable ONLY via the zero-evidence guard (step 5)
#   * the double-source guard is idempotent (re-source is a no-op)
#
# Run via: bats hooks/test/code-based-grader.bats
# Hermetic: the lib is sourced read-only in a fresh bash per case; no live
# host service, DB, or filesystem mutation.

bats_require_minimum_version 1.5.0

REAL_LIB="${BATS_TEST_DIRNAME}/../lib/code-based-grader.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "code-based-grader.sh not found: ${REAL_LIB}"
}

# Drive code_based_grader_check in a fresh bash with the six caller-scope
# variables pinned. Mirrors track-outcome.sh: source the lib, set the inputs,
# call the function, capture the single verdict token on stdout.
# Args (positional, all optional — empty string for "unset"):
#   $1 TASK_TYPE  $2 METRIC_PASS  $3 RESULT  $4 ATTRIBUTION_SOURCE
#   $5 GRADER_BODY_TEXT  $6 GRADER_FILES_FIELD
grade() {
  run env \
    GR_TASK_TYPE="${1:-}" \
    GR_METRIC_PASS="${2:-}" \
    GR_RESULT="${3:-}" \
    GR_ATTRIBUTION="${4:-}" \
    GR_BODY="${5:-}" \
    GR_FILES="${6:-}" \
    bash -c '
      source "$1"
      TASK_TYPE="${GR_TASK_TYPE}"
      METRIC_PASS="${GR_METRIC_PASS}"
      RESULT="${GR_RESULT}"
      ATTRIBUTION_SOURCE="${GR_ATTRIBUTION}"
      GRADER_BODY_TEXT="${GR_BODY}"
      GRADER_FILES_FIELD="${GR_FILES}"
      code_based_grader_check
    ' _ "${REAL_LIB}"
}

# Drive _cbg_zero_evidence directly with its two positional args.
# Exits 0 (true) when ZERO evidence of any kind is present.
zero_evidence() {
  run env GR_BODY="${1:-}" GR_FILES="${2:-}" bash -c '
    source "$1"
    _cbg_zero_evidence "${GR_BODY}" "${GR_FILES}"
  ' _ "${REAL_LIB}"
}

# Step 1: infra attribution rows → unverified (author-side only)

@test "attribution subagent-stop-missing → unverified (infra row, never graded)" {
  grade bug-fix true "done" subagent-stop-missing "test passing exit 0" "fix.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "attribution agent-id-missing → unverified even with pass evidence" {
  grade feature true "done" agent-id-missing "" "auth.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "attribution completion-missing → unverified" {
  grade bug-fix true "done" completion-missing "spec green" "x.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "attribution conversation-only → unverified" {
  grade feature true "done" conversation-only "" "a.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

# Step 2: non-success result → unverified (nothing to verify)

@test "result=fail → unverified (not a success-family value)" {
  grade bug-fix true "fail" hook-input "test passing exit 0" "fix.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "result=blocked → unverified" {
  grade feature true "blocked" hook-input "" "a.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "result=done_with_concerns is a success-family value (reaches per-type check)" {
  # success-family + bug-fix + block-resident test/pass evidence → verified_pass.
  grade bug-fix true "done_with_concerns" hook-input "added test, suite passing exit 0" "fix.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_pass" ]]
}

# Step 3: non-code task_types → explicit skip-with-reason → unverified

@test "task_type=review → unverified (no test artifact expected)" {
  grade review true "done" hook-input "looks good, approved" "src/a.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "task_type=diagnosis → unverified" {
  grade diagnosis true "done" hook-input "root cause in parser" ""
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "task_type=doc → unverified" {
  grade doc true "done" hook-input "document written" ""
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "task_type=cleanup → unverified" {
  grade cleanup true "done" hook-input "removed dead imports" "src/a.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

# Step 4: writer did not claim metric_pass=true → unverified

@test "metric_pass=false → unverified (no positive claim to verify)" {
  grade bug-fix false "done" hook-input "test passing exit 0" "fix.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "metric_pass empty → unverified" {
  grade feature "" "done" hook-input "" "a.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

# Step 5: narrow LLM09 zero-evidence guard → verified_fail (the ONLY path)

@test "done + metric_pass=true + zero evidence of any kind → verified_fail" {
  grade bug-fix true "done" hook-input "" ""
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_fail" ]]
}

@test "zero-evidence verified_fail fires for plan too (task_type independent)" {
  grade plan true "done" hook-input "" ""
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_fail" ]]
}

@test "whitespace-only body + blank files → still verified_fail (no real evidence)" {
  grade feature true "done" hook-input "   " "  "
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_fail" ]]
}

@test "a files: path alone defeats the zero-evidence guard → not verified_fail" {
  # files present → evidence of a kind exists → step 5 not taken; feature without
  # a test-file path falls through to its per-type unverified default.
  grade feature true "done" hook-input "" "src/a.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "a cited source in the body alone defeats the zero-evidence guard" {
  # research with a Sources: marker but no files → evidence present → not
  # verified_fail; research defaults to unverified by task_type.
  grade research true "done" hook-input "Sources: three cited refs" ""
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

# Step 6: per-task-type verified_pass checks

@test "bug-fix with test + passing phrasing → verified_pass" {
  grade bug-fix true "done" hook-input "added regression test, suite passing" "src/fix.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_pass" ]]
}

@test "bug-fix with 'spec' + 'exit 0' phrasing → verified_pass" {
  grade bug-fix true "done" hook-input "spec reproduces, exit 0 now" "src/fix.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_pass" ]]
}

@test "bug-fix with a body but no test/pass phrasing → unverified (not fail)" {
  grade bug-fix true "done" hook-input "patched the null deref in handler" "src/fix.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "feature with a test-file path in files: → verified_pass" {
  grade feature true "done" hook-input "new endpoint" "src/auth.ts, src/auth.test.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_pass" ]]
}

@test "feature with a .spec. file path → verified_pass" {
  grade feature true "done" hook-input "new module" "src/login.spec.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_pass" ]]
}

@test "feature with a .bats test path → verified_pass" {
  grade feature true "done" hook-input "new hook" "hooks/test/new-hook.test.bats"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "verified_pass" ]]
}

@test "feature with only non-test source files → unverified (not fail)" {
  grade feature true "done" hook-input "new endpoint" "src/auth.ts, src/router.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "refactor → unverified by task_type (no trustworthy block-resident marker)" {
  grade refactor true "done" hook-input "existing tests pass, no behavior change" "src/a.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "plan with body evidence → unverified by task_type (markers off-surface)" {
  grade plan true "done" hook-input "## Phase 1 ## Acceptance Criteria" "doc.md"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "research with cited sources → unverified by task_type (off-surface)" {
  grade research true "done" hook-input "Sources: https://example.com cross-verified" ""
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

@test "unknown task_type → unverified (no responsibility to assign a verdict)" {
  grade mystery true "done" hook-input "anything" "src/a.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "unverified" ]]
}

# _cbg_zero_evidence direct unit checks

@test "_cbg_zero_evidence: blank body + blank files → true (zero evidence)" {
  zero_evidence "" ""
  [[ "${status}" -eq 0 ]]
}

@test "_cbg_zero_evidence: whitespace-only body + files → true" {
  zero_evidence "  " "  "
  [[ "${status}" -eq 0 ]]
}

@test "_cbg_zero_evidence: a files: path present → false (evidence)" {
  zero_evidence "" "src/a.ts"
  [[ "${status}" -ne 0 ]]
}

@test "_cbg_zero_evidence: 'Sources:' marker in body → false" {
  zero_evidence "Sources: cited" ""
  [[ "${status}" -ne 0 ]]
}

@test "_cbg_zero_evidence: an https URL in body → false" {
  zero_evidence "see https://example.com" ""
  [[ "${status}" -ne 0 ]]
}

@test "_cbg_zero_evidence: any non-whitespace body → false" {
  zero_evidence "just some prose" ""
  [[ "${status}" -ne 0 ]]
}

# Source-guard idempotency: re-source is a no-op, function still defined

@test "double-source guard: re-sourcing the lib is idempotent, function survives" {
  run bash -c '
    source "$1"
    source "$1"
    declare -F code_based_grader_check >/dev/null && echo defined
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "defined" ]]
}
