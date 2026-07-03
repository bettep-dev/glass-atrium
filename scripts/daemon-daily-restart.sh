#!/usr/bin/env bash
# daemon-daily-restart.sh — hard restart of a daemon tmux session (kill + recreate)
# Usage: bash daemon-daily-restart.sh {autoagent|wiki}
#
# Behavior:
#   1. Validate role argument and resolve session/log paths.
#   2. Kill-after-verify preflight: tmux/bootstrap/healthcheck AND a runnable
#      claude binary (dangling-symlink probe) — abort while the session is
#      still untouched if a replacement REPL could never start.
#   3. Pre-restart healthcheck (warn-only — an already-broken daemon is still
#      a valid input, the whole point is to recover it).
#   3.7 Acquire the restart-window lock (lib/daemon-lock.sh) — the supervise
#      bootstrap honors it before respawn-create, so the kill→recreate below
#      cannot duplicate-race a launchd-respawned supervisor.
#   4. Kill the tmux session (tmux kill-session) → this terminates the claude
#      child process, releasing its audit token so the kernel reassigns TCC
#      responsibility on the next launch.
#   5. Poll until `tmux has-session` reports the session gone (bounded wait).
#   6. Invoke ${ROLE}-daemon-bootstrap.sh in `return` mode to recreate the
#      session from scratch, retrying with linear backoff on failure (rc not in
#      {0,2}). Bootstrap internally: pre-spawns the fakechat MCP server, creates
#      the tmux session + exec claude, waits for the REPL/HTTP to warm up, then
#      calls daemon-inject-entry.sh to re-submit /loop. In `return` mode it
#      RETURNS the inject result as its exit code (rather than entering its own
#      step-6 self-health loop), so we regain control and run the post-restart
#      healthcheck. We do NOT call daemon-inject-entry.sh directly here because
#      its internal healthcheck requires the session to already exist. After
#      the recreate window closes, `launchctl kickstart` (no -k) resurrects the
#      supervisor job if it is dead (a live one is untouched).
#   7. Post-restart healthcheck to verify new session alive and cron registered.
#   8. Log everything to /tmp/daemon-daily-restart-<role>.log.
#
# Invoked by: launchd (com.glass-atrium.daemon-daily-restart.plist) daily at 05:30 KST.
# Manual invocation: bash daemon-daily-restart.sh autoagent
#
# Rationale: macOS 26.3.1 tightened TCC responsible-process attribution, causing
# long-lived claude processes to lose access to ~/Documents and /Volumes/* over
# time. Unlike daemon-weekly-clear.sh (which only sends /clear and keeps the
# process alive), a full kill + recreate forces the kernel to allocate fresh
# audit tokens and restores TCC-protected path access.
#
# CAVEAT: Killing the tmux session terminates any in-progress /loop turn in that
# daemon. This is acceptable because /loop is cron-driven and self-resuming —
# the next scheduled tick after restart re-runs the pending work. Do NOT run
# this during known critical batch windows if avoidable.
#
# Exit codes:
#   0 = success (killed + recreated + post-restart healthcheck pass)
#   1 = unrecoverable error (bad role, bootstrap fail, post-healthcheck fail)
#   6 = bootstrap timeout backstop fired (run_with_timeout rc 124/137) — an
#       anomaly path: return mode normally exits within entry-injection time.
#   7 = concurrent restart window: the restart-window lock (lib/daemon-lock.sh)
#       is held by a live sibling — the single-flight authority for double-fire
# Note: healthcheck timeout falls through to the attempt 1/2/3 cascade → fatal()
# → exit 1; it has no dedicated exit code (the cascade is authoritative).
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"

# Quota-footer timezone — RESOLVED [meta].timezone, env-overridable. The full
# resolution rationale (concrete-zone requirement, TZ-immune /etc/localtime read)
# lives once in atrium_load_timezone (lib/atrium-config.sh). The function-level
# quota detectors still default to Asia/Seoul when unset so the bats extraction
# harness stays self-contained.
ATRIUM_TIMEZONE="$(atrium_load_timezone)"
readonly ATRIUM_TIMEZONE

# Max seconds to wait for tmux session teardown after kill-session. tmux usually
# reports has-session=false within ~100ms of kill-session returning, but under
# heavy load or with zombie panes it can take longer. 10s is generous.
readonly KILL_TIMEOUT_SEC=10

# Poll interval while waiting for kill confirmation.
readonly KILL_POLL_INTERVAL_SEC=1

# Wait after bootstrap returns before the post-restart healthcheck. /loop rewrites
# to CronCreate asynchronously and emits "Scheduled <8-hex-id>" (which the
# healthcheck greps for) — that round-trip is still in flight when bootstrap
# returns. 300s absorbs the worst-case round-trip (200-260s under quota throttle)
# while staying under launchd's 600s hook ceiling. Env-overridable for tests.
: "${POST_BOOTSTRAP_WAIT_SEC:=300}"
readonly POST_BOOTSTRAP_WAIT_SEC

