#!/usr/bin/env bash
# queue-session.sh — the owner queue's session-side wire steps, shared by the SessionStart / SessionEnd
# hooks and the queue CLI so their register fields cannot drift. Sourced, not executable.
# Never puts the queue key or the messaging token on argv, stdout or a request body; sends a pid, never a start time.

if [[ -n "${_QUEUE_SESSION_LOADED:-}" ]]; then
  return 0
fi
readonly _QUEUE_SESSION_LOADED=1

# shellcheck source-path=SCRIPTDIR source=atrium-config.sh
source "${BASH_SOURCE[0]%/*}/atrium-config.sh"
# shellcheck source-path=SCRIPTDIR source=path-guard.sh
source "${BASH_SOURCE[0]%/*}/path-guard.sh"

readonly QUEUE_CONNECT_TIMEOUT_S=1
readonly QUEUE_MAX_TIME_S=2
readonly QUEUE_KEY_SHAPE='^[A-Za-z0-9_-]{16,255}$'
readonly QUEUE_UUID_SHAPE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
readonly QUEUE_PID_SHAPE='^[1-9][0-9]{0,9}$'
# with the length cap: the monitor's TOKEN_SHAPE (socket-channel.ts); macOS regex caps a bound at 255
readonly QUEUE_MESSAGING_AUTH_SHAPE='^[!-~]+$'
readonly QUEUE_MESSAGING_AUTH_MAX=512
readonly QUEUE_PERMISSION_HINTS=' default acceptEdits auto bypassPermissions dontAsk plan '

queue_get_root() {
  printf '%s\n' "${GA_ROOT:-${HOME}/.glass-atrium}"
}

# The installed CLI's absolute path — the one literal the settings allow rule, the pointer line and the help name.
queue_get_cli_path() {
  local root
  root="$(queue_get_root)"
  printf '%s/scripts/atrium-queue.sh\n' "${root}"
}

queue_get_token_dir() {
  local root
  root="$(queue_get_root)"
  printf '%s/data/queue/tokens\n' "${root}"
}

# This session's id: $1 (a hook payload's session_id) when a UUID, else the session env; empty when neither is.
queue_get_session_id() {
  local id="${1:-}"
  [[ "${id}" =~ ${QUEUE_UUID_SHAPE} ]] || id="${CLAUDE_CODE_SESSION_ID:-}"
  if [[ "${id}" =~ ${QUEUE_UUID_SHAPE} ]]; then printf '%s\n' "${id}"; fi
}

