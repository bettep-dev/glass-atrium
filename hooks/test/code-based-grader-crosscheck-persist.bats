#!/usr/bin/env bats
# code-based-grader-crosscheck-persist.bats — acceptance spec for persisting the Step 4-5
# cross-check state (plan clauded-docs/1466 T131a). Sibling of code-based-grader-crosscheck.bats,
# which pins the collapsed VERDICT; this one pins the four-value STATE the collapse discards.
#
# PINNED:
#   * FOUR VALUES — na, verified, contradicted, withhold are each recorded verbatim, on rows
#     that pass the recorder scan gate (task_type in the bug-fix/feature pair, self-reported
#     metric_pass, terminal result in the done family, non-empty files).
#   * WITHHELD != NOT-APPLICABLE — the subset review_flag_reasons does not encode: all three
#     withhold branches (unverifiable transcript, empty write-history, partial mismatch) record
#     `withhold`, never `na`, even though two of them collapse into the same `unverified` verdict
#     that `na` also produces.
#   * SAME-PATH RECORDING — the token is written by the compute arm itself. A verdict recorded
#     without the state file wired stays byte-identical (backward-compat, direct unit test).
#
# Run via: bats hooks/test/code-based-grader-crosscheck-persist.bats
# Hermetic: per-test sandbox holds both the existing test fixture and the state spool.

bats_require_minimum_version 1.5.0

REAL_LIB="${BATS_TEST_DIRNAME}/../lib/code-based-grader.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "code-based-grader.sh not found: ${REAL_LIB}"
  SANDBOX="$(cd -- "$(mktemp -d -t ga-grader-ccp.XXXXXX)" && pwd -P)"
  EXIST_TEST="${SANDBOX}/auth.test.ts"
  printf '%s\n' 'describe("x", () => {})' >"${EXIST_TEST}"
  STATE_FILE="${SANDBOX}/crosscheck.state"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Drive code_based_grader_check exactly as track-outcome.sh does, with the state spool wired.
# Args: $1 TASK_TYPE $2 METRIC_PASS $3 RESULT $4 ATTRIBUTION $5 BODY $6 FILES
#       $7 GRADER_WRITE_SCAN $8 GRADER_WRITE_PATHS (newline-separated)
grade_state() {
  run env \
    GR_TASK_TYPE="${1:-}" \
    GR_METRIC_PASS="${2:-}" \
    GR_RESULT="${3:-}" \
    GR_ATTRIBUTION="${4:-}" \
    GR_BODY="${5:-}" \
    GR_FILES="${6:-}" \
    GR_SCAN="${7:-}" \
    GR_WRITES="${8:-}" \
    GRADER_CROSSCHECK_STATE_FILE="${STATE_FILE}" \
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

assert_state() {
  local want="${1}" got
  [[ -f "${STATE_FILE}" ]] || { echo "no cross-check state recorded, expected: ${want}" >&2; return 1; }
  got="$(cat "${STATE_FILE}")"
  [[ "${got}" == "${want}" ]] || { echo "expected state ${want}, got: ${got}" >&2; return 1; }
}

# --- the four values ---

@test "feature + all claimed paths matched → state verified" {
  grade_state feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    verifiable "${EXIST_TEST}"
  [[ "${status}" -eq 0 ]] || return 1
  assert_state verified
}

@test "feature + total authorship mismatch → state contradicted" {
  grade_state feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    verifiable "/repo/src/unrelated.ts"
  [[ "${status}" -eq 0 ]] || return 1
  assert_state contradicted
}

@test "bug-fix + glob files field → state na" {
  grade_state bug-fix true "done" hook-input "test passes" "src/*.ts" \
    verifiable "${EXIST_TEST}"
  [[ "${status}" -eq 0 ]] || return 1
  assert_state na
}

@test "unwired scan → state na (backward-compatible files-evidence default)" {
  grade_state feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    "" ""
  [[ "${status}" -eq 0 ]] || return 1
  assert_state na
}

# --- withheld is NOT not-applicable: all three branches, each distinct from na ---

@test "feature + unverifiable transcript → state withhold, not na" {
  grade_state feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    unverifiable ""
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "verdict contract changed: ${output}" >&2; return 1; }
  assert_state withhold
}

@test "feature + empty write-history → state withhold, not na" {
  grade_state feature true "done" hook-input "new endpoint" "${EXIST_TEST}" \
    verifiable ""
  [[ "${status}" -eq 0 ]] || return 1
  assert_state withhold
}

@test "bug-fix + partial mismatch → state withhold while the verdict reads unverified" {
  # one claimed path matched, one absent — the verdict collapses to the same unverified an
  # inapplicable row produces, so the state file is the only place the difference survives.
  grade_state bug-fix true "done" hook-input "failing test now passes" \
    "${EXIST_TEST},${SANDBOX}/generated.snap" verifiable "${EXIST_TEST}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "unverified" ]] || { echo "verdict contract changed: ${output}" >&2; return 1; }
  assert_state withhold
}

# --- backward compatibility of the unwired path ---

@test "state file unset → no spool written and the verdict is unchanged" {
  run env \
    GR_LIB="${REAL_LIB}" GR_FILES="${EXIST_TEST}" \
    bash -c '
      source "${GR_LIB}"
      TASK_TYPE="feature"
      METRIC_PASS="true"
      RESULT="done"
      ATTRIBUTION_SOURCE="hook-input"
      GRADER_BODY_TEXT="new endpoint"
      GRADER_FILES_FIELD="${GR_FILES}"
      GRADER_WRITE_SCAN="verifiable"
      GRADER_WRITE_PATHS="${GR_FILES}"
      code_based_grader_check
    '
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "verified_pass" ]] || { echo "unwired verdict changed: ${output}" >&2; return 1; }
  [[ ! -f "${STATE_FILE}" ]] || { echo "unwired run must not write a state spool" >&2; return 1; }
}
