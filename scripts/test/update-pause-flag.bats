#!/usr/bin/env bats
# update-pause-flag.sh suite — pins the T10 cooperative daemon pause-flag
# contract (Glass Atrium update system, plan E3 / design C):
#   * path resolution — canonical ${GA_ROOT}/.update-state/autoagent-pause.flag,
#     ATRIUM_PAUSE_STATE_DIR override, GA_ROOT anchoring
#   * create / remove — atomic create, idempotent remove
#   * age-check — python3 mtime (loud-fail on absent), NEVER stat -f / -c
#   * is_active honor predicate — fresh flag → rc0 (suspend), no flag → rc1,
#     STALE flag (age > TTL) → loud-fail clear + rc1 (crashed-updater liveness)
#   * daemon honor wiring — daemon-cycle.sh + daemon-apply.sh skip-on-pause and
#     resume-on-stale, with NO flag = normal run
#
# Run via: bats scripts/test/update-pause-flag.bats
# Requires: bats >= 1.5.0, python3
#
# Hermetic: every test pins the pause state dir to a per-test mktemp sandbox via
# ATRIUM_PAUSE_STATE_DIR so the live ~/.glass-atrium/.update-state is NEVER
# touched. The lib is sourced under full `set -Eeuo pipefail` to prove its
# functions are strict-mode-safe (sourced-lib convention, like apply-spine.bats).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/scripts/lib/update-pause-flag.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "update-pause-flag.sh not found: ${REAL_LIB}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  WORK="$(cd -- "$(mktemp -d -t update-pause-bats.XXXXXX)" && pwd -P)"
  STATE="${WORK}/.update-state"
  export ATRIUM_PAUSE_STATE_DIR="${STATE}"
  unset ATRIUM_PAUSE_TTL_SECS
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# source the lib under strict mode (proves strict-mode safety)
load_lib() {
  set -Eeuo pipefail
  IFS=$'\n\t'
  # shellcheck source=/dev/null
  . "${REAL_LIB}"
}

# --- path resolution -------------------------------------------------------

@test "flag path honors ATRIUM_PAUSE_STATE_DIR override" {
  load_lib
  run update_pause_flag_path
  [ "${status}" -eq 0 ]
  [ "${output}" = "${STATE}/autoagent-pause.flag" ]
}

@test "flag path anchors on GA_ROOT/.update-state when no override" {
  load_lib
  unset ATRIUM_PAUSE_STATE_DIR
  GA_ROOT="/tmp/ga-root-xyz"
  run update_pause_flag_path
  [ "${status}" -eq 0 ]
  [ "${output}" = "/tmp/ga-root-xyz/.update-state/autoagent-pause.flag" ]
}

@test "flag path falls back to HOME/.glass-atrium when GA_ROOT unset" {
  load_lib
  unset ATRIUM_PAUSE_STATE_DIR
  unset GA_ROOT
  run update_pause_flag_path
  [ "${status}" -eq 0 ]
  [ "${output}" = "${HOME}/.glass-atrium/.update-state/autoagent-pause.flag" ]
}

@test "explicit dir arg takes precedence over env + GA_ROOT" {
  load_lib
  run update_pause_flag_path "/explicit/dir"
  [ "${status}" -eq 0 ]
  [ "${output}" = "/explicit/dir/autoagent-pause.flag" ]
}

# --- TTL resolution --------------------------------------------------------

@test "ttl defaults to 1800 with no override" {
  load_lib
  run update_pause_ttl_secs
  [ "${output}" = "1800" ]
}

@test "ttl honors a positive integer override" {
  load_lib
  export ATRIUM_PAUSE_TTL_SECS=42
  run update_pause_ttl_secs
  [ "${output}" = "42" ]
}

@test "ttl rejects non-integer / non-positive override → 1800" {
  load_lib
  export ATRIUM_PAUSE_TTL_SECS="abc"
  run update_pause_ttl_secs
  [ "${output}" = "1800" ]
  export ATRIUM_PAUSE_TTL_SECS=0
  run update_pause_ttl_secs
  [ "${output}" = "1800" ]
}

# --- create / remove -------------------------------------------------------

