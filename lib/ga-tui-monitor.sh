# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2312  # SC2154: reads shared globals (MONITOR_*/GA_*/PORT/install-path vars etc.) declared + assigned by the glass-atrium loader; SC2034: assigns shared monitor-state globals read at runtime by the loader + other TUI siblings; both present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC2312: launchctl/pgrep/lsof probes are deliberately invoked inside command substitutions or conditionals (the masked return is the intended signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — monitor lifecycle module, SOURCED by the entry point (never
# executed): shebang, strict mode, IFS and traps stay loader-owned so re-sourcing never
# re-arms them. Owns the launchd-ownership probe, the stop/restore around an install, the
# orphan-PID-on-port detection + our-PID check, the orphan stop, the install-presence probe
# and the summary parser. restore_launchd_monitor runs from cleanup()'s EXIT trap, armed
# only after every TUI module is sourced (always defined at call time).
# IMP2: launchd monitor stop/restore around the install health gate. The engine gate
# (ga-core.sh) would validate the STALE monitor if one still serves the port, so a
# launchd-OWNED monitor is stopped before the gate and restored after — restore GUARANTEED
# by cleanup()'s EXIT trap (survives the gate's bare `exit`). The engine gate is UNCHANGED:
# once the port frees its precondition curl fails and it proceeds; its die stays the safety net.
#
# monitor_is_launchd_owned — POSITIVE ownership evidence only: a free-running `node` dev
# server on the port must NOT be auto-handled, so "port serving + plist exists" is
# insufficient. True ONLY if BOTH: `launchctl list` shows com.glass-atrium.monitor with a
# NUMERIC pid (`-` = loaded-but-not-running → NOT owned), AND that pid is an exact whole-line
# lsof -ti match (`grep -Fxq` so 5355 never false-matches 53556). Port via atrium_monitor_port
# (ADR-1), never a literal; absent launchctl/lsof or unresolvable port → false.
monitor_is_launchd_owned() {
  command -v launchctl >/dev/null 2>&1 || return 1
  command -v lsof >/dev/null 2>&1 || return 1
  local port
  port="$(atrium_monitor_port)" || return 1 # unresolvable port → cannot assert ownership
  local label="com.glass-atrium.monitor" pid
  # `launchctl list` row "<pid>\t<status>\t<label>": EXACT-label awk match (==, not substring)
  # so the sibling com.glass-atrium.monitor-log-rotate (pid `-`, sorts first) is never picked.
  pid="$(launchctl list 2>/dev/null | awk -v l="${label}" '$NF==l{print $1; exit}' || true)"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1 # `-` (not running) / empty / garbage → not owned
  # cross-check the launchd pid owns the :${port} LISTENER (exact whole-line). -sTCP:LISTEN
  # excludes client connections (a bare lsof also returns them).
  local listener_pids
  listener_pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  printf '%s\n' "${listener_pids}" | grep -Fxq -- "${pid}" || return 1
  return 0
}

# stop_launchd_monitor_for_install — stop a launchd-owned monitor so the health gate sees a
# free port (no-op when not owned). Stop flags set BEFORE the bootout so a crash mid-stop
# still triggers the cleanup() restore. After bootout, poll until the port frees (bounded
# ~5s); if it never frees → restore + loud stderr + return non-zero so the caller aborts
# cleanly (never proceed blind into a gate that would validate the stale instance).
stop_launchd_monitor_for_install() {
  monitor_is_launchd_owned || return 0
  local port
  port="$(atrium_monitor_port)" || return 1 # unresolvable port → abort before any stop
  local label="com.glass-atrium.monitor"
  # stop flags BEFORE the bootout (crash-mid-stop → cleanup() still restores).
  MONITOR_WAS_STOPPED="yes"
  MONITOR_PLIST_PATH="${LAUNCH_AGENTS}/${label}.plist"
  log "== install: launchd monitor temporarily stopped for the health gate (bootout ${label}) =="
  # bootout first (macOS 11+), fall back to legacy unload (ga-core.sh primitive shape).
  # Masked: an already-gone job must not abort the stop.
  launchctl bootout "gui/${UID}/${label}" 2>/dev/null \
    || launchctl unload -w "${MONITOR_PLIST_PATH}" 2>/dev/null || true
  # poll until the port frees, bounded by a SECONDS-delta wall-clock ceiling (~5s default,
  # GA_MONITOR_PORT_FREE_TIMEOUT_SECS): an iteration count drifts when a probe blocks, the SECONDS
  # anchor caps true elapsed. A still-bound port → the gate would see the stale instance, so
  # loud-fail. -sTCP:LISTEN polls the LISTENER only (a lingering client connection would keep a
  # bare lsof non-empty → false timeout).
  local ceiling="${GA_MONITOR_PORT_FREE_TIMEOUT_SECS:-5}" started="${SECONDS}"
  while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]; do
    [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]] && return 0
    sleep 1
  done
  if [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]]; then
    return 0
  fi
  # port never freed — restore what we stopped, surface loudly, and signal abort.
  printf 'ERROR: launchd monitor stop left :%s bound after %ss — install aborted to avoid validating the stale instance. Restoring the monitor.\n' \
    "${port}" "${ceiling}" >&2
  restore_launchd_monitor
  return 1
}

