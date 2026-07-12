# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (DRY_RUN/GA_DAEMON_SESSIONS/PG_SOCKET) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — detached daemon / tmux-session / unmanaged-postgres-orphan lifecycle domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# kill_daemon_tmux_sessions — kill the DETACHED daemon tmux sessions (GA_DAEMON_SESSIONS) that
# run `claude --channels plugin:fakechat@...` and SURVIVE `launchctl bootout` (reparented to
# PID 1). Shared by uninstall (stop_detached_daemons) + install-start (clear a stale session).
# Guarded like unload_launchd_jobs: DRY_RUN report-only; is_sandbox_target skips the WHOLE kill
# (the tmux server is a per-USER host resource shared with the real user regardless of HOME);
# missing tmux = loud-log skip (Precondition Loud-Fail). Best-effort, returns 0.
kill_daemon_tmux_sessions() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping detached daemon tmux session teardown (${GA_DAEMON_SESSIONS[*]})"
    return 0
  fi
  # is_sandbox_target returns 0 by contract (stdout verdict) → masking is intentional
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "sandbox target — detached daemon tmux sessions untouched"
    return 0
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    log "tmux not found — skipping detached daemon tmux session teardown"
    return 0
  fi
  local sess
  for sess in "${GA_DAEMON_SESSIONS[@]}"; do
    if tmux has-session -t "${sess}" 2>/dev/null; then
      if tmux kill-session -t "${sess}" 2>/dev/null; then
        log "killed detached tmux session '${sess}'"
      else
        log "tmux kill-session '${sess}' failed (continuing)"
      fi
    else
      log "no detached tmux session '${sess}' to kill"
    fi
  done
  return 0
}

# clear_unmanaged_pg_orphan — INSTALL-scoped clear of a GENUINE unmanaged postgres orphan: a
# postmaster from a now-DELETED keg (files gone, alive PPID 1) that keeps :5432 / the peer-auth
# socket and, having lost its tzdata, REJECTS `SET timezone='UTC'` — breaking the monitor's
# UTC-gated pool. Called ONLY from preflight_pg_utc_guard's unmanaged-orphan branch (after
# ga_detect_postgres_utc=='broken' AND a brew RESTART failed to clear it), so a HEALTHY server
# (ok/down/absent) is NEVER entered or touched. Two layers, NO brew-service stop: (layer-2) lsof
# the socket/:5432, SIGINT (postgres FAST shutdown), poll the socket free (bounded); (layer-3)
# remove the stale socket so a fresh install binds clean. Carries its OWN DRY_RUN + sandbox
# guards — a skipped clear leaves the orphan, so the caller's re-verify stays 'broken' →
# loud-fail (never a false 'cleared'). GRACEFUL — missing tool / failed signal = loud-log skip,
# returns 0.
clear_unmanaged_pg_orphan() {
  local sock="${PG_SOCKET}/.s.PGSQL.5432"
  # install-scoped (own DRY_RUN + sandbox guards); a skipped clear leaves the orphan → caller re-verify stays 'broken' → loud-fail.
  if "${DRY_RUN}"; then
    log "dry-run: skipping unmanaged pg orphan clear on ${sock}"
    return 0
  fi
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "sandbox target — unmanaged pg orphan on ${sock} left untouched"
    return 0
  fi
  # (layer-2) identify the postmaster owning the socket/:5432 and SIGINT it (fast shutdown).
  if ! command -v lsof >/dev/null 2>&1; then
    log "lsof not found — cannot detect an orphaned postmaster on ${sock}"
    return 0
  fi
  local pids
  pids="$(lsof -t -- "${sock}" 2>/dev/null || true)"
  [[ -z "${pids}" ]] && pids="$(lsof -ti tcp:5432 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    log "no orphaned postmaster bound to ${sock} / :5432"
  else
    local pid
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] || continue
      # SIGINT = postgres "fast shutdown": rolls back active txns, then exits.
      if kill -INT "${pid}" 2>/dev/null; then
        log "sent SIGINT (fast shutdown) to orphaned postmaster pid ${pid}"
      else
        log "could not signal postmaster pid ${pid} (continuing)"
      fi
    done <<EOF
${pids}
EOF
    # bounded poll until the socket frees, by a SECONDS-delta wall-clock ceiling (~10s default,
    # GA_PG_SOCKET_FREE_TIMEOUT_SECS): an iteration count drifts when a probe blocks, the SECONDS
    # anchor caps true elapsed. An unbounded wait would be a new hang path.
    local ceiling="${GA_PG_SOCKET_FREE_TIMEOUT_SECS:-10}" started="${SECONDS}"
    while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]; do
      [[ -e "${sock}" ]] || break
      [[ -z "$(lsof -t -- "${sock}" 2>/dev/null || true)" ]] && break
      sleep 1
    done
  fi
  # (layer-3) remove a stale socket left by the killed postmaster so a fresh install binds clean.
  if [[ -S "${sock}" ]]; then
    if rm -f -- "${sock}" 2>/dev/null; then
      log "removed stale postgres socket ${sock}"
    fi
  fi
  return 0
}

# stop_detached_daemons — uninstall teardown of the orphans that survive `launchctl bootout` +
# `claude plugin uninstall`: (a) the detached daemon tmux sessions and (b) lingering fakechat
# channel procs (`claude --channels plugin:fakechat@...` + their `spawn-unix-fd.py` helpers).
# Runs BEFORE the DB drop so the daemons release their DB connections first. The postgres SERVER
# + its /tmp peer-auth socket are LEFT ALONE — uninstall never stops a server it did not start
# (the orphan clear lives install-side in preflight_pg_utc_guard, for a broken/unmanaged
# squatter). Guarded like unload_launchd_jobs (DRY_RUN report-only, is_sandbox_target skip —
# per-USER host resources shared regardless of HOME). Best-effort + loud-log; returns 0.
stop_detached_daemons() {
  # (a) tmux sessions — shared helper carries its own DRY_RUN + sandbox + tmux-absent guards.
  kill_daemon_tmux_sessions

  if "${DRY_RUN}"; then
    log "dry-run: skipping fakechat proc reap"
    return 0
  fi
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "sandbox target — fakechat procs untouched"
    return 0
  fi

  # (b) lingering fakechat channel procs + spawn helpers (outlive the plugin uninstall).
  if command -v pkill >/dev/null 2>&1; then
    if pkill -f 'claude --channels plugin:fakechat@' 2>/dev/null; then
      log "reaped lingering fakechat channel procs (claude --channels plugin:fakechat@)"
    else
      log "no lingering fakechat channel procs to reap"
    fi
    if pkill -f 'spawn-unix-fd.py' 2>/dev/null; then
      log "reaped fakechat spawn-unix-fd.py helper procs"
    else
      log "no fakechat spawn-unix-fd.py helper procs to reap"
    fi
  else
    log "pkill not found — skipping fakechat proc reap"
  fi
  # postgres server + /tmp socket intentionally NOT touched — a healthy server is the user's (orphan clear is install-scoped).
  return 0
}
