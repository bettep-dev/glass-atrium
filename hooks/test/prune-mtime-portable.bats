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
# Hooks run under /bin/bash where present (bash 3.2 on macOS), with a sandbox HOME, no GA_DATA_ROOT
# and every swept dir overridden — no run can resolve a default to live data.

PRUNE_SPAWNS="${BATS_TEST_DIRNAME}/../prune-session-spawns.sh"
PRUNE_SECWARN="${BATS_TEST_DIRNAME}/../prune-security-warnings-state.sh"

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${PRUNE_SPAWNS}" ]] || skip "prune-session-spawns.sh not found"
  [[ -f "${PRUNE_SECWARN}" ]] || skip "prune-security-warnings-state.sh not found"
  PM_TMP="$(mktemp -d -t prune-mtime.XXXXXX)"
  mkdir -p "${PM_TMP}/home"
  HOOK_BASH="bash"
  if [[ -x /bin/bash ]]; then HOOK_BASH="/bin/bash"; fi
}

teardown() {
  if ga_guard_path "${PM_TMP:-}"; then rm -rf -- "${PM_TMP:?}"; fi
}

# run_hook <hook> [VAR=value...] — runs the hook on `{}` stdin inside the sandbox HOME.
run_hook() {
  local hook="${1}"
  shift
  # shellcheck disable=SC2016  # $1/$2 belong to the child bash
  run env -u GA_DATA_ROOT HOME="${PM_TMP}/home" "$@" \
    "${HOOK_BASH}" -c 'printf "%s" "{}" | "$1" "$2"' _ "${HOOK_BASH}" "${hook}"
}

@test "prune-session-spawns: fresh marker preserved, stale marker pruned (portable mtime)" {
  local spawns="${PM_TMP}/spawns" trash="${PM_TMP}/trash"
  mkdir -p "${spawns}" "${trash}"
  printf 'fresh\n' >"${spawns}/fresh-marker"
  printf 'stale\n' >"${spawns}/stale-marker"
  # Fresh = now; stale = 2020-01-01 (far outside the default 86400s TTL).
  touch -t 202001010000 "${spawns}/stale-marker"

  run_hook "${PRUNE_SPAWNS}" SESSION_SPAWNS_DIR="${spawns}" AGENT_TOOL_BUDGET_DIR="${PM_TMP}/budget" \
    PRUNE_TRASH_DIR="${trash}" SESSION_SPAWNS_TTL=86400
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  # The fresh marker MUST remain (the exact portability regression: old Linux code pruned it).
  [ -f "${spawns}/fresh-marker" ] || { echo "fresh marker wrongly pruned"; return 1; }
  # The stale marker MUST be gone from the spawns dir and land in Trash.
  [ ! -f "${spawns}/stale-marker" ] || { echo "stale marker not pruned"; return 1; }
  ls "${trash}"/stale-marker_* >/dev/null 2>&1 || { echo "stale marker not moved to Trash"; return 1; }
}

@test "prune-session-spawns: an existing empty swept dir does not stop the other dir's sweep" {
  local row empty_dir stale_dir base
  # Row = <empty dir>:<dir holding a stale entry>; both orders, so either sweep can be the empty one.
  for row in "spawns:budget" "budget:spawns"; do
    empty_dir="${row%%:*}"
    stale_dir="${row##*:}"
    base="${PM_TMP}/empty-${empty_dir}"
    mkdir -p "${base}/spawns" "${base}/budget" "${base}/trash"
    printf 'stale\n' >"${base}/${stale_dir}/stale-entry"
    touch -t 202001010000 "${base}/${stale_dir}/stale-entry"

    run_hook "${PRUNE_SPAWNS}" SESSION_SPAWNS_DIR="${base}/spawns" AGENT_TOOL_BUDGET_DIR="${base}/budget" \
      PRUNE_TRASH_DIR="${base}/trash" SESSION_SPAWNS_TTL=86400
    [ "${status}" -eq 0 ] || { echo "empty ${empty_dir}: exit ${status}: ${output}"; return 1; }
    ls "${base}/trash"/stale-entry_* >/dev/null 2>&1 \
      || { echo "empty ${empty_dir}: stale ${stale_dir} entry not moved to Trash: ${output}"; return 1; }
  done
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
  run_hook "${PRUNE_SECWARN}" PRUNE_BASE_DIR="${base}" PRUNE_TRASH_DIR="${trash}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  # Fresh (within the 300s window) preserved; stale pruned.
  [ -f "${fresh}" ] || { echo "fresh state file wrongly pruned"; return 1; }
  [ ! -f "${stale}" ] || { echo "stale state file not pruned"; return 1; }
  ls "${trash}"/security_warnings_state_22222222-*_*.json >/dev/null 2>&1 \
    || { echo "stale state file not moved to Trash"; return 1; }
}
