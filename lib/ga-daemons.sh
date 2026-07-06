# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (DRY_RUN/GA_DAEMON_SESSIONS/PG_SOCKET) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — detached daemon / tmux-session / unmanaged-postgres-orphan lifecycle domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# kill_daemon_tmux_sessions — kill the DETACHED daemon tmux sessions (GA_DAEMON_SESSIONS).
# These run `claude --channels plugin:fakechat@...` and SURVIVE `launchctl bootout`
# (reparented to PID 1), so bootout alone leaves them running. Shared by uninstall
# (stop_detached_daemons) AND install start (clear a stale session so a fresh daemon boots
# clean). GUARDED exactly like unload_launchd_jobs: DRY_RUN reports without acting;
# is_sandbox_target skips the WHOLE kill (the tmux server is a per-USER host resource shared
# with the real user regardless of HOME — a sandboxed run must NOT kill the real sessions);
# a missing tmux is a loud-log skip (Precondition Loud-Fail — never silent). Best-effort,
# always returns 0.
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
# postmaster from a now-DELETED keg (files gone, process alive PPID 1) that keeps the :5432 /
# peer-auth socket and, having lost its tzdata, REJECTS `SET timezone='UTC'` — breaking the
# monitor's UTC-gated pool. Called ONLY from preflight_pg_utc_guard's unmanaged-orphan branch,
# reached after ga_detect_postgres_utc=='broken' AND a brew RESTART did not clear it — so a
# HEALTHY server (ok / down / absent) is never entered here and is NEVER touched. Two layers, NO
# brew-service stop (never stop a brew-managed server): (layer-2) lsof the socket/:5432, SIGINT
# (postgres FAST shutdown), poll the socket free (bounded); (layer-3) remove the stale socket
# file so a fresh install binds clean. Carries its OWN DRY_RUN + sandbox guards (it no longer
# sits behind stop_detached_daemons' guards) — a skipped clear leaves the orphan in place, so
# the caller's post-clear re-verify stays 'broken' and falls through to the loud-fail (never a
# false 'cleared'). GRACEFUL — every missing tool / failed signal is a loud-log skip, never
# fatal; always returns 0.
clear_unmanaged_pg_orphan() {
  local sock="${PG_SOCKET}/.s.PGSQL.5432"
  # This helper now runs install-scoped (from preflight_pg_utc_guard), NOT behind
  # stop_detached_daemons' guards — so it carries its OWN DRY_RUN + sandbox guards. A skipped
  # clear leaves the orphan, so the caller's re-verify stays 'broken' → correct loud-fail.
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
    # bounded poll until the socket frees (never an unbounded wait — that would be a new
    # hang path). ~10s ceiling; break the instant the socket has no owner.
    local waited=0
    while [[ "${waited}" -lt 10 ]]; do
      [[ -e "${sock}" ]] || break
      [[ -z "$(lsof -t -- "${sock}" 2>/dev/null || true)" ]] && break
      sleep 1
      waited=$((waited + 1))
    done
  fi
  # (layer-3) remove a stale socket file left behind by the killed postmaster so a fresh
  # install's cluster binds a clean socket.
  if [[ -S "${sock}" ]]; then
    if rm -f -- "${sock}" 2>/dev/null; then
      log "removed stale postgres socket ${sock}"
    fi
  fi
  return 0
}

# stop_detached_daemons — uninstall teardown of the orphans that survive `launchctl bootout`
# + `claude plugin uninstall`: (a) the detached daemon tmux sessions and (b) lingering fakechat
# channel procs (`claude --channels plugin:fakechat@...` + their `spawn-unix-fd.py` helpers)
# that outlive the plugin uninstall. Runs BEFORE the DB drop so the daemons release their DB
# connections first. The postgres SERVER + its /tmp peer-auth socket are LEFT ALONE — uninstall
# must never stop a server it did not start (a healthy brew server + its socket are the user's,
# not GA's to tear down; the orphan clear lives install-side in preflight_pg_utc_guard, entered
# only for a genuinely broken/unmanaged squatter). GUARDED like unload_launchd_jobs (DRY_RUN
# report-only, is_sandbox_target skip — these are per-USER host resources shared with the real
# user regardless of HOME). Best-effort + loud-log each action; NEVER aborts uninstall (returns 0).
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
  # The postgres server + its /tmp peer-auth socket are intentionally NOT touched here — a
  # healthy server is the user's, and the genuine-orphan clear is install-scoped (preflight).
  return 0
}
