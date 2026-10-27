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
if [[ -r "${BASH_SOURCE%/*}/lib/pipe-drain.sh" ]]; then
  # shellcheck source=lib/pipe-drain.sh
  source "${BASH_SOURCE%/*}/lib/pipe-drain.sh"
else
  # Library missing or unreadable → the same drain_after in place, so the hook keeps its verdict.
  # A test, not a failed source: bash 3.2 exits on a missing sourced file even inside a condition.
  drain_after() {
    local rc=0
    "$@" || rc=$?
    cat >/dev/null || true
    return "${rc}"
  }
fi

# Monitor-API config — env-overridable (test isolation), loopback-pinned.
# Default-URL port derived via the hook_monitor_port wrapper (ADR-1: env →
# monitor/.env → config → 16145); NO literal fallback here (the single default lives
# in the resolver). A full SCOPE_DRIFT_MONITOR_URL override wins over the derived
# default; a resolver failure degrades to '' (non-bindable URL, fire-and-forget).
# shellcheck disable=SC2310
#   Best-effort resolver — its failure is absorbed into the '' degrade described above.
monitor_port="$(hook_monitor_port || true)"
MONITOR_URL="${SCOPE_DRIFT_MONITOR_URL:-http://127.0.0.1:${monitor_port}/api/clauded-docs}"
CURL_TIMEOUT="${SCOPE_DRIFT_CURL_TIMEOUT:-2}"

# The comparison predicate + the `[SCOPE]` declaration parsers live in lib/ so this hook and the
# recorder's scope-excess leg share ONE definition.
# shellcheck source=lib/scope-match.sh
source "${BASH_SOURCE%/*}/lib/scope-match.sh"

