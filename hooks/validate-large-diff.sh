#!/usr/bin/env bash
# PostToolUse(Edit|Write) — detect large changes
# On a 400+ line diff, recommend qa-code-reviewer review (advisory, non-blocking)
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# Threshold per ~/.claude/rules/core-git-workflow.md "PR 400-line split" rule
readonly LARGE_DIFF_THRESHOLD=400

# Fold the repo-detection into the first diff: `git diff` itself exits non-zero outside a work
# tree, so its exit code replaces the standalone `git rev-parse --is-inside-work-tree` probe —
# 2 git subprocesses per edit instead of 3 (1 on the non-repo path, which short-circuits here).
# Non-repo / bare repo → exit 0 (non-blocking advisory, unchanged). The unstaged + staged churn
# sum and the >threshold verdict are byte-identical to the prior separate-diff computation.
LINES=$(git diff --numstat 2>/dev/null | awk '{s+=$1+$2} END {print s+0}') || exit 0
STAGED=$(git diff --cached --numstat 2>/dev/null | awk '{s+=$1+$2} END {print s+0}')
TOTAL=$((LINES + STAGED))

if [[ "${TOTAL}" -gt "${LARGE_DIFF_THRESHOLD}" ]]; then
  emit_error "SCOPE-080" "info" \
    "Large diff detected (>${LARGE_DIFF_THRESHOLD} lines)" \
    "대규모 변경 감지 (${LARGE_DIFF_THRESHOLD}줄 초과)" \
    "Request qa-code-reviewer review before committing" \
    "커밋 전 qa-code-reviewer 리뷰를 요청하세요" \
    "{\"total_lines\":${TOTAL}}"
fi

exit 0
