#!/usr/bin/env bash
# PreToolUse(Bash) — block dangerous commands
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
CMD=$(hook_get_tool_input "${INPUT}" "command")

if printf '%s' "${CMD}" | grep -qE '(rm\s+-rf\s+/($|[^a-zA-Z])|rm\s+-rf\s+/\*|rm\s+-rf\s+~|rm\s+-rf\s+\$HOME|rm\s+-rf\s+\.\s*$|rm\s+-rf\s+\.\.|chmod\s+777|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|curl\s+.*\|\s*bash|dd\s+if=|mkfs\.|:\(\)\{|fork\s*bomb)'; then
  emit_error "SEC-010" "block" \
    "Dangerous system command blocked" \
    "Request explicit user confirmation before executing" \
    "{\"command\":\"${CMD}\"}"
  exit 2
fi
exit 0