# Safety backstop for the bootstrap invocation (called in `return` mode, which
# exits within entry-injection time). 600s absorbs a worst-case slow warm-up and
# stays under the launchd script-level ceiling; a 124/137 here signals a genuine
# anomaly (unexpected hang). run_with_timeout sends SIGTERM at TIMEOUT, SIGKILL
# at TIMEOUT+GRACE.
readonly BOOTSTRAP_TIMEOUT_SEC=600
readonly BOOTSTRAP_KILL_GRACE_SEC=10

# Healthcheck attempts (up to 3) gated on /loop Skill round-trip + tmux pane
# scrape; total worst-case wall time = 3 attempts × ~60s probe each + 2 × 5s
# inter-attempt sleeps = ~190s. 240s ceiling absorbs that with headroom while
# preventing a hung pane scrape from blocking indefinitely (observed pathology:
# tmux capture-pane on a zombie pane can block uninterruptibly).
readonly HEALTHCHECK_TIMEOUT_SEC=240

# Bootstrap retry budget: a transient bootstrap failure (slow plugin load, port
# contention, REPL warm-up hiccup) must not strand the just-killed session as a
# terminal teardown — retry with linear backoff (15s, 30s) before giving up.
# rc=2 (quota wall) is excluded: the same wall would eat every retry, burning
# auth tokens for a daemon that is intentionally idle. Env-overridable for tests.
: "${BOOTSTRAP_RETRY_MAX:=3}"
: "${BOOTSTRAP_RETRY_BACKOFF_SEC:=15}"
readonly BOOTSTRAP_RETRY_MAX
readonly BOOTSTRAP_RETRY_BACKOFF_SEC

# Single-flight / double-fire protection: a launchd double-fire could spawn two
# concurrent kill-session + bootstrap sequences (orphan tmux servers + racing
# pg_write_run rows). The authority is the ATOMIC restart-window symlink lock
# acquired at step 3.7 (lib/daemon-lock.sh) — `ln -s` is atomic, so exactly one
# instance wins and the loser loud-fails (exit 7) BEFORE any destructive step.
# A cmdline `pgrep` guard formerly sat here but was removed: it matched this
# script's own command-substitution subshells (which inherit the full argv but
# carry a different PID than $$), a process-table false positive that aborted
# hermetic CI runs. The atomic lock is immune to process-table noise.

usage() {
  printf 'usage: %s {autoagent|wiki}\n' "${0##*/}" >&2
  exit 1
}

# 1. Argument validation.
if [[ $# -ne 1 ]]; then
  usage
fi

ROLE="$1"
case "${ROLE}" in
  autoagent | wiki) ;;
  *) usage ;;
esac
readonly ROLE

readonly SESSION="claude-${ROLE}-daemon"
readonly HEALTHCHECK="${SCRIPT_DIR}/${ROLE}-daemon-healthcheck.sh"
readonly BOOTSTRAP_SCRIPT="${SCRIPT_DIR}/${ROLE}-daemon-bootstrap.sh"
# Env-overridable for hermetic tests (production keeps the /tmp default).
: "${LOG_FILE:=/tmp/daemon-daily-restart-${ROLE}.log}"
readonly LOG_FILE

# Shared restart-window lock (symlink pid-lock) — also sourced by
# daemon-bootstrap-common.sh, whose supervise mode honors the lock this script
# holds across kill→recreate.
# shellcheck source=lib/daemon-lock.sh
source "${SCRIPT_DIR}/lib/daemon-lock.sh"

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] [daemon-daily-restart-%s] %s\n' "${ts}" "${ROLE}" "$*" >>"${LOG_FILE}"
}

