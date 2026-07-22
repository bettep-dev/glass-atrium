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

# Escape a raw string for safe embedding as a JSON string value — pure-bash (Bash 3.2 ${//}),
# no jq/python dependency, so it is safe even in the python3-absent path (hook_require_python3
# emits an error PRECISELY when python3 is missing). Order matters: backslash FIRST, then the
# double-quote, then the common control chars. Args: $1=raw · stdout: escaped body (no quotes).
_hook_json_escape() {
  local s="${1}"
  # backslash FIRST (must precede the quote pass), then the double-quote, then common control chars.
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "${s}"
}

# Emit a structured JSON error object to stderr.
# Args: $1=error_code $2=severity $3=message
#       $4=suggestion (optional) $5=context_json (optional, default "{}")
# DF-21: message/suggestion are free text — a raw printf %s embed of a value carrying a " or \
# produced MALFORMED JSON. Build via jq (full JSON-correct escaping + validates ctx as a JSON
# fragment); on jq absent (or a jq parse failure) fall back to the pure-bash escaper so the object
# stays valid. ctx is a caller-supplied JSON fragment → --argjson (parsed, not re-quoted); an
# unparseable ctx degrades to {} rather than dropping the whole error.
hook_emit_error() {
  local hook_name code="${1}" severity="${2}" message="${3}"
  local suggestion="${4:-}" ctx="${5:-"{}"}"
  # ${0} = executed-hook identity at any call depth (hooks are executed, never sourced).
  # A fixed BASH_SOURCE index misnames wrapper-path callers (emit_error / hook_require_python3) as the library; bash 3.2 has no negative index.
  hook_name="$(basename "${0}" .sh)"
  if command -v jq >/dev/null 2>&1; then
    local _json
    if _json="$(jq -cn \
      --arg hook "${hook_name}" --arg code "${code}" --arg severity "${severity}" \
      --arg message "${message}" --arg suggestion "${suggestion}" --argjson context "${ctx}" \
      '{hook:$hook,error_code:$code,severity:$severity,message:$message,suggestion:$suggestion,context:$context}' 2>/dev/null)"; then
      printf '%s\n' "${_json}" >&2
      return 0
    fi
    if _json="$(jq -cn \
      --arg hook "${hook_name}" --arg code "${code}" --arg severity "${severity}" \
      --arg message "${message}" --arg suggestion "${suggestion}" \
      '{hook:$hook,error_code:$code,severity:$severity,message:$message,suggestion:$suggestion,context:{}}' 2>/dev/null)"; then
      printf '%s\n' "${_json}" >&2
      return 0
    fi
  fi
  local e_hook e_code e_sev e_msg e_sug
  e_hook="$(_hook_json_escape "${hook_name}")"
  e_code="$(_hook_json_escape "${code}")"
  e_sev="$(_hook_json_escape "${severity}")"
  e_msg="$(_hook_json_escape "${message}")"
  e_sug="$(_hook_json_escape "${suggestion}")"
  printf '{"hook":"%s","error_code":"%s","severity":"%s","message":"%s","suggestion":"%s","context":%s}\n' \
    "${e_hook}" "${e_code}" "${e_sev}" "${e_msg}" "${e_sug}" "${ctx}" >&2
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
# (empty CONTENT = no match = allow); a security hook MUST fail CLOSED. Opt-in is
# per-hook — the caller set (4) is derivable via
# `grep -l hook_require_python3 hooks/*.sh | grep -v hook-utils.sh`; the -v excludes THIS
# file, which the grep would otherwise self-match as a fifth "caller" for defining the function;
# fail-soft extraction for every other hook is unchanged.
# Args: $1=block_code · $2=message. On python3 absent → emit_error(block) + exit 2.
hook_require_python3() {
  local code="${1}" message="${2}"
  command -v python3 >/dev/null 2>&1 && return 0
  emit_error "${code}" "block" "${message}" \
    "Install python3 (required for hook input parsing) and retry" \
    "{\"missing\":\"python3\"}"
  exit 2
}

# Fail-closed python3 precondition, gated on there being real input to guard: empty
# stdin ("" / "{}" / "{ }") keeps the fail-open exit-0 contract (nothing to guard),
# any other input delegates to hook_require_python3 (block + exit 2 on absence).
# Args: $1=hook_input · $2=block_code · $3=message.
hook_require_python3_unless_empty() {
  local input="${1}" code="${2}" message="${3}"
  case "${input}" in
    "" | "{}" | "{ }") return 0 ;;
    *) hook_require_python3 "${code}" "${message}" ;;
  esac
}

