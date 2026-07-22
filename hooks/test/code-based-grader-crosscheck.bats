#!/usr/bin/env bats
# code-based-grader-crosscheck.bats — acceptance spec for the T2 Step 4-5 transcript
# Write/Edit cross-check (plan clauded-docs/290, ADR-6; absorbs former T15). This is the
# OTHER half of T2 — the grader-side consumer of style_ref_match.py::collect_write_paths.
# It drives code_based_grader_check via the SAME caller-scope interface the production
# hook drives (track-outcome.sh), now also setting GRADER_WRITE_SCAN + GRADER_WRITE_PATHS.
#
# PINNED (plan ACs 264-265 + the W2 safety invariant):
#   * AC 264 — all claimed path-shaped entries matched a NON-EMPTY write-history →
#     verified (promotion allowed); >=1 unmatched → contradicted → verified_fail. This is
#     the ONLY transcript-cross-check verified_fail path (the first-ever activation of the
#     control — see plan ADR-6; live baseline is 0 verified_fail in 2081 rows).
#   * AC 265 — an unverifiable transcript (scan=unverifiable) → promotion withheld →
#     unverified, for code task_types.
#   * W2 SAFETY — an EMPTY write-history → withhold (never verified_fail): Write/Edit is
#     blind to Bash-authored writes, so an empty history cannot DEMONSTRATE absence.
#   * W2 SAFETY — the cross-check never bypasses existence: a matched-but-non-existent
#     claimed path still rests at unverified (files-evidence gate stands).
#   * LENIENT MATCH — a repo-root-relative claim matches its ABSOLUTE write-history entry
#     (substring / basename), so a legitimate row is NEVER a false contradiction.
#   * BACKWARD-COMPAT — an unwired ('' scan, the direct grader unit test) preserves the
#     pure files-evidence verdict (held Steps 1-3 stay byte-identical).
#
# Run via: bats hooks/test/code-based-grader-crosscheck.bats
# Hermetic: existing files created under a per-test sandbox; absolute paths keep resolution
# deterministic. Write-history is passed as a newline-separated GRADER_WRITE_PATHS value.

bats_require_minimum_version 1.5.0

REAL_LIB="${BATS_TEST_DIRNAME}/../lib/code-based-grader.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "code-based-grader.sh not found: ${REAL_LIB}"
  SANDBOX="$(cd -- "$(mktemp -d -t ga-grader-cc.XXXXXX)" && pwd -P)"
  EXIST_TEST="${SANDBOX}/auth.test.ts"
  printf '%s\n' 'describe("x", () => {})' >"${EXIST_TEST}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Drive code_based_grader_check with the six base inputs plus the two Step 4-5 inputs.
# Args: $1 TASK_TYPE $2 METRIC_PASS $3 RESULT $4 ATTRIBUTION $5 BODY $6 FILES
#       $7 GRADER_WRITE_SCAN $8 GRADER_WRITE_PATHS (newline-separated)
grade_cc() {
  run env \
    GR_TASK_TYPE="${1:-}" \
    GR_METRIC_PASS="${2:-}" \
    GR_RESULT="${3:-}" \
    GR_ATTRIBUTION="${4:-}" \
    GR_BODY="${5:-}" \
    GR_FILES="${6:-}" \
    GR_SCAN="${7:-}" \
    GR_WRITES="${8:-}" \
    bash -c '
      source "$1"
      TASK_TYPE="${GR_TASK_TYPE}"
      METRIC_PASS="${GR_METRIC_PASS}"
      RESULT="${GR_RESULT}"
      ATTRIBUTION_SOURCE="${GR_ATTRIBUTION}"
      GRADER_BODY_TEXT="${GR_BODY}"
      GRADER_FILES_FIELD="${GR_FILES}"
      GRADER_WRITE_SCAN="${GR_SCAN}"
      GRADER_WRITE_PATHS="${GR_WRITES}"
      code_based_grader_check
    ' _ "${REAL_LIB}"
}

# --- AC 264: contradiction → verified_fail (the transcript-cross-check verified_fail) ---

@test "feature verifiable + claimed path absent from a non-empty write-history → verified_fail" {
  grade_cc feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    verifiable "/repo/src/unrelated.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_fail" ]] || { echo "expected verified_fail (contradiction), got: ${output}" >&2; return 1; }
}

@test "feature verifiable + all claimed paths matched + existing test → verified_pass" {
  grade_cc feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    verifiable "${EXIST_TEST}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_pass" ]] || { echo "expected verified_pass (verified + existing test), got: ${output}" >&2; return 1; }
}

