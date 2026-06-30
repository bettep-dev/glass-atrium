#!/usr/bin/env bash
# code-based-grader.sh — 3-Tier Eval Grader, Code-Based tier.
#
# Usage: source "${BASH_SOURCE%/*}/lib/code-based-grader.sh"
#
# Provides:
#   code_based_grader_check — per-task-type deterministic 3-state verdict function
#     (verified_pass | unverified | verified_fail — advisory, never overwrites
#      the writer self-reported metric_pass; see core-outcome-record.md T1)
#
# Declaration-only — no main code path auto-runs on source.
# Sourced by the production hook (hooks/track-outcome.sh) → single SoT, no per-caller drift.
#
# Compatibility: Bash 3.2+ (macOS stock)
# Sibling exemplar: hook-utils.sh + style-ref-consts.sh (source guard + single SoT)

# Double-source guard — avoid function redefinition
# shellcheck disable=SC2317
#   return-after-||-true is the same source-guard pattern as sibling
#   style-ref-consts.sh. ShellCheck's unreachable verdict is a
#   source-context-unaware false-positive.
if [[ -n "${_CODE_BASED_GRADER_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _CODE_BASED_GRADER_LOADED=1

# code_based_grader_check — deterministic 3-state verdict on author-side metric_pass
#
# Inputs (caller-scope variables — SC2154 silenced via shellcheck directive):
#   TASK_TYPE             — bug-fix | feature | refactor | research | plan |
#                           review | diagnosis | doc | cleanup | (unknown)
#   METRIC_PASS           — true | false | "" (writer-side self-judge)
#   RESULT                — done | done_with_concerns | blocked | needs_context | fail
#   ATTRIBUTION_SOURCE    — hook-input | cron-derived | subagent-stop-missing |
#                           agent-id-missing | completion-missing | conversation-only
#   GRADER_BODY_TEXT      — outcome body text (block-scoped [COMPLETION] capture, bounded)
#   GRADER_FILES_FIELD    — [COMPLETION] files: field value (comma/space-separated, multi-line)
#
# Outputs (stdout — single token, 3-state per core-outcome-record.md T1):
#   verified_pass — writer's metric_pass=true claim corroborated by block-resident evidence
#   unverified    — no verification applicable (infra row / non-success result /
#                   non-code task_type / metric_pass≠true / unknown task_type / off-surface
#                   evidence / absent structured signal — the DEFAULT for every code type)
#   verified_fail — the narrow LLM09 zero-evidence guard ONLY: result=done + metric_pass=true
#                   + zero deliverable evidence of ANY kind (no files: paths, no sources/URLs,
#                   empty/no block body). Absence of an off-surface heading is NOT this case.
#
# Input-surface invariant (reconciled SoT — core-outcome-record.md grader_verdict guide):
#   The grader reads ONLY block-resident text + files: paths — it NEVER sees the off-surface
#   deliverable (plan/research doc in monitor.ClaudedDoc; diff/test files in the repo).
#   Therefore plan/research default to unverified by task_type ALONE, refactor has NO reliable
#   block-resident "behavior preserved" signal (→ unverified default), and the per-type marker
#   regexes that keyed on off-surface artifacts are REMOVED (they were structurally guaranteed
#   false-fails). Every retained check gates on a STRUCTURED field; magic-phrase prose is never
#   a pass/fail signal.
#
# Contract:
#   - the function itself always exit 0 (verdict only on stdout)
#   - the function READs caller-scope variables only — caller variable mutation forbidden
#   - metric_pass is the WRITER self-report; this verdict is ADVISORY (a SEPARATE
#     column) — the caller MUST NOT overwrite metric_pass from this token
#   - infra attribution is an unconditional unverified (author-side outcome only)
#   - the 4 non-code task_types (review/diagnosis/doc/cleanup) are an EXPLICIT
#     skip-with-reason → unverified (no test artifact expected — NOT a fail)
#   - per-case verification logic is short and deterministic — no LLM call / external fetch
#
# shellcheck disable=SC2154
#   TASK_TYPE / METRIC_PASS / RESULT / ATTRIBUTION_SOURCE / GRADER_BODY_TEXT /
#   GRADER_FILES_FIELD are caller-scope variables — set in track-outcome.sh.
#   The Bats test uses the same setup.
code_based_grader_check() {
  # 1) infra attribution row → unverified (author-side only)
  case "${ATTRIBUTION_SOURCE:-}" in
    subagent-stop-missing | agent-id-missing | completion-missing | conversation-only)
      printf 'unverified\n'
      return 0
      ;;
    *) ;;
  esac

  # 2) result is not a success-family value → unverified (nothing to verify)
  case "${RESULT:-}" in
    done | done_with_concerns) ;;
    *)
      printf 'unverified\n'
      return 0
      ;;
  esac

  # 3) non-code task_types → explicit skip-with-reason → unverified.
  # A verdict/diagnosis/document/hygiene deliverable expects NO test artifact, so its
  # absence is not a failure (NOT a fail).
  case "${TASK_TYPE:-}" in
    review | diagnosis | doc | cleanup)
      printf 'unverified\n'
      return 0
      ;;
    *) ;;
  esac

  # 4) writer did not claim metric_pass=true → unverified (no positive claim to verify)
  if [[ "${METRIC_PASS:-}" != "true" ]]; then
    printf 'unverified\n'
    return 0
  fi

  local body="${GRADER_BODY_TEXT:-}"
  local files="${GRADER_FILES_FIELD:-}"

  # 5) narrow LLM09 zero-evidence guard — the SINGLE verified_fail path across ALL task_types.
  # result=done + metric_pass=true (already established above) + ZERO deliverable evidence of
  # ANY kind → verified_fail. "Evidence of any kind" = a non-blank files: field OR any source/
  # URL reference OR a non-empty body. Absence of an off-surface heading is NOT this case.
  if _cbg_zero_evidence "${body}" "${files}"; then
    printf 'verified_fail\n'
    return 0
  fi

  # 6) per-task-type verified_pass check. DEFAULT = unverified (evidence is off-surface or no
  # block-resident structured signal exists). Only a block-resident structured field promotes
  # to verified_pass; its absence is unverified — NEVER verified_fail (that path is step 5 only).
  case "${TASK_TYPE:-}" in
    bug-fix)
      # block-resident: test/spec mention co-occurring with pass / green / "exit 0"
      if [[ "${body}" =~ (test|spec) ]] && [[ "${body}" =~ (pass(ed|ing)?|green|exit[[:space:]]0) ]]; then
        printf 'verified_pass\n'
      else
        printf 'unverified\n'
      fi
      ;;
    feature)
      # a test/spec file path in the files: field promotes to verified_pass; absence → unverified.
      # (Historical rows with empty files_modified default here — acknowledged data loss, NOT a fail.)
      if [[ "${files}" =~ (test|spec)[^[:space:],]*\.(ts|tsx|js|jsx|py|sh|bats|rb|go|java|kt) ]]; then
        printf 'verified_pass\n'
      else
        printf 'unverified\n'
      fi
      ;;
    refactor | plan | research)
      # No reliable block-resident structured signal:
      #   refactor — "behavior preserved" has no trustworthy block-resident marker (the gameable
      #              free-text "existing tests pass" check is DROPPED — Gaming-the-Judge avoidance).
      #   plan/research — markers (## Phase / ## Acceptance Criteria / Sources: / cited URLs) live
      #              off-surface in the separate doc, invisible to the grader.
      # → unverified by task_type ALONE (verified_fail is reachable only via step 5 zero-evidence).
      printf 'unverified\n'
      ;;
    *)
      # unknown task_type — unverified (no responsibility to assign a verdict).
      # LOCKSTEP SoT: the off-role reclassification runs upstream in track-outcome.sh
      # (role_task_type_allowed → role default) BEFORE this grader sees TASK_TYPE, so a
      # non-code agent's deliverable arrives already typed to its role default. This branch
      # is the third consumer of the shared Role → Allowed contract — agreeing with
      # guess_task_type (track-outcome.sh) and _norm_task_type (_pg_outcome_dualwrite.py).
      printf 'unverified\n'
      ;;
  esac
}

# _cbg_zero_evidence — true (exit 0) when the deliverable carries ZERO evidence of ANY kind:
# blank files: field AND no source/URL reference AND an empty body. Any one present → false.
# Drives the single verified_fail path (the narrow LLM09 misinformation guard). Reads only its
# two positional args; touches no caller-scope variable.
_cbg_zero_evidence() {
  local body="${1:-}"
  local files="${2:-}"
  # files: field carries a path → evidence present
  if [[ -n "${files//[[:space:]]/}" ]]; then
    return 1
  fi
  # body references a source / cited URL → evidence present
  if [[ "${body}" =~ [Ss]ources?: ]] || [[ "${body}" =~ https?:// ]]; then
    return 1
  fi
  # body carries any non-whitespace content → evidence present
  if [[ -n "${body//[[:space:]]/}" ]]; then
    return 1
  fi
  return 0
}
