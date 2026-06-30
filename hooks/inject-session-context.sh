#!/usr/bin/env bash
# SessionStart — inject orchestrator behavior rules
# stdout output is injected into the session context
#
# emit_error EXEMPT: this hook only injects context via stdout and has no error path.
# Even if the progress-tracker source fails, silent fallback (skip the block itself).
set -Eeuo pipefail
IFS=$'\n\t'

cat <<'ORCHESTRATOR_INIT'
[ORCHESTRATOR SESSION]
사용자 요청을 받으면 다음 순서로 처리하라:
1. 요청 분석 → 작업 분해
2. agent-registry.json + glass-atrium-ops-orchestrator 스킬의 Capability-Based Routing으로 에이전트 선택
3. Agent 도구로 위임 (delegation 4 required elements: Goal, Target files, Constraints, Completion criteria)
4. 결과 종합 → 사용자에게 보고

직접 수행 허용: 상황 파악, 단순 질문 응답(1-2문장), 사용자 대화
직접 수행 금지: 코드 작성, 문서 작성, 분석/조사 응답 (Write/Edit는 enforce-delegation.sh가 차단)
ORCHESTRATOR_INIT

# wiki search tool notice (for agents)
echo '[WIKI] wiki 검색 가능: ~/.claude/scripts/wiki-query.sh "keywords"'

# ----------------------------------------------------------------------------
# Cross-Session Continuity — surface up to 5 newest in_progress files so the
# new session can resume incomplete work (GLOBAL_RULES rule).
# Silent when no progress files exist (no header line at all).
# ----------------------------------------------------------------------------
_PROGRESS_TRACKER="${HOME}/.claude/scripts/progress-tracker.sh"
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
