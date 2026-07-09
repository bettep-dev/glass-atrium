#!/usr/bin/env bash
# SC2034: apply_lock_acquired is the result global CONSUMED by sourcing scripts
# (daemon-apply.sh + update.sh update_serialize_begin), not this lib — structural
# false positive, same contract daemon-lock.sh documents.
# shellcheck disable=SC2034
#
# apply-lock.sh — stale-reclaim guard for the shared mkdir-directory .apply-lock
# held by BOTH writers: the autoagent apply stage (daemon-apply.sh) and the
# Glass Atrium updater (update.sh update_serialize_begin). Sourced, not
# executable; the sourcing script owns strict mode + the ERR trap.
#
# Primitive: `mkdir <dir>` — directory creation is atomic on POSIX, so it stays
# the mutual-exclusion primitive (NOT switched to a symlink). The holder records
# its pid in a `pid` file INSIDE the lock dir (temp + rename, so a contending
# reader never sees a half-written pid).
#
# Problem this closes: a SIGKILLed holder fires no EXIT trap, so the lock dir was
# left stranded and EVERY future daemon/update run loud-failed forever (permanent
# wedge). Acquire now probes the holder before deciding held-vs-stale and
# RECLAIMS a lock whose holder is BOTH not-live (kill -0 fails / no pid) AND aged
# past a TTL. A genuinely LIVE holder still blocks — mutual exclusion is
# preserved. The reclaim liveness logic mirrors daemon-lock.sh's proven
# dead-holder probe, adapted from its symlink primitive to this mkdir-dir one.
#
# Three hardenings on top of that reclaim design (incident #58325 defects 2-4):
#   * recycled-PID guard — the holder record carries a `fingerprint` file (the
#     pid's process start time) so a recycled pid no longer reads as a live
#     holder forever; a fingerprint-less (legacy) lock keeps the bare kill -0
#     semantics.
#   * single-winner reclaim — a stale lock is taken over by an atomic mv-aside
#     (rename) instead of rm-then-mkdir, so two concurrent reclaimers can never
#     both acquire, and a late reclaimer can never destroy the winner's freshly
#     rebuilt lock.
#   * loud owner-record failure — a pid/fingerprint WRITE failure releases the
#     just-created dir and FAILS the acquire (Precondition Loud-Fail) instead of
#     silently degrading hard mutual exclusion to a TTL-bounded lock.
#
# Result is reported via the apply_lock_acquired global (NOT an exit code) so
# set -e / ERR-trap callers can invoke apply_lock_acquire as a plain statement,
# exactly as daemon-lock.sh reports daemon_lock_acquired.

# TTL (seconds) beyond which a not-live lock is treated as crashed-holder residue.
# ATRIUM_APPLY_LOCK_TTL_SECS override; a non-positive / non-integer value falls
# back to 1800s (30 min) — the same generous upper bound the update pause-flag
# stale-TTL uses, since the two guards protect the same apply window.
apply_lock_ttl_secs() {
  local raw="${ATRIUM_APPLY_LOCK_TTL_SECS:-}"
  if [[ "${raw}" =~ ^[0-9]+$ ]] && [[ "${raw}" -gt 0 ]]; then
    printf '%s\n' "${raw}"
  else
    printf '%s\n' "1800"
  fi
}

# Echo the integer age in seconds (now - mtime) of the lock dir at $1 via python3
# os.stat().st_mtime — the SAME portable idiom the pause-flag lib uses, NEVER the
# BSD/GNU-divergent `stat -f` / `stat -c`. The dir mtime tracks the pid-file write
# (the acquisition instant); nothing mutates the lock dir afterward. Loud-fails
# (rc 1) when the dir is absent OR python3 cannot compute it. Negative age (clock
# skew) is clamped to 0.
apply_lock_age_secs() {
  local p="$1"
  [[ -e "${p}" ]] || return 1
  # `python3 - "${p}"` → sys.argv = ['-', "${p}"]; the path travels through argv
  # (never interpolated into the program text) so an exotic path is injection-safe.
  python3 - "${p}" <<'PY' || return 1
import os, sys, time
try:
    age = time.time() - os.stat(sys.argv[1]).st_mtime
except OSError as exc:
    sys.stderr.write(f"[apply-lock] age-check failed: {exc}\n")
    raise SystemExit(1)
print(int(age) if age > 0 else 0)
PY
}

