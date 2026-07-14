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
# missing key → empty, trailing newlines AND NUL bytes stripped to mirror the $() command-substitution
# capture (bash drops NUL bytes), then NUL-terminated in argument order. The replace('\x00','') is
# required: json PERMITS \u0000 in a string (json.load decodes it to a real NUL) - a NUL is NOT a
# delimiter a JSON string cannot contain — and an un-stripped embedded NUL would truncate the
# `read -r -d ''` consumer mid-value, diverging from hook_get_field's $()-capture. Fail-open: python3
# absent / malformed JSON / non-object root → every field degrades to empty, matching N sequential
# hook_get_field calls.
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
    out.write(str(d.get(f, "")).rstrip("\n").replace("\x00", ""))
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

# Join all arguments into a single `|`-separated string — used to fold a pattern array into one ERE
# alternation (top-level `|` is lowest precedence, so each pattern's internal groups stay intact).
# Args: $@=strings · stdout: the joined string (no trailing newline).
hook_join_alt() {
  local IFS='|'
  printf '%s' "$*"
}

HOOK_LOG_DIR="${HOME}/.claude/logs"
HOOK_DATA_DIR="${HOME}/.claude/data"

# English-only alias for hooks using the 5-param emit_error signature → hook_emit_error.
emit_error() {
  local code="${1}" severity="${2}" message="${3}"
  local suggestion="${4:-}" ctx="${5:-"{}"}"
  hook_emit_error "${code}" "${severity}" "${message}" "${suggestion}" "${ctx}"
}

# Short-TTL single-integer read cache for best-effort advisory hooks. Optimization ONLY — lets a hook
# skip an expensive live source (a fresh DB connect) when the same value was read within the TTL.
# Read side. On a valid, fresh hit sets the global HOOK_CACHE_VALUE (the cached integer) and returns
# 0; ANY anomaly (unreadable / non-integer epoch-or-value / expired / future epoch / bad TTL) returns
# 1 → the caller MUST fall back to the live read (a real advisory value is never suppressed by a bad
# cache). Value domain is non-negative integers (token counts) — matching the advisory sources.
# The global-var return channel (not stdout) is deliberate: the caller invokes this DIRECTLY in an
# if-condition (`if hook_cache_read ...; then`), which disables set -e inside the function so the
# internal `return 1` miss paths never trip a caller's fail-open ERR trap — the same convention as
# scope_drift_read_cache (CACHED_* globals). A `$( )` capture would re-arm ERR in the subshell.
# File layout mirrors scope_drift_read_cache: line1=epoch, line2=value. Args: $1=cache_file $2=ttl_s.
hook_cache_read() {
  local cache_file="${1}" ttl="${2}"
  [[ -r "${cache_file}" ]] || return 1
  [[ "${ttl}" =~ ^[0-9]+$ ]] || return 1

  local cached_epoch cached_value now age
  {
    IFS= read -r cached_epoch || return 1
    IFS= read -r cached_value || return 1
  } <"${cache_file}"

  # Corrupt header/value (non-integer) → live read.
  [[ "${cached_epoch}" =~ ^[0-9]+$ ]] || return 1
  [[ "${cached_value}" =~ ^[0-9]+$ ]] || return 1

  # TTL freshness. A future epoch (clock skew) is treated as stale. Non-final-in-&&-list arithmetic,
  # so set -e/ERR ignore its false-exit (identical pattern to scope_drift_read_cache).
  now="$(date +%s)"
  [[ "${now}" =~ ^[0-9]+$ ]] || return 1
  ((now < cached_epoch)) && return 1
  age=$((now - cached_epoch))
  ((age > ttl)) && return 1

  # Cross-file return channel — consumed by the caller in the true-branch. SC2034: used elsewhere.
  # shellcheck disable=SC2034
  HOOK_CACHE_VALUE="${cached_value}"
  return 0
}

# Short-TTL cache — write side. Atomic temp+rename (same-FS). Best-effort: the caller swallows a
# non-zero return, so a write failure only forces a harmless live re-read next time. Prepends the
# current epoch as line 1, then one line per value in argument order; a multi-line value (e.g. a
# path list) MUST be the LAST arg so the read side's final slurp round-trips.
# Args: $1=cache_file  $2..=values (each its own line; last may be multi-line).
hook_cache_write() {
  local cache_file="${1}"
  shift
  local cache_dir tmp now v
  cache_dir="$(dirname "${cache_file}")"
  mkdir -p "${cache_dir}" || return 1
  now="$(date +%s)"
  tmp="${cache_file}.tmp.$$"
  if ! {
    printf '%s\n' "${now}"
    for v in "$@"; do
      printf '%s\n' "${v}"
    done
  } >"${tmp}"; then
    rm -f "${tmp}"
    return 1
  fi
  mv -f "${tmp}" "${cache_file}" || {
    rm -f "${tmp}"
    return 1
  }
  return 0
}
