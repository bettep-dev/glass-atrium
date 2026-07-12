#!/usr/bin/env bash
# code-based-grader.sh — Code-Based tier of the 3-Tier Eval grader. Declaration-only,
# sourced by track-outcome.sh (single SoT, no per-caller drift). Bash 3.2+ (macOS stock).
#
# code_based_grader_check → per-task-type deterministic 3-state verdict
#   (verified_pass | unverified | verified_fail) — advisory: never overwrites the writer
#   self-reported metric_pass (core-outcome-record.md T1).

# Double-source guard.
# shellcheck disable=SC2317
#   SC2317-unreachable is a source-context-unaware false-positive on this return-after-||-true guard.
if [[ -n "${_CODE_BASED_GRADER_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _CODE_BASED_GRADER_LOADED=1

# code_based_grader_check — deterministic 3-state verdict on the author-side metric_pass.
#
# Inputs (all caller-scope, set in track-outcome.sh — SC2154 silenced below):
#   TASK_TYPE, METRIC_PASS, RESULT, ATTRIBUTION_SOURCE, GRADER_BODY_TEXT, GRADER_FILES_FIELD.
#
# Outputs (stdout, single token — 3-state per core-outcome-record.md T1):
#   verified_pass — metric_pass=true claim corroborated by block-resident evidence.
#   unverified    — no verification applicable (infra / non-success / non-code / metric_pass≠true /
#                   off-surface / absent signal — the DEFAULT for every code type).
#   verified_fail — narrow LLM09 zero-evidence guard ONLY: result=done + metric_pass=true + ZERO
#                   deliverable evidence of ANY kind. Off-surface-heading absence is NOT this case.
#
# Input-surface invariant (core-outcome-record.md grader_verdict guide): the grader reads ONLY
#   block-resident text + files: paths — NEVER the off-surface deliverable (plan/research doc,
#   diff/test files). So plan/research/refactor default to unverified by task_type alone, and the
#   per-type marker regexes that keyed on off-surface artifacts are REMOVED (structurally
#   guaranteed false-fails). Every retained check gates on a STRUCTURED field; prose never signals.
#
# Contract: function always exits 0 (verdict on stdout), READs caller-scope only (no mutation);
#   the verdict is ADVISORY (a SEPARATE column) — the caller MUST NOT overwrite metric_pass from it.
#   Infra attribution → unconditional unverified; the 4 non-code task_types (review/diagnosis/doc/
#   cleanup) → explicit skip → unverified (no test artifact expected, NOT a fail). No LLM/external call.
#
# shellcheck disable=SC2154
#   TASK_TYPE / METRIC_PASS / RESULT / ATTRIBUTION_SOURCE / GRADER_BODY_TEXT / GRADER_FILES_FIELD
#   are caller-scope — set in track-outcome.sh (Bats test uses the same setup).
code_based_grader_check() {
  # 1) infra attribution → unverified (author-side only).
  case "${ATTRIBUTION_SOURCE:-}" in
    subagent-stop-missing | agent-id-missing | completion-missing | conversation-only)
      printf 'unverified\n'
      return 0
      ;;
    *) ;;
  esac

  # 2) non-success-family result → unverified (nothing to verify).
  case "${RESULT:-}" in
    done | done_with_concerns) ;;
    *)
      printf 'unverified\n'
      return 0
      ;;
  esac

  # 3) non-code task_types → explicit skip → unverified (no test artifact expected, NOT a fail).
  case "${TASK_TYPE:-}" in
    review | diagnosis | doc | cleanup)
      printf 'unverified\n'
      return 0
      ;;
    *) ;;
  esac

  # 4) writer did not claim metric_pass=true → unverified.
  if [[ "${METRIC_PASS:-}" != "true" ]]; then
    printf 'unverified\n'
    return 0
  fi

  local body="${GRADER_BODY_TEXT:-}"
  local files="${GRADER_FILES_FIELD:-}"

  # 5) narrow LLM09 zero-evidence guard — the SINGLE verified_fail path (all task_types):
  # result=done + metric_pass=true + ZERO evidence of ANY kind. Off-surface-heading absence is NOT this.
  if _cbg_zero_evidence "${body}" "${files}"; then
    printf 'verified_fail\n'
    return 0
  fi

  # 6) per-task-type verified_pass check. DEFAULT = unverified (off-surface / no structured signal).
  # Only a block-resident structured field promotes; absence → unverified, NEVER verified_fail (step 5 only).
  case "${TASK_TYPE:-}" in
    bug-fix)
      # block-resident: test/spec (word-bounded, common inflections) co-occurring
      # with pass / green / "exit 0". Boundaries stop bare-substring false promotes
      # ("laTEST passWORD" no longer matches).
      if [[ "${body}" =~ (^|[^[:alpha:]])(test|spec)(s|ed|ing)?([^[:alpha:]]|$) ]] \
        && [[ "${body}" =~ (^|[^[:alpha:]])(pass(es|ed|ing)?|green|exit[[:space:]]0)([^[:alpha:]]|$) ]]; then
        printf 'verified_pass\n'
      else
        printf 'unverified\n'
      fi
      ;;
    feature)
      # test/spec file path in files: → verified_pass; absence → unverified.
      # (Empty files_modified defaults here — acknowledged data loss, NOT a fail.)
      # word-bounded test/spec (same technique as bug-fix) so an embedded substring
      # ("latest.ts", "respect.rb") no longer false-promotes; "foo.test.ts" still does.
      if [[ "${files}" =~ (^|[^[:alpha:]])(test|spec)(s|ed|ing)?([^[:space:],[:alpha:]][^[:space:],]*)?\.(ts|tsx|js|jsx|py|sh|bats|rb|go|java|kt) ]]; then
        printf 'verified_pass\n'
      else
        printf 'unverified\n'
      fi
      ;;
    refactor | plan | research)
      # No reliable block-resident structured signal → unverified by task_type ALONE:
      #   refactor — the gameable free-text "existing tests pass" check is DROPPED (Gaming-the-Judge avoidance).
      #   plan/research — their markers live off-surface in the separate doc, invisible to the grader.
      printf 'unverified\n'
      ;;
    *)
      # unknown task_type → unverified. LOCKSTEP SoT: off-role reclassification runs upstream in
      # track-outcome.sh (role default) before this grader sees TASK_TYPE. Third consumer of the
      # shared Role → Allowed contract — must agree with guess_task_type + _norm_task_type.
      printf 'unverified\n'
      ;;
  esac
}

# _cbg_zero_evidence — true when the deliverable carries ZERO evidence of ANY kind: blank files:
# field AND no source/URL AND empty body (any one present → false). Drives the single verified_fail
# path (narrow LLM09 misinformation guard); reads its two positional args, no caller-scope var.
_cbg_zero_evidence() {
  local body="${1:-}"
  local files="${2:-}"
  if [[ -n "${files//[[:space:]]/}" ]]; then
    return 1
  fi
  if [[ "${body}" =~ [Ss]ources?: ]] || [[ "${body}" =~ https?:// ]]; then
    return 1
  fi
  if [[ -n "${body//[[:space:]]/}" ]]; then
    return 1
  fi
  return 0
}