# --- AC 265: unverifiable → withhold promotion → unverified ---

@test "feature unverifiable + existing test path → unverified (withhold, AC 265)" {
  grade_cc feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    unverifiable ""
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "unverifiable must withhold promotion → unverified, got: ${output}" >&2; return 1; }
}

# --- W2 SAFETY: empty write-history never mints verified_fail ---

@test "feature verifiable + EMPTY write-history + claimed test path → unverified (withhold, never verified_fail)" {
  grade_cc feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    verifiable ""
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "empty history must withhold → unverified, got: ${output}" >&2; return 1; }
  [[ "${output}" != "verified_fail" ]] || { echo "empty history must NEVER be verified_fail (W2)" >&2; return 1; }
}

# --- W2 SAFETY: the cross-check never bypasses the existence gate ---

@test "feature verifiable + claimed path in write-history but NON-EXISTENT on disk → unverified (existence gate stands)" {
  grade_cc feature true "done" hook-input "new endpoint" "${SANDBOX}/never.test.ts" \
    verifiable "${SANDBOX}/never.test.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "a matched-but-non-existent path must rest at unverified, got: ${output}" >&2; return 1; }
  [[ "${output}" != "verified_fail" ]] || { echo "matched write must not mint verified_fail on a missing file (W2)" >&2; return 1; }
}

# --- LENIENT MATCH: repo-relative claim matches its absolute write entry (no false contradiction) ---

@test "feature verifiable + repo-relative claim substring-matches absolute write entry → not contradicted" {
  # claimed "src/foo.test.ts" is a substring of "/abs/repo/src/foo.test.ts" → matched
  # (verified, not contradicted); the file does not exist → unverified, NEVER verified_fail.
  grade_cc feature true "done" hook-input "new endpoint" "src/foo.test.ts" \
    verifiable "/abs/repo/src/foo.test.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != "verified_fail" ]] || { echo "lenient match must prevent a false contradiction on a repo-relative claim" >&2; return 1; }
  [[ "${output}" == "unverified" ]] || { echo "expected unverified (matched but non-existent), got: ${output}" >&2; return 1; }
}

# --- Step 1 gating: glob / no-path-shaped → na → files-evidence verdict (no contradiction) ---

@test "feature verifiable + glob entry → unverified (non-gradeable, not contradicted)" {
  grade_cc feature true "done" hook-input "new endpoint" "${SANDBOX}/*.md" \
    verifiable "/repo/src/x.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "a glob field must be non-gradeable → unverified, got: ${output}" >&2; return 1; }
}

@test "feature verifiable + no path-shaped entry (prose) → unverified (indeterminate, not contradicted)" {
  grade_cc feature true "done" hook-input "new endpoint" "none (deliverable is a clauded-doc)" \
    verifiable "/repo/src/x.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "a no-path-shaped field must be indeterminate → unverified, got: ${output}" >&2; return 1; }
}

# --- BACKWARD-COMPAT: unwired ('' scan) preserves the pure files-evidence verdict ---

@test "feature unwired (empty scan) + existing test → verified_pass (held Steps 1-3 unchanged)" {
  grade_cc feature true "done" hook-input "new endpoint" "${EXIST_TEST}" "" ""
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_pass" ]] || { echo "unwired must fall to files-evidence → verified_pass, got: ${output}" >&2; return 1; }
}

# --- bug-fix arm: contradiction overrides body phrasing; verified path still promotes ---

@test "bug-fix verifiable + body pass-phrasing but claimed path absent from write-history → verified_fail" {
  grade_cc bug-fix true "done" hook-input "test passes" "${EXIST_TEST}" \
    verifiable "/repo/src/unrelated.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_fail" ]] || { echo "contradiction must override body phrasing → verified_fail, got: ${output}" >&2; return 1; }
}

@test "bug-fix verifiable + body pass-phrasing + claimed path matched → verified_pass" {
  grade_cc bug-fix true "done" hook-input "test passes" "${EXIST_TEST}" \
    verifiable "${EXIST_TEST}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_pass" ]] || { echo "verified cross-check + body phrasing → verified_pass, got: ${output}" >&2; return 1; }
}

# --- bug-fix arm: unverifiable withholds even a body-phrasing promotion (AC 265) ---

@test "bug-fix unverifiable + body pass-phrasing + claimed path → unverified (withhold)" {
  grade_cc bug-fix true "done" hook-input "test passes" "${EXIST_TEST}" \
    unverifiable ""
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "unverifiable must withhold the body-phrasing promotion, got: ${output}" >&2; return 1; }
}
