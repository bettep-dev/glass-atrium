#!/usr/bin/env bats
# apply-lock.sh suite (P1-T7) — pins the shared stale-reclaim guard for the
# mkdir-directory .apply-lock held by BOTH writers (daemon-apply.sh apply stage +
# update.sh update_serialize_begin). This is the permanent replacement for the
# retired mid-apply signals (update_head_is_wip / [WIP-AUTO] HEAD): a mid-apply
# daemon is now a LIVE lock holder; a SIGKILLed daemon leaves a stale/dead lock the
# guard reclaims instead of wedging every future run.
#
# The 8 P1-T7 cases pinned here:
#   1. uncontended acquire                     -> apply_lock_acquired=true, lock dir
#   2. LIVE holder                             -> blocked (acquired=false), NOT reclaimed
#   3. DEAD holder past the TTL                -> reclaimed (crashed-holder residue)
#   4. DEAD holder within the TTL              -> still held (fresh mid-acquire racer)
#   5. path-guard                              -> a mis-derived non-.apply-lock dir is
#                                                 NEVER rm'd (reclaim + release refuse)
#   6. ownership-gated release                 -> removes our own lock, refuses a foreign
#                                                 live holder's
#   7. mkdir-directory primitive               -> a real dir (not a symlink), NO `ln -s`
#   8. pid recorded INSIDE the dir             -> temp+rename, single numeric pid, no
#                                                 leftover temp file
#
# Incident #58325 defect pins (mutual-exclusion hardenings, cases 9-19):
#   9. pid-less FRESH lock                     -> held (crashed-before-pid-write racer)
#  10. pid-less STALE lock                     -> reclaimed (TTL bounds a record-less lock)
#  11. release with absent/empty pid           -> treated as our own partial lock, removed
#  12. RECYCLED pid (live, wrong fingerprint)  -> not-live; stale age -> reclaimed (no wedge)
#  13. RECYCLED pid but FRESH                  -> held (TTL age gate still applies)
#  14. live holder, MATCHING fingerprint       -> held even past the TTL (verified live)
#  15. legacy fingerprint-less LIVE holder     -> held even past the TTL (bare kill -0
#                                                 fallback; never insta-reclaimed)
#  16. fingerprint recorded on acquire         -> temp+rename, matches ps lstart, no residue
#  17. single-winner reclaim (late loser)      -> a reclaimer acting on an outdated stale
#                                                 decision cannot destroy the winner's
#                                                 fresh lock (atomic restore, no tomb left)
#  18. single-winner reclaim (winner)          -> genuinely stale dir taken over; tomb
#                                                 removed, no residue
#  19. owner-record write failure              -> loud named ERROR, partial dir released,
#                                                 acquired=false, rc still 0 (contract)
#
# Run via: bats scripts/test/apply-lock.bats
# Requires: bats >= 1.5.0, python3
#
# Hermetic: every test runs against a per-test mktemp sandbox; the shared lib is
# sourced under full `set -Eeuo pipefail` in disposable `bash -c` children (proving
# strict-mode safety — apply-lock.sh installs no ERR trap, so no trap leaks into the
# bats shell) and the acquire RESULT is read from the apply_lock_acquired global it
# echoes. The live ~/.claude/data/daemon-reports/.apply-lock is NEVER touched. TTL is
# steered via ATRIUM_APPLY_LOCK_TTL_SECS and mtime via python3 os.utime — never
# BSD/GNU-divergent `touch -d` / `stat -f` / `stat -c`.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export LIB="${GA}/scripts/lib/apply-lock.sh"