# run_with_timeout — portable `timeout --kill-after=GRACE DURATION CMD...`.
# Neither timeout(1) nor gtimeout exists on stock macOS, so this wrapper prefers
# coreutils gtimeout/timeout when present, else falls back to a pure-bash
# background-PID + sleep watchdog reproducing the same SIGTERM-at-DURATION →
# SIGKILL-at-DURATION+GRACE escalation.
# Return-code contract MATCHES timeout(1) so the call-site 124/137 branches work:
#   124 = DURATION elapsed, child SIGTERMed (graceful timeout)
#   137 = child survived TERM, SIGKILLed after GRACE (128 + SIGKILL 9)
#   else = the command's own exit code (completed before the deadline)
# Args: $1=grace_sec  $2=duration_sec  $3...=command + args
run_with_timeout() {
  local grace_sec="$1" duration_sec="$2"
  shift 2

  # Prefer coreutils if available (native semantics, no watchdog overhead).
  local coreutils_timeout=""
  if command -v gtimeout >/dev/null 2>&1; then
    coreutils_timeout="gtimeout"
  elif command -v timeout >/dev/null 2>&1; then
    coreutils_timeout="timeout"
  fi
  if [[ -n "${coreutils_timeout}" ]]; then
    local rc=0
    "${coreutils_timeout}" --kill-after="${grace_sec}" "${duration_sec}" "$@" || rc=$?
    return "${rc}"
  fi

  # Pure-bash fallback watchdog. Run the command in the background, then a
  # detached killer waits DURATION and escalates TERM → (GRACE) → KILL.
  "$@" &
  local cmd_pid=$!

  # Watchdog: TERM at DURATION; if still alive after GRACE, KILL. Self-exits
  # immediately if the command already finished (kill -0 fails → nothing to do).
  (
    sleep "${duration_sec}"
    if kill -0 "${cmd_pid}" 2>/dev/null; then
      kill -TERM "${cmd_pid}" 2>/dev/null || true
      sleep "${grace_sec}"
      if kill -0 "${cmd_pid}" 2>/dev/null; then
        kill -KILL "${cmd_pid}" 2>/dev/null || true
      fi
    fi
  ) &
  local watchdog_pid=$!

  # Wait for the command; capture its raw status. `wait` on a known PID returns
  # that child's exit status (128+signal when signalled).
  local cmd_rc=0
  wait "${cmd_pid}" 2>/dev/null || cmd_rc=$?

  # Command done (one way or another) → stop the watchdog if it is still waiting.
  kill "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true

  # Map signal-deaths to timeout(1)'s 124/137 convention.
  case "${cmd_rc}" in
    143) return 124 ;; # 128 + SIGTERM(15) → graceful timeout
    137) return 137 ;; # 128 + SIGKILL(9)  → hard timeout after grace
    *) return "${cmd_rc}" ;;
  esac
}

trap 'log "ERROR: line ${LINENO}: ${BASH_COMMAND}"' ERR

# Detect Claude Max quota-reached state in tmux pane scrollback. Matches the REPL
# footer, the CLI budget-overrun banner, the bare "Limit reached" token, and the
# wiki rate-limit variants. On match, callers emit PG status='quota_exceeded'
# (not 'error') so downstream alerts/UI suppress noise from external quota events
# (not actionable infra failures). ERE metachars () are escaped; /, . are
# intended wildcards.
detect_quota_in_pane() {
  local session="$1"
  local pane_dump tz tz_ere
  # ERE-escape inlined (not atrium_ere_escape): the bats harness extracts this
  # function standalone, so it must not depend on the sourced lib.
  tz="${ATRIUM_TIMEZONE:-Asia/Seoul}"
  tz_ere="$(printf '%s' "${tz}" | sed -e 's/[][\.^$|?*+(){}\\]/\\&/g')"
  pane_dump="$(tmux capture-pane -t "${session}" -p -S -100 2>/dev/null || true)"
  grep -qE 'Limit reached|Usage ⚠ Limit|Exceeded USD budget|out of extra usage|/rate-limit-options|resets .* \('"${tz_ere}"'\)' <<<"${pane_dump}"
}

# The quota footer line persists in scrollback for the daemon's whole lifetime,
# so a plain detect would skip every restart even after reset = self-recovery
# hole. This gate parses the "resets <Month> <Day> at <Hour><am|pm> (<tz>)"
# timestamp (tz = configured [meta].timezone) and returns 0 (proceed) only once
# that reset epoch has passed.
# Parse failure → return 0 (proceed): one wasted restart beats a permanent skip.
quota_reset_passed() {
  local session="$1"
  local pane_dump reset_line month day hour ampm hour_ampm
  local now_epoch year parsed_epoch tz tz_ere
  # ERE-escape inlined (not atrium_ere_escape): the bats harness extracts this
  # function standalone, so it must not depend on the sourced lib.
  tz="${ATRIUM_TIMEZONE:-Asia/Seoul}"
  tz_ere="$(printf '%s' "${tz}" | sed -e 's/[][\.^$|?*+(){}\\]/\\&/g')"
  pane_dump="$(tmux capture-pane -t "${session}" -p -S -100 2>/dev/null || true)"
  # Last match = most recent footer. || true — grep no-match exits 1; under
  # pipefail the inherited ERR trap (set -E reaches the substitution subshell
  # even from an if-test, bash 3.2) logs a spurious "ERROR: line N: tail -1".
  # The empty-result fallback below is the real no-match signal.
  reset_line="$(printf '%s\n' "${pane_dump}" \
    | grep -E 'resets [A-Z][a-z]+ [0-9]+ at [0-9]+(am|pm) \('"${tz_ere}"'\)' \
    | tail -1 || true)"
  if [[ -z "${reset_line}" ]]; then
    log "WARN: quota reset timestamp parse failed (no match) — fallback: proceed with restart"
    return 0
  fi
  local extracted
  extracted="$(printf '%s\n' "${reset_line}" \
    | sed -nE 's/.*resets ([A-Z][a-z]+) ([0-9]+) at ([0-9]+)(am|pm).*/\1 \2 \3 \4/p')"
  if [[ -z "${extracted}" ]]; then
    log "WARN: quota reset timestamp parse failed (sed extraction) — fallback: proceed with restart"
    return 0
  fi
  # IFS override required: top-level IFS=$'\n\t' would pack the whole string into
  # the first var instead of splitting on spaces.
  IFS=' ' read -r month day hour ampm <<<"${extracted}"
  if [[ -z "${month}" || -z "${day}" || -z "${hour}" || -z "${ampm}" ]]; then
    log "WARN: quota reset timestamp parse failed (field split: month='${month}' day='${day}' hour='${hour}' ampm='${ampm}') — fallback: proceed with restart"
    return 0
  fi
  hour_ampm="${hour}:00:00${ampm}"
  now_epoch="$(date +%s)"
  year="$(date +%Y)"
  parsed_epoch="$(TZ="${tz}" date -j -f '%Y %B %d %I:%M:%S%p' "${year} ${month} ${day} ${hour_ampm}" +%s 2>/dev/null || true)"
  if [[ -z "${parsed_epoch}" ]]; then
    log "WARN: quota reset timestamp parse failed (date conversion year=${year}) — fallback: proceed with restart"
    return 0
  fi
  # Dec→Jan rollover: a current-year parse before yesterday → retry with year+1.
  if ((parsed_epoch < now_epoch - 86400)); then
    year=$((year + 1))
    parsed_epoch="$(TZ="${tz}" date -j -f '%Y %B %d %I:%M:%S%p' "${year} ${month} ${day} ${hour_ampm}" +%s 2>/dev/null || true)"
    if [[ -z "${parsed_epoch}" ]]; then
      log "WARN: quota reset timestamp parse failed (date conversion rollover year=${year}) — fallback: proceed with restart"
      return 0
    fi
    log "quota reset rollover detected — retry with year=${year}"
  fi
  if ((now_epoch >= parsed_epoch)); then
    log "quota reset time passed (reset='${month} ${day} ${hour}${ampm} ${tz}', now=$(TZ="${tz}" date '+%Y-%m-%d %H:%M:%S %Z'))"
    return 0
  fi
  log "quota reset time not yet reached (reset='${month} ${day} ${hour}${ampm} ${tz}', diff=$((parsed_epoch - now_epoch))s)"
  return 1
}

