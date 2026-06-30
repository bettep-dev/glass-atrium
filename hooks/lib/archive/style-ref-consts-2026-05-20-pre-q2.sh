#!/usr/bin/env bash
# style-ref-consts.sh — Project Convention Probe (style_ref) AC-B2 단일 SoT
#
# Usage: source "${BASH_SOURCE%/*}/lib/style-ref-consts.sh"
#
# Provides:
#   style_ref_compute_review_flag — AC-B2 review_flag 산출 함수
#
# Declaration-only — source 시 main code path 자동 실행 없음.
# Bats test + production hook 양쪽이 동일 file source → drift risk 제거.
#
# Compatibility: Bash 3.2+ (macOS stock)
# Sibling exemplar: hook-utils.sh (source guard + hook_* naming convention)

# 중복 source 방어 — function 재정의 회피
if [[ -n "${_STYLE_REF_CONSTS_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _STYLE_REF_CONSTS_LOADED=1

# AC-B2: style_ref 누락 + task_type ∈ {feature,bug-fix,refactor} → review_flag=true
#
# Caller-scope contract:
#   reads:  STYLE_REF, TASK_TYPE, ATTRIBUTION_SOURCE
#   writes: REVIEW_FLAG ("true" or "false")
#
# 면제 조건 (REVIEW_FLAG unchanged):
#   - STYLE_REF non-empty (Project Convention Probe 수행 신호)
#   - TASK_TYPE ∉ {feature, bug-fix, refactor} (research / plan / report 등)
#   - ATTRIBUTION_SOURCE ∉ {hook-input, cron-derived}
#     (instrumentation row — writer 부재이므로 모호성 신호 아님)
#
# v1.0 OPTIONAL — result 격상 없음, review_flag 만 (Gaming-the-Judge 회피).
#
# shellcheck disable=SC2154
#   TASK_TYPE / ATTRIBUTION_SOURCE 는 caller-scope 변수 — outcome-record.sh
#   L595 (TASK_TYPE) + L483 (ATTRIBUTION_SOURCE) 에서 set 됨. 함수가 호출되는
#   시점에 이미 assigned. Bats test 도 함수 호출 직전 setup line 에서 assign.
# shellcheck disable=SC2034
#   REVIEW_FLAG 는 caller 가 읽음 (outcome-record.sh L981 init + L1095 PG envelope).
style_ref_compute_review_flag() {
  # task_type allowlist 는 함수 내부 literal case-glob — PATTERN 상수 노출 회피
  # (shell-dev M3: SC2034 + glob fragility 제거)
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
