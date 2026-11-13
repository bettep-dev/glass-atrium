#!/usr/bin/env bash
# queue-session.sh — the owner queue's session-side wire steps, shared by the SessionStart / SessionEnd
# hooks and the queue CLI so their register fields cannot drift. Sourced, not executable.
# Never reads the messaging token; sends a pid, never a start time.

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
readonly QUEUE_UUID_SHAPE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
readonly QUEUE_PID_SHAPE='^[1-9][0-9]{0,9}$'
readonly QUEUE_ITEM_ID_SHAPE='^[1-9][0-9]{0,15}$'
# another session's awaiting set untouched this long → that session is gone (a kill or a closed terminal skips SessionEnd)
readonly QUEUE_AWAITING_TTL_DAYS=30
readonly QUEUE_PERMISSION_HINTS=' default acceptEdits auto bypassPermissions dontAsk plan '
# the item states nothing moves on from; the set itself is the monitor's TERMINAL (queue-turn-end-check.bats compares the two)
# shellcheck disable=SC2034  # read by the sourcing turn-end hook
readonly QUEUE_TERMINAL_STATUSES=' delivered seen withdrawn '
# the states a running wait carries forward: open (no answer yet) and answered (claimed by the wait)
# shellcheck disable=SC2034  # read by the sourcing turn-end hook
readonly QUEUE_WAIT_RESOLVED_STATUSES=' open answered '
# in code points; the number itself is the monitor's SESSION_NAME_MAX (atrium-queue.bats compares the two)
readonly QUEUE_NAME_MAX=100
# space: the whitespace JS String.prototype.trim strips → a name the monitor would read as blank is never sent
QUEUE_NAME_JQ="$(
  cat <<'JQ'
def space: "[\\s\\p{Zs}\\x{FEFF}\\x{2028}\\x{2029}]";
$name | explode | map(if . < 32 or (. >= 127 and . < 160) then 32 else . end) | implode
| sub("^\(space)+"; "")
| explode | .[:$max] | implode | sub("\(space)+$"; "")
| select(test("[^" + (space | .[1:-1]) + "]"))
JQ
)"
readonly QUEUE_NAME_JQ

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

# <method> <route> [json body] [max seconds] → the reply body, then a last line holding the HTTP status;
# non-zero only with no reply at all (unreachable or slow).
queue_send() {
  local method="$1" route="$2" body="${3:-}" max_time="${4:-${QUEUE_MAX_TIME_S}}" port
  port="$(atrium_monitor_port 2>/dev/null)" || return 1
  local -a args=(--silent --connect-timeout "${QUEUE_CONNECT_TIMEOUT_S}" --max-time "${max_time}"
    --request "${method}" --write-out '\n%{http_code}')
  if [[ -n "${body}" ]]; then
    args+=(--header 'content-type: application/json' --data-binary "${body}")
  fi
  curl "${args[@]}" "http://127.0.0.1:${port}${route}" 2>/dev/null
}

# POST <route> <json body> [max seconds] → reply body on stdout; non-zero when unreachable, slow or refused.
queue_post() {
  local reply status
  # shellcheck disable=SC2310  # no reply → this function's own failure, never an errexit
  reply="$(queue_send POST "$1" "$2" "${3:-}")" || return 1
  status="${reply##*$'\n'}"
  [[ "${status}" == 2?? ]] || return 1
  printf '%s\n' "${reply%$'\n'*}"
}

# <text> → the name the monitor accepts: control characters as spaces, trimmed, cut to QUEUE_NAME_MAX; nothing when blank
queue_get_shown_name() {
  jq -rn --arg name "$1" --argjson max "${QUEUE_NAME_MAX}" "${QUEUE_NAME_JQ}"
}

# This session's derived name → stdout, shown form; nothing when no source holds one. Sources in order:
# the background job's state when it names session $2 · the last custom title, else the last AI title, in transcript $1
queue_get_derived_name() {
  local name
  name="$(queue_get_job_name "$2")"
  [[ -n "${name}" ]] || name="$(queue_get_transcript_title "$1")"
  if [[ -n "${name}" ]]; then queue_get_shown_name "${name}"; fi
}