# The session's start directory: $1 (a hook payload's cwd) when an absolute directory, else this process's cwd.
# The server resumes from it and finds the worktree root from it, so a Bash-tool `cd` must never move it.
queue_get_cwd() {
  local cwd="${1:-}"
  [[ "${cwd}" == /* && -d "${cwd}" ]] || cwd="${PWD}"
  printf '%s\n' "${cwd}"
}

queue_get_pid() {
  local pid="${CLAUDE_PID:-}"
  if [[ "${pid}" =~ ${QUEUE_PID_SHAPE} ]]; then printf '%s\n' "${pid}"; fi
}

queue_get_socket_path() {
  local socket="${CLAUDE_CODE_MESSAGING_SOCKET:-}"
  if [[ "${socket}" == /* ]]; then printf '%s\n' "${socket}"; fi
}

# The queue key from its 0600 file → stdout (callers hand it to curl's stdin config only); non-zero when unprovisioned.
queue_get_key() {
  local key_file key
  key_file="$(queue_get_root)/secrets/queue-key"
  [[ -f "${key_file}" && -r "${key_file}" ]] || return 1
  key="$(head -c 512 -- "${key_file}")"
  key="${key%%[[:space:]]*}"
  [[ "${key}" =~ ${QUEUE_KEY_SHAPE} ]] || return 1
  printf '%s\n' "${key}"
}

# <method> <route> [json body] [max seconds] → the reply body, then a last line holding the HTTP status;
# non-zero only with no reply at all (unprovisioned, unreachable or slow).
queue_send() {
  local method="$1" route="$2" body="${3:-}" max_time="${4:-${QUEUE_MAX_TIME_S}}" key port
  key="$(queue_get_key)" || return 1
  port="$(atrium_monitor_port 2>/dev/null)" || return 1
  local -a args=(--silent --config - --connect-timeout "${QUEUE_CONNECT_TIMEOUT_S}" --max-time "${max_time}"
    --request "${method}" --write-out '\n%{http_code}')
  if [[ -n "${body}" ]]; then
    args+=(--header 'content-type: application/json' --data-binary "${body}")
  fi
  # key → curl's stdin config, never argv
  printf 'header = "x-atrium-queue-key: %s"\n' "${key}" | curl "${args[@]}" "http://127.0.0.1:${port}${route}" 2>/dev/null
}

# POST <route> <json body> [max seconds] → reply body on stdout; non-zero when unprovisioned, unreachable, slow or refused.
queue_post() {
  local reply status
  # shellcheck disable=SC2310  # no reply → this function's own failure, never an errexit
  reply="$(queue_send POST "$1" "$2" "${3:-}")" || return 1
  status="${reply##*$'\n'}"
  [[ "${status}" == 2?? ]] || return 1
  printf '%s\n' "${reply%$'\n'*}"
}

# Copies the messaging token to its 0600 per-session file in the 0700 token dir; the sender reads it there.
queue_put_messaging_auth() {
  local session_id="$1" dir file tmp
  [[ "${CLAUDE_CODE_MESSAGING_TOKEN:-}" =~ ${QUEUE_MESSAGING_AUTH_SHAPE} ]] || return 0
  ((${#CLAUDE_CODE_MESSAGING_TOKEN} <= QUEUE_MESSAGING_AUTH_MAX)) || return 0
  dir="$(queue_get_token_dir)"
  (umask 077 && mkdir -p -- "${dir}") || return 1
  # a pre-existing link or foreign-owned entry is never written through
  [[ -d "${dir}" && ! -L "${dir}" && -O "${dir}" ]] || return 1
  chmod 700 "${dir}" || return 1
  file="${dir}/${session_id}"
  tmp="$(umask 077 && mktemp "${dir}/.${session_id}.XXXXXX")" || return 1
  if ! printf '%s' "${CLAUDE_CODE_MESSAGING_TOKEN}" >"${tmp}" || ! mv -f -- "${tmp}" "${file}"; then
    if ga_guard_path "${tmp}"; then rm -f -- "${tmp:?}"; fi
    return 1
  fi
}

# The register step: the token copy, then the register POST → the answered-waiting count on stdout.
# All optional: $1 permission mode hint (dropped unless one the monitor accepts) · $2 max seconds ·
# $3 cwd and $4 session id from a hook payload (queue_get_cwd / queue_get_session_id fallbacks)
queue_register_session() {
  local hint="${1:-}" max_time="${2:-}" cwd session_id pid socket body reply count
  session_id="$(queue_get_session_id "${4:-}")"
  pid="$(queue_get_pid)"
  [[ -n "${session_id}" && -n "${pid}" ]] || return 1
  [[ "${QUEUE_PERMISSION_HINTS}" == *" ${hint} "* ]] || hint=""
  queue_put_messaging_auth "${session_id}" || true
  socket="$(queue_get_socket_path)"
  cwd="$(queue_get_cwd "${3:-}")"
  body="$(jq -nc --arg sessionId "${session_id}" --argjson pid "${pid}" --arg cwd "${cwd}" \
    --arg configDir "${CLAUDE_CONFIG_DIR:-}" --arg socketPath "${socket}" --arg permissionHint "${hint}" \
    --arg launchHint "${ATRIUM_QUEUE_ACCEPT_WRAPPER:+accept_wrapper}" \
    '{$sessionId, $pid, $cwd, $configDir, $socketPath, $permissionHint, $launchHint} | with_entries(select(.value != ""))')" || return 1
  reply="$(queue_post /api/queue/sessions/register "${body}" "${max_time}")" || return 1
  count="$(jq -r '.answeredWaiting // 0' <<<"${reply}" 2>/dev/null)" || return 1
  [[ "${count}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${count}"
}

# The deregister step: pid, else the socket path (the monitor reads the pid from its name), else the id alone.
# $1: session id from a hook payload (optional; queue_get_session_id fallback)
queue_deregister_session() {
  local session_id pid socket body token_file
  session_id="$(queue_get_session_id "${1:-}")"
  [[ -n "${session_id}" ]] || return 1
  pid="$(queue_get_pid)"
  socket=""
  [[ -n "${pid}" ]] || socket="$(queue_get_socket_path)"
  body="$(jq -nc --arg sessionId "${session_id}" --arg pid "${pid}" --arg socketPath "${socket}" \
    '{$sessionId, pid: ($pid | if . == "" then null else tonumber end), $socketPath} | with_entries(select(.value != "" and .value != null))')" || return 1
  token_file="$(queue_get_token_dir)/${session_id}"
  if ga_guard_path "${token_file}"; then rm -f -- "${token_file:?}"; fi
  queue_post /api/queue/sessions/deregister "${body}" >/dev/null
}
