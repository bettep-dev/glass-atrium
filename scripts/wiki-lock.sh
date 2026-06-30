#!/usr/bin/env bash
# wiki-lock.sh — advisory lock helper for wiki write operations.
#
# Why: Concurrent wiki-curator writes (manual run vs cron 04:00, or future
# parallel batches) can corrupt master-index.md and wiki notes. Provides a
# portable lock primitive usable from shell scripts.
#
# Strategy: atomic `mkdir` advisory lock — POSIX-portable and race-free since
# mkdir of an existing dir fails atomically. Stock macOS ships no flock(1), so
# this is the only path (no flock fast-path exists).
#
# Owner model (the exclusion-critical detail): the lock records the PID of the
# REAL holder, then a stale lock is reaped only when kill -0 shows that holder
# dead. For the bare `acquire`/`release` subcommands the holder is the CALLER
# shell ($PPID), because this helper exits the instant the subcommand returns —
# recording the helper's own $$ would record an already-dead PID and let the next
# acquirer reap a live lock. The `with` form records $$ instead: that helper
# stays alive for the wrapped command's lifetime, so it IS the holder.
#
# Interface:
#   wiki-lock.sh acquire <name> [timeout_sec]   # exit 0 on success, 2 on timeout
#   wiki-lock.sh release <name>                 # exit 0 always (idempotent)
#   wiki-lock.sh with <name> [timeout_sec] -- <command...>
#     Runs <command> while holding the lock. Releases on EXIT/INT/TERM.
#
# Lock dir: /tmp/wiki-lock-<name>.lock (the directory itself is the token).
# Contains the holder PID + an acquire timestamp for debugging.

set -Eeuo pipefail
IFS=$'\n\t'

readonly LOCK_ROOT="/tmp"
readonly DEFAULT_TIMEOUT=30

usage() {
  cat >&2 <<'EOF'
Usage:
  wiki-lock.sh acquire <name> [timeout_sec]
  wiki-lock.sh release <name>
  wiki-lock.sh with <name> [timeout_sec] -- <command...>
EOF
  exit 64
}

lock_path() {
  local name="$1"
  printf '%s/wiki-lock-%s.lock' "${LOCK_ROOT}" "${name}"
}

# Reap a stale lock whose owning PID is no longer alive.
# Safe because mkdir-based locking means the directory itself is the token;
# a dead owner cannot race with us over its own PID.
reap_if_stale() {
  local lock_dir="$1"
  local pid_file="${lock_dir}/pid"

  [[ -d "${lock_dir}" ]] || return 0
  [[ -f "${pid_file}" ]] || return 0

  local owner_pid
  owner_pid="$(cat "${pid_file}" 2>/dev/null || echo '')"
  [[ -n "${owner_pid}" ]] || return 0

  if ! kill -0 "${owner_pid}" 2>/dev/null; then
    # Owner is dead. Clean up.
    rm -rf -- "${lock_dir}" 2>/dev/null || true
    printf 'wiki-lock: reaped stale lock (dead pid=%s) at %s\n' \
      "${owner_pid}" "${lock_dir}" >&2
  fi
}

# $3 = owner PID to record as the holder. The bare `acquire` subcommand passes
# $PPID (the caller shell) because this helper process exits the instant acquire
# returns — recording $$ would record an already-dead PID, which reap_if_stale
# would then reap out from under the live caller, defeating exclusion. The `with`
# form passes $$ instead: that helper stays alive for the command's lifetime, so
# it IS the real holder.
acquire_lock() {
  local name="$1"
  local timeout="${2:-${DEFAULT_TIMEOUT}}"
  local owner_pid="${3:-$$}"
  local lock_dir
  lock_dir="$(lock_path "${name}")"

  local waited=0
  while ((waited <= timeout)); do
    reap_if_stale "${lock_dir}"

    # Atomic: mkdir fails if directory exists.
    if mkdir -- "${lock_dir}" 2>/dev/null; then
      printf '%s\n' "${owner_pid}" >"${lock_dir}/pid"
      date -u +%Y-%m-%dT%H:%M:%SZ >"${lock_dir}/acquired_at"
      return 0
    fi

    sleep 1
    waited=$((waited + 1))
  done

  printf 'wiki-lock: timeout after %ss acquiring %s\n' \
    "${timeout}" "${name}" >&2
  return 2
}

# $2 = owner PID claimed by the releaser, matched against the recorded holder so
# one process cannot release another's lock. Mirrors acquire_lock's owner model:
# the bare `release` subcommand passes $PPID, the `with` form passes $$.
release_lock() {
  local name="$1"
  local owner_pid_self="${2:-$$}"
  local lock_dir
  lock_dir="$(lock_path "${name}")"

  [[ -d "${lock_dir}" ]] || return 0

  # Only release if we own it (pid match) — prevents cross-process stomping.
  local owner_pid
  owner_pid="$(cat "${lock_dir}/pid" 2>/dev/null || echo '')"
  if [[ -n "${owner_pid}" && "${owner_pid}" != "${owner_pid_self}" ]]; then
    # Not ours; leave it alone.
    return 0
  fi

  rm -rf -- "${lock_dir}" 2>/dev/null || true
  return 0
}

cmd_with() {
  # Parse: with <name> [timeout] -- <command...>
  local name="$1"
  shift
  [[ -n "${name}" ]] || usage

  local timeout="${DEFAULT_TIMEOUT}"
  if [[ "${1:-}" != "--" && -n "${1:-}" ]]; then
    timeout="$1"
    shift
  fi

  [[ "${1:-}" == "--" ]] || usage
  shift
  (($# > 0)) || usage

  # This helper process stays alive for the command's lifetime, so it IS the real
  # holder — record its own $$ as owner. Register cleanup BEFORE acquiring so
  # release fires on any exit path.
  # shellcheck disable=SC2064  # expand name/pid now, not at trap time
  trap "release_lock '${name}' $$" EXIT INT TERM

  acquire_lock "${name}" "${timeout}" "$$"

  local exit_code=0
  "$@" || exit_code=$?
  return "${exit_code}"
}

main() {
  (($# >= 1)) || usage
  local subcmd="$1"
  shift

  case "${subcmd}" in
    acquire)
      (($# >= 1)) || usage
      # The caller shell ($PPID) is the real holder — this helper exits on return.
      acquire_lock "$1" "${2:-${DEFAULT_TIMEOUT}}" "${PPID}"
      ;;
    release)
      (($# >= 1)) || usage
      release_lock "$1" "${PPID}"
      ;;
    with)
      cmd_with "$@"
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