setup() {
  [[ -f "${LIB}" ]] || skip "apply-lock.sh not found: ${LIB}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  WORK="$(cd -- "$(mktemp -d -t apply-lock-bats.XXXXXX)" && pwd -P)"
  REPORTS="${WORK}/reports" # the .apply-lock parent (mirrors daemon-reports)
  LOCK="${REPORTS}/.apply-lock"
  mkdir -p "${REPORTS}" # parent exists; the lock dir itself is created by acquire
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Spawn a subshell, reap it, and echo its now-dead pid. Callers additionally re-check
# kill -0 and skip on the (astronomically rare) pid-reuse flake, so a reused pid never
# turns into a false failure.
spawn_dead_pid() {
  local p
  (exit 0) &
  p=$!
  wait "${p}" 2>/dev/null || true
  printf '%s' "${p}"
}

# Backdate a path's mtime by $2 seconds via python3 os.utime — the SAME portable idiom
# apply_lock_age_secs uses, never a BSD/GNU-divergent `touch -d` / `stat`.
backdate_secs() {
  python3 -c 'import os,sys,time; d=float(sys.argv[2]); t=time.time()-d; os.utime(sys.argv[1],(t,t))' "$1" "$2"
}

# --- 1. uncontended acquire ------------------------------------------------

@test "uncontended acquire creates the lock dir and sets apply_lock_acquired=true" {
  run bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=true"* ]]
  [[ -d "${LOCK}" ]] # the lock is a real directory (the mutual-exclusion primitive)
}

# --- 2. LIVE holder blocks (no reclaim) ------------------------------------

@test "a LIVE holder blocks acquire (apply_lock_acquired=false) and is NOT reclaimed" {
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid" # $$ = this bats shell, a genuinely LIVE pid
  run bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=false"* ]] # live holder -> mutual exclusion preserved
  [[ "$(cat "${LOCK}/pid")" == "$$" ]]  # original live holder untouched (not reclaimed)
}

# --- 3. DEAD + STALE holder reclaimed --------------------------------------

@test "a DEAD holder aged past the TTL is reclaimed (crashed-holder residue)" {
  local dead
  dead="$(spawn_dead_pid)"
  kill -0 "${dead}" 2>/dev/null && skip "flake: dead pid ${dead} was reused"
  mkdir -p "${LOCK}"
  printf '%s\n' "${dead}" >"${LOCK}/pid" # a dead pid: kill -0 fails -> not-live
  backdate_secs "${LOCK}" 3600           # aged well past the tiny TTL below
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=true"* ]] # not-live AND stale -> reclaimed
  [[ -d "${LOCK}" ]]
  [[ "$(cat "${LOCK}/pid")" != "${dead}" ]] # pid replaced by the reclaimer's own
}

# --- 4. DEAD + FRESH holder held -------------------------------------------

@test "a DEAD holder within the TTL is still held (fresh lock, not reclaimed)" {
  local dead
  dead="$(spawn_dead_pid)"
  kill -0 "${dead}" 2>/dev/null && skip "flake: dead pid ${dead} was reused"
  mkdir -p "${LOCK}"
  printf '%s\n' "${dead}" >"${LOCK}/pid" # not-live...
  # ...but freshly mkdir'd (age ~0) under a generous TTL -> a mid-acquire racer, held.
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1800 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=false"* ]] # two-signal gate: not-live alone is insufficient
  [[ -d "${LOCK}" ]]
  [[ "$(cat "${LOCK}/pid")" == "${dead}" ]] # untouched
}

# --- 5. path-guard refuses a non-.apply-lock dir ---------------------------

@test "path-guard: a mis-derived non-.apply-lock dir is NEVER rm'd (reclaim + release refuse)" {
  local notlock="${REPORTS}/notlock" # deliberately does NOT end in .apply-lock
  local dead
  dead="$(spawn_dead_pid)"
  kill -0 "${dead}" 2>/dev/null && skip "flake: dead pid ${dead} was reused"
  mkdir -p "${notlock}"
  printf '%s\n' "${dead}" >"${notlock}/pid"
  backdate_secs "${notlock}" 3600 # dead + stale would normally reclaim...
  # ...but the SECURITY path-guard blocks the reclaim removal for a non-.apply-lock path.
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${notlock}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=false"* ]] # never acquired (the guard blocked the reclaim)
  [[ -d "${notlock}" ]]                 # SECURITY: dir preserved, never rm -rf'd
  [[ -f "${notlock}/pid" ]]             # contents intact
  # release is likewise path-guarded — it must not touch a non-.apply-lock dir either
  run bash -c 'set -Eeuo pipefail; source "'"${LIB}"'"; apply_lock_release "'"${notlock}"'"'
  [ "$status" -eq 0 ]
  [[ -d "${notlock}" ]]
}

# --- 6. ownership-gated release --------------------------------------------

@test "release is ownership-gated: removes our own lock, refuses a foreign live holder's" {
  # positive: acquire + release in the SAME shell removes the lock
  run bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    apply_lock_release "'"${LOCK}"'"
    [[ -d "'"${LOCK}"'" ]] && printf "STILL\n" || printf "GONE\n"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"GONE"* ]] # our own lock released

  # negative: a lock owned by a DIFFERENT (live) pid is NOT released by us — a
  # reclaimer may have taken over, and destroying its lock would break exclusion.
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid" # owned by the bats shell (live, != the child)
  run bash -c 'set -Eeuo pipefail; source "'"${LIB}"'"; apply_lock_release "'"${LOCK}"'"'
  [ "$status" -eq 0 ]
  [[ -d "${LOCK}" ]]                   # foreign-owned lock preserved
  [[ "$(cat "${LOCK}/pid")" == "$$" ]] # holder pid untouched
}

# --- 7. mkdir-directory primitive, NO symlink ------------------------------