# Normalize a POSIX path by collapsing "." and ".." segments without touching the
# filesystem (the target may not exist yet). Traversal-safety: "hooks/../x" resolves
# to "x", so a protected prefix cannot be dodged — and a protected segment cannot be
# forged — via "..". Args: $1 = path. Echoes the normalized path.
hook_normalize_path() {
  local path="${1}" seg
  local -a out=()
  local lead=""
  [[ "${path}" == /* ]] && lead="/"
  local saved_ifs="${IFS}"
  IFS='/'
  # Word-split on "/" intentionally to walk each segment.
  # shellcheck disable=SC2206
  local -a parts=(${path})
  IFS="${saved_ifs}"
  # ${arr[@]+"${arr[@]}"} guards empty-array expansion under set -u on bash 3.2.
  for seg in ${parts[@]+"${parts[@]}"}; do
    case "${seg}" in
      "" | ".") : ;;
      "..")
        # Pop the last real segment (do not pop past root / a leading "..").
        if [[ ${#out[@]} -gt 0 && "${out[${#out[@]} - 1]}" != ".." ]]; then
          unset 'out[${#out[@]}-1]'
          out=(${out[@]+"${out[@]}"})
        elif [[ -z "${lead}" ]]; then
          out+=("..")
        fi
        ;;
      *) out+=("${seg}") ;;
    esac
  done
  local joined=""
  if [[ ${#out[@]} -gt 0 ]]; then
    local saved_ifs2="${IFS}"
    IFS='/'
    joined="${out[*]}"
    IFS="${saved_ifs2}"
  fi
  printf '%s\n' "${lead}${joined}"
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

# Runtime log/data roots — HOME-anchored (GA_DATA_ROOT override), DECOUPLED from the install-tree GA_ROOT,
# which is unset in the CLI-fired-hook + launchd-daemon contexts these consumers run in. Python twin:
# hooks/ga_paths.py. Default-only change: an exported GA_DATA_ROOT still redirects both roots.
HOOK_LOG_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/logs"
HOOK_DATA_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data"

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

# Cached-or-live single-integer advisory read — the shared body of the two PreToolUse(Agent) advisory
# hooks (context-budget + spawn-cost), which differ only in env prefix, cache subdir, and live reader.
# A fresh within-TTL cache hit SKIPS the caller's expensive live source (psycopg import + connect); a
# miss/stale/unreadable/bypassed/error degrades to the live read (never suppresses the advisory, never
# fabricates a value). The stored + returned value is integer-normalized (non-digit bytes stripped,
# empty → 0) so a hit is byte-identical to the live path (verdict parity). Caching is disabled when the
# session key sanitizes to empty (no shared key) or <PREFIX>_CACHE_BYPASS is set. Per-hook config is
# resolved by ${!var} indirection (Bash 3.2-safe): <PREFIX>_CACHE_TTL (unset/non-integer → 10),
# <PREFIX>_CACHE_DIR (unset → HOOK_LOG_DIR/<default_subdir>), <PREFIX>_CACHE_BYPASS.
# live_fn MUST already be defined by the caller (dependency inversion) — it is dispatched as
# `live_fn <sid>` and must print the raw integer on stdout.
# Args: $1=env_prefix $2=default_cache_subdir $3=live_fn $4=session_id · stdout: the integer.
hook_cached_int_read() {
  local env_prefix="${1}" default_subdir="${2}" live_fn="${3}" sid="${4}"
  local ttl_var="${env_prefix}_CACHE_TTL" dir_var="${env_prefix}_CACHE_DIR"
  local bypass_var="${env_prefix}_CACHE_BYPASS"
  local ttl cache_dir cache_file safe_sid value

  ttl="${!ttl_var:-10}"
  [[ "${ttl}" =~ ^[0-9]+$ ]] || ttl=10
  safe_sid="$(hook_path_safe_key "${sid}")"
  cache_dir="${!dir_var:-${HOOK_LOG_DIR}/${default_subdir}}"
  cache_file=""
  [[ -n "${safe_sid}" ]] && cache_file="${cache_dir}/${safe_sid}.cache"

  # Cache hit → reuse (skips the caller's live source). Direct call in the if-condition (NOT $( )) so
  # set -e is disabled inside hook_cache_read → its miss `return 1` never trips a caller's fail-open ERR
  # trap; the hit value comes back via the global HOOK_CACHE_VALUE. Predicate call → SC2310.
  if [[ -n "${cache_file}" ]] && [[ -z "${!bypass_var:-}" ]]; then
    # shellcheck disable=SC2310
    if hook_cache_read "${cache_file}" "${ttl}"; then
      printf '%s\n' "${HOOK_CACHE_VALUE}"
      return 0
    fi
  fi

  # Live read + integer-normalize so the cached value equals the live value exactly.
  value="$("${live_fn}" "${sid}")"
  value="$(printf '%s' "${value}" | tr -cd '0-9')"
  [[ -z "${value}" ]] && value=0

  # Persist for subsequent same-session spawns (best-effort — a write failure only forces a re-read).
  if [[ -n "${cache_file}" ]]; then
    # shellcheck disable=SC2310
    hook_cache_write "${cache_file}" "${value}" || true
  fi

  printf '%s\n' "${value}"
  return 0
}