# a job dir inherited by another session's process names that job's session, not this one
queue_get_job_name() {
  local state="${CLAUDE_JOB_DIR:-}/state.json"
  [[ "${CLAUDE_JOB_DIR:-}" == /* && -f "${state}" ]] || return 0
  jq -r --arg id "$1" 'select(.sessionId == $id or .resumeSessionId == $id) | .name | strings' "${state}" 2>/dev/null || return 0
}

# title records only → the transcript's conversation text is never parsed
queue_get_transcript_title() {
  local transcript="${1:-}"
  [[ "${transcript}" == /* && -f "${transcript}" ]] || return 0
  { grep -F -e '"custom-title"' -e '"ai-title"' -- "${transcript}" 2>/dev/null || true; } \
    | jq -Rrn '[inputs | fromjson? | objects] | (map(select(.type == "custom-title") | .customTitle | strings) | last)
      // (map(select(.type == "ai-title") | .aiTitle | strings) | last) // empty' 2>/dev/null || return 0
}

# The register step: the register POST → the answered-waiting count on stdout.
# All optional: $1 permission mode hint (dropped unless one the monitor accepts) · $2 max seconds ·
# $3 cwd and $4 session id from a hook payload (queue_get_cwd / queue_get_session_id fallbacks) ·
# $5 an explicit session name, already in shown form (queue_get_shown_name), sent as name ·
# else $6 a transcript path → queue_get_derived_name, sent as derivedName
# (the monitor lets only an explicit name replace an explicit one)
queue_register_session() {
  local hint="${1:-}" max_time="${2:-}" cwd session_id pid name="" derived_name="" body reply count
  session_id="$(queue_get_session_id "${4:-}")"
  pid="$(queue_get_pid)"
  [[ -n "${session_id}" && -n "${pid}" ]] || return 1
  [[ "${QUEUE_PERMISSION_HINTS}" == *" ${hint} "* ]] || hint=""
  cwd="$(queue_get_cwd "${3:-}")"
  if [[ -n "${5:-}" ]]; then
    name="$5"
  else
    derived_name="$(queue_get_derived_name "${6:-}" "${session_id}")" || derived_name=""
  fi
  body="$(jq -nc --arg sessionId "${session_id}" --argjson pid "${pid}" --arg cwd "${cwd}" \
    --arg configDir "${CLAUDE_CONFIG_DIR:-}" --arg permissionHint "${hint}" --arg name "${name}" \
    --arg derivedName "${derived_name}" \
    '{$sessionId, $pid, $cwd, $configDir, $permissionHint, $name, $derivedName}
      | with_entries(select(.value != ""))')" || return 1
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
  # retired messaging token → also deleted here, not only by the monitor sweep, so a down monitor leaves none behind
  token_file="$(queue_get_token_dir)/${session_id}"
  if ga_guard_path "${token_file}"; then rm -f -- "${token_file:?}"; fi
  queue_post /api/queue/sessions/deregister "${body}" >/dev/null
}

# <session id> → this Claude process's view of the session's wait lock: none · live (a running wait of this process) ·
# stale; nothing without CLAUDE_PID (a wait cannot start without it)
queue_get_wait_state() {
  local owner_pid WAIT_LOCK WAIT_RECORD
  owner_pid="$(queue_get_pid)"
  [[ -n "${owner_pid}" ]] || return 0
  WAIT_LOCK="$(queue_get_root)/data/queue/waits/$1"
  # an empty waiter part never reads as mine → live only for a running wait of this Claude process
  WAIT_RECORD="||${owner_pid}|$(get_start_time "${owner_pid}")"
  get_wait_lock_state
}

# <pid> → its process start time, the recycled-pid guard; nothing when the pid is gone
get_start_time() {
  local started
  started="$(LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null)" || return 0
  started="${started#"${started%%[![:space:]]*}"}"
  printf '%s\n' "${started%"${started##*[![:space:]]}"}"
}

# → mine · none · live (another running wait of this Claude process) · stale (its waiter is gone, or it names another
# Claude process); the one reader of the lock name. Reads the caller's WAIT_LOCK (lock path) and WAIT_RECORD (its own
# "waiter pid|its start|owner pid|its start" record).
get_wait_lock_state() {
  local held
  held="$(readlink "${WAIT_LOCK}" 2>/dev/null)" || held=""
  # shellcheck disable=SC2310  # liveness is the last branch
  if [[ "${held}" == "${WAIT_RECORD}" ]]; then
    printf 'mine\n'
  elif [[ -z "${held}" ]]; then
    printf 'none\n'
  elif is_wait_live "${held}"; then
    printf 'live\n'
  else
    printf 'stale\n'
  fi
}

# <held record> → 0 while its waiter still runs and its owner is this wait's own Claude process
is_wait_live() {
  local waiter_pid waiter_start owner started
  IFS='|' read -r waiter_pid waiter_start owner <<<"$1"
  [[ "${owner}" == "${WAIT_RECORD#*|*|}" && "${waiter_pid}" =~ ${QUEUE_PID_SHAPE} && -n "${waiter_start}" ]] || return 1
  started="$(get_start_time "${waiter_pid}")"
  [[ "${started}" == "${waiter_start}" ]]
}

# Awaiting marks: one empty file per item a session posted that expects an owner answer, named by the item id → the
# turn-end check lists them before any monitor call. SessionEnd keeps them: a resumed session keeps its id.

# <session id> → its awaiting set's directory; non-zero for anything but a UUID
queue_get_awaiting_dir() {
  local root
  [[ "$1" =~ ${QUEUE_UUID_SHAPE} ]] || return 1
  root="$(queue_get_root)"
  printf '%s/data/queue/awaiting/%s\n' "${root}" "$1"
}

# <session id> <item id> → marks the posted item awaiting
queue_create_awaiting_item() {
  local dir
  dir="$(queue_get_awaiting_dir "$1")" || return 1
  [[ "$2" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || return 1
  { mkdir -p -- "${dir}" && : >"${dir}/$2"; } 2>/dev/null
}

# <session id> <item id> → the item awaits no longer (acked or withdrawn)
queue_delete_awaiting_item() {
  local dir marker
  dir="$(queue_get_awaiting_dir "$1")" || return 1
  [[ "$2" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || return 1
  marker="${dir}/$2"
  if ga_guard_path "${marker}"; then rm -f -- "${marker:?}"; fi
}

# <session id> → its awaiting item ids, newest (highest) first; nothing when none
queue_get_awaiting_items() {
  local dir marker ids=""
  dir="$(queue_get_awaiting_dir "$1")" || return 1
  for marker in "${dir}"/*; do
    if [[ -f "${marker}" && "${marker##*/}" =~ ${QUEUE_ITEM_ID_SHAPE} ]]; then ids+="${marker##*/}"$'\n'; fi
  done
  if [[ -n "${ids}" ]]; then sort -rn <<<"${ids%$'\n'}"; fi
}

# Drops every awaiting set untouched for QUEUE_AWAITING_TTL_DAYS; run right after a create, so the caller's own set is
# fresh and never among them.
# ponytail: a live session whose newest mark is older than the TTL loses its set → raise the TTL if owners answer later
queue_delete_stale_awaiting() {
  local root sets set
  root="$(queue_get_root)/data/queue/awaiting"
  sets="$(find "${root}" -mindepth 1 -maxdepth 1 -type d -mtime "+${QUEUE_AWAITING_TTL_DAYS}" 2>/dev/null)" || return 1
  [[ -n "${sets}" ]] || return 0
  while IFS= read -r set; do
    if ga_guard_path "${set}"; then rm -rf -- "${set:?}"; fi
  done <<<"${sets}"
}
