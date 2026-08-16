#!/usr/bin/env bash
# PreToolUse(Edit|Write) — Scope Drift Detection
# Compares two allowed-path sources — the plan's target-file list and the delegation's `[SCOPE]
# files=` declaration — against the actual edit target, and warns when the file matches NEITHER
# (exit 0, non-blocking).
#
# ADVISORY, never a block: the shared predicate matches on partial paths and basenames, so a
# false SCOPE-070 is structurally possible; promoting this to exit 2 would punish correct work
# on a predicate that cannot carry it. Promotion needs accumulated false-positive data and an
# explicit user decision, not a coverage milestone.
#
# Coverage limit of the `[SCOPE]` source: the declaration is read from the SUBAGENT transcript's
# record 0, so it covers subagent edits only. A main-session edit carries no agent_id, the
# delegation prompt is unreachable, and the leg fails open.
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"
# shellcheck source=lib/hook-utils.sh
source "${BASH_SOURCE%/*}/lib/hook-utils.sh"

# Monitor-API config — env-overridable (test isolation), loopback-pinned.
# Default-URL port derived via the hook_monitor_port wrapper (ADR-1: env →
# monitor/.env → config → 16145); NO literal fallback here (the single default lives
# in the resolver). A full SCOPE_DRIFT_MONITOR_URL override wins over the derived
# default; a resolver failure degrades to '' (non-bindable URL, fire-and-forget).
monitor_port="$(hook_monitor_port || true)"
MONITOR_URL="${SCOPE_DRIFT_MONITOR_URL:-http://127.0.0.1:${monitor_port}/api/clauded-docs}"
CURL_TIMEOUT="${SCOPE_DRIFT_CURL_TIMEOUT:-2}"

# The comparison predicate + the `[SCOPE]` declaration parsers live in lib/ so this hook and the
# recorder's scope-excess leg share ONE definition.
# shellcheck source=lib/scope-match.sh
source "${BASH_SOURCE%/*}/lib/scope-match.sh"

# Extract path-like tokens from the `<section id="target-files">` slice → newline list.
# Relies on the T1 flat-leaf contract (slices to the first </section>). sed-only (no awk).
# P1 nesting guard: a nested opening <section> in the slice violates the leaf contract → a
# truncated list could mis-fire SCOPE-070, so emit empty (fail-open, no guessing).
# Args: $1=html body. Prints cleaned list to stdout (empty on parse anomaly · always return 0).
extract_target_files_section() {
  local body="${1}"
  # Flatten to one line, then slice between opening tag and first </section>.
  local flattened from_open sliced
  flattened="$(printf '%s' "${body}" | tr '\n' ' ')"

  # After the opening tag (close not yet applied) — source for the nesting guard.
  from_open="$(printf '%s' "${flattened}" \
    | sed -n 's/.*<section[^>]*id="target-files"[^>]*>\(.*\)/\1/p')"
  [[ -z "${from_open}" ]] && return 0

  sliced="$(printf '%s' "${from_open}" | sed 's/<\/section>.*//')"
  [[ -z "${sliced}" ]] && return 0

  # P1 guard: nested opening <section> → leaf violation → fail-open.
  if printf '%s' "${sliced}" | grep -q '<section[^>]*>'; then
    return 0
  fi

  # <li>/<br> → newlines (one item per line), then strip remaining tags + decode entities.
  printf '%s' "${sliced}" \
    | sed 's/<li[^>]*>/\n/g; s/<\/li>/\n/g; s/<br[^>]*>/\n/g' \
    | sed 's/<[^>]*>//g' \
    | sed 's/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g'
}

# Shared drift decision — match file_path against the resolved target list; on no-match emit the
# SCOPE-070 advisory (exit 0, non-blocking). Called by BOTH the live-resolution and cache-hit
# branches so the verdict is identical by construction, independent of where the list came from.
# Args: $1=file_path  $2=allowed_files  $3=plan_id
check_drift_and_emit() {
  local file_path="${1}" allowed_files="${2}" plan_id="${3}"
  # Intended predicate call (explicit return 0/1, no set -e reliance) → SC2310 disabled.
  # shellcheck disable=SC2310
  if ! match_file_against_allowed "${file_path}" "${allowed_files}"; then
    emit_error "SCOPE-070" "advisory" \
      "Scope drift: file not in plan target list" \
      "Update plan target files or confirm the modification is intentional" \
      "{\"file\":\"${file_path}\",\"source\":\"plan-doc\",\"plan_id\":${plan_id}}"
  fi
}

