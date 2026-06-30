#!/usr/bin/env bash
# update-pause-flag.sh — the cooperative AutoAgent-daemon pause flag for the
# Glass Atrium update system (plan E3 / design C, task T10). Pure, sourced
# library: function definitions ONLY, no top-level side effects, no executable
# entry point — the same convention as scripts/lib/apply-spine.sh and
# atrium-config.sh.
#
# IMPORTANT — strict mode is the CALLER's responsibility (sourced-lib convention)
# This file deliberately does NOT run `set -Eeuo pipefail`: a sourced file must
# not mutate the caller's shell options. Every function is SAFE under a caller
# that has already set `set -Eeuo pipefail` + `IFS=$'\n\t'`.
#
# PURPOSE (writer-serialization, cooperative): while a Glass Atrium update swaps
# files, it HOLDS this flag; the launchd-live autoagent daemon (AND the
# daemon-daily-restart-spawned instance) cooperatively SUSPENDS its
# decision-to-run for as long as the flag is held, so a daemon cycle/apply write
# can never race the update's file swap. The daemon honors the flag via
# `update_pause_is_active` at its entry points (daemon-cycle.sh, daemon-apply.sh);
# the updater creates/removes it via `update_pause_create` / `update_pause_remove`.
#
# CANONICAL PATH (FIXED, GA_ROOT-anchored — NEVER a per-invocation temp path):
#     ${GA_ROOT}/.update-state/autoagent-pause.flag
# stated alongside the .apply-lock locking convention. The state dir is resolved
# by `update_pause_state_dir`; an ATRIUM_PAUSE_STATE_DIR env override exists for
# tests/sandboxes only (the python honor side — autoagent/lib/autoagent_pause.py —
# reads the SAME env vars + defaults so updater and daemon coordinate on one path).
#
# STALE / TTL GUARD (Precondition Loud-Fail — shared-self-improve-hygiene): a
# trap clears the flag on a normal updater exit, but a CRASHED updater
# (SIGKILL / OOM / power-loss) leaves it behind with no trap able to fire. So
# `update_pause_is_active` additionally treats a flag OLDER than a bounded TTL
# (ATRIUM_PAUSE_TTL_SECS, default 1800s) as crashed-updater residue: it
# LOUD-FAIL clears the flag and reports NOT-active, so the daemon + daily-restart
# instance can NEVER freeze indefinitely behind an abandoned flag.
#
# AGE-CHECK PORTABILITY (binding): the age comparison uses `python3` mtime
# (os.stat().st_mtime), NEVER the BSD/GNU-divergent `stat -f` / `stat -c` (whose
# flags differ between macOS and Linux). python3 is already a hard dependency of
# the daemon (daemon-cycle.sh exits 3 when it is absent).

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

# Echo the update-state dir holding the pause flag. Precedence:
#   $1 arg → ATRIUM_PAUSE_STATE_DIR env → ${GA_ROOT:-${HOME}/.glass-atrium}/.update-state
# GA_ROOT (set readonly by the updater entry point) and the ${HOME}/.glass-atrium
# default resolve to the SAME physical path, so updater (GA_ROOT set) and daemon
# (GA_ROOT unset) agree.
update_pause_state_dir() {
  if [[ -n "${1:-}" ]]; then
    printf '%s\n' "$1"
    return 0
  fi
  if [[ -n "${ATRIUM_PAUSE_STATE_DIR:-}" ]]; then
    printf '%s\n' "${ATRIUM_PAUSE_STATE_DIR}"
    return 0
  fi
  printf '%s\n' "${GA_ROOT:-${HOME}/.glass-atrium}/.update-state"
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

# ---------------------------------------------------------------------------
# Age check (python3 mtime — NEVER stat -f / stat -c)
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Updater-side helpers (create / remove)
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Daemon-side honor predicate
# ---------------------------------------------------------------------------

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