# SECURITY: refuse to remove anything that is not clearly the shared apply-lock
# dir. A mis-derived lock path must never let rm -rf / rmdir escape onto an
# unrelated path — EVERY reclaim + release removal is gated on this guard.
_apply_lock_path_guard() {
  case "$1" in
    */.apply-lock) return 0 ;;
    *) return 1 ;;
  esac
}

# SECURITY: reclaim-tomb removal guard — the moved-aside stale dir may only be
# rm -rf'd when its name matches the tomb pattern this lib itself generates.
# Kept SEPARATE from _apply_lock_path_guard so the release path stays gated on
# the exact .apply-lock suffix (the rm -rf escape guard must not widen).
_apply_lock_tomb_guard() {
  case "$1" in
    */.apply-lock.reclaimed.*) return 0 ;;
    *) return 1 ;;
  esac
}

# Echo the identity fingerprint of pid $1: its process start time via
# `ps -p PID -o lstart=` (BSD ps and GNU procps both support lstart; no procfs
# assumption). Capture and probe MUST both use this one helper so the two
# strings compare byte-identically; leading/trailing whitespace is trimmed
# because macOS pads lstart with trailing spaces. Empty output = pid gone (died
# between probes) or ps unavailable — callers treat empty as "no fingerprint".
_apply_lock_pid_fingerprint() {
  local pid="$1" fp
  fp="$(ps -p "${pid}" -o lstart= 2>/dev/null || true)"
  fp="${fp#"${fp%%[![:space:]]*}"}" # ltrim
  fp="${fp%"${fp##*[![:space:]]}"}" # rtrim
  printf '%s\n' "${fp}"
}

# Record the holder identity INSIDE the lock dir (temp + rename): the pid file,
# plus a `fingerprint` file carrying the pid's process start time (the
# recycled-PID guard consumed by _apply_lock_holder_live). The dir already
# exists (the caller just mkdir'd it), so the writes cannot race dir creation,
# and each rename gives a contending reader an all-or-nothing record (no
# half-written read). rc 1 + a named stderr ERROR on any WRITE failure —
# silently keeping an owner-less lock would degrade hard mutual exclusion to
# TTL-bounded (Precondition Loud-Fail), so the caller releases the dir and
# fails the acquire. A fingerprint that cannot be CAPTURED (ps unavailable) is
# NOT a write failure: the fingerprint file is skipped and the lock keeps the
# legacy bare-kill-0 liveness semantics.
_apply_lock_write_pid() {
  local lock_dir="$1" fp tmp
  tmp="${lock_dir}/.pid.tmp.$$"
  if ! printf '%s\n' "$$" >"${tmp}" 2>/dev/null \
    || ! mv -f -- "${tmp}" "${lock_dir}/pid" 2>/dev/null; then
    printf '[apply-lock] ERROR: pid-write failed (owner-less lock would degrade mutual exclusion): %s\n' \
      "${lock_dir}" >&2
    return 1
  fi
  fp="$(_apply_lock_pid_fingerprint "$$")"
  if [[ -z "${fp}" ]]; then
    return 0 # no fingerprint capturable → legacy liveness semantics
  fi
  tmp="${lock_dir}/.fp.tmp.$$"
  if ! printf '%s\n' "${fp}" >"${tmp}" 2>/dev/null \
    || ! mv -f -- "${tmp}" "${lock_dir}/fingerprint" 2>/dev/null; then
    printf '[apply-lock] ERROR: fingerprint-write failed (recycled-PID guard unrecorded): %s\n' \
      "${lock_dir}" >&2
    return 1
  fi
}

# Remove ONLY a lock dir this process JUST created but could not stamp with an
# owner record. Contents are enumerated (this lib's own files) and the dir
# falls to rmdir — deliberately NOT rm -rf on this failure path, so a surprise
# foreign file aborts the removal instead of being destroyed.
_apply_lock_delete_partial() {
  local lock_dir="$1"
  rm -f -- "${lock_dir}/.pid.tmp.$$" "${lock_dir}/.fp.tmp.$$" \
    "${lock_dir}/pid" "${lock_dir}/fingerprint" 2>/dev/null || true
  rmdir -- "${lock_dir}" 2>/dev/null || true
}

# rc 0 = a LIVE holder currently owns the lock; rc 1 = not-live. Not-live covers a
# dead pid, an absent/empty/non-numeric pid file (a holder that crashed after
# mkdir but before writing its pid), AND a live pid whose recorded fingerprint no
# longer matches its current process start time — a RECYCLED pid; without this a
# dead lock inheriting a busy pid reads live forever (permanent wedge, since the
# TTL gate only bounds not-live locks). A lock with NO fingerprint record (legacy
# holder, or ps unavailable at acquire) keeps the bare kill -0 semantics — never
# instantly reclaimable, never fingerprint-checked. Not-live alone NEVER reclaims;
# the caller additionally requires the TTL age gate.
_apply_lock_holder_live() {
  local lock_dir="$1" pid="" recorded="" current=""
  if [[ -f "${lock_dir}/pid" ]]; then
    pid="$(cat -- "${lock_dir}/pid" 2>/dev/null || true)"
  fi
  case "${pid}" in
    '' | *[!0-9]*) return 1 ;;
    *) ;; # numeric pid → fall through to the liveness probe
  esac
  kill -0 "${pid}" 2>/dev/null || return 1
  if [[ -f "${lock_dir}/fingerprint" ]]; then
    recorded="$(cat -- "${lock_dir}/fingerprint" 2>/dev/null || true)"
  fi
  if [[ -z "${recorded}" ]]; then
    return 0 # legacy lock (no fingerprint) → live by the bare kill -0 probe
  fi
  current="$(_apply_lock_pid_fingerprint "${pid}")"
  if [[ -z "${current}" ]]; then
    # pid vanished between kill -0 and ps (or ps broke): conservative — report
    # live; a genuinely dead pid fails kill -0 on the next acquire (no wedge).
    return 0
  fi
  [[ "${current}" == "${recorded}" ]] # mismatch = recycled pid = not-live
}

