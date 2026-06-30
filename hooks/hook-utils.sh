#!/usr/bin/env bash
# hook-utils.sh — Shared utility library for Claude Code hooks
#
# Usage: source "${BASH_SOURCE%/*}/hook-utils.sh"
#
# Provides common functions for hook scripts:
#   hook_read_input     — Read JSON from stdin
#   hook_get_field      — Extract top-level JSON field
#   hook_get_tool_input — Extract tool_input sub-field
#   hook_emit_error     — Structured JSON error to stderr
#   hook_log            — Diagnostic message to stderr
#   hook_is_subagent    — Check subagent context
#
# Dependencies: python3 (macOS system default)
# Compatibility: Bash 3.2+ (macOS stock)

# Guard against double-sourcing
if [[ -n "${_HOOK_UTILS_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _HOOK_UTILS_LOADED=1

# Read and return hook JSON input from stdin.
# Falls back to empty JSON object on read failure.
hook_read_input() {
  local input
  input="$(cat 2>/dev/null)" || true
  if [[ -z "${input}" ]]; then
    printf '%s\n' '{}'
  else
    printf '%s\n' "${input}"
  fi
}

# Extract a top-level field from JSON input.
# Args: $1=json_input $2=field_name
hook_get_field() {
  local input="${1}" field="${2}"
  printf '%s\n' "${input}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get(sys.argv[1], ''))
" "${field}" 2>/dev/null || printf '%s\n' ""
}

# Extract a field from the tool_input sub-object.
# Args: $1=json_input $2=field_name
hook_get_tool_input() {
  local input="${1}" field="${2}"
  printf '%s\n' "${input}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('tool_input', {}).get(sys.argv[1], ''))
" "${field}" 2>/dev/null || printf '%s\n' ""
}

# Emit a structured JSON error object to stderr.
# Args: $1=error_code $2=severity $3=message
#       $4=suggestion (optional) $5=context_json (optional, default "{}")
hook_emit_error() {
  local hook_name code="${1}" severity="${2}" message="${3}"
  local suggestion="${4:-}" ctx="${5:-"{}"}"
  hook_name="$(basename "${BASH_SOURCE[1]:-${0}}" .sh)"
  printf '{"hook":"%s","error_code":"%s","severity":"%s","message":"%s","suggestion":"%s","context":%s}\n' \
    "${hook_name}" "${code}" "${severity}" "${message}" "${suggestion}" "${ctx}" >&2
}

# Log a diagnostic message to stderr with the caller's hook name.
# Args: $1=message
hook_log() {
  local hook_name
  hook_name="$(basename "${BASH_SOURCE[1]:-${0}}" .sh)"
  printf '%s\n' "[${hook_name}] ${1}" >&2
}

# Check whether the hook is running in a subagent context.
# Args: $1=json_input
# Returns: 0 if subagent, 1 if main session
hook_is_subagent() {
  local agent_id
  agent_id="$(hook_get_field "${1}" "agent_id")"
  [[ -n "${agent_id}" ]]
}

# Fail-closed python3 precondition guard — for SECURITY hooks ONLY.
# WHY: hook_get_field/hook_get_tool_input degrade to empty when python3 is absent
# (their trailing `2>/dev/null || printf ""`), which silently disarms a fail-open
# security gate (empty CONTENT = no match = allow). A security hook MUST instead
# fail CLOSED. This helper does not change the fail-soft extraction other hooks
# rely on — only the two security hooks opt in by calling it; everything else
# keeps its current behavior.
# Args: $1=block_code · $2=message. On python3 absent → emit_error(block) + exit 2.
hook_require_python3() {
  local code="${1}" message="${2}"
  command -v python3 >/dev/null 2>&1 && return 0
  emit_error "${code}" "block" "${message}" \
    "Install python3 (required for hook input parsing) and retry" \
    "{\"missing\":\"python3\"}"
  exit 2
}

# Allowlist-transform an external identifier to a path-safe single segment.
# WHY: LLM01 path-traversal defense — external payload (agent_id / agent_type) interpolated into a
# filesystem path must be reduced to [A-Za-z0-9_-] so "../" and other traversal bytes cannot escape.
# Callers keep their own empty-result fail-open guard (a fully-stripped value returns empty here).
# Args: $1=raw_identifier · stdout: sanitized segment (may be empty).
hook_path_safe_key() { printf '%s' "${1}" | tr -cd 'A-Za-z0-9_-'; }

# Common directories (shared constants)
HOOK_LOG_DIR="${HOME}/.claude/logs"
HOOK_DATA_DIR="${HOME}/.claude/data"

# English-only alias for hooks using the 5-param emit_error signature.
# Maps: emit_error(code, severity, message, suggestion, ctx)
#   to: hook_emit_error(code, severity, message, suggestion, ctx)
emit_error() {
  local code="${1}" severity="${2}" message="${3}"
  local suggestion="${4:-}" ctx="${5:-"{}"}"
  hook_emit_error "${code}" "${severity}" "${message}" "${suggestion}" "${ctx}"
}