@test "create writes the canonical flag with a pid+created payload" {
  load_lib
  run update_pause_create
  [ "${status}" -eq 0 ]
  [ "${output}" = "${STATE}/autoagent-pause.flag" ]
  [ -f "${STATE}/autoagent-pause.flag" ]
  grep -q "pid=" "${STATE}/autoagent-pause.flag"
  grep -q "created=" "${STATE}/autoagent-pause.flag"
}

@test "remove is idempotent (absent flag → rc0)" {
  load_lib
  run update_pause_remove
  [ "${status}" -eq 0 ]
  update_pause_create >/dev/null
  run update_pause_remove
  [ "${status}" -eq 0 ]
  [ ! -e "${STATE}/autoagent-pause.flag" ]
}

# --- ownership guard: concurrent-writer safety (finding #15) ----------------
# Regression pins for the race where a LOSING concurrent updater's create/cleanup
# clobbers + deletes the WINNING updater's pause flag. In bats `$$` is the (stable)
# test-process pid, so a payload written with a foreign pid models a rival updater.
# Assertions are `|| return 1`-gated (loud-fail, matching publish-release.bats).

@test "create REFUSES (rc1) a fresh flag held by a live FOREIGN updater" {
  load_lib
  local foreign
  sleep 30 &
  foreign=$! # a real live pid distinct from $$
  mkdir -p -- "${STATE}"
  printf 'pid=%s created=%s\n' "${foreign}" "$(date -u +%s)" >"${STATE}/autoagent-pause.flag"
  run update_pause_create
  kill "${foreign}" 2>/dev/null || true
  [[ "${status}" -eq 1 ]] || return 1
  [[ "${output}" == *"REFUSING create"* ]] || return 1
  # the winner's payload is untouched (never clobbered)
  grep -q "pid=${foreign}" "${STATE}/autoagent-pause.flag" || return 1
}

@test "create OVERWRITES a DEAD-owner flag (crashed-updater residue)" {
  load_lib
  mkdir -p -- "${STATE}"
  local dead=999999 # a pid with no live process → kill -0 fails → overwrite path
  while kill -0 "${dead}" 2>/dev/null; do dead=$((dead - 1)); done
  printf 'pid=%s created=%s\n' "${dead}" "$(date -u +%s)" >"${STATE}/autoagent-pause.flag"
  run update_pause_create
  [[ "${status}" -eq 0 ]] || return 1
  grep -q "pid=$$" "${STATE}/autoagent-pause.flag" || return 1 # now owned by us
}

@test "create OVERWRITES a STALE flag even with a live foreign owner (TTL recovery)" {
  load_lib
  export ATRIUM_PAUSE_TTL_SECS=1
  mkdir -p -- "${STATE}"
  local foreign
  sleep 30 &
  foreign=$!
  printf 'pid=%s created=%s\n' "${foreign}" "$(date -u +%s)" >"${STATE}/autoagent-pause.flag"
  touch -t 202001010000 "${STATE}/autoagent-pause.flag" # age >> 1s TTL
  run update_pause_create
  kill "${foreign}" 2>/dev/null || true
  [[ "${status}" -eq 0 ]] || return 1
  grep -q "pid=$$" "${STATE}/autoagent-pause.flag" || return 1
}

@test "create OVERWRITES its own-pid flag (heartbeat refresh)" {
  load_lib
  update_pause_create >/dev/null # first create → pid=$$
  run update_pause_create        # refresh → still $$, rc0
  [[ "${status}" -eq 0 ]] || return 1
  grep -q "pid=$$" "${STATE}/autoagent-pause.flag" || return 1
}

@test "remove LEAVES a flag owned by a live FOREIGN updater (the core fix)" {
  load_lib
  mkdir -p -- "${STATE}"
  local foreign
  sleep 30 &
  foreign=$!
  printf 'pid=%s created=%s\n' "${foreign}" "$(date -u +%s)" >"${STATE}/autoagent-pause.flag"
  run update_pause_remove
  kill "${foreign}" 2>/dev/null || true
  [[ "${status}" -eq 0 ]] || return 1                  # idempotent, no error
  [[ -e "${STATE}/autoagent-pause.flag" ]] || return 1 # NOT deleted — winner survives
}

@test "remove DELETES a flag we own (payload pid == \$\$)" {
  load_lib
  update_pause_create >/dev/null # pid=$$
  run update_pause_remove
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${STATE}/autoagent-pause.flag" ]] || return 1
}

