#!/usr/bin/env bash
# PreToolUse(Bash) — block --no-verify, --no-gpg-sign
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
CMD=$(hook_get_tool_input "${INPUT}" "command")

if printf '%s' "${CMD}" | grep -qE '(git\s+commit\s+.*--no-verify|--no-gpg-sign|git\s+commit\s+.*\s-n\b)'; then
  emit_error "SEC-011" "block" \
    "Hook bypass flag blocked" \
    "Remove --no-verify / -n / --no-gpg-sign so the pre-commit hooks run; if signing is not configured, set it up or set commit.gpgsign false explicitly (core-git-workflow.md -> Commits)" \
    "{\"command\":\"${CMD}\"}"
  exit 2
fi
exit 0
