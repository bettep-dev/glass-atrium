#!/usr/bin/env bats
# prune-mtime-portable.bats — pins the OS-portable mtime accessor in the two SessionStart prune hooks
# (prune-session-spawns.sh + prune-security-warnings-state.sh). Both derive a file's epoch mtime to
# decide preserve-vs-prune. The pre-fix code used a bare BSD `stat -f %m`; on GNU/Linux `-f` means
# --file-system, so every file read as mtime 0 → fell BELOW every freshness cutoff → was pruned as
# stale (silent data loss). The fix detects the flavor once (uname → `stat -f %m` | `stat -c %Y`).
#
# These tests seed a FRESH file (mtime now) alongside a STALE file (mtime years old) and assert the
# fresh one is PRESERVED. On Linux with the old bare-`-f` code the fresh file would read mtime 0 and be
# wrongly pruned — so a portability regression fails here (not silently in production).

PRUNE_SPAWNS="${BATS_TEST_DIRNAME}/../prune-session-spawns.sh"
PRUNE_SECWARN="${BATS_TEST_DIRNAME}/../prune-security-warnings-state.sh"

setup() {
  [[ -f "${PRUNE_SPAWNS}" ]] || skip "prune-session-spawns.sh not found"
  [[ -f "${PRUNE_SECWARN}" ]] || skip "prune-security-warnings-state.sh not found"
  PM_TMP="$(mktemp -d -t prune-mtime.XXXXXX)"
}

teardown() {
  [[ -n "${PM_TMP:-}" && -d "${PM_TMP}" ]] && rm -rf -- "${PM_TMP}" || true
}

@test "prune-session-spawns: fresh marker preserved, stale marker pruned (portable mtime)" {
  local spawns="${PM_TMP}/spawns" trash="${PM_TMP}/trash"
  mkdir -p "${spawns}" "${trash}"
  printf 'fresh\n' >"${spawns}/fresh-marker"
  printf 'stale\n' >"${spawns}/stale-marker"
  # Fresh = now; stale = 2020-01-01 (far outside the default 86400s TTL).
  touch -t 202001010000 "${spawns}/stale-marker"

  run env SESSION_SPAWNS_DIR="${spawns}" PRUNE_TRASH_DIR="${trash}" SESSION_SPAWNS_TTL=86400 \
    bash -c 'printf "%s" "{}" | bash "$1"' _ "${PRUNE_SPAWNS}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  # The fresh marker MUST remain (the exact portability regression: old Linux code pruned it).
  [ -f "${spawns}/fresh-marker" ] || { echo "fresh marker wrongly pruned"; return 1; }
  # The stale marker MUST be gone from the spawns dir and land in Trash.
  [ ! -f "${spawns}/stale-marker" ] || { echo "stale marker not pruned"; return 1; }
  ls "${trash}"/stale-marker_* >/dev/null 2>&1 || { echo "stale marker not moved to Trash"; return 1; }
}

@test "prune-security-warnings-state: fresh state preserved, stale state pruned (portable mtime)" {
  local base="${PM_TMP}/base" trash="${PM_TMP}/trash2"
  mkdir -p "${base}" "${trash}"
  # UUID-shaped names (the hook's glob is security_warnings_state_*.json).
  local fresh="${base}/security_warnings_state_11111111-1111-1111-1111-111111111111.json"
  local stale="${base}/security_warnings_state_22222222-2222-2222-2222-222222222222.json"
  printf '{}\n' >"${fresh}"
  printf '{}\n' >"${stale}"
  touch -t 202001010000 "${stale}"

  # Empty JSON (no session_id) forces the mtime-window preserve path (the branch that reads mtime).
  run env PRUNE_BASE_DIR="${base}" PRUNE_TRASH_DIR="${trash}" \
    bash -c 'printf "%s" "{}" | bash "$1"' _ "${PRUNE_SECWARN}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  # Fresh (within the 300s window) preserved; stale pruned.
  [ -f "${fresh}" ] || { echo "fresh state file wrongly pruned"; return 1; }
  [ ! -f "${stale}" ] || { echo "stale state file not pruned"; return 1; }
  ls "${trash}"/security_warnings_state_22222222-*_*.json >/dev/null 2>&1 \
    || { echo "stale state file not moved to Trash"; return 1; }
}