@test "remove DELETES a flag with an unparseable / ownerless payload" {
  load_lib
  mkdir -p -- "${STATE}"
  printf 'garbage no pid here\n' >"${STATE}/autoagent-pause.flag"
  run update_pause_remove
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${STATE}/autoagent-pause.flag" ]] || return 1
}

@test "flag_pid parses the payload pid; empty on absent / unparseable" {
  load_lib
  run update_pause_flag_pid "${STATE}/autoagent-pause.flag" # absent
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
  mkdir -p -- "${STATE}"
  printf 'pid=4242 created=1\n' >"${STATE}/autoagent-pause.flag"
  run update_pause_flag_pid "${STATE}/autoagent-pause.flag"
  [[ "${output}" = "4242" ]] || return 1
  printf 'nope\n' >"${STATE}/autoagent-pause.flag"
  run update_pause_flag_pid "${STATE}/autoagent-pause.flag"
  [[ -z "${output}" ]] || return 1
}

# --- age-check (python3 mtime, NEVER stat -f / -c) -------------------------

@test "age-check loud-fails (rc1) on an absent flag" {
  load_lib
  run update_pause_flag_age_secs "${STATE}/autoagent-pause.flag"
  [ "${status}" -eq 1 ]
}

@test "age-check returns a small integer for a just-created flag" {
  load_lib
  update_pause_create >/dev/null
  run update_pause_flag_age_secs "${STATE}/autoagent-pause.flag"
  [ "${status}" -eq 0 ]
  [[ "${output}" =~ ^[0-9]+$ ]]
  [ "${output}" -lt 5 ]
}

@test "age-check does NOT shell out to stat -f / stat -c (python3 only)" {
  # The lib must use python3 mtime, not the BSD/GNU-divergent stat flags. Strip
  # comment lines first: the lib's cautionary comments literally name the
  # forbidden `stat -f` / `stat -c` flags, so a raw grep false-matches the
  # documentation rather than an actual command invocation.
  run bash -c "grep -vE '^[[:space:]]*#' \"${REAL_LIB}\" | grep -E 'stat -f|stat -c'"
  [ "${status}" -ne 0 ]  # no real stat -f/-c command → grep finds nothing → rc1
  grep -q 'python3' "${REAL_LIB}"
}

# --- is_active honor predicate --------------------------------------------

@test "is_active rc1 (run) when no flag present" {
  load_lib
  run update_pause_is_active
  [ "${status}" -eq 1 ]
}

@test "is_active rc0 (suspend) when a fresh flag is held" {
  load_lib
  update_pause_create >/dev/null
  run update_pause_is_active
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"active pause flag"* ]]
}

@test "is_active loud-fail clears a STALE flag and returns rc1 (run)" {
  load_lib
  export ATRIUM_PAUSE_TTL_SECS=1
  update_pause_create >/dev/null
  # backdate the flag well beyond the 1s TTL → stale crashed-updater residue
  touch -t 202001010000 "${STATE}/autoagent-pause.flag"
  run update_pause_is_active
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"STALE"* ]]
  [ ! -e "${STATE}/autoagent-pause.flag" ]  # cleared so the daemon never freezes
}

# --- daemon honor wiring (daemon-cycle.sh / daemon-apply.sh) ---------------

# DELIBERATELY HOME-anchored (NOT ${GA}-relative): the BEHAVIOR tests below
# EXECUTE daemon-cycle.sh, which resolves its OWN pause-flag lib from
# ${HOME}/.glass-atrium/scripts/lib (a script-side anchor). Pointing these at the
# ${GA} checkout would let the behavior tests RUN but then FAIL when the canonical
# install is absent (the daemon degrades to "proceeding without update-pause gate"
# instead of the asserted skip/STALE path). Keeping the HOME anchor lets the
# `[[ -f "${CYCLE_SH}" ]] || skip` guards cleanly skip the daemon-integration tests
# off a canonical install (CI checkout), while the 15 hermetic lib tests above —
# anchored on ${GA} via REAL_LIB — always run.
CYCLE_SH="${HOME}/.glass-atrium/autoagent/daemon-cycle.sh"
# daemon-apply.sh's writer-serialization lock is being redesigned (bare git mkdir-lock
# -> the shared stale-reclaim apply_lock_acquire); the INSTALLED copy lags until the
# update lands, so anchor the ordering assertion on the SOURCE tree (${GA}) — the same
# source-under-test anchor the hermetic lib tests use — not on ${HOME}.
APPLY_SH="${GA}/autoagent/daemon-apply.sh"