# Per-session resolution cache (plan id + target-file list) — read side. On a valid, fresh,
# non-empty hit: sets CACHED_PLAN_ID + CACHED_ALLOWED_FILES and returns 0. Any anomaly (unreadable /
# truncated / non-integer header / expired / no path-like token) returns 1 → the caller falls back
# to the live loopback (fail-open — a real drift detection is never suppressed by a bad cache).
# Args: $1=cache_file
scope_drift_read_cache() {
  local cache_file="${1}"
  [[ -r "${cache_file}" ]] || return 1

  local cached_epoch cached_plan_id cached_files now ttl age
  {
    IFS= read -r cached_epoch || return 1
    IFS= read -r cached_plan_id || return 1
    cached_files="$(cat)"
  } <"${cache_file}"

  # Corrupt header (non-integer epoch / id) → live lookup.
  [[ "${cached_epoch}" =~ ^[0-9]+$ ]] || return 1
  [[ "${cached_plan_id}" =~ ^[0-9]+$ ]] || return 1

  # TTL freshness bounds mid-session plan-supersede staleness. A future epoch (clock skew) is
  # treated as stale. Default 300s, env-overridable; a non-integer override falls back to 300.
  now="$(date +%s)"
  [[ "${now}" =~ ^[0-9]+$ ]] || return 1
  ttl="${SCOPE_DRIFT_CACHE_TTL:-300}"
  [[ "${ttl}" =~ ^[0-9]+$ ]] || ttl=300
  ((now < cached_epoch)) && return 1
  age=$((now - cached_epoch))
  ((age > ttl)) && return 1

  # Re-validate the cached list exactly as the live path does (non-empty + a path-like token).
  [[ -z "${cached_files}" ]] && return 1
  printf '%s' "${cached_files}" | grep -q '[./]' || return 1

  CACHED_PLAN_ID="${cached_plan_id}"
  CACHED_ALLOWED_FILES="${cached_files}"
  return 0
}

# Per-session resolution cache — write side. Delegates to the shared variadic writer: epoch is line 1,
# plan_id line 2, and the (multi-line) allowed-files list stays LAST so the read side's slurp round-
# trips. Best-effort — a write failure only forces a harmless re-resolve on the next edit.
# Args: $1=cache_file  $2=plan_id  $3=allowed_files
scope_drift_write_cache() {
  hook_cache_write "${1}" "${2}" "${3}"
}

# Drain stdin once — capture file_path before any branch (needed for the system-path
# short-circuit). Non-zero/empty input → fail-open.
INPUT=$(cat 2>/dev/null) || exit 0
FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

# Branch-root grammar, single-sited in lib/ — the config-dir predicate below covers every
# `~/.claude-*` profile branch. This hook is fail-OPEN by design (a false SCOPE-070 is forbidden),
# so an unreadable lib passes silently instead of degrading the short-circuit.
# shellcheck source=lib/claude-config-dirs.sh
source "${BASH_SOURCE%/*}/lib/claude-config-dirs.sh" || exit 0