# restore_launchd_monitor — IDEMPOTENT re-bootstrap of a monitor we stopped (no-op unless
# MONITOR_WAS_STOPPED == yes). The flag is cleared BEFORE the bootstrap (clear-then-bootstrap)
# so a throwing bootstrap can't let the cleanup() backstop double-bootstrap. ALWAYS returns 0:
# it runs inside cleanup() under `set -Eeuo pipefail` where a non-zero rc would corrupt the
# preserved exit code, so every risky command is masked and a restore failure surfaces ONLY
# via loud stderr.
restore_launchd_monitor() {
  [[ "${MONITOR_WAS_STOPPED}" == "yes" ]] || return 0
  local plist="${MONITOR_PLIST_PATH}"
  # clear BEFORE bootstrap so re-entry / the cleanup() backstop never double-bootstraps.
  MONITOR_WAS_STOPPED=""
  log "== install: restoring the launchd monitor (bootstrap, now serving the rebuilt dist) =="
  # bootstrap may return non-zero (already-loaded / load race) — mask it; the curl verify is the real check.
  launchctl bootstrap "gui/${UID}" "${plist}" 2>/dev/null || true
  # verify restore: poll /api/health for 200, bounded by the engine's health-window constant
  # (no new magic number). Port via atrium_monitor_port (ADR-1); a resolver failure masks to ''
  # → the poll times out into the loud manual-remediation below (never a non-zero rc that would
  # corrupt the exit code).
  local port
  port="$(atrium_monitor_port 2>/dev/null || true)"
  # SECONDS-delta wall-clock ceiling (BOOTSTRAP_HEALTH_WINDOW_SECS, no new magic number): an
  # iteration count drifts because each curl probe can itself cost up to --max-time, the SECONDS
  # anchor caps true elapsed. --connect-timeout/--max-time bound each probe so a stalled
  # connection can never block a poll iteration past the deadline (an uncapped curl could hang
  # indefinitely on a half-open socket).
  local ceiling="${BOOTSTRAP_HEALTH_WINDOW_SECS}" started="${SECONDS}"
  while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]; do
    if curl -sf -o /dev/null --connect-timeout 2 --max-time 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
      log "== install: launchd monitor restored (now serving the rebuilt dist) =="
      return 0
    fi
    sleep 1
  done
  # restore could not be verified — NEVER silent: print the exact manual remediation.
  printf 'ERROR: launchd monitor did not answer /api/health 200 within %ss after restore. Restore it manually: launchctl bootstrap gui/%s %s\n' \
    "${BOOTSTRAP_HEALTH_WINDOW_SECS}" "${UID}" "${plist}" >&2
  return 0
}

