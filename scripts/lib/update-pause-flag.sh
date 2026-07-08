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

# Updater-side helpers (create / remove)

# Create the canonical pause flag atomically (temp + mv). Writes a small payload
# (pid + unix-second mtime anchor). Echoes the created path. Arg: $1 = optional
# state-dir override.
update_pause_create() {
  local dir flag tmp
  dir="$(update_pause_state_dir "${1:-}")"
  flag="${dir}/autoagent-pause.flag"
  mkdir -p -- "${dir}"
  tmp="${flag}.tmp.$$"
  printf 'pid=%s created=%s\n' "$$" "$(date -u +%s)" >"${tmp}"
  mv -f -- "${tmp}" "${flag}"
  printf '%s\n' "${flag}"
}

# Remove the pause flag. Idempotent (absent flag → rc 0, a normal not-an-error
# result). Arg: $1 = optional state-dir override.
update_pause_remove() {
  local flag
  flag="$(update_pause_flag_path "${1:-}")"
  rm -f -- "${flag}"
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