@test "mkdir-directory primitive: an acquired lock is a real dir (not a symlink), no ln -s" {
  run bash -c 'set -Eeuo pipefail; source "'"${LIB}"'"; apply_lock_acquire "'"${LOCK}"'"'
  [ "$status" -eq 0 ]
  [[ -d "${LOCK}" ]]   # a directory (mkdir is atomic on POSIX)
  [[ ! -L "${LOCK}" ]] # NOT a symlink
  # static: the primitive is mkdir; there is NO `ln -s` symlink lock anywhere in the lib
  run grep -nE '(^|[^[:alnum:]_])mkdir([^[:alnum:]_]|$)' "${LIB}"
  [ "$status" -eq 0 ] # mkdir primitive present
  run grep -nE 'ln[[:space:]]+-s' "${LIB}"
  [ "$status" -ne 0 ] # no symlink primitive
  [[ -z "${output}" ]]
}

# --- 8. pid recorded INSIDE the lock dir -----------------------------------

@test "the holder pid is recorded INSIDE the lock dir (temp+rename, single numeric pid)" {
  run bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=true"* ]]
  [[ -f "${LOCK}/pid" ]] # pid lives INSIDE the dir (not a sibling file)
  run cat "${LOCK}/pid"
  [[ "$output" =~ ^[0-9]+$ ]] # a single numeric pid (all-or-nothing rename, no half-write)
  # the temp file used for the atomic rename left no residue
  run bash -c 'ls "'"${LOCK}"'"/.pid.tmp.* 2>/dev/null'
  [ "$status" -ne 0 ]
}

# Echo the lock-lib fingerprint of pid $1 (the bats shell passes its own $$) via a
# disposable child that sources the lib — the tests below forge holder records
# with the EXACT helper the lib compares against (byte-identical trim included).
fingerprint_of() {
  bash -c 'source "'"${LIB}"'"; _apply_lock_pid_fingerprint "$1"' _ "$1"
}

# --- 9. pid-less FRESH lock held --------------------------------------------

@test "a pid-less FRESH lock is held (crashed-before-pid-write racer, not insta-reclaimed)" {
  mkdir -p "${LOCK}" # no pid file at all — holder crashed after mkdir, before pid write
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1800 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=false"* ]] # record-less alone is NOT reclaim grounds
  [[ -d "${LOCK}" ]]                    # untouched
}

# --- 10. pid-less STALE lock reclaimed --------------------------------------

@test "a pid-less STALE lock is reclaimed (TTL bounds a record-less lock)" {
  mkdir -p "${LOCK}" # no pid file
  backdate_secs "${LOCK}" 3600
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=true"* ]]
  [[ -d "${LOCK}" ]]
  run cat "${LOCK}/pid"
  [[ "$output" =~ ^[0-9]+$ ]] # the reclaimer stamped its own record
  # the mv-aside takeover left no tomb residue
  run bash -c 'ls "'"${REPORTS}"'"/.apply-lock.reclaimed.* 2>/dev/null'
  [ "$status" -ne 0 ]
}

# --- 11. release with absent/empty pid --------------------------------------

@test "release treats an absent/empty pid as our own partial lock and removes it" {
  # absent pid file
  mkdir -p "${LOCK}"
  run bash -c 'set -Eeuo pipefail; source "'"${LIB}"'"; apply_lock_release "'"${LOCK}"'"'
  [ "$status" -eq 0 ]
  [[ ! -d "${LOCK}" ]]
  # empty pid file
  mkdir -p "${LOCK}"
  : >"${LOCK}/pid"
  run bash -c 'set -Eeuo pipefail; source "'"${LIB}"'"; apply_lock_release "'"${LOCK}"'"'
  [ "$status" -eq 0 ]
  [[ ! -d "${LOCK}" ]]
}

# --- 12. recycled pid + stale age -> reclaimed -------------------------------

@test "a RECYCLED pid (live pid, mismatching fingerprint) past the TTL is reclaimed" {
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid"                         # genuinely LIVE pid (bats shell)...
  printf '%s\n' "RECYCLED-PID-BOGUS" >"${LOCK}/fingerprint" # ...but NOT the recorded holder
  backdate_secs "${LOCK}" 3600
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=true"* ]] # pre-fix this wedged forever (bare kill -0)
  [[ "$(cat "${LOCK}/pid")" != "$$" ]] # record replaced by the reclaimer's own
}

# --- 13. recycled pid but FRESH -> held (TTL gate still applies) -------------

@test "a RECYCLED pid on a FRESH lock is still held (TTL age gate precedes reclaim)" {
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid"
  printf '%s\n' "RECYCLED-PID-BOGUS" >"${LOCK}/fingerprint"
  # no backdate: age ~0 under a generous TTL -> a mid-acquire racer must survive
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1800 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=false"* ]]
  [[ "$(cat "${LOCK}/pid")" == "$$" ]] # untouched
}

# --- 14. matching fingerprint -> live holder blocks past the TTL -------------

