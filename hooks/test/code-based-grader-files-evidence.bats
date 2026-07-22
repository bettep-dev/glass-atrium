#!/usr/bin/env bats
# code-based-grader-files-evidence.bats — T1c fail-at-HEAD coverage for T2
# (Grader files-evidence — MERGED, absorbs former T15). This suite is the
# ACCEPTANCE SPEC for the files-evidence rule the T2 DEV adds to
# code_based_grader_check. It exercises the SAME caller-scope interface the
# production hook drives (GRADER_FILES_FIELD etc.), so it stays hook-faithful.
#
# THE CORRECTIONS PINNED (plan Step 1-3, W1/W2):
#   * W1 — promotion requires an EXISTING test/spec-shaped path, not merely a
#     path-SHAPED string. HEAD promotes a feature row on a regex match of the
#     files STRING with no stat, so a NON-EXISTENT test-shaped path promotes.
#   * W2 — a path-shaped entry that does not resolve yields unverified and
#     NEVER verified_fail (a legitimately deleted file is indistinguishable from
#     fabrication at this tier; live data shows 0 verified_fail in 2081 rows).
#   * Step 1 — a glob metacharacter entry is non-gradeable → unverified; a
#     leading ~ expands to $HOME before stat; a no-path-shaped field (observed
#     live prose form) is indeterminate → unverified.
#
# FAIL-AT-HEAD (RED against a627de7, GREEN after T2):
#   * a NON-EXISTENT test-shaped path → unverified (HEAD: verified_pass via regex).
#   * a DELETED test path → unverified, never verified_fail (HEAD: verified_pass).
#   * a glob-metachar entry co-occurring with a test path → unverified (HEAD: pass).
#   * a ~-prefixed NON-EXISTENT test path → unverified after $HOME expand + stat.
# REGRESSION / POSITIVE GUARDS (GREEN at HEAD and after):
#   * an EXISTING absolute test path → verified_pass (the promotion path still works).
#   * a ~-prefixed EXISTING test path → verified_pass ($HOME expand resolves it).
#   * existing NON-test files only → unverified (W1 guard).
#   * the observed live prose "none (deliverable is monitor clauded-doc ...)" → unverified.
#   * a nonexistent path NEVER mints verified_fail (the W2 invariant, both epochs).
#
# NOTE (scope): the transcript cross-check + cache tool-filter namespacing (plan
# Step 4-5, style_ref_match.py) is the OTHER half of T2 and lives in the python
# matcher lib — out of this grader-lib suite's boundary; the T2 DEV covers it in
# the matcher's own test. This suite pins the load-bearing files-evidence rule.
#
# Run via: bats hooks/test/code-based-grader-files-evidence.bats
# Hermetic: real files are created under a per-test sandbox; absolute paths are
# used so resolution is deterministic (no cwd/repo-root coupling). $HOME is
# overridden to the sandbox only for the ~-expansion cases.

bats_require_minimum_version 1.5.0

REAL_LIB="${BATS_TEST_DIRNAME}/../lib/code-based-grader.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "code-based-grader.sh not found: ${REAL_LIB}"
  SANDBOX="$(cd -- "$(mktemp -d -t ga-files-evidence.XXXXXX)" && pwd -P)"
  # An EXISTING test-shaped file and an EXISTING non-test file.
  EXIST_TEST="${SANDBOX}/exists.test.ts"
  EXIST_PLAIN="${SANDBOX}/plain.ts"
  printf '%s\n' 'describe("x", () => {})' >"${EXIST_TEST}"
  printf '%s\n' 'export const x = 1' >"${EXIST_PLAIN}"
  # A path that is created then DELETED — resolution must fail.
  DELETED_TEST="${SANDBOX}/gone.test.ts"
  printf '%s\n' 'x' >"${DELETED_TEST}"
  rm -f -- "${DELETED_TEST}"
  # A $HOME-relative existing test file for the ~-expansion positive case.
  HOME_TEST="${SANDBOX}/home.test.ts"
  printf '%s\n' 'it("y", () => {})' >"${HOME_TEST}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Drive code_based_grader_check in a fresh bash with the six caller-scope inputs
