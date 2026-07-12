#!/usr/bin/env bash
# update-pause-flag.sh — cooperative AutoAgent-daemon pause flag for the Glass
# Atrium update system. Pure sourced library: function defs only, no side effects
# (same convention as apply-spine.sh / atrium-config.sh); strict mode is the
# CALLER's responsibility (a sourced lib must not mutate caller shell options).
#
# PURPOSE (cooperative writer-serialization): a running update HOLDS this flag
# while it swaps files; the launchd-live autoagent daemon (and the
# daemon-daily-restart instance) cooperatively SUSPENDS its run while held, so a
# daemon cycle/apply write never races the swap. Daemon honors via
# `update_pause_is_active` (daemon-cycle.sh, daemon-apply.sh); updater toggles via
# `update_pause_create` / `update_pause_remove`.
#
# CANONICAL PATH (FIXED, GA_ROOT-anchored — NEVER a per-invocation temp):
#     ${GA_ROOT}/.update-state/autoagent-pause.flag
# resolved by `update_pause_state_dir` (ATRIUM_PAUSE_STATE_DIR overrides tests
# only). The python honor side (autoagent/lib/autoagent_pause.py) reads the SAME
# env vars + defaults so updater and daemon coordinate on one path.
#
# STALE / TTL GUARD (Precondition Loud-Fail — shared-self-improve-hygiene): the
# exit trap clears the flag normally, but a CRASHED updater (SIGKILL / OOM /
# power-loss) leaves it with no trap able to fire. So `update_pause_is_active`
# treats a flag older than a bounded TTL (ATRIUM_PAUSE_TTL_SECS, default 1800s) as
# crashed-updater residue: loud-fail clears it + reports NOT-active, so the daemon
# can NEVER freeze indefinitely behind an abandoned flag.
#
# AGE-CHECK PORTABILITY (binding): the comparison uses `python3` mtime, NEVER the
# BSD/GNU-divergent `stat -f` / `stat -c`. python3 is already a hard daemon
# dependency (daemon-cycle.sh exits 3 when absent).

# SC2312 (command substitution masks a return value) is an --enable=all INFO check
# that flags this lib's deliberate `"$(resolver)"` argument-capture idiom (the path
# + pid resolvers feed the next command). set -e already propagates a
# command-substitution failure, so SC2312 carries no real signal here — matching the
# sibling libs (scripts/lib/mirror-farm.sh, scripts/update.sh) that disable it.
# shellcheck disable=SC2312

# Path resolution

# Echo the update-state dir holding the pause flag. Precedence:
#   $1 arg → ATRIUM_PAUSE_STATE_DIR env → ${GA_ROOT:-${HOME}/.glass-atrium}/.update-state
# GA_ROOT (set readonly by the updater entry point) and the ${HOME}/.glass-atrium
# default resolve to the SAME physical path, so updater (GA_ROOT set) and daemon
# (GA_ROOT unset) agree.
update_pause_state_dir() {
  printf '%s\n' \
    "${1:-${ATRIUM_PAUSE_STATE_DIR:-${GA_ROOT:-${HOME}/.glass-atrium}/.update-state}}"
}

# Echo the canonical pause-flag path (file need not exist). Arg: $1 = optional
# state-dir override.
update_pause_flag_path() {
  printf '%s\n' "$(update_pause_state_dir "${1:-}")/autoagent-pause.flag"
}

# Echo the TTL (seconds) beyond which a flag is treated as stale crashed-updater
# residue. ATRIUM_PAUSE_TTL_SECS override; a non-positive / non-integer value
# falls back to the 1800s (30-minute) default — a generous upper bound on a real
# update apply.
update_pause_ttl_secs() {
  local raw="${ATRIUM_PAUSE_TTL_SECS:-}"
  if [[ "${raw}" =~ ^[0-9]+$ ]] && [[ "${raw}" -gt 0 ]]; then
    printf '%s\n' "${raw}"
  else
    printf '%s\n' "1800"
  fi
}

# Age check (python3 mtime — NEVER stat -f / stat -c)

# Echo the integer age in seconds (now - mtime) of the flag at $1 via python3
# os.stat().st_mtime. Loud-fails (rc 1) when the file is absent OR python3
# cannot compute it. A clock skew producing a negative age is clamped to 0.
update_pause_flag_age_secs() {
  local p="$1"
  [[ -e "${p}" ]] || return 1
  # `python3 - "${p}"` → sys.argv = ['-', "${p}"]; the path goes through argv
  # (never interpolated into the program text) so an exotic path is injection-safe.
  python3 - "${p}" <<'PY' || return 1
import os, sys, time
try:
    age = time.time() - os.stat(sys.argv[1]).st_mtime
except OSError as exc:
    sys.stderr.write(f"[update-pause] age-check failed: {exc}\n")
    raise SystemExit(1)
print(int(age) if age > 0 else 0)
PY
}

# Ownership parse (payload pid)