# Atomically take over the lock dir at $1 that the caller ALREADY decided is
# stale (not-live + aged past the TTL). rc 0 = the stale dir is gone and the
# caller may mkdir fresh; rc 1 = takeover lost or the decision no longer holds
# (the caller treats the lock as held). Single-winner property: the takeover is
# an atomic mv (rename) of the stale dir to a per-contender tomb — exactly one
# racing reclaimer's mv succeeds; the loser gets ENOENT, never a shot at the
# winner's rebuilt lock. Because the decision→mv window still exists (a winner
# may fully rebuild a FRESH lock before our mv fires), the tomb is RE-VERIFIED
# after the mv — rename preserves the dir's own mtime, so the age gate still
# reflects the true acquire instant — and a tomb that is NOT stale residue is
# atomically restored. SECURITY: the mv source stays behind
# _apply_lock_path_guard and the tomb removal behind _apply_lock_tomb_guard.
_apply_lock_reclaim() {
  local lock_dir="$1" tomb age ttl
  _apply_lock_path_guard "${lock_dir}" || return 1
  tomb="${lock_dir}.reclaimed.$$.${RANDOM}"
  _apply_lock_tomb_guard "${tomb}" || return 1
  if [[ -e "${tomb}" ]]; then
    return 1 # tomb-name collision (crash leftover) — never risk an mv-into
  fi
  mv -- "${lock_dir}" "${tomb}" 2>/dev/null || return 1 # lost the takeover race
  # Sole owner of the tomb now — re-verify the stale decision race-free.
  ttl="$(apply_lock_ttl_secs)"
  if ! _apply_lock_holder_live "${tomb}" \
    && age="$(apply_lock_age_secs "${tomb}")" \
    && [[ "${age}" -gt "${ttl}" ]]; then
    rm -rf -- "${tomb}" 2>/dev/null || true
    return 0
  fi
  # NOT stale residue after all — we displaced a winner's fresh (or live) lock
  # in the decided-stale-then-stalled interleave. Put it back atomically.
  if ! mv -- "${tomb}" "${lock_dir}" 2>/dev/null; then
    # Restore lost to a fast-path racer that re-created the lock dir. Preserve
    # the displaced dir for inspection — destroying it here could erase a live
    # holder's record (automatic resolution forbidden on this path).
    printf '[apply-lock] ERROR: displaced a fresh lock and could not restore it — preserved: %s\n' \
      "${tomb}" >&2
  fi
  return 1
}

