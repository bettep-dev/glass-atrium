#!/usr/bin/env bash
# style-ref-consts.sh — Project Convention Probe (style_ref) single SoT.
#
# Usage: source "${BASH_SOURCE%/*}/lib/style-ref-consts.sh"
#
# Provides:
#   style_ref_compute_review_flag — review_flag compute function
#
# Declaration-only — no main code path auto-runs on source.
# Bats test + production hook both source the same file → drift risk eliminated.
#
# Compatibility: Bash 3.2+ (macOS stock)
# Sibling exemplar: hook-utils.sh (source guard + hook_* naming convention)

# Double-source guard — avoid function redefinition
if [[ -n "${_STYLE_REF_CONSTS_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _STYLE_REF_CONSTS_LOADED=1

# style_ref missing + task_type ∈ {feature,bug-fix,refactor} → review_flag=true
#
# Caller-scope contract:
#   reads:  STYLE_REF, TASK_TYPE, ATTRIBUTION_SOURCE
#   writes: REVIEW_FLAG ("true" or "false")
#
# Exemption conditions (REVIEW_FLAG unchanged):
#   - STYLE_REF non-empty (signal that the Project Convention Probe ran)
#   - TASK_TYPE ∉ {feature, bug-fix, refactor} (research / plan / report etc.)
#   - ATTRIBUTION_SOURCE ∉ {hook-input, cron-derived}
#     (instrumentation row — no writer, so not an ambiguity signal)
#
# OPTIONAL — no result escalation, review_flag only (Gaming-the-Judge avoidance).
#
# shellcheck disable=SC2154
#   TASK_TYPE / ATTRIBUTION_SOURCE are caller-scope variables — set in
#   track-outcome.sh L595 (TASK_TYPE) + L483 (ATTRIBUTION_SOURCE). They are
#   already assigned by the time the function is called. The Bats test also
#   assigns them on the setup line just before the call.
# shellcheck disable=SC2034
#   REVIEW_FLAG is read by the caller (track-outcome.sh L981 init + L1095 PG envelope).
style_ref_compute_review_flag() {
  # the task_type allowlist is an in-function literal case-glob — avoids exposing a PATTERN constant
  # (no SC2034, no glob fragility)
  if [[ -z "${STYLE_REF}" ]]; then
    case "${TASK_TYPE}" in
      feature | bug-fix | refactor)
        case "${ATTRIBUTION_SOURCE}" in
          hook-input | cron-derived)
            REVIEW_FLAG="true"
            ;;
          *) ;;
        esac
        ;;
      *) ;;
    esac
  fi
}

# Cross-layer SoT — the bash-side single location for the "greenfield" literal.
# Cross-layer mirror:
#   - Python: literal + comment cross-ref inside the heredoc in ~/.claude/hooks/style-ref-verify.sh
#   - TypeScript: ~/.glass-atrium/monitor/src/server/routes/improvement.ts module-private const
# On value change, all 3 layers MUST be edited together — no automatic enforcement (manual sync).
# shellcheck disable=SC2034
#   STYLE_REF_GREENFIELD is read by the source-er — an intended export of this declaration-only file.
readonly STYLE_REF_GREENFIELD='greenfield'