# System file paths always allowed — highest-priority short-circuit (silent, no advisory noise).
# Absent file_path → do NOT short-circuit (empty path is not a system path).
# Intended predicate call (exit status IS the answer, no set -e reliance) → SC2310 disabled.
# shellcheck disable=SC2310
if [[ -n "${FILE_PATH}" ]] \
  && { [[ "${FILE_PATH}" == */memory/* ]] \
    || claude_config_is_branch_path "${FILE_PATH}"; }; then
  exit 0
fi

# Second allowed-path source — the delegation's `[SCOPE] files=` declaration, read from record 0
# of the spawning subagent's own transcript. Covers the everyday delegation that has no plan doc
# at all. A match here is authoritative (union semantics: either source may allow the edit); a
# non-match emits its own advisory and lets the plan-doc leg below reach its own verdict.
# Resolution is cached per agent_id in the existing per-session cache shape (same helpers, same
# TTL and bypass env) — the sentinel below caches the far more common "no declaration" answer
# too, so an undeclared delegation re-parses no transcript on later edits.
SCOPE_DECL_NONE_SENTINEL='./no-scope-declaration'
scope_decl_resolve() {
  local agent_id session_id safe_key cache_file tpath decl_line files
  agent_id="$(echo "${INPUT}" | jq -r '.agent_id // ""' 2>/dev/null || true)"
  session_id="$(echo "${INPUT}" | jq -r '.session_id // ""' 2>/dev/null || true)"
  [[ -n "${agent_id}" ]] && [[ -n "${session_id}" ]] || return 0

  safe_key="$(hook_path_safe_key "${agent_id}")"
  cache_file=""
  if [[ -n "${safe_key}" ]]; then
    cache_file="${SCOPE_DRIFT_CACHE_DIR:-${HOOK_LOG_DIR}/scope-drift-plancache}/scope-decl-${safe_key}.cache"
  fi
  # shellcheck disable=SC2310
  #   Predicate call — the exit status IS the answer (cache hit vs re-resolve).
  if [[ -n "${cache_file}" ]] && [[ -z "${SCOPE_DRIFT_CACHE_BYPASS:-}" ]] \
    && scope_drift_read_cache "${cache_file}"; then
    printf '%s' "${CACHED_ALLOWED_FILES}"
    return 0
  fi

  tpath=""
  for tpath in "${HOME}/.claude/projects/"*"/${session_id}/subagents/agent-${agent_id}.jsonl" \
    "${HOME}/.claude/projects/"*"/${session_id}/subagents/workflows/wf_"*"/agent-${agent_id}.jsonl"; do
    [[ -f "${tpath}" ]] && break
    tpath=""
  done

  files=""
  if [[ -n "${tpath}" ]]; then
    decl_line="$(scope_decl_from_record0 "${tpath}")"
    [[ -n "${decl_line}" ]] && files="$(scope_decl_files "${decl_line}")"
  fi
  [[ -z "${files}" ]] && files="${SCOPE_DECL_NONE_SENTINEL}"

  if [[ -n "${cache_file}" ]]; then
    # shellcheck disable=SC2310
    #   Best-effort cache write — a failure only forces a re-resolve on the next edit.
    scope_drift_write_cache "${cache_file}" "0" "${files}" || true
  fi
  printf '%s' "${files}"
}

if [[ -n "${FILE_PATH}" ]]; then
  SCOPE_DECL_FILES="$(scope_decl_resolve)"
  if [[ -n "${SCOPE_DECL_FILES}" ]] && [[ "${SCOPE_DECL_FILES}" != "${SCOPE_DECL_NONE_SENTINEL}" ]]; then
    # shellcheck disable=SC2310
    #   Predicate call — the exit status IS the answer (declared vs undeclared path).
    if match_file_against_allowed "${FILE_PATH}" "${SCOPE_DECL_FILES}"; then
      exit 0
    fi
    emit_error "SCOPE-070" "advisory" \
      "Scope drift: file not in the delegation [SCOPE] files= declaration" \
      "Widen the delegation [SCOPE] declaration or confirm the modification is intentional" \
      "{\"file\":\"${FILE_PATH}\",\"source\":\"scope-decl\"}"
  fi
fi

# PLAN_FILE unset → auto-restore per-file scope binding via the monitor API: pick the in-progress
# doc → GET its HTML body → parse `<section id="target-files">` → feed the same match loop.
# fail-open (a false-positive SCOPE-070 is forbidden): curl absent / monitor down / 0 or ambiguous
# docs / GET failure / section absent / 0 path-like tokens → pass silently, never promote to SCOPE-070.
if [[ -z "${PLAN_FILE:-}" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    exit 0
  fi

  # file_path absent → no per-file matching → skip the API call.
  [[ -z "${FILE_PATH}" ]] && exit 0

  # Per-session resolution cache (plan id + target-file list) — optimization only. A hit skips
  # BOTH loopback curls + the HTML re-parse below; a miss / stale / corrupt / unreadable cache
  # falls back to the live lookup (fail-open — a real drift detection is never suppressed).
  # Keyed on session_id: a changed PLAN_FILE takes the branch above (cache untouched), and
  # SCOPE_DRIFT_CACHE_BYPASS forces a fresh resolve (explicit refresh signal). Empty session id →
  # caching disabled (no shared key) so distinct sessions never collide.
  SESSION_ID=$(echo "${INPUT}" | jq -r '.session_id // ""' 2>/dev/null || true)
  SAFE_SID="$(hook_path_safe_key "${SESSION_ID}")"
  CACHE_DIR="${SCOPE_DRIFT_CACHE_DIR:-${HOOK_LOG_DIR}/scope-drift-plancache}"
  CACHE_FILE=""
  if [[ -n "${SAFE_SID}" ]]; then
    CACHE_FILE="${CACHE_DIR}/${SAFE_SID}.cache"
  fi

  # Cache hit → reuse the resolved list, skip both curls + the parse. Predicate call → SC2310.
  # shellcheck disable=SC2310
  if [[ -n "${CACHE_FILE}" ]] && [[ -z "${SCOPE_DRIFT_CACHE_BYPASS:-}" ]] \
    && scope_drift_read_cache "${CACHE_FILE}"; then
    check_drift_and_emit "${FILE_PATH}" "${CACHED_ALLOWED_FILES}" "${CACHED_PLAN_ID}"
    exit 0
  fi

  # 1. List API → pick the in-progress doc ID. Response {"total":N,"rows":[...]}.
  #    Selection: newest created_at, tie → max id (deterministic). --max-time enforced.
  PLAN_LIST_JSON=""
  PLAN_LIST_JSON="$(curl -sf --max-time "${CURL_TIMEOUT}" "${MONITOR_URL}" 2>/dev/null || true)"
  [[ -z "${PLAN_LIST_JSON}" ]] && exit 0

  PLAN_ID=""
  PLAN_ID="$(printf '%s' "${PLAN_LIST_JSON}" \
    | jq -r '[.rows[]? | select(.doc_status == "progress")]
             | sort_by(.created_at // "", .id) | last | .id // empty' 2>/dev/null || true)"

  # No in-progress doc / parse failure → "absent" is NOT "drift" → fail-open.
  if [[ -z "${PLAN_ID}" ]] || [[ ! "${PLAN_ID}" =~ ^[0-9]+$ ]]; then
    exit 0
  fi

  # 2. GET-by-id → HTML body. Separate --max-time (double-call worst-case <5s).
  PLAN_DOC_JSON=""
  PLAN_DOC_JSON="$(curl -sf --max-time "${CURL_TIMEOUT}" "${MONITOR_URL}/${PLAN_ID}" 2>/dev/null || true)"
  [[ -z "${PLAN_DOC_JSON}" ]] && exit 0

  PLAN_BODY=""
  PLAN_BODY="$(printf '%s' "${PLAN_DOC_JSON}" | jq -r '.body // empty' 2>/dev/null || true)"
  [[ -z "${PLAN_BODY}" ]] && exit 0

  # 3. Parse target-files section. Separate assignment (function always returns 0) avoids SC2310.
  ALLOWED_FILES=""
  ALLOWED_FILES="$(extract_target_files_section "${PLAN_BODY}" 2>/dev/null)"

  # Section absent / extraction failure → fail-open. A suspect list is absorbed by the match loop.
  [[ -z "${ALLOWED_FILES}" ]] && exit 0
  # Pass if 0 path-like tokens (/ or .) — guards a whitespace/tag-residue slice.
  if ! printf '%s' "${ALLOWED_FILES}" | grep -q '[./]'; then
    exit 0
  fi

  # 4. Persist the resolution for subsequent same-session edits (best-effort — never gates the
  #    verdict), then run the shared drift decision (identical to the cache-hit branch above).
  if [[ -n "${CACHE_FILE}" ]]; then
    # Best-effort: a write failure must NOT abort the hook (optimization only) → SC2310 disabled.
    # shellcheck disable=SC2310
    scope_drift_write_cache "${CACHE_FILE}" "${PLAN_ID}" "${ALLOWED_FILES}" || true
  fi
  check_drift_and_emit "${FILE_PATH}" "${ALLOWED_FILES}" "${PLAN_ID}"
  exit 0
fi
[[ ! -f "${PLAN_FILE}" ]] && exit 0

# file_path absent → no per-file matching.
[[ -z "${FILE_PATH}" ]] && exit 0

# Read plan content into a variable first — TOCTOU defense. SC2155: separate declare/assign.
PLAN_CONTENT=""
if ! PLAN_CONTENT=$(cat "${PLAN_FILE}" 2>/dev/null) || [[ -z "${PLAN_CONTENT}" ]]; then
  hook_log "plan file read failed: ${PLAN_FILE}"
  exit 0
fi

# Extract from the `## Target Files` heading to the next ## (case-insensitive, English-only).
HEADING_RE='^##[[:space:]]+[Tt]arget [Ff]iles'
ALLOWED_FILES=$(echo "${PLAN_CONTENT}" | sed -E -n "/${HEADING_RE}/,/^## /{ /${HEADING_RE}/d; /^## /d; p; }")

# No target-files section → pass.
[[ -z "${ALLOWED_FILES}" ]] && exit 0

# Match → file outside the list → SCOPE-070 advisory (exit 0, non-blocking). SC2310 disabled (above).
# shellcheck disable=SC2310
if ! match_file_against_allowed "${FILE_PATH}" "${ALLOWED_FILES}"; then
  emit_error "SCOPE-070" "advisory" \
    "Scope drift: file not in plan target list" \
    "Update plan target files or confirm the modification is intentional" \
    "{\"file\":\"${FILE_PATH}\",\"source\":\"plan-doc\"}"
fi

exit 0