@test "daemon-cycle.sh sources the pause lib and gates on update_pause_is_active" {
  [[ -f "${CYCLE_SH}" ]] || skip "daemon-cycle.sh missing"
  grep -q 'update-pause-flag.sh' "${CYCLE_SH}"
  grep -q 'update_pause_is_active' "${CYCLE_SH}"
  # the skip path is a clean exit 0 (not a DEGRADED non-zero)
  grep -q 'skipping cycle (exit 0)' "${CYCLE_SH}"
}

@test "daemon-apply.sh sources the pause lib and gates before lock acquisition" {
  [[ -f "${APPLY_SH}" ]] || skip "daemon-apply.sh missing"
  grep -q 'update-pause-flag.sh' "${APPLY_SH}"
  grep -q 'update_pause_is_active' "${APPLY_SH}"
  # the pause gate must precede the .apply-lock acquisition (writer-serialization
  # honor happens at the decision-to-run, before any work). The lock is now taken via
  # the shared stale-reclaim apply_lock_acquire (git-free), NOT a bare mkdir "${LOCK_DIR}".
  local pause_line lock_line
  pause_line="$(grep -n 'update_pause_is_active' "${APPLY_SH}" | head -1 | cut -d: -f1)"
  lock_line="$(grep -n 'apply_lock_acquire' "${APPLY_SH}" | head -1 | cut -d: -f1)"
  [ -n "${pause_line}" ]
  [ -n "${lock_line}" ]
  [ "${pause_line}" -lt "${lock_line}" ]
}

@test "daemon-cycle.sh degrades to WARN+proceed when the pause lib is missing" {
  [[ -f "${CYCLE_SH}" ]] || skip "daemon-cycle.sh missing"
  # DAEMON SAFETY: an absent lib must never break the launchd-live daemon.
  grep -q 'proceeding without update-pause gate' "${CYCLE_SH}"
}

@test "daemon-cycle.sh BEHAVIOR: a held pause flag short-circuits to exit 0 before dispatch" {
  [[ -f "${CYCLE_SH}" ]] || skip "daemon-cycle.sh missing"
  # HOME stays real so the lib resolves at ~/.glass-atrium/scripts/lib; the flag
  # is redirected to the sandbox via ATRIUM_PAUSE_STATE_DIR. AUTOAGENT_CLAUDE_BIN
  # preset so the claude-bin detection (exit 4) never gates this test. The pause
  # gate runs BEFORE the cycle dispatch, so no report/work is produced.
  load_lib                         # source the lib so update_pause_create resolves
  update_pause_create >/dev/null  # hold a FRESH flag in the sandbox
  run env ATRIUM_PAUSE_STATE_DIR="${STATE}" \
          AUTOAGENT_CLAUDE_BIN="$(command -v python3)" \
          bash "${CYCLE_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"skipping cycle (exit 0)"* ]]
}

@test "daemon-cycle.sh BEHAVIOR: a STALE flag is cleared and does NOT short-circuit" {
  [[ -f "${CYCLE_SH}" ]] || skip "daemon-cycle.sh missing"
  # A crashed-updater stale flag must NOT freeze the daemon: the gate clears it
  # and proceeds. We assert the STALE-clear log fired and the flag was removed;
  # the downstream dispatch may exit non-zero (no PG/claude in the test host),
  # which is fine — the point is the gate did NOT short-circuit on the stale flag.
  load_lib                         # source the lib so update_pause_create resolves
  export ATRIUM_PAUSE_TTL_SECS=1
  update_pause_create >/dev/null
  touch -t 202001010000 "${STATE}/autoagent-pause.flag"
  run env ATRIUM_PAUSE_STATE_DIR="${STATE}" ATRIUM_PAUSE_TTL_SECS=1 \
          AUTOAGENT_CLAUDE_BIN="$(command -v python3)" \
          bash "${CYCLE_SH}" --dry-run
  [[ "${output}" == *"STALE"* ]]
  [ ! -e "${STATE}/autoagent-pause.flag" ]
  # NOT the pause short-circuit message (it proceeded past the gate)
  [[ "${output}" != *"skipping cycle (exit 0)"* ]]
}