@test "a live holder with a MATCHING fingerprint blocks even past the TTL" {
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid"
  fingerprint_of "$$" >"${LOCK}/fingerprint" # correct identity for the live pid
  backdate_secs "${LOCK}" 3600               # age alone must NOT reclaim a verified holder
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=false"* ]]
  [[ "$(cat "${LOCK}/pid")" == "$$" ]] # untouched
}

# --- 15. legacy fingerprint-less LIVE holder -> old semantics preserved ------

@test "a legacy fingerprint-less LIVE holder blocks even past the TTL (bare kill -0 fallback)" {
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid" # live pid, NO fingerprint file (old-format lock)
  backdate_secs "${LOCK}" 3600
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=false"* ]] # fingerprint-absent = legacy live semantics
  [[ "$(cat "${LOCK}/pid")" == "$$" ]]
}

# --- 16. fingerprint recorded on acquire ------------------------------------

@test "acquire records the holder fingerprint (temp+rename, matches ps lstart, no residue)" {
  run bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
    printf "expected=%s\n" "$(_apply_lock_pid_fingerprint "$$")"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"acquired=true"* ]]
  local expected
  expected="${output#*expected=}"
  [[ -n "${expected}" ]]                                # ps lstart capturable on this host
  [[ -f "${LOCK}/fingerprint" ]]                        # fingerprint lives INSIDE the dir
  [[ "$(cat "${LOCK}/fingerprint")" == "${expected}" ]] # byte-identical to the probe helper
  # the temp file used for the atomic rename left no residue
  run bash -c 'ls "'"${LOCK}"'"/.fp.tmp.* 2>/dev/null'
  [ "$status" -ne 0 ]
}

# --- 17. single-winner reclaim: late loser cannot destroy the winner's lock --

@test "single-winner reclaim: a late reclaimer on an outdated stale decision cannot destroy the winner's fresh lock" {
  # The winner's FRESH lock: live pid + correct fingerprint (as if reclaimer A just
  # finished rebuilding). Reclaimer B decided "stale" on the OLD dir and only NOW
  # executes its takeover step — the sequenced deterministic form of the TOCTOU race.
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid"
  fingerprint_of "$$" >"${LOCK}/fingerprint"
  run bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    _apply_lock_reclaim "'"${LOCK}"'"
  '
  [ "$status" -eq 1 ]                  # takeover refused (rc 1 -> caller holds)
  [[ -d "${LOCK}" ]]                   # winner's lock survived (atomic restore)
  [[ "$(cat "${LOCK}/pid")" == "$$" ]] # record intact
  [[ "$(cat "${LOCK}/fingerprint")" == "$(fingerprint_of "$$")" ]]
  run bash -c 'ls "'"${REPORTS}"'"/.apply-lock.reclaimed.* 2>/dev/null'
  [ "$status" -ne 0 ] # restored, no tomb leaked
}

# --- 18. single-winner reclaim: genuinely stale dir is taken over ------------

@test "single-winner reclaim: a genuinely stale dir is taken over and the tomb removed" {
  local dead
  dead="$(spawn_dead_pid)"
  kill -0 "${dead}" 2>/dev/null && skip "flake: dead pid ${dead} was reused"
  mkdir -p "${LOCK}"
  printf '%s\n' "${dead}" >"${LOCK}/pid"
  backdate_secs "${LOCK}" 3600
  run env ATRIUM_APPLY_LOCK_TTL_SECS=1 bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    _apply_lock_reclaim "'"${LOCK}"'" && printf "TAKEOVER\n"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"TAKEOVER"* ]]
  [[ ! -e "${LOCK}" ]] # stale dir gone — the caller may mkdir fresh
  run bash -c 'ls "'"${REPORTS}"'"/.apply-lock.reclaimed.* 2>/dev/null'
  [ "$status" -ne 0 ] # tomb removed, no residue
}

# --- 19. owner-record write failure -> loud-fail, dir released ---------------

@test "acquire loud-fails with a named ERROR and releases the dir when the owner record cannot be written" {
  # umask 0777 makes acquire's own mkdir create the lock dir mode 000 -> the pid
  # write inside MUST fail (a real filesystem fault, no function-stub seam).
  run bash -c '
    set -Eeuo pipefail
    umask 0777
    source "'"${LIB}"'"
    apply_lock_acquire "'"${LOCK}"'"
    printf "acquired=%s\n" "${apply_lock_acquired}"
  '
  [ "$status" -eq 0 ]                                         # always-return-0 contract holds
  [[ "$output" == *"acquired=false"* ]]                       # acquire FAILED, not silently degraded
  [[ "$output" == *"[apply-lock] ERROR: pid-write failed"* ]] # named loud error on stderr
  [[ ! -e "${LOCK}" ]]                                        # partial dir released, not left owner-less
}