# Echo the owner pid recorded in the flag payload ($1 = flag path), or empty when
# the flag is absent OR its first line has no parseable `pid=<int>` field. Bash 3.2
# parameter-expansion parse (no arrays, no stat -f/-c per this lib's portability
# rule). `|| :` keeps a no-trailing-newline read from wiping the captured line.
update_pause_flag_pid() {
  local p="$1" line="" pid=""
  [[ -e "${p}" ]] || return 0
  IFS= read -r line <"${p}" 2>/dev/null || :
  case "${line}" in
    pid=*)
      pid="${line#pid=}"
      pid="${pid%% *}"
      ;;
    *) ;; # no parseable pid= field → empty owner (unowned / legacy payload)
  esac
  [[ "${pid}" =~ ^[0-9]+$ ]] || pid=""
  printf '%s\n' "${pid}"
}

# Updater-side helpers (create / remove)

# Create the canonical pause flag atomically (temp + mv). Writes a small payload
# (pid + unix-second mtime anchor). Echoes the created path. Arg: $1 = optional
# state-dir override.
#
# OWNERSHIP GUARD (concurrent-writer safety): REFUSE (rc 1 + loud stderr) to clobber
# a flag that is FRESH (age <= TTL) AND owned by a LIVE FOREIGN updater (payload pid
# != $$ AND kill -0 succeeds). A losing racer must never overwrite the winner's
# payload — doing so would let the racer's own EXIT trap delete the winner's flag.
# Own-pid heartbeat refresh (update.sh), a stale flag (age > TTL), a dead-owner
# flag, and an unparseable payload all FALL THROUGH and overwrite as before —
# preserving the TTL crashed-updater recovery and the heartbeat-refresh path.
update_pause_create() {
  local dir flag tmp owner ttl age
  dir="$(update_pause_state_dir "${1:-}")"
  flag="${dir}/autoagent-pause.flag"
  if [[ -e "${flag}" ]]; then
    owner="$(update_pause_flag_pid "${flag}")"
    if [[ -n "${owner}" && "${owner}" != "$$" ]] && kill -0 "${owner}" 2>/dev/null; then
      ttl="$(update_pause_ttl_secs)"
      if age="$(update_pause_flag_age_secs "${flag}")" && [[ "${age}" -le "${ttl}" ]]; then
        printf '[update-pause] REFUSING create: fresh flag held by live updater (pid=%s age=%ss ttl=%ss): %s\n' \
          "${owner}" "${age}" "${ttl}" "${flag}" >&2
        return 1
      fi
    fi
  fi
  mkdir -p -- "${dir}"
  tmp="${flag}.tmp.$$"
  printf 'pid=%s created=%s\n' "$$" "$(date -u +%s)" >"${tmp}"
  mv -f -- "${tmp}" "${flag}"
  printf '%s\n' "${flag}"
}

# Remove the pause flag. Idempotent (absent flag → rc 0, a normal not-an-error
# result). Arg: $1 = optional state-dir override.
#
# OWNERSHIP GATE (defense-in-depth, mirrors apply_lock_release): remove ONLY a flag
# WE own (payload pid == $$) or one with no parseable owner. A flag owned by another
# pid is left intact so a losing concurrent updater's cleanup can never delete the
# winning updater's flag. Effective because create (above) no longer clobbers a
# live foreign owner, so the payload pid stays the true owner's. Stale foreign
# residue is still reclaimed by the TTL guard in update_pause_is_active.
update_pause_remove() {
  local flag owner
  flag="$(update_pause_flag_path "${1:-}")"
  [[ -e "${flag}" ]] || return 0
  owner="$(update_pause_flag_pid "${flag}")"
  if [[ -z "${owner}" || "${owner}" == "$$" ]]; then
    rm -f -- "${flag}"
  fi
}

# Daemon-side honor predicate

# THE honor predicate the daemon entry points call.
#   rc 0 = a FRESH flag is held → the caller (daemon) MUST SUSPEND this run.
#   rc 1 = no flag, OR a STALE flag (loud-fail cleared here) → the caller RUNS.
# Arg: $1 = optional state-dir override. All diagnostics go to stderr.
update_pause_is_active() {
  local flag age ttl
  flag="$(update_pause_flag_path "${1:-}")"
  [[ -e "${flag}" ]] || return 1
  ttl="$(update_pause_ttl_secs)"
  if ! age="$(update_pause_flag_age_secs "${flag}")"; then
    # Cannot compute the age (python3 broken, or a race removed the flag between
    # the existence test and the stat). Liveness-first: a flag we cannot age MUST
    # NOT freeze the daemon forever, so loud-WARN and treat as INACTIVE — an
    # indefinite freeze is the strictly worse failure than a small write-race
    # window (and python3 is a guaranteed daemon dependency anyway).
    printf '[update-pause] WARN: age-check failed for %s — ignoring flag (liveness)\n' \
      "${flag}" >&2
    return 1
  fi
  if [[ "${age}" -gt "${ttl}" ]]; then
    printf '[update-pause] STALE pause flag cleared (age=%ss > ttl=%ss): %s — crashed-updater residue; daemon resumes\n' \
      "${age}" "${ttl}" "${flag}" >&2
    rm -f -- "${flag}" \
      || printf '[update-pause] WARN: stale flag unlink failed: %s\n' "${flag}" >&2
    return 1
  fi
  printf '[update-pause] active pause flag (age=%ss ttl=%ss): %s — daemon suspends this run\n' \
    "${age}" "${ttl}" "${flag}" >&2
  return 0
}
