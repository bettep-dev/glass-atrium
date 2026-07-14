#!/usr/bin/env bash
# PreToolUse hook: block dangerous git commands from the Bash tool
# exit code 2 = block the tool call
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
COMMAND=$(hook_get_tool_input "${INPUT}" "command")

# Dangerous command patterns — data-driven loop.
# Field delimiter is US (Unit Separator, 0x1F) — a control byte that can never
# appear inside a regex or a human-readable message. A regex '|' alternation is
# therefore preserved intact. The previous pipe ('|') delimiter collided with the
# alternation inside the force-push / push-to-main patterns: the split truncated
# each pattern mid-regex, silently disarming both blocks (and GIT-006 truncated to
# 'git\s+push\s+\S+\s+(main' — an unbalanced '(' that grep rejected as invalid).
# Format: regex<US>code<US>message<US>suggestion
readonly US=$'\x1f'
RULES=(
  "git\s+push\s+.*--force|git\s+push\s+-f\b${US}GIT-001${US}Force push blocked${US}Request explicit user confirmation for force push"
  "git\s+reset\s+--hard${US}GIT-002${US}Hard reset blocked${US}Request explicit user confirmation for hard reset"
  "git\s+clean\s+-fd${US}GIT-003${US}Clean force-delete blocked${US}Request explicit user confirmation"
  "git\s+checkout\s+\.\s*\$${US}GIT-004${US}Discard-all blocked${US}Request explicit user confirmation"
  "git\s+restore\s+\.\s*\$${US}GIT-005${US}Restore-all blocked${US}Request explicit user confirmation"
  "git\s+push\s+\S+\s+(main|master)\b${US}GIT-006${US}Push to main/master blocked${US}Create a feature branch and use a pull request"
)

# Rule-table lint (recurrence guard): assert a pattern compiles under grep -E
# before it is used to gate a command. A future delimiter collision that truncates
# a pattern into invalid regex must NOT silently disarm the gate — a non-compiling
# pattern fails CLOSED (block) rather than passing the command through.
pattern_compiles() {
  local pat="$1" rc
  # Empty-input probe: grep exits 1 (no match) for a valid regex, 2 for invalid.
  printf '' | grep -qE -- "${pat}" 2>/dev/null && rc=0 || rc=$?
  [[ "${rc}" -ne 2 ]]
}

for rule in "${RULES[@]}"; do
  IFS="${US}" read -r pattern code message suggestion <<<"${rule}"
  # SC2310: pattern_compiles is a pure predicate — set -e disable under `if !` is intended.
  # shellcheck disable=SC2310
  if ! pattern_compiles "${pattern}"; then
    emit_error "GIT-000" "block" \
      "commit-guard rule table malformed: pattern for ${code} does not compile" \
      "Fix the RULES table delimiter/escaping in enforce-commit-guard.sh" \
      "{\"rule\":\"${code}\"}"
    exit 2
  fi
  if printf '%s' "${COMMAND}" | grep -qE "${pattern}"; then
    emit_error "${code}" "block" \
      "${message}" "${suggestion}" \
      "{\"command\":\"${COMMAND}\"}"
    exit 2
  fi
done

exit 0