# Stamp the just-mkdir'd lock dir at $1 with our owner record, or release the
# partial dir when the record cannot be written (Precondition Loud-Fail — an
# owner-less lock would silently degrade hard mutual exclusion to TTL-bounded).
# Sets the global apply_lock_acquired=true ONLY on a fully stamped lock; a
# release leaves it false. Both branches end rc 0, so a set -e caller may invoke
# this as a plain statement (preserving apply_lock_acquire's always-return-0
# contract). Callers invoke it immediately after a successful mkdir of the dir.
_apply_lock_stamp_or_release() {
  local lock_dir="$1"
  if _apply_lock_write_pid "${lock_dir}"; then
    apply_lock_acquired=true
  else
    _apply_lock_delete_partial "${lock_dir}"
  fi
}

# Acquire the mkdir-dir lock at $1. Sets apply_lock_acquired=true on success,
# false when a LIVE holder keeps it, a concurrent reclaimer wins the takeover,
# OR the owner record cannot be written (loud-fail: the just-created dir is
# released rather than left owner-less). A holder that is BOTH not-live AND aged
# past the TTL is reclaimed via the single-winner mv-aside takeover. Always
# returns 0 (result is in the global) so set -e callers invoke it plainly.
apply_lock_acquired=false
apply_lock_acquire() {
  local lock_dir="$1"
  apply_lock_acquired=false

  # Fast path — uncontended acquire (mkdir is atomic on POSIX).
  if mkdir -- "${lock_dir}" 2>/dev/null; then
    _apply_lock_stamp_or_release "${lock_dir}"
    return 0
  fi

  # Contended. Reclaim ONLY when the holder is BOTH not-live AND the lock has aged
  # past the TTL — either signal alone is insufficient: a live long-holder must
  # keep the lock, and a FRESH lock whose pid we cannot yet read is a mid-acquire
  # racer (legitimately held), not crashed residue.
  if _apply_lock_holder_live "${lock_dir}"; then
    return 0 # live holder → legitimately held (caller loud-fails)
  fi
  local age ttl
  ttl="$(apply_lock_ttl_secs)"
  if ! age="$(apply_lock_age_secs "${lock_dir}")"; then
    # Cannot age the lock (python3 broken, or a race removed it). Do NOT reclaim
    # blindly — treat as held; a genuinely stale lock ages out and is reclaimed on
    # a later acquire (no permanent wedge, no risk of nuking a live lock).
    return 0
  fi
  if [[ "${age}" -le "${ttl}" ]]; then
    return 0 # not-live but still fresh → held (avoid racing a mid-acquire holder)
  fi

  # Dead holder AND stale → single-winner takeover, then acquire fresh. The
  # path-guard precedes the takeover so a mis-derived lock_dir can never let the
  # mv / rm -rf escape onto an unrelated path.
  _apply_lock_path_guard "${lock_dir}" || return 0
  printf '[apply-lock] reclaiming stale lock (age=%ss > ttl=%ss, holder not live): %s\n' \
    "${age}" "${ttl}" "${lock_dir}" >&2
  _apply_lock_reclaim "${lock_dir}" || return 0 # lost the takeover → held
  if mkdir -- "${lock_dir}" 2>/dev/null; then
    _apply_lock_stamp_or_release "${lock_dir}"
  fi
  # Losing the fresh mkdir to a concurrent acquirer leaves apply_lock_acquired
  # =false → the caller treats it as legitimately held (loud-fail).
  return 0
}

# Release the lock at $1 — path-guarded, and ONLY when we STILL own it (pid file
# matches $$, OR is absent/empty = our own crashed-mid-acquire partial lock). A
# reclaimer may have taken over a lock we were wrongly presumed to abandon;
# destroying its lock here would break mutual exclusion. rm -rf (not rmdir)
# because the dir now holds the pid + fingerprint files. Idempotent; always
# returns 0.
apply_lock_release() {
  local lock_dir="$1" held=""
  _apply_lock_path_guard "${lock_dir}" || return 0
  if [[ -f "${lock_dir}/pid" ]]; then
    held="$(cat -- "${lock_dir}/pid" 2>/dev/null || true)"
  fi
  if [[ -z "${held}" || "${held}" == "$$" ]]; then
    rm -rf -- "${lock_dir}" 2>/dev/null || true
  fi
}
