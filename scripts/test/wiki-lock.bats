#!/usr/bin/env bats
# wiki-lock.bats — pins the helper's two lock-dir removals (dead-holder reap, owner release) and
# its load-time dependency on the shared path guard.
#
# The helper's lock root is a readonly /tmp, so each test takes a lock name unique to this run and
# test, and teardown removes that one lock dir only.

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
SCRIPT="${GA}/scripts/wiki-lock.sh"
# Above every platform pid ceiling, so kill -0 can never find it alive.
DEAD_PID=99999999

setup() {
  # shellcheck source=../lib/path-guard.sh
  source "${GA}/scripts/lib/path-guard.sh"
  LOCK_NAME="bats-${BATS_RUN_TMPDIR##*/}-${BATS_TEST_NUMBER}"
  LOCK_DIR="/tmp/wiki-lock-${LOCK_NAME}.lock"
}

teardown() {
  if ga_guard_path "${LOCK_DIR:-}"; then
    rm -rf -- "${LOCK_DIR:?}"
  fi
}

seed_dead_holder_lock() {
  mkdir -- "${LOCK_DIR}"
  printf '%s\n' "${DEAD_PID}" >"${LOCK_DIR}/pid"
}

@test "a lock whose recorded holder is dead is reaped and the acquire takes it over" {
  seed_dead_holder_lock
  run bash "${SCRIPT}" acquire "${LOCK_NAME}" 0
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"reaped stale lock (dead pid=${DEAD_PID})"* ]] || return 1
  [ "$(cat "${LOCK_DIR}/pid")" != "${DEAD_PID}" ]
}

@test "the with form holds the lock for the command and removes it once the command returns" {
  run bash "${SCRIPT}" with "${LOCK_NAME}" 0 -- test -d "${LOCK_DIR}"
  [ "${status}" -eq 0 ]
  [ ! -e "${LOCK_DIR}" ]
}

@test "a copy without the shared path guard beside it refuses to run and leaves the lock alone" {
  mkdir -p "${BATS_TEST_TMPDIR}/sandbox"
  cp "${SCRIPT}" "${BATS_TEST_TMPDIR}/sandbox/wiki-lock.sh"
  seed_dead_holder_lock
  run bash "${BATS_TEST_TMPDIR}/sandbox/wiki-lock.sh" acquire "${LOCK_NAME}" 0
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"path-guard.sh"* ]] || return 1
  [ "$(cat "${LOCK_DIR}/pid")" = "${DEAD_PID}" ]
}
