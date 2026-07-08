#!/usr/bin/env bash
# style-ref-consts.sh — Project Convention Probe (style_ref) single SoT. Declaration-only,
# sourced by both the Bats test and the production hook (drift eliminated). Bash 3.2+ (macOS stock).
#
# style_ref_compute_review_flag — review_flag compute function.

# Double-source guard.
if [[ -n "${_STYLE_REF_CONSTS_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _STYLE_REF_CONSTS_LOADED=1

# style_ref missing + task_type ∈ {feature,bug-fix,refactor} → review_flag=true.
# Caller-scope: reads STYLE_REF / TASK_TYPE / ATTRIBUTION_SOURCE, writes REVIEW_FLAG.
# Exempt (REVIEW_FLAG unchanged): STYLE_REF non-empty (Probe ran) · task_type ∉ the 3 code types ·
#   ATTRIBUTION_SOURCE ∉ {hook-input, cron-derived} (instrumentation row, no writer).
# OPTIONAL — no result escalation, review_flag only (Gaming-the-Judge avoidance).
#
# shellcheck disable=SC2154
#   TASK_TYPE / ATTRIBUTION_SOURCE are caller-scope — set in track-outcome.sh (L595 / L483);
#   the Bats test assigns them on the setup line just before the call.
# shellcheck disable=SC2034
#   REVIEW_FLAG is read by the caller (track-outcome.sh L981 init + L1095 PG envelope).
style_ref_compute_review_flag() {
  # task_type allowlist is an in-function literal case-glob — avoids exposing a PATTERN constant (no SC2034, no glob fragility).
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

# Cross-layer SoT — the bash-side single location for the "greenfield" literal. Mirrored in 3 layers:
#   bash (here) · Python heredoc in ~/.claude/hooks/style-ref-verify.sh · TS const in
#   ~/.glass-atrium/monitor/src/server/routes/improvement.ts. On value change ALL 3 MUST be edited
#   together — no automatic enforcement (manual sync).
# shellcheck disable=SC2034
#   STYLE_REF_GREENFIELD is read by the source-er — an intended export of this declaration-only file.
readonly STYLE_REF_GREENFIELD='greenfield'