# pinned (mirrors track-outcome.sh + the existing code-based-grader.bats grade()).
# Args: $1 TASK_TYPE $2 METRIC_PASS $3 RESULT $4 ATTRIBUTION $5 BODY $6 FILES
#       $7 HOME override (optional — empty leaves the real $HOME).
grade() {
  run env \
    GR_TASK_TYPE="${1:-}" \
    GR_METRIC_PASS="${2:-}" \
    GR_RESULT="${3:-}" \
    GR_ATTRIBUTION="${4:-}" \
    GR_BODY="${5:-}" \
    GR_FILES="${6:-}" \
    GR_HOME="${7:-}" \
    bash -c '
      [[ -n "${GR_HOME}" ]] && export HOME="${GR_HOME}"
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

# --- FAIL-AT-HEAD: existence-gated promotion (W1 / Step 3) ---

@test "feature: NON-EXISTENT test-shaped path → unverified [FAIL-AT-HEAD: HEAD promotes via regex]" {
  grade feature true "done" hook-input "new endpoint" "${SANDBOX}/never-created.test.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "expected unverified for a non-existent path, got: ${output}" >&2; return 1; }
}

@test "feature: DELETED test path → unverified AND never verified_fail [FAIL-AT-HEAD]" {
  grade feature true "done" hook-input "new endpoint" "${DELETED_TEST}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "expected unverified for a deleted path, got: ${output}" >&2; return 1; }
  [[ "${output}" != "verified_fail" ]] || { echo "a resolution failure must never mint verified_fail (W2)" >&2; return 1; }
}

# --- FAIL-AT-HEAD: glob metacharacter entry is non-gradeable (Step 1 / AC 262) ---

@test "feature: a glob-metachar entry alongside a real test path → unverified [FAIL-AT-HEAD]" {
  grade feature true "done" hook-input "new endpoint" "${EXIST_TEST}, ${SANDBOX}/*.md"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "a glob entry must be non-gradeable → unverified, got: ${output}" >&2; return 1; }
}

@test "feature: a brace-form glob entry → unverified [FAIL-AT-HEAD]" {
  grade feature true "done" hook-input "new endpoint" "${EXIST_TEST}, ${SANDBOX}/{a,b}.test.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "a brace-glob entry must be non-gradeable → unverified, got: ${output}" >&2; return 1; }
}

# --- FAIL-AT-HEAD: leading ~ expands to $HOME before stat (Step 1 / AC 264) ---

@test "feature: ~-prefixed NON-EXISTENT test path → unverified after \$HOME expand + stat [FAIL-AT-HEAD]" {
  # The literal ~ is deliberate — the GRADER (not the shell) must expand it.
  # shellcheck disable=SC2088
  grade feature true "done" hook-input "new endpoint" "~/never-created.test.ts" "${SANDBOX}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "expected unverified for a ~-expanded non-existent path, got: ${output}" >&2; return 1; }
}

# --- POSITIVE GUARDS: the promotion path still works (GREEN at HEAD and after) ---

@test "feature: an EXISTING absolute test path → verified_pass (promotion still works)" {
  grade feature true "done" hook-input "new endpoint" "${EXIST_PLAIN}, ${EXIST_TEST}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_pass" ]] || { echo "an existing test path must promote, got: ${output}" >&2; return 1; }
}

@test "feature: ~-prefixed EXISTING test path → verified_pass (\$HOME expansion resolves it)" {
  # The literal ~ is deliberate — the GRADER (not the shell) must expand it.
  # shellcheck disable=SC2088
  grade feature true "done" hook-input "new endpoint" "~/home.test.ts" "${SANDBOX}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_pass" ]] || { echo "a ~-expanded existing test path must promote, got: ${output}" >&2; return 1; }
}

# --- REGRESSION GUARDS (GREEN at HEAD and after) ---

@test "feature: existing NON-test files only → unverified (W1 — existence of unrelated files promotes nothing)" {
  grade feature true "done" hook-input "new endpoint" "${EXIST_PLAIN}, ${SANDBOX}/router.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "non-test files must not promote, got: ${output}" >&2; return 1; }
}

@test "feature: observed live prose 'none (deliverable is monitor clauded-doc ...)' → unverified" {
  grade feature true "done" hook-input "new endpoint" "none (deliverable is monitor clauded-doc id 282 | content_hash abc123)"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "a no-path-shaped prose field must be indeterminate → unverified, got: ${output}" >&2; return 1; }
}

@test "feature: a bare glob '*.md' as the only entry → unverified (non-gradeable)" {
  grade feature true "done" hook-input "new endpoint" "${SANDBOX}/*.md"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "a lone glob entry must be non-gradeable → unverified, got: ${output}" >&2; return 1; }
}

@test "W2 invariant: a non-existent path with a non-empty body never mints verified_fail" {
  grade feature true "done" hook-input "some prose about the work" "${SANDBOX}/never-created.test.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != "verified_fail" ]] || { echo "resolution/existence failure must never be verified_fail (W2)" >&2; return 1; }
}
