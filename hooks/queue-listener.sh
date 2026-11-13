#!/usr/bin/env bash
# queue-listener.sh — SessionStart and Stop hook, bound asyncRewake: in an interactive main session it execs the queue
# CLI's listen step, which polls this session's answered owner-queue count without claiming and wakes the idle session
# with one count line naming the pending command (exit 2) — never an item's text.
# Exits 0 at once for a subagent payload, a non-cli entrypoint (`claude -p` runs an asyncRewake hook synchronously and
# would hold its run for the listener's lifetime), a background job, or a session whose kind it cannot decide.
# Disposition reask, as a wake into its own turn, never a block of the turn end that started it. Fail-open: exit 0.

set -Eeuo pipefail
IFS=$'\n\t'
# inside a $( ) the trap fails the substitution, so its caller still sees the failure
trap 'if ((BASH_SUBSHELL > 0)); then exit 1; fi; exit 0' ERR

# a background job's session process runs under this host process (`claude --bg`); interactive ones under a terminal
readonly BG_PTY_HOST_FLAG=--bg-pty-host

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")" || exit 0
fi
lib="${self%/*}/../scripts/lib/queue-session.sh"
cli="${self%/*}/../scripts/atrium-queue.sh"
[[ -f "${lib}" && -x "${cli}" ]] || exit 0
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/queue-session.sh
source "${lib}" 2>/dev/null || exit 0
# shellcheck source=lib/session-entrypoint.sh
source "${self%/*}/lib/session-entrypoint.sh" 2>/dev/null || exit 0

main() {
  local payload="" fields session_id
  if [[ ! -t 0 ]]; then payload="$(head -c 65536 2>/dev/null)" || payload=""; fi
  # shellcheck disable=SC2310  # each gate is a plain test → exit 0
  is_listenable_session || exit 0
  # a main-session payload → "main <its session_id>"; nothing for a subagent's or a malformed one
  fields="$(jq -r 'if type == "object" and (has("agent_id") | not) then "main \(.session_id | strings // "")"
    else empty end' <<<"${payload}" 2>/dev/null)" || exit 0
  [[ "${fields}" == "main "* ]] || exit 0
  session_id="$(queue_get_session_id "${fields#main }")"
  [[ -n "${session_id}" ]] || exit 0
  export CLAUDE_CODE_SESSION_ID="${session_id}"
  exec "${cli}" listen </dev/null
}

# 0 for an interactive main session's process: cli entrypoint, no job dir, and a parent that is no background-job host
# — a parent it cannot read counts as one (fails closed)
is_listenable_session() {
  local pid parent_pid parent
  # shellcheck disable=SC2310  # a single [[ ]] test
  is_owner_facing_session || return 1
  [[ -z "${CLAUDE_JOB_DIR:-}" ]] || return 1
  pid="$(queue_get_pid)"
  [[ -n "${pid}" ]] || return 1
  # shellcheck disable=SC2310  # a single ps read → non-zero fails closed
  is_print_mode_process "${pid}" && return 1
  parent_pid="$(ps -o ppid= -p "${pid}" 2>/dev/null)" || return 1
  parent_pid="${parent_pid//[[:space:]]/}"
  [[ "${parent_pid}" =~ ${QUEUE_PID_SHAPE} ]] || return 1
  parent="$(ps -o command= -p "${parent_pid}" 2>/dev/null)" || return 1
  [[ -n "${parent}" && "${parent}" != *"${BG_PTY_HOST_FLAG}"* ]]
}

# <pid> → 0 when that process's argv carries a print flag, or when its argv cannot be read (fails closed); a second
# headless signal beside the entrypoint, which a `claude -p` child of an interactive session inherits as `cli`
is_print_mode_process() {
  local command word words
  command="$(ps -ww -o command= -p "$1" 2>/dev/null)" || return 0
  [[ -n "${command}" ]] || return 0
  IFS=' ' read -r -a words <<<"${command}"
  for word in "${words[@]}"; do
    case "${word}" in
      -p | --print | --print=*) return 0 ;;
      *) ;;
    esac
  done
  return 1
}

main
exit 0
