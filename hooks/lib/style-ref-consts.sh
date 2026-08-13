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

# The reason-token registry + channel sets, and the roster of agents the probe block is delivered
# to. Sourced here (not assumed from the caller) so the Bats test and the hook load one predicate.
# shellcheck source=lib/review-flag-reasons.sh
source "${BASH_SOURCE%/*}/review-flag-reasons.sh"
# shellcheck source=lib/styleref-roster.sh
source "${BASH_SOURCE%/*}/styleref-roster.sh"

# style_ref missing + task_type ∈ {feature,bug-fix,refactor} → review_flag=true, reason stamped.
# Caller-scope: reads STYLE_REF / TASK_TYPE / ATTRIBUTION_SOURCE / AGENT_TYPE, writes REVIEW_FLAG.
# Exempt (REVIEW_FLAG unchanged): STYLE_REF non-empty (Probe ran) · task_type ∉ the 3 code types ·
#   ATTRIBUTION_SOURCE outside WRITER_ATTRIBUTION_SOURCES (no writer emission to hold responsible) ·
#   a registered agent outside STYLEREF_AGENTS (the probe instruction was never delivered to it).
# An UNREGISTERED agent flags under its own reason instead of the omission one: the ephemeral name
# is an orchestration defect, and charging it as a probe omission mis-attributes it to the writer.
# OPTIONAL — no result escalation, review_flag only (Gaming-the-Judge avoidance).
#
# shellcheck disable=SC2154
#   TASK_TYPE / ATTRIBUTION_SOURCE / AGENT_TYPE are caller-scope — set in track-outcome.sh;
#   the Bats test assigns them on the setup line just before the call.
# shellcheck disable=SC2034
#   REVIEW_FLAG is read by the caller (track-outcome.sh init + PG envelope).
style_ref_compute_review_flag() {
  [[ -z "${STYLE_REF}" ]] || return 0

  # task_type allowlist is an in-function literal case-glob — avoids exposing a PATTERN constant (no SC2034, no glob fragility).
  case "${TASK_TYPE}" in
    feature | bug-fix | refactor) ;;
    *) return 0 ;;
  esac

  attribution_in_set "${ATTRIBUTION_SOURCE}" "${WRITER_ATTRIBUTION_SOURCES}" || return 0

  if ! agent_registry_has "${AGENT_TYPE:-}"; then
    REVIEW_FLAG="true"
    review_flag_add_reason "unregistered-agent-probe-exempt"
    return 0
  fi

  attribution_in_set "${AGENT_TYPE:-}" "${STYLEREF_AGENTS}" || return 0

  REVIEW_FLAG="true"
  review_flag_add_reason "probe-omission"
}

# Cross-layer SoT — the bash-side single location for the "greenfield" literal. Mirrored in 3 layers:
#   bash (here) · Python heredoc in ~/.claude/hooks/style-ref-verify.sh · TS const in
#   ~/.glass-atrium/monitor/src/server/routes/improvement.ts. On value change ALL 3 MUST be edited
#   together — no automatic enforcement (manual sync).
# shellcheck disable=SC2034
#   STYLE_REF_GREENFIELD is read by the source-er — an intended export of this declaration-only file.
readonly STYLE_REF_GREENFIELD='greenfield'
