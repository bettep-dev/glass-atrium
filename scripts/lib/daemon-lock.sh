#!/usr/bin/env bash
# SC2154: ROLE is defined by the sourcing script (daemon-daily-restart.sh, or a
# bootstrap wrapper per the daemon-bootstrap-common.sh wrapper contract) — a
# sourced lib cannot see the assignment, so the unassigned-reference warning is
# a structural false positive. SC2034 is its mirror image: the lock paths and
# result globals are consumed by the sourcing scripts, not inside this lib.
# shellcheck disable=SC2154,SC2034
#
# daemon-lock.sh — symlink pid-lock helpers shared by daemon-daily-restart.sh
# (holds the restart-window lock across kill→recreate) and
# daemon-bootstrap-common.sh (supervisor lock + restart-window honor). Sourced,
# not executable; both sourcing scripts define ROLE before sourcing.
#
# Primitive: `ln -s <pid> <lock>` — symlink creation is atomic AND carries the
# holder pid as the link target, so there is no mkdir+pidfile two-step window in
# which a racer reads an empty lock. A SIGKILLed holder leaves a stale link;
# acquire reclaims it after a liveness probe (kill -0) on the recorded pid.
# Helpers report state via globals (daemon_lock_holder / daemon_lock_acquired),
# not exit codes, so set -e / ERR-trap callers can invoke them plainly.

# Env-overridable for hermetic tests only; production callers share the /tmp
# default — both sourcing scripts MUST resolve identical lock paths.
: "${DAEMON_LOCK_DIR:=/tmp}"
readonly DAEMON_LOCK_DIR
readonly DAEMON_RESTART_LOCK="${DAEMON_LOCK_DIR}/daemon-restart-${ROLE}.lock"
readonly DAEMON_SUPERVISOR_LOCK="${DAEMON_LOCK_DIR}/daemon-supervisor-${ROLE}.lock"

# Reads the holder pid into daemon_lock_holder ("" when unlocked).
daemon_lock_holder=""
daemon_lock_read_holder() {
  daemon_lock_holder="$(readlink -- "$1" 2>/dev/null || true)"
}

# Sets daemon_lock_acquired=true when the lock is taken (link target = owner
# pid); false when a live holder keeps it. A dead-holder link is reclaimed with
# a single retry — losing that retry to a concurrent reclaimer counts as held.
daemon_lock_acquired=false
daemon_lock_acquire() {
  local lock_path="$1" owner_pid="$2"
  daemon_lock_acquired=false
  if ln -s "${owner_pid}" "${lock_path}" 2>/dev/null; then
    daemon_lock_acquired=true
    return 0
  fi
  daemon_lock_read_holder "${lock_path}"
  if [[ -n "${daemon_lock_holder}" ]] && kill -0 "${daemon_lock_holder}" 2>/dev/null; then
    return 0
  fi
  # rm failure is not silent: the retry below then reports daemon_lock_acquired
  # =false and the caller surfaces it (yield / exit 7).
  rm -f -- "${lock_path}" 2>/dev/null || true
  if ln -s "${owner_pid}" "${lock_path}" 2>/dev/null; then
    daemon_lock_acquired=true
  fi
}

# Removes the lock only when owned by owner_pid — an unrelated release must not
# destroy a racer's freshly acquired lock. A failed rm leaves a stale link that
# the next acquire reclaims via the dead-holder probe.
daemon_lock_release() {
  local lock_path="$1" owner_pid="$2"
  daemon_lock_read_holder "${lock_path}"
  if [[ "${daemon_lock_holder}" == "${owner_pid}" ]]; then
    rm -f -- "${lock_path}" 2>/dev/null || true
  fi
}
