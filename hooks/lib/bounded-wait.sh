#!/usr/bin/env bash
# bounded-wait.sh — run_with_deadline, a hook's bounded wait where no timeout binary exists (stock macOS ships none).
# The command may be a shell function, so a hook bounds a whole step of its own, not only one executable.
# Bash 3.2+ (macOS stock); pgrep (macOS, Linux procps) reaches the children of a command it kills.

# shellcheck disable=SC2317  # source-context-unaware false positive on this double-source guard
if [[ -n "${_BOUNDED_WAIT_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _BOUNDED_WAIT_LOADED=1

# GNU timeout's status for a command it ended → a missed deadline reads apart from the command's own failure
readonly DEADLINE_STATUS=124

# Runs "$@" on the caller's stdin; a command still running after <seconds> is killed with every process under it.
# Returns: the command's own status, or DEADLINE_STATUS when the deadline came first — never with a child left running.
run_with_deadline() {
  local seconds="$1" command_pid watchdog_pid status=0 watchdog_status=0
  shift
  # explicit stdin → a background job's default stdin is /dev/null
  (
    trap - ERR
    "$@"
  ) <&0 &
  command_pid=$!
  _watch_deadline "${seconds}" "${command_pid}" </dev/null >/dev/null 2>&1 &
  watchdog_pid=$!
  # 2>/dev/null → bash's job-death notice never reaches a hook's stderr
  wait "${command_pid}" 2>/dev/null || status=$?
  kill -TERM "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || watchdog_status=$?
  ((watchdog_status != 0)) || return "${DEADLINE_STATUS}"
  return "${status}"
}

# Sleeps <seconds>, then kills <pid> with its tree; exit 0 only once that kill ran.
# A TERM while asleep cancels (exit 3) and takes the sleep with it; a TERM once the kill began is ignored.
_watch_deadline() {
  local self
  trap - ERR
  # this subshell's own pid → bash 3.2 has no BASHPID
  self="$(exec sh -c 'printf "%s\n" "${PPID}"')"
  trap 'pkill -P "${self}" 2>/dev/null; exit 3' TERM
  sleep "$1" &
  wait "$!"
  trap '' TERM
  _kill_process_tree "$2"
}

# STOP first → the process forks nothing new while its children are found; then each child's tree, then itself
_kill_process_tree() {
  local children child
  kill -STOP "$1" 2>/dev/null || return 0
  children="$(pgrep -P "$1")" || true
  while IFS= read -r child; do
    [[ -z "${child}" ]] || _kill_process_tree "${child}"
  done <<<"${children}"
  kill -KILL "$1" 2>/dev/null || true
}
