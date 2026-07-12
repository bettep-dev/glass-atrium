#!/usr/bin/env bash
# hook-utils.sh — Shared utility library for Claude Code hooks.
# Usage: source "${BASH_SOURCE%/*}/hook-utils.sh"
# Dependencies: python3 (macOS system default) · Compatibility: Bash 3.2+ (macOS stock).

# Guard against double-sourcing
if [[ -n "${_HOOK_UTILS_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _HOOK_UTILS_LOADED=1

# Read hook JSON from stdin; empty read → empty JSON object.
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

# Single-pass multi-field extractor for TOP-LEVEL fields — parses the hook JSON input ONCE and
# emits each requested field's value in ONE python3 invocation (one interpreter cold-start instead
# of N). Per-field output is byte-identical to hook_get_field for the same key: str() of the value,
# missing key → empty, trailing newlines stripped to mirror the $() command-substitution capture,
# NUL-terminated in argument order (NUL keeps embedded-newline values intact — the one delimiter a
# JSON string cannot contain). Fail-open: python3 absent / malformed JSON / non-object root → every
# field degrades to empty, matching N sequential hook_get_field calls.
# Args: $1=json_input; $2..=top-level field names.
# Consume with one `IFS= read -r -d '' var` per field, e.g.:
#   { IFS= read -r -d '' a; IFS= read -r -d '' b; } < <(hook_get_fields "${input}" a b)
hook_get_fields() {
  local input="${1}" _f
  shift
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${input}" \
    | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
out = sys.stdout
for f in sys.argv[1:]:
    out.write(str(d.get(f, "")).rstrip("\n"))
    out.write("\0")
' "$@" 2>/dev/null || {
    # python3 absent / hard failure → N empty NUL-terminated values (parity with N× hook_get_field).
    for _f in "$@"; do
      printf '\0'
    done
  }
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

# Fail-closed python3 precondition guard — SECURITY hooks ONLY.
# WHY: hook_get_field/hook_get_tool_input degrade to empty when python3 is absent
# (trailing `2>/dev/null || printf ""`) → silently disarms a fail-open security gate
# (empty CONTENT = no match = allow); a security hook MUST fail CLOSED. Only the two
# security hooks opt in — fail-soft extraction for every other hook is unchanged.
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

HOOK_LOG_DIR="${HOME}/.claude/logs"
HOOK_DATA_DIR="${HOME}/.claude/data"

# English-only alias for hooks using the 5-param emit_error signature → hook_emit_error.
emit_error() {
  local code="${1}" severity="${2}" message="${3}"
  local suggestion="${4:-}" ctx="${5:-"{}"}"
  hook_emit_error "${code}" "${severity}" "${message}" "${suggestion}" "${ctx}"
}