# CHANGE 3: non-launchd orphan stop for the install health gate. A NON-launchd orphan (a
# stray `node dist/server/main.js` from a crashed install or a manual dev run) is MISSED by
# stop_launchd_monitor_for_install (no-op), so it keeps the port bound → bootstrap_health_gate
# sees a 200 from the stale instance and die()s: the root cause of the install "hang". CHANGE 2
# reaps the spinner; this frees the port.
#
# monitor_orphan_pid_on_port — echo the PID of a monitor-port LISTENER that is NOT
# launchd-owned, else nothing. Shared NON-LAUNCHD-LISTENER DETECTOR; it does NOT judge
# ours-vs-foreign (ADR-2: detectors shared, ACTION per-caller). Emits a PID only when lsof
# reports a LISTENER pid AND monitor_is_launchd_owned is false — a launchd-owned monitor
# yields nothing, so the launchd path (bootout) stays its only handler. Port via
# atrium_monitor_port (ADR-1); always exits 0 (stdout verdict).
monitor_orphan_pid_on_port() {
  command -v lsof >/dev/null 2>&1 || return 0 # no lsof → cannot identify an orphan; defer to the gate's die
  local port
  port="$(atrium_monitor_port)" || return 0 # unresolvable port → cannot probe; defer to the gate's die
  # launchd-owned port → NOT an orphan; emit nothing so only the bootout path handles it.
  if monitor_is_launchd_owned; then
    return 0
  fi
  # -sTCP:LISTEN: the LISTENER pid only (a bare lsof also returns client connections — never a
  # kill target). head -1: a single owning pid.
  local listener_pid
  listener_pid="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ "${listener_pid}" =~ ^[0-9]+$ ]] || return 0 # nothing listening (or garbage) → no orphan
  printf '%s\n' "${listener_pid}"
}

# monitor_pid_is_ours — TRUE (rc 0) iff PID $1 is OUR monitor (ADR-2 R1): BOTH (a) argv
# contains `dist/server/main.js` AND (b) cwd == ${GA_ROOT}/monitor. The monitor runs
# `cd ${GA_ROOT}/monitor && exec node dist/server/main.js`, so ps reports the RELATIVE argv —
# matching an ABSOLUTE path would NEVER hit and would MIS-FLAG our own stray as foreign
# (regressing AC-S2.5b self-heal). cwd is the disambiguator argv lacks: a foreign node in a
# DIFFERENT tree passes (a), fails (b). cwd via `lsof -p <pid> -a -d cwd -Fn` (n-prefixed
# name). Any missing signal (absent ps/lsof, non-numeric pid) → rc 1 (FOREIGN fail-safe:
# never kill on incomplete evidence).
monitor_pid_is_ours() {
  local pid="$1"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  command -v ps >/dev/null 2>&1 || return 1
  command -v lsof >/dev/null 2>&1 || return 1
  # (a) argv identifies A monitor — the RELATIVE `dist/server/main.js` substring.
  local argv
  argv="$(ps -o command= -p "${pid}" 2>/dev/null || true)"
  case "${argv}" in
    *dist/server/main.js*) ;;
    *) return 1 ;; # argv is not a monitor → foreign
  esac
  # (b) cwd pins it to OUR install root. `-a -d cwd` restricts lsof to the cwd fd; -Fn emits an
  # `n`-prefixed name line — strip the leading `n`.
  local cwd
  cwd="$(lsof -p "${pid}" -a -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0, 2); exit}' || true)"
  [[ "${cwd}" == "${GA_ROOT}/monitor" ]] || return 1 # different tree → foreign
  return 0
}

