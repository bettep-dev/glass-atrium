#!/usr/bin/env bats
# style-ref-flag-predicate.bats — style_ref_compute_review_flag holds only writers that actually
# received the Project Convention Probe responsible for omitting it.
#
# WHY: the predicate used to flag on two attribution channels and on every agent name alike, so an
# ephemeral (registry-absent) spawn name and a registered agent outside the probe roster were both
# recorded as writer-side probe omissions — an orchestration defect charged to the writer.
#
# Run via: bats hooks/test/style-ref-flag-predicate.bats
# Requires: bats, jq. Hermetic — registry fixture under BATS_TEST_TMPDIR, no monitor/DB touched.

CONSTS_LIB="${BATS_TEST_DIRNAME}/../lib/style-ref-consts.sh"

# The 11 attribution values the recorder assigns, split by the binding contract: a writer emitted a
# complete block on the 3 below, on none of the other 8.
WRITER_CHANNELS="hook-input cron-derived structuredoutput-completion"
NON_WRITER_CHANNELS="structuredoutput-derived completion-synthesized budget-truncation truncated_completion completion-missing subagent-stop-missing agent-id-missing conversation-only"

ROSTER_AGENT="glass-atrium-dev-shell"
REGISTERED_NON_ROSTER_AGENT="glass-atrium-qa-code-reviewer"
EPHEMERAL_AGENT="glass-atrium-teammate-ad83f1"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required for registry membership"
  [[ -f "${CONSTS_LIB}" ]] || skip "predicate lib not found: ${CONSTS_LIB}"

  CLAUDE_AGENT_REGISTRY_FILE="${BATS_TEST_TMPDIR}/agent-registry.json"
  printf '{"agents":{"%s":{},"%s":{}}}\n' \
    "${ROSTER_AGENT}" "${REGISTERED_NON_ROSTER_AGENT}" >"${CLAUDE_AGENT_REGISTRY_FILE}"
  export CLAUDE_AGENT_REGISTRY_FILE
}

# Assign the caller-scope inputs, run the predicate once, leave REVIEW_FLAG / REVIEW_FLAG_REASONS
# for the assertions. STYLE_REF is always empty here — a present reference exempts every case.
compute() {
  local task_type="${1}" attribution="${2}" agent="${3}"
  STYLE_REF=""
  TASK_TYPE="${task_type}"
  ATTRIBUTION_SOURCE="${attribution}"
  AGENT_TYPE="${agent}"
  REVIEW_FLAG="false"
  REVIEW_FLAG_REASONS=""
  # shellcheck source=../lib/style-ref-consts.sh
  source "${CONSTS_LIB}"
  style_ref_compute_review_flag
}

@test "AC-4.5 the three writer channels flag an absent probe reference" {
  for channel in ${WRITER_CHANNELS}; do
    compute "feature" "${channel}" "${ROSTER_AGENT}"
    [[ "${REVIEW_FLAG}" = "true" ]] || {
      printf 'writer channel %s did not flag\n' "${channel}" >&2
      return 1
    }
    [[ "${REVIEW_FLAG_REASONS}" = "probe-omission" ]] || {
      printf 'writer channel %s stamped %s\n' "${channel}" "${REVIEW_FLAG_REASONS}" >&2
      return 1
    }
  done
}

@test "AC-4.5 the eight non-writer channels never flag" {
  for channel in ${NON_WRITER_CHANNELS}; do
    compute "feature" "${channel}" "${ROSTER_AGENT}"
    [[ "${REVIEW_FLAG}" = "false" ]] || {
      printf 'non-writer channel %s flagged\n' "${channel}" >&2
      return 1
    }
    [[ -z "${REVIEW_FLAG_REASONS}" ]] || {
      printf 'non-writer channel %s stamped %s\n' "${channel}" "${REVIEW_FLAG_REASONS}" >&2
      return 1
    }
  done
}

@test "AC-4.4 an unregistered agent resolves to the unregistered reason, never probe-omission" {
  for task_type in feature bug-fix refactor; do
    compute "${task_type}" "hook-input" "${EPHEMERAL_AGENT}"
    [[ "${REVIEW_FLAG_REASONS}" = "unregistered-agent-probe-exempt" ]] || {
      printf '%s stamped %s\n' "${task_type}" "${REVIEW_FLAG_REASONS}" >&2
      return 1
    }
  done
}

@test "AC-4.14 a registered agent outside the probe roster never flags" {
  for task_type in feature bug-fix refactor; do
    compute "${task_type}" "hook-input" "${REGISTERED_NON_ROSTER_AGENT}"
    [[ "${REVIEW_FLAG}" = "false" ]] || {
      printf '%s flagged a non-roster agent\n' "${task_type}" >&2
      return 1
    }
    [[ -z "${REVIEW_FLAG_REASONS}" ]] || {
      printf '%s stamped %s on a non-roster agent\n' "${task_type}" "${REVIEW_FLAG_REASONS}" >&2
      return 1
    }
  done
}

@test "a present probe reference exempts every input combination" {
  compute "feature" "hook-input" "${ROSTER_AGENT}"
  STYLE_REF="hooks/lib/style-ref-consts.sh"
  REVIEW_FLAG="false"
  REVIEW_FLAG_REASONS=""
  style_ref_compute_review_flag
  [[ "${REVIEW_FLAG}" = "false" ]]
  [[ -z "${REVIEW_FLAG_REASONS}" ]]
}

@test "AC-4.7 each channel set is declared exactly once across the hooks tree" {
  local hooks_dir="${BATS_TEST_DIRNAME}/.."
  local writer_decls degraded_decls
  writer_decls="$(grep -rl "^readonly WRITER_ATTRIBUTION_SOURCES=" "${hooks_dir}" | wc -l | tr -d ' ')"
  degraded_decls="$(grep -rl "^readonly DEGRADED_ATTRIBUTION_SOURCES=" "${hooks_dir}" | wc -l | tr -d ' ')"
  [[ "${writer_decls}" -eq 1 ]] || {
    printf 'WRITER_ATTRIBUTION_SOURCES declared in %s files\n' "${writer_decls}" >&2
    return 1
  }
  [[ "${degraded_decls}" -eq 1 ]] || {
    printf 'DEGRADED_ATTRIBUTION_SOURCES declared in %s files\n' "${degraded_decls}" >&2
    return 1
  }
}

@test "AC-4.6 the style-ref roster is declared exactly once across the hooks tree" {
  local decls
  decls="$(grep -rl "^readonly STYLEREF_AGENTS=" "${BATS_TEST_DIRNAME}/.." | wc -l | tr -d ' ')"
  [[ "${decls}" -eq 1 ]] || {
    printf 'STYLEREF_AGENTS declared in %s files\n' "${decls}" >&2
    return 1
  }
}
