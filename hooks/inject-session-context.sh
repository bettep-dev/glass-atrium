#!/usr/bin/env bash
# SessionStart — inject orchestrator behavior rules
# stdout output is injected into the session context
#
# emit_error EXEMPT: this hook only injects context via stdout and has no error path.
# Even if the progress-tracker source fails, silent fallback (skip the block itself).
set -Eeuo pipefail
IFS=$'\n\t'

# [WORKFLOW PRE-FLIGHT] turn-0 line design decision (Thread A/B salience initiative, additive):
# The turn-0 line enumerates the THREE co-equal DEV-spawn requirements (entry token / [SIZE-EST] / verify-stage).
# DECISION: JS-authoring pitfalls (bash dollar-brace leak + nested backtick inside a dollar-brace interpolation)
# are DELIBERATELY kept OFF this turn-0 line to preserve one-legible-line readability. They live on the skill
# (glass-atrium-ops-orchestrator -> "Plain-JS script" bullet + Pre-submit self-check item 5) and the SoT
# (orchestrator-role.md -> ### Ultracode / Workflow-tool Mode JS-authoring pitfall bullet). Revisit ONLY if a
# 4th clause fits while the turn-0 line stays a single legible line.
cat <<'ORCHESTRATOR_INIT'
[ORCHESTRATOR SESSION]
사용자 요청을 받으면 다음 순서로 처리하라:
1. 요청 분석 → 작업 분해 (compound 축약 금지 · delegation당 >2 번들 or ~40 tool_use 예상 → 분할, 과분할 금지 · DEV: sizable→plan / simple→[ENTRY-CLASS] — SoT: orchestrator-role.md Decision row + ### Spawn Budget)
2. agent-registry.json + glass-atrium-ops-orchestrator 스킬의 Capability-Based Routing으로 에이전트 선택
3. Agent 도구로 위임 (delegation 6 required elements: Goal, Target files, Constraints, Completion criteria, Resource Budget, Ripple radius)
4. 결과 종합 → 사용자에게 보고
[WORKFLOW PRE-FLIGHT] dev-* spawn 스크립트 3대 필수 요건(consolidated: 스킬 glass-atrium-ops-orchestrator → "DEV-spawn 3-requirement pre-flight checklist"): ①plan-ref 또는 [ENTRY-CLASS] 토큰(log()/meta.description) ②[SIZE-EST] bundles=N tool_uses~=N 토큰(매 dev-* spawn, 같은 home) ③첫 dev-* 앞 {qa-code-reviewer, DEV} verify-stage — 셋 다 exit-2 gate는 backstop일 뿐, authoring 의무가 PRIMARY (→ orchestrator-role.md ### Ultracode / Workflow-tool Mode)

직접 수행 허용: 상황 파악, 단순 질문 응답(1-2문장), 사용자 대화
직접 수행 금지: 코드 작성, 문서 작성, 분석/조사 응답 (Write/Edit는 enforce-delegation.sh가 차단)
ORCHESTRATOR_INIT

# wiki search tool notice (for agents)
echo '[WIKI] wiki 검색 가능: ~/.glass-atrium/scripts/wiki-query.sh "keywords"'

# ----------------------------------------------------------------------------
# Cross-Session Continuity — surface up to 5 newest in_progress files so the
# new session can resume incomplete work (GLOBAL_RULES rule).
# Silent when no progress files exist (no header line at all).
# ----------------------------------------------------------------------------
# Store-root form: scripts/ is consumed in place from the store — the
# ~/.claude/scripts farm is gone (hooks/ and scripts/ are sibling store dirs).
_PROGRESS_TRACKER="${HOME}/.glass-atrium/scripts/progress-tracker.sh"
if [[ -r "${_PROGRESS_TRACKER}" ]]; then
  # shellcheck source=/dev/null
  source "${_PROGRESS_TRACKER}"
  _open_paths=()
  # shellcheck disable=SC2312  # progress_list_open returns 0 by contract
  while IFS= read -r _line; do
    [[ -n "${_line}" ]] || continue
    _open_paths+=("${_line}")
    [[ ${#_open_paths[@]} -ge 5 ]] && break
  done < <(progress_list_open)

  if [[ ${#_open_paths[@]} -gt 0 ]]; then
    # Comma-separated single line — easy for downstream prompt parsers.
    _joined=""
    for _p in "${_open_paths[@]}"; do
      if [[ -z "${_joined}" ]]; then
        _joined="${_p}"
      else
        _joined="${_joined}, ${_p}"
      fi
    done
    printf '[CONTINUITY] open progress files: %s\n' "${_joined}"
  fi
fi