# stop_orphan_monitor_for_install — a NON-launchd LISTENER on the port gets the ADR-2
# ownership policy: our own stray (monitor_pid_is_ours) → SIGTERM→SIGKILL self-heal
# (UNCHANGED); a FOREIGN holder → do NOT kill, FAIL loudly identifying it. No-op when the port
# is free OR launchd-owned (that path ran first). SAFETY: only ever kills the verified
# non-launchd LISTENER that is VERIFIED-ours. SIGTERM, verify the port frees (bounded ~5s),
# escalate SIGKILL only if not; a port that never frees → loud-fail (return non-zero) so the
# caller aborts. Port via atrium_monitor_port (ADR-1).
stop_orphan_monitor_for_install() {
  local orphan_pid
  orphan_pid="$(monitor_orphan_pid_on_port)"
  [[ -n "${orphan_pid}" ]] || return 0 # port free or launchd-owned → nothing to do
  local port
  port="$(atrium_monitor_port)" || return 1 # unresolvable port → abort before any action
  # ADR-2: a FOREIGN holder (fails the argv+cwd test) is NOT ours — NEVER kill it; fail loudly
  # so the operator resolves the conflict by hand.
  if ! monitor_pid_is_ours "${orphan_pid}"; then
    printf 'ERROR: :%s is held by a FOREIGN process (pid %s) that is NOT our monitor (argv/cwd mismatch) — install aborted WITHOUT killing it. Identify it: lsof -nP -iTCP:%s -sTCP:LISTEN\n' \
      "${port}" "${orphan_pid}" "${port}" >&2
    return 1
  fi
  log "== install: NON-launchd OUR-monitor stray on :${port} (pid ${orphan_pid}) — stopping it so the health gate port is free =="
  # SIGTERM the verified our-stray listener pid, then poll until :${port} frees, bounded by a
  # SECONDS-delta wall-clock ceiling (~5s default, GA_MONITOR_PORT_FREE_TIMEOUT_SECS — same bound
  # as stop_launchd_monitor_for_install): an iteration count drifts when a probe blocks.
  kill "${orphan_pid}" 2>/dev/null || true
  local ceiling="${GA_MONITOR_PORT_FREE_TIMEOUT_SECS:-5}" started="${SECONDS}"
  while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]; do
    [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]] && {
      log "== install: orphan stopped — :${port} is now free for the health gate =="
      return 0
    }
    sleep 1
  done
  # still bound after SIGTERM → escalate to SIGKILL on the SAME verified pid. Re-derive the
  # listener pid first so a port reclaimed by a DIFFERENT pid is never -9'd blindly.
  local recheck_pid
  recheck_pid="$(monitor_orphan_pid_on_port)"
  if [[ "${recheck_pid}" == "${orphan_pid}" ]]; then
    kill -KILL "${orphan_pid}" 2>/dev/null || true
    sleep 1
  fi
  if [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]]; then
    log "== install: orphan stopped (SIGKILL) — :${port} is now free for the health gate =="
    return 0
  fi
  # port never freed — surface loudly and signal abort (never validate a stale instance).
  printf 'ERROR: a non-launchd process still holds :%s after SIGTERM+SIGKILL — install aborted to avoid validating the stale instance. Identify it: lsof -nP -iTCP:%s -sTCP:LISTEN\n' \
    "${port}" "${port}" >&2
  return 1
}

# monitor_install_present — install-completion gate for the Monitor shortcut. The launchd
# plist in ~/Library/LaunchAgents is written ONLY by a completed install, so its presence is a
# cheap, durable "installed" signal (no jq/curl/manifest parse on the menu hot path).
# Presence-only test; never reads the file's contents.
monitor_install_present() {
  [[ -f "${HOME}/Library/LaunchAgents/com.glass-atrium.monitor.plist" ]]
}

# parse_monitor_summary — compose the Monitor done digest from the action rc: 0 = opened in
# the browser (installed), 2 = install-gated (not installed yet), other = browser-open failed.
# $2 = the dashboard URL (non-secret). Mirrors parse_token_summary; no secret enters the string.
parse_monitor_summary() {
  local rc="$1" url="$2"
  MONITOR_SUMMARY=""
  MONITOR_SUMMARY_ROW2=""
  if [[ "${rc}" -eq 0 ]]; then
    MONITOR_SUMMARY="$(c "${C_OK}" "${G_OK}") $(c "${C_STRONG}" "opened in browser")"
    MONITOR_SUMMARY_ROW2="$(c "${C_DIM}" "${url}")"
  elif [[ "${rc}" -eq 2 ]]; then
    MONITOR_SUMMARY="$(c "${C_ALERT}" "!") $(c "${C_STRONG}" "available after Install")"
    MONITOR_SUMMARY_ROW2="$(c "${C_DIM}" "run Install first ${G_DOT} then Monitor opens ${url}")"
  else
    MONITOR_SUMMARY="$(c "${C_ALERT}" "${G_FAIL}") $(c "${C_STRONG}" "couldn't open browser")"
    MONITOR_SUMMARY_ROW2="$(c "${C_DIM}" "open ${url} manually")"
  fi
}
