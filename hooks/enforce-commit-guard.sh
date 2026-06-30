#!/usr/bin/env bash
# PreToolUse hook: block dangerous git commands from the Bash tool
# exit code 2 = block the tool call
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
COMMAND=$(hook_get_tool_input "${INPUT}" "command")

# Dangerous command patterns — data-driven loop
# Format: regex|code|message|suggestion
RULES=(
  'git\s+push\s+.*--force|git\s+push\s+-f\b|GIT-001|Force push blocked|Request explicit user confirmation for force push'
  'git\s+reset\s+--hard|GIT-002|Hard reset blocked|Request explicit user confirmation for hard reset'
  'git\s+clean\s+-fd|GIT-003|Clean force-delete blocked|Request explicit user confirmation'
  'git\s+checkout\s+\.\s*$|GIT-004|Discard-all blocked|Request explicit user confirmation'
  'git\s+restore\s+\.\s*$|GIT-005|Restore-all blocked|Request explicit user confirmation'
  'git\s+push\s+\S+\s+(main|master)\b|GIT-006|Push to main/master blocked|Create a feature branch and use a pull request'
)

for rule in "${RULES[@]}"; do
  IFS='|' read -r pattern code message suggestion <<< "${rule}"
  if printf '%s' "${COMMAND}" | grep -qE "${pattern}"; then
    emit_error "${code}" "block" \
      "${message}" "${suggestion}" \
      "{\"command\":\"${COMMAND}\"}"
    exit 2
  fi
done

exit 0