# SCOPE-070 advisory. emit_error hands the context to jq as one argument; Linux refuses one of 131072
# bytes or more, so a context carrying an over-long edit path goes as '{}'.
# Args: $1=message  $2=suggestion  $3=context json
emit_scope_drift() {
  local context="${3}"
  if (($(LC_ALL=C && printf '%s' "${#context}") >= 131072)); then context='{}'; fi
  emit_error "SCOPE-070" "advisory" "${1}" "${2}" "${context}"
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
    emit_scope_drift \
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
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  printf '%s' "${cached_files}" | drain_after grep -q '[./]' || return 1

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
# Payload names: an inherited export would carry them into every child's environment, capped per string on Linux.
export -n INPUT FILE_PATH SESSION_ID SAFE_SID CACHE_FILE file_path context ctx
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

# The spawning subagent's own transcript for ($1=agent_id, $2=session_id), or empty when none exists.
get_subagent_transcript() {
  local tpath
  for tpath in "${HOME}/.claude/projects/"*"/${2}/subagents/agent-${1}.jsonl" \
    "${HOME}/.claude/projects/"*"/${2}/subagents/workflows/wf_"*"/agent-${1}.jsonl"; do
    if [[ -f "${tpath}" ]]; then
      printf '%s' "${tpath}"
      return 0
    fi
  done
}

# Plan-reference shape — mirrors enforce-verification-gate.sh → references_plan; keep the two in sync.
readonly PLAN_REF_ERE='clauded-docs/[0-9]+|[A-Za-z0-9_./-]*plan[A-Za-z0-9_-]*\.html|documents/[A-Za-z0-9_./-]+\.html|(^|[^A-Za-z0-9_])plan-[0-9]+([^A-Za-z0-9]|$)|(^|[^A-Za-z0-9_])[0-9]+-plan([^A-Za-z0-9]|$)'

# Simple-task delegation — record 0 of the subagent transcript carries `[ENTRY-CLASS] simple-task`
# and no plan-reference. Such work owes no [SCOPE] declaration and binds to no plan. rc 1 otherwise,
# and on any read failure (fail toward the unchanged comparison).
is_simple_task_delegation() {
  local agent_id session_id tpath record0
  agent_id="$(echo "${INPUT}" | jq -r '.agent_id // ""' 2>/dev/null || true)"
  session_id="$(echo "${INPUT}" | jq -r '.session_id // ""' 2>/dev/null || true)"
  [[ -n "${agent_id}" ]] && [[ -n "${session_id}" ]] || return 1
  tpath="$(get_subagent_transcript "${agent_id}" "${session_id}")"
  [[ -r "${tpath}" ]] || return 1
  record0="$(head -n 1 "${tpath}" \
    | jq -r 'if (.message.content | type) == "string" then .message.content
             elif (.message.content | type) == "array" then ([.message.content[]? | .text? // ""] | join("\n"))
             else "" end' 2>/dev/null)" || return 1
  [[ "${record0}" == *"[ENTRY-CLASS] simple-task"* ]] || return 1
  # shellcheck disable=SC2310  # the reader's status is the answer
  ! printf '%s' "${record0}" | drain_after grep -qE "${PLAN_REF_ERE}"
}

# Second allowed-path source — the delegation's `[SCOPE] files=` declaration, read from record 0
# of the spawning subagent's own transcript. Covers the everyday delegation that has no plan doc
# at all. A match here is authoritative (union semantics: either source may allow the edit); a
# non-match emits its own advisory and lets the plan-doc leg below reach its own verdict.
# Resolution is cached per agent_id in the existing per-session cache shape (same helpers, same
# TTL and bypass env) — the sentinel below caches the far more common "no declaration" answer
# too, so an undeclared delegation re-resolves no declaration on later edits. The simple-task
# check runs first and is uncached: it re-reads record 0 on every subagent edit. An unread
# declaration (selector status 2) has its own sentinel and is never cached, so the next edit
# reads it again.
SCOPE_DECL_NONE_SENTINEL='./no-scope-declaration'
SCOPE_DECL_UNREAD_SENTINEL='./scope-declaration-unread'
scope_decl_resolve() {
  local agent_id session_id safe_key cache_file tpath decl_line files decl_status=0
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

  tpath="$(get_subagent_transcript "${agent_id}" "${session_id}")"

  files=""
  if [[ -n "${tpath}" ]]; then
    # shellcheck disable=SC2310  # the selector's status IS the answer, captured by the ||
    decl_line="$(scope_decl_from_record0 "${tpath}")" || decl_status=$?
    if ((decl_status != 0)); then
      printf '%s' "${SCOPE_DECL_UNREAD_SENTINEL}"
      return 0
    fi
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

# A simple-task delegation binds to no plan and owes no [SCOPE] → neither comparison below judges its
# edits, a [SCOPE] it carries anyway included. The explicit PLAN_FILE leg is not a token check and stays.
IS_SIMPLE_TASK=false
# shellcheck disable=SC2310  # predicate call — the exit status IS the answer
if [[ -n "${FILE_PATH}" ]] && is_simple_task_delegation; then
  IS_SIMPLE_TASK=true
fi

if [[ -n "${FILE_PATH}" && "${IS_SIMPLE_TASK}" == false ]]; then
  SCOPE_DECL_FILES="$(scope_decl_resolve)"
  if [[ "${SCOPE_DECL_FILES}" == "${SCOPE_DECL_UNREAD_SENTINEL}" ]]; then
    (printf '[validate-scope-drift] [SCOPE] comparison did not run for this edit: the delegation [SCOPE] declaration could not be read. The plan-doc comparison still runs. Advisory only.\n') >&2 || true
  elif [[ -n "${SCOPE_DECL_FILES}" ]] && [[ "${SCOPE_DECL_FILES}" != "${SCOPE_DECL_NONE_SENTINEL}" ]]; then
    # shellcheck disable=SC2310
    #   Predicate call — the exit status IS the answer (declared vs undeclared path).
    if match_file_against_allowed "${FILE_PATH}" "${SCOPE_DECL_FILES}"; then
      exit 0
    fi
    emit_scope_drift \
      "Scope drift: file not in the delegation [SCOPE] files= declaration" \
      "Widen the delegation [SCOPE] declaration or confirm the modification is intentional" \
      "{\"file\":\"${FILE_PATH}\",\"source\":\"scope-decl\"}"
  fi
fi

# PLAN_FILE unset → auto-restore per-file scope binding via the monitor API: the one `implementing`
# plan → GET its body → parse its Target Files list in the plan's own format → same match loop.
# fail-open (a false-positive SCOPE-070 is forbidden): curl absent / monitor down / 0 or ambiguous
# docs / GET failure / list absent / 0 path-like tokens → pass silently, never promote to SCOPE-070.
# Accepted residual (advisory noise): a lone `implementing` plan also binds a concurrent plan-backed or
# unclassified edit outside it that has no usable `[SCOPE]` (a simple-task delegation is exempt), and a
# cached binding outlives a 2nd plan's arrival by the TTL.
if [[ -z "${PLAN_FILE:-}" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    exit 0
  fi

  # file_path absent → no per-file matching → skip the API call.
  [[ -z "${FILE_PATH}" ]] && exit 0
  [[ "${IS_SIMPLE_TASK}" == true ]] && exit 0

  # Per-session resolution cache (plan id + target-file list) — optimization only. A hit skips
  # BOTH loopback curls + the Target Files re-parse below; a miss / stale / corrupt / unreadable cache
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

  # 1. List API → the implementing plan ID. Response {"total":N,"rows":[...]}. limit=200 is the
  #    route's page maximum. Each row's stage is re-checked: a server ignoring the filter returns
  #    every stage. Exactly one binds — several are other lanes' plans. --max-time enforced.
  PLAN_LIST_JSON=""
  PLAN_LIST_JSON="$(curl -sf --max-time "${CURL_TIMEOUT}" \
    "${MONITOR_URL}?doc_status=implementing&limit=200" 2>/dev/null || true)"
  [[ -z "${PLAN_LIST_JSON}" ]] && exit 0

  PLAN_ID=""
  PLAN_ID="$(printf '%s' "${PLAN_LIST_JSON}" \
    | jq -r '[.rows[]? | select(.doc_status == "implementing")]
             | if length == 1 then .[0].id else empty end' 2>/dev/null || true)"

  # None or several implementing / parse failure → "absent" is NOT "drift" → fail-open.
  if [[ -z "${PLAN_ID}" ]] || [[ ! "${PLAN_ID}" =~ ^[0-9]+$ ]]; then
    exit 0
  fi

  # 2. GET-by-id → format + body. Separate --max-time (double-call worst-case <5s).
  PLAN_DOC_JSON=""
  PLAN_DOC_JSON="$(curl -sf --max-time "${CURL_TIMEOUT}" "${MONITOR_URL}/${PLAN_ID}" 2>/dev/null || true)"
  [[ -z "${PLAN_DOC_JSON}" ]] && exit 0

  PLAN_BODY=""
  PLAN_BODY="$(printf '%s' "${PLAN_DOC_JSON}" | jq -r '.body // empty' 2>/dev/null || true)"
  [[ -z "${PLAN_BODY}" ]] && exit 0

  PLAN_FORMAT=""
  PLAN_FORMAT="$(printf '%s' "${PLAN_DOC_JSON}" | jq -r '.format // empty' 2>/dev/null || true)"

  # 3. Parser chosen by format, never by trying both: an md plan quoting the HTML contract example
  #    would bind its placeholder paths. Separate assignment (parsers always return 0) avoids SC2310.
  ALLOWED_FILES=""
  case "${PLAN_FORMAT}" in
    html) ALLOWED_FILES="$(extract_target_files_section "${PLAN_BODY}" 2>/dev/null)" ;;
    md) ALLOWED_FILES="$(extract_target_files_heading "${PLAN_BODY}")" ;;
    *) exit 0 ;;
  esac

  # List absent / extraction failure → fail-open. A suspect list is absorbed by the match loop.
  [[ -z "${ALLOWED_FILES}" ]] && exit 0
  # Pass if 0 path-like tokens (/ or .) — guards a whitespace/tag-residue slice.
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  if ! printf '%s' "${ALLOWED_FILES}" | drain_after grep -q '[./]'; then
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

ALLOWED_FILES="$(extract_target_files_heading "${PLAN_CONTENT}")"

# No target-files section → pass.
[[ -z "${ALLOWED_FILES}" ]] && exit 0

# Match → file outside the list → SCOPE-070 advisory (exit 0, non-blocking). SC2310 disabled (above).
# shellcheck disable=SC2310
if ! match_file_against_allowed "${FILE_PATH}" "${ALLOWED_FILES}"; then
  emit_scope_drift \
    "Scope drift: file not in plan target list" \
    "Update plan target files or confirm the modification is intentional" \
    "{\"file\":\"${FILE_PATH}\",\"source\":\"plan-doc\"}"
fi

exit 0