fatal() {
  log "FATAL: $*"
  printf 'FATAL: %s (see %s)\n' "$*" "${LOG_FILE}" >&2
  # Mirror fail status to PG before exit. PG DaemonStatus enum has no 'fail'
  # value → use 'error'. On a detected quota pattern, overwrite to
  # 'quota_exceeded' (the alert-suppress target).
  if [[ -n "${STARTED_AT:-}" ]]; then
    local final_status="error"
    if detect_quota_in_pane "${SESSION}"; then
      final_status="quota_exceeded"
      log "Claude Max quota reached — status overwrite: error → quota_exceeded"
    fi
    pg_write_run "${final_status}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "fatal: ${1//\"/\\\"}"
  fi
  exit 1
}

# Kill-after-verify probe: PATH lookup AND a dereferencing -x test on the
# resolved path. The -x re-check matters for the mid-upgrade window — npm
# relinks /opt/homebrew/bin/claude, so the symlink can dangle between the PATH
# lookup and the kill below; -x follows the link, a vanished target fails it.
verify_claude_runnable() {
  local claude_path
  claude_path="$(command -v claude || true)"
  [[ -n "${claude_path}" && -x "${claude_path}" ]]
}

# 2. Pre-flight: binary + script existence.
if ! command -v tmux >/dev/null 2>&1; then
  fatal "tmux not on PATH"
fi

if [[ ! -x "${BOOTSTRAP_SCRIPT}" ]]; then
  fatal "bootstrap script not executable: ${BOOTSTRAP_SCRIPT}"
fi

if [[ ! -x "${HEALTHCHECK}" ]]; then
  fatal "healthcheck not executable: ${HEALTHCHECK}"
fi

# Kill-after-verify ordering: a session killed now could never be recreated if
# claude cannot start — abort while it is still untouched.
if ! verify_claude_runnable; then
  fatal "claude missing or not runnable (dangling symlink?) — aborting before kill-session, session left untouched"
fi

# NOTE: single-flight double-fire protection is the ATOMIC restart-window lock
# acquired at step 3.7 below, NOT a startup pgrep guard (see the rationale block
# above the usage() function). The kill→recreate sequence is gated on that lock,
# so no destructive step runs before single-flight is decided.

log "starting daily restart for session=${SESSION}"

# STARTED_AT for PG dual-write — ISO 8601 UTC (matches
# core.daemon_runs.started_at TIMESTAMPTZ).
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_DATE="$(date +%Y-%m-%d)"
PG_HELPER="${SCRIPT_DIR}/_pg_dual_write_daemon.py"

# Helper: write_daemon_run via JSON envelope subprocess. Best-effort (|| true).
# daemon_name is role-qualified (daily-restart-<role>): both roles run the same
# date, so a shared name would collide on the (run_date, daemon_name) UPSERT
# key — the later role silently overwriting the earlier row.
# Args: $1=status (ok|partial|error|missing|stale), $2=ended_at ISO UTC, $3=notes (optional)
# status MUST be a PG DaemonStatus enum value.
pg_write_run() {
  local status="$1" ended_at="$2" notes="${3:-}"
  if [[ ! -x "${PG_HELPER}" ]]; then
    return 0
  fi
  local envelope
  if [[ -n "${notes}" ]]; then
    envelope="$(printf '{"op":"write_daemon_run","args":{"daemon_name":"daily-restart-%s","run_date":"%s","started_at":"%s","ended_at":"%s","status":"%s","notes":"%s"}}' \
      "${ROLE}" "${RUN_DATE}" "${STARTED_AT}" "${ended_at}" "${status}" "${notes}")"
  else
    envelope="$(printf '{"op":"write_daemon_run","args":{"daemon_name":"daily-restart-%s","run_date":"%s","started_at":"%s","ended_at":"%s","status":"%s"}}' \
      "${ROLE}" "${RUN_DATE}" "${STARTED_AT}" "${ended_at}" "${status}")"
  fi
  printf '%s\n' "${envelope}" | python3 "${PG_HELPER}" >>"${LOG_FILE}" 2>&1 || true
}

# write_daemon_run for the `autoagent` daemon (not `daily-restart-<role>`): the
# alert evaluator filters on daemon_name='autoagent', so a 'daily-restart-<role>'
# row would not suppress the alert. Same envelope shape as pg_write_run but with a CURRENT
# started_at (not the daily-restart STARTED_AT) to align with the alert's
# expectedAt window.
# Args: $1=status (quota_exceeded), $2=ended_at ISO UTC, $3=notes (required for quota traceability)
pg_write_autoagent_run() {
  local status="$1" ended_at="$2" notes="$3"
  if [[ ! -x "${PG_HELPER}" ]]; then
    return 0
  fi
  local autoagent_started_at envelope
  autoagent_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  envelope="$(printf '{"op":"write_daemon_run","args":{"daemon_name":"autoagent","run_date":"%s","started_at":"%s","ended_at":"%s","status":"%s","notes":"%s"}}' \
    "${RUN_DATE}" "${autoagent_started_at}" "${ended_at}" "${status}" "${notes}")"
  printf '%s\n' "${envelope}" | python3 "${PG_HELPER}" >>"${LOG_FILE}" 2>&1 || true
}

# 3. Pre-restart healthcheck. Warn-only: the whole purpose of this script is to
#    recover daemons that may have drifted into an unhealthy state (TCC token
#    aging, stuck REPL, etc.), so a failing pre-check is expected sometimes and
#    MUST NOT abort the restart.
if "${HEALTHCHECK}" >/dev/null 2>&1; then
  log "pre-restart healthcheck: OK"
else
  log "pre-restart healthcheck: FAIL (proceeding anyway — restart will recover)"
fi

# 3.5 Pre-restart quota gate — if pane scrollback shows Claude Max quota tokens,
# the daemon is intentionally idle (waiting for reset), not unhealthy. Restarting
# only forces a new REPL spawn into the same wall, wasting auth tokens. The quota
# line persists for the daemon's lifetime, so gate on quota_reset_passed: proceed
# once the reset time has passed (or the timestamp parse failed — quota status
# unknown, the gate's WARN line carries that verdict), else skip (mirror
# status='quota_exceeded', exit 0) and let the next 24h daily-restart re-evaluate.
if tmux has-session -t "${SESSION}" 2>/dev/null && detect_quota_in_pane "${SESSION}"; then
  if quota_reset_passed "${SESSION}"; then
    log "quota detect ignored — gate cleared (reset time passed, or parse failed: quota status unknown; see preceding line), proceeding with restart"
  else
    log "Claude Max quota reached (pre-restart) — restart skipped, recording status='quota_exceeded'"
    pg_write_run "quota_exceeded" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "pre-restart quota gate: session=${SESSION} restart skipped"
    exit 0
  fi
fi

# 3.7 Restart-window lock — the single-flight authority for double-fire. It
# serializes two overlapping cases: (a) two daily-restart siblings (a launchd
# double-fire) race on `ln -s`; exactly one wins, the loser loud-fails (exit 7)
# before any kill; (b) the lock marks the kill→recreate window for the OTHER
# side — a launchd-respawned supervise bootstrap (the supervisor exits 3 the
# moment the session below is killed) waits on this lock instead of duplicate-
# racing the return-mode recreate. EXIT trap releases on every path; a SIGKILLed
# run leaves a stale link reclaimed at next acquire.
daemon_lock_acquire "${DAEMON_RESTART_LOCK}" "$$"
if [[ "${daemon_lock_acquired}" != "true" ]]; then
  log "FATAL: restart lock ${DAEMON_RESTART_LOCK} held by live pid ${daemon_lock_holder} — concurrent restart window, skipping this run"
  printf 'FATAL: concurrent restart window for role=%s (lock=%s pid=%s)\n' \
    "${ROLE}" "${DAEMON_RESTART_LOCK}" "${daemon_lock_holder}" >&2
  exit 7
fi
trap 'daemon_lock_release "${DAEMON_RESTART_LOCK}" "$$"' EXIT

# 4+5. Kill the tmux session and poll until tmux confirms teardown, as one
#    re-enterable unit — the bootstrap retry loop below re-runs it to clear a
#    half-created session (created but uninjected) before each retry. Idempotent:
#    an already-gone session skips straight to confirmation. tmux kill-session
#    exits non-zero when the target doesn't exist, so it gates on has-session.
#    rc 1 = kill refused or session survived KILL_TIMEOUT_SEC (caller decides
#    fatality). Bash 3.2 compatible loop.
kill_session_and_confirm() {
  if tmux has-session -t "${SESSION}" 2>/dev/null; then
    log "killing tmux session '${SESSION}'"
    if ! tmux kill-session -t "${SESSION}" 2>/dev/null; then
      log "WARN: tmux kill-session failed for '${SESSION}'"
      return 1
    fi
  else
    log "WARN: session '${SESSION}' did not exist at kill time — skipping kill"
  fi
  local waited=0
  while ((waited < KILL_TIMEOUT_SEC)); do
    if ! tmux has-session -t "${SESSION}" 2>/dev/null; then
      break
    fi
    sleep "${KILL_POLL_INTERVAL_SEC}"
    waited=$((waited + KILL_POLL_INTERVAL_SEC))
  done
  if tmux has-session -t "${SESSION}" 2>/dev/null; then
    log "WARN: session '${SESSION}' still present ${KILL_TIMEOUT_SEC}s after kill-session"
    return 1
  fi
  log "session '${SESSION}' teardown confirmed after ${waited}s"
}

if ! kill_session_and_confirm; then
  fatal "session '${SESSION}' teardown failed"
fi

# Pre-bootstrap orphan-marker sweep.
# Claude Code's plugin GC sweep (05:00 KST) writes .orphaned_at markers to
# plugin cache dirs, causing the next REPL spawn to skip MCP server bootstrap
# (e.g., fakechat bun server never starts → the configured fakechat ports
# (defaults 8787/8788) stay unbound → daemon
# wired but dead). Sweep all such markers before bootstrap so the next claude
# spawn re-bootstraps every plugin's MCP server.
# These are build artifacts (regenerable) — rm exception per core-security.md.
find "${HOME}/.claude/plugins/cache/claude-plugins-official" -name .orphaned_at -delete 2>/dev/null || true
log "orphan-marker sweep complete"

# 6. Recreate via bootstrap in RETURN mode. Bootstrap is idempotent and self-
#    contained: it pre-spawns the fakechat MCP server, creates the tmux session +
#    exec claude, waits for the REPL/HTTP to warm up, then runs
#    daemon-inject-entry.sh to submit /loop. In `return` mode it RETURNS the
#    inject result as its exit code (instead of entering its step-6 self-health
#    loop), so we can proceed to the post-bootstrap healthcheck below. Without the
#    `return` arg it defaults to `supervise` (the launchd KeepAlive path) and
#    never returns — hence this call MUST pass `return` explicitly.
#
# return-mode exit-code contract:
#   0       = entry-injection succeeded → proceed to healthcheck (status ok path)
#   2       = quota wall → marker file is the single SoT (rc=2 diagnostic only,
#             no double-signal). autoagent marker check below skips healthcheck;
#             wiki has no marker (decoupled) so skip healthcheck here.
#   other   = injection failed / session unhealthy → fatal
# The timeout wrapper is retained as a safety backstop only: in return mode the
# bootstrap returns within entry-injection time, so a 124/137 here is now an
# ANOMALY (not the expected path), recorded as error for monitor visibility.
log "invoking bootstrap in return mode: ${BOOTSTRAP_SCRIPT} (timeout backstop=${BOOTSTRAP_TIMEOUT_SEC}s, attempts=${BOOTSTRAP_RETRY_MAX})"
bootstrap_rc=0
bootstrap_attempt=1
while :; do
  bootstrap_rc=0
  run_with_timeout "${BOOTSTRAP_KILL_GRACE_SEC}" "${BOOTSTRAP_TIMEOUT_SEC}" \
    "${BOOTSTRAP_SCRIPT}" return >>"${LOG_FILE}" 2>&1 || bootstrap_rc=$?
  # rc 0 (injected) and rc 2 (quota wall) are terminal; anything else gets a
  # linear-backoff retry — the session is already dead at this point, so an
  # immediate terminal teardown would strand the daemon for a whole day.
  if [[ "${bootstrap_rc}" -eq 0 || "${bootstrap_rc}" -eq 2 ]]; then
    break
  fi
  if ((bootstrap_attempt >= BOOTSTRAP_RETRY_MAX)); then
    break
  fi
  backoff=$((BOOTSTRAP_RETRY_BACKOFF_SEC * bootstrap_attempt))
  log "WARN: bootstrap attempt ${bootstrap_attempt}/${BOOTSTRAP_RETRY_MAX} failed (rc=${bootstrap_rc}) — clearing any half-created session, retrying in ${backoff}s"
  # A failed attempt can leave a created-but-uninjected session whose presence
  # would no-op the next return-mode attempt — clear it so the retry recreates.
  kill_session_and_confirm || true
  sleep "${backoff}"
  bootstrap_attempt=$((bootstrap_attempt + 1))
done

# Recreate window closed (success or terminal) — release now so a waiting
# supervise bootstrap can adopt without sitting out the healthcheck phase; the
# EXIT trap stays as backstop for the fatal paths.
daemon_lock_release "${DAEMON_RESTART_LOCK}" "$$"

# Resurrect the launchd supervisor when its job is dead: under KeepAlive
# {SuccessfulExit=false} a clean exit 0 (e.g., a cold-start inject defer) is
# never respawned, leaving the recreated session unsupervised. kickstart
# WITHOUT -k: a live supervisor is untouched; a dead one respawns, sees the
# session, and adopts it. Runs on the failure paths too — launchd's KeepAlive
# retry chain is then the recovery of last resort. Best-effort but loud.
if command -v launchctl >/dev/null 2>&1; then
  kickstart_rc=0
  launchctl kickstart "gui/${UID}/com.glass-atrium.${ROLE}-daemon" >>"${LOG_FILE}" 2>&1 || kickstart_rc=$?
  if [[ "${kickstart_rc}" -ne 0 ]]; then
    log "WARN: launchctl kickstart gui/${UID}/com.glass-atrium.${ROLE}-daemon failed (rc=${kickstart_rc}) — supervisor job may need manual bootstrap"
  else
    log "supervisor kickstart ok (gui/${UID}/com.glass-atrium.${ROLE}-daemon)"
  fi
else
  log "WARN: launchctl not on PATH — skipping supervisor kickstart"
fi

if [[ "${bootstrap_rc}" -eq 124 || "${bootstrap_rc}" -eq 137 ]]; then
  log "FATAL: bootstrap timed out after ${BOOTSTRAP_TIMEOUT_SEC}s (rc=${bootstrap_rc}) — anomaly: return mode should exit within entry-injection time"
  pg_write_run "error" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "bootstrap timeout ${BOOTSTRAP_TIMEOUT_SEC}s role=${ROLE} (rc=${bootstrap_rc})"
  printf 'FATAL: bootstrap timeout after %ss for role=%s (see %s)\n' \
    "${BOOTSTRAP_TIMEOUT_SEC}" "${ROLE}" "${LOG_FILE}" >&2
  exit 6
fi
if [[ "${bootstrap_rc}" -eq 2 ]]; then
  # Quota wall. Marker file is the single SoT — for autoagent the marker check
  # below detects it, records quota_exceeded, and exits 0; for wiki there is no
  # marker (decoupled), so record the daily-restart row 'ok' (the restart
  # succeeded — session alive, only /loop hit a quota wall) and skip the
  # healthcheck (which would race the quota wait).
  log "bootstrap returned 2 (quota wall, diagnostic) — marker file is the quota SoT"
  # autoagent does NOT exit here: it relies on the cross-file invariant that
  # autoagent-daemon-bootstrap.sh ALWAYS writes the quota marker on inject exit 2,
  # so the marker check below detects it, records quota_exceeded, and exits 0. A
  # future edit returning rc=2 WITHOUT the marker would fall through to the 300s
  # wait + healthcheck and race the quota wall (false-fail) — keep that marker-
  # write invariant intact. wiki has no marker (decoupled).
  if [[ "${ROLE}" != "autoagent" ]]; then
    pg_write_run "ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "role=${ROLE} session=${SESSION} quota_wall (healthcheck skipped)"
    log "daily restart completed with quota wall (${ROLE} /loop skipped today, daemon session alive)"
    exit 0
  else
    # Observability: autoagent falls through (no exit) to the quota-marker check
    # below — log the hand-off so post-mortems see the deferral explicitly.
    log "autoagent rc=2 — deferring to quota-marker check (no exit here)"
  fi
elif [[ "${bootstrap_rc}" -ne 0 ]]; then
  fatal "bootstrap failed (rc=${bootstrap_rc}) — session may not have been recreated (check ${LOG_FILE})"
else
  log "bootstrap returned 0"
fi

# Post-bootstrap quota marker check. autoagent-daemon-bootstrap.sh writes a
# today-dated marker file when the inject path detects a quota wall (exit 2).
# Marker presence means the session is alive but `/loop` could not register cron
# — the post-bootstrap healthcheck would race the quota wait and false-fail.
# Instead UPSERT status='quota_exceeded' under daemon_name='autoagent' so the
# alert evaluator's whitelist suppresses daemon.report_missing, then exit 0.
# autoagent role only (wiki's marker scheme is decoupled). Marker is removed
# immediately after consumption — idempotent across same-date invocations.
if [[ "${ROLE}" == "autoagent" ]]; then
  QUOTA_MARKER="/tmp/autoagent-quota-marker-$(date +%Y-%m-%d)"
  if [[ -f "${QUOTA_MARKER}" ]]; then
    log "quota wall marker detected post-bootstrap (${QUOTA_MARKER}) — recording status='quota_exceeded' for daemon_name=autoagent, skipping healthcheck"
    pg_write_autoagent_run "quota_exceeded" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "auto-marked by daily-restart: inject quota wall (bootstrap exit 2 propagated)"
    rm -f "${QUOTA_MARKER}" || log "WARN: failed to remove quota marker ${QUOTA_MARKER} (non-fatal)"
    # daily-restart's own status row stays 'ok' — the restart sequence itself
    # succeeded; only the autoagent /loop injection hit a quota wall. Use the
    # existing pg_write_run for the daily-restart row to preserve audit trail.
    pg_write_run "ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "role=${ROLE} session=${SESSION} quota_wall=autoagent (healthcheck skipped)"
    log "daily restart completed with quota wall (autoagent /loop skipped today, daemon session alive)"
    exit 0
  fi
fi

# 7. Post-bootstrap wait. The healthcheck's cron-registration check (Step 5 in
#    the healthcheck script) requires the /loop Skill to have completed its
#    CronCreate round-trip and emitted "Scheduled <8-hex-id>" into the pane.
#    Without this wait, the healthcheck may race the Skill and report a false
#    negative.
sleep "${POST_BOOTSTRAP_WAIT_SEC}"

# 8. Post-restart healthcheck. Authoritative verification: session exists +
#    pane_pid alive + pane_cmd is claude + cron registered in scrollback.
# 3-attempt retry loop (plugin/MCP bootstrap is
# event-loop async + /loop Skill round-trip varies 60-90s; retries absorb that
# without weakening the failure signal). Healthcheck stderr → LOG_FILE for
# post-mortem; a pre-fail pane snapshot disambiguates race-vs-Skill-bypass.
# Attempt 1 uses --skip-cron-watchdog to verify session/pane/process health
# WITHOUT requiring CronCreate evidence, decoupling "daemon revived" from "/loop
# completed CronCreate" (cron may not yet be in scrollback if the Skill is mid-
# flight). Attempts 2/3 run the full check (cron required) — if that still fails,
# the session is alive but the Skill genuinely bypassed CronCreate = the real
# error. Each invocation is wrapped in timeout(1) because tmux capture-pane on a
# zombie pane can block uninterruptibly; a timeout is treated as a regular
# failure feeding the retry/fatal cascade.
# Helper: run healthcheck under timeout, return its rc (124/137 = timeout).
run_healthcheck() {
  local rc=0
  run_with_timeout "${BOOTSTRAP_KILL_GRACE_SEC}" "${HEALTHCHECK_TIMEOUT_SEC}" \
    "${HEALTHCHECK}" "$@" >>"${LOG_FILE}" 2>&1 || rc=$?
  if [[ "${rc}" -eq 124 || "${rc}" -eq 137 ]]; then
    log "WARN: healthcheck timed out after ${HEALTHCHECK_TIMEOUT_SEC}s (rc=${rc}, args=$*)"
  fi
  return "${rc}"
}

if ! run_healthcheck --skip-cron-watchdog; then
  log "post-restart healthcheck attempt 1 (--skip-cron-watchdog) FAILED — sleeping 5s before retry"
  sleep 5
  if ! run_healthcheck; then
    log "post-restart healthcheck attempt 2 (full) FAILED — sleeping 5s before final retry"
    sleep 5
    if ! run_healthcheck; then
      log "pane snapshot at fail moment (last 20 lines of scrollback):"
      tmux capture-pane -t "${SESSION}" -p -S -200 2>/dev/null | tail -20 >>"${LOG_FILE}" || true
      fatal "post-restart healthcheck FAILED on all 3 attempts — session recreated but unhealthy"
    fi
    log "post-restart healthcheck attempt 3 (full) OK"
  else
    log "post-restart healthcheck attempt 2 (full) OK"
  fi
else
  # Attempt 1 (skip-cron) passed → daemon process alive. Run a follow-up full
  # check (with cron-watchdog) to verify the Skill round-trip also completed. A
  # failure here means the daemon is alive but the Skill bypassed CronCreate —
  # warn (non-fatal) so the next /loop tick can re-attempt cron registration.
  log "post-restart healthcheck attempt 1 (--skip-cron-watchdog) OK — daemon process verified alive"
  if ! run_healthcheck; then
    log "WARN: full check (with cron-watchdog) FAILED after skip-cron OK — daemon alive but cron registration race or Skill CronCreate bypass; next /loop tick will re-register"
  else
    log "post-restart healthcheck full check OK — daemon and cron both confirmed"
  fi
fi

log "daily restart completed successfully (session=${SESSION} fully recovered)"

# Record success row in core.daemon_runs.
pg_write_run "ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "role=${ROLE} session=${SESSION}"

exit 0
