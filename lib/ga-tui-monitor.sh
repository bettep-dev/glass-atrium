# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2312  # SC2154: reads shared globals (MONITOR_*/GA_*/PORT/install-path vars etc.) declared + assigned by the glass-atrium loader; SC2034: assigns shared monitor-state globals read at runtime by the loader + other TUI siblings; both present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC2312: launchctl/pgrep/lsof probes are deliberately invoked inside command substitutions or conditionals (the masked return is the intended signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — monitor lifecycle module. SOURCED by the glass-atrium entry
# point (never executed): the shebang, strict mode, IFS, traps and every interleaved
# top-level const/stub stay loader-owned so re-sourcing never re-arms them. Owns the
# launchd-ownership probe, the stop/restore of the launchd monitor around an install,
# the orphan-PID-on-port detection with the our-PID check, the orphan monitor stop, the
# install-presence probe and the monitor summary parser — reading the loader's
# file-scope globals at call time in the same sourced shell. restore_launchd_monitor is
# invoked cross-sibling by the loader-owned cleanup() EXIT trap, armed only after every
# TUI module is sourced, so it is always defined at call time.
# === IMP2: launchd monitor stop/restore for the install health gate =========
# The engine bootstrap_health_gate (lib/ga-core.sh) refuses to start while a monitor
# already serves :16145 — it would validate the STALE instance, not the rebuilt dist/.
# When that monitor is launchd-OWNED, the install transparently stops it before the gate
# and restores it after. Restore is GUARANTEED on every exit path via cleanup()'s EXIT
# trap (the only hook that survives the gate's bare `exit`). The engine gate is left
# UNCHANGED: once the launcher frees the port, the gate's precondition curl fails and it
# proceeds normally; the explicit die stays the CI/passthrough safety net.
#
# monitor_is_launchd_owned — POSITIVE launchd ownership evidence only. A free-running
# `node` dev server on the monitor port must NOT be auto-handled, so "port serving +
# plist exists" is insufficient. True ONLY if BOTH: `launchctl list` shows
# com.glass-atrium.monitor with a NUMERIC pid (a `-` = loaded-but-not-running → NOT
# owned), AND that pid is an exact whole-line match in `lsof -ti tcp:<port>` (the engine
# gate's own cross-check shape, ga-core.sh ~L1371 — `grep -Fxq` so 5355 never
# false-matches 53556). The port derives via the shared atrium_monitor_port resolver
# (ADR-1) — never a literal, so no split-brain vs the port the monitor actually binds.
# launchctl/lsof absent OR an unresolvable port → false (no auto-handle; the engine
# gate's existing die stays the safety net).
monitor_is_launchd_owned() {
  command -v launchctl >/dev/null 2>&1 || return 1
  command -v lsof >/dev/null 2>&1 || return 1
  local port
  port="$(atrium_monitor_port)" || return 1 # unresolvable port → cannot assert ownership
  local label="com.glass-atrium.monitor" pid
  # `launchctl list` row: "<pid>\t<status>\t<label>" — the label is the LAST whitespace
  # field. EXACT-label awk match (==, not substring) so the sibling job
  # com.glass-atrium.monitor-log-rotate (whose pid is `-`) is never picked; its row also
  # sorts first, so a substring + head -1 would wrongly select the `-` pid.
  pid="$(launchctl list 2>/dev/null | awk -v l="${label}" '$NF==l{print $1; exit}' || true)"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1 # `-` (not running) / empty / garbage → not owned
  # cross-check the launchd pid actually owns the :${port} LISTENER (exact whole-line).
  # -sTCP:LISTEN restricts to the listener; a bare lsof also returns client connections.
  local listener_pids
  listener_pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  printf '%s\n' "${listener_pids}" | grep -Fxq -- "${pid}" || return 1
  return 0
}

# stop_launchd_monitor_for_install — stop a launchd-owned monitor so the health gate
# sees a free port. No-op (return 0) when not launchd-owned. The stop flags are set
# BEFORE the bootout so a crash mid-stop still triggers the cleanup() restore. After
# bootout, poll until the monitor port frees, bounded (~5s). On a port that never frees:
# restore + a loud stderr message, then return non-zero so the caller aborts the install
# cleanly (never proceed blind into a gate that would validate the stale instance). The
# port derives via atrium_monitor_port (ADR-1) — never a literal.
stop_launchd_monitor_for_install() {
  monitor_is_launchd_owned || return 0
  local port
  port="$(atrium_monitor_port)" || return 1 # unresolvable port → abort before any stop
  local label="com.glass-atrium.monitor"
  # set the stop flags BEFORE the bootout (crash-mid-stop → cleanup() still restores).
  MONITOR_WAS_STOPPED="yes"
  MONITOR_PLIST_PATH="${LAUNCH_AGENTS}/${label}.plist"
  log "== install: launchd monitor temporarily stopped for the health gate (bootout ${label}) =="
  # bootout first (macOS 11+), fall back to legacy unload — the engine primitive shape
  # (ga-core.sh ~L641). Masked: an already-gone job must not abort the stop.
  launchctl bootout "gui/${UID}/${label}" 2>/dev/null \
    || launchctl unload -w "${MONITOR_PLIST_PATH}" 2>/dev/null || true
  # poll until the port frees, bounded (~5s) — a still-bound port means the gate would
  # still see the stale instance, so loud-fail rather than proceed.
  # -sTCP:LISTEN: poll the LISTENER only. A lingering client connection (e.g. a browser
  # viewing the dashboard) keeps a bare lsof non-empty → false 5s timeout abort.
  local waited=0
  while [[ "${waited}" -lt 5 ]]; do
    [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  if [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]]; then
    return 0
  fi
  # port never freed — restore what we stopped, surface loudly, and signal abort.
  printf 'ERROR: launchd monitor stop left :%s bound after %ss — install aborted to avoid validating the stale instance. Restoring the monitor.\n' \
    "${port}" "${waited}" >&2
  restore_launchd_monitor
  return 1
}

# restore_launchd_monitor — IDEMPOTENT re-bootstrap of a monitor we stopped. No-op
# (return 0) unless MONITOR_WAS_STOPPED == yes. The flag is cleared STRICTLY BEFORE the
# bootstrap (clear-then-bootstrap) so a bootstrap that throws cannot let the cleanup()
# backstop double-bootstrap. ALWAYS returns 0 — it runs inside cleanup() under
# `set -Eeuo pipefail` where a non-zero rc would corrupt the preserved exit code, so
# every risky command is masked and a restore failure surfaces ONLY via a loud stderr
# remediation message, never via the return code.
restore_launchd_monitor() {
  [[ "${MONITOR_WAS_STOPPED}" == "yes" ]] || return 0
  local plist="${MONITOR_PLIST_PATH}"
  # clear BEFORE bootstrap (clear-then-bootstrap) — a re-entry or the cleanup() backstop
  # must never double-bootstrap even if the bootstrap below throws.
  MONITOR_WAS_STOPPED=""
  log "== install: restoring the launchd monitor (bootstrap, now serving the rebuilt dist) =="
  # bootstrap can legitimately return non-zero (already-loaded / load race) — mask it;
  # the curl verify below is the real liveness check.
  launchctl bootstrap "gui/${UID}" "${plist}" 2>/dev/null || true
  # verify restore: poll /api/health for 200, bounded by the engine's own health window
  # constant (no new magic number) so the two windows stay consistent. The port derives
  # via atrium_monitor_port (ADR-1); a resolver failure is masked to '' (this fn ALWAYS
  # returns 0 inside cleanup() under set -e) → the poll simply times out into the loud
  # manual-remediation message below, never a non-zero rc that would corrupt the exit code.
  local port
  port="$(atrium_monitor_port 2>/dev/null || true)"
  local waited=0
  while [[ "${waited}" -lt "${BOOTSTRAP_HEALTH_WINDOW_SECS}" ]]; do
    if curl -sf -o /dev/null "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
      log "== install: launchd monitor restored (now serving the rebuilt dist) =="
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  # restore could not be verified — NEVER silent: print the exact manual remediation.
  printf 'ERROR: launchd monitor did not answer /api/health 200 within %ss after restore. Restore it manually: launchctl bootstrap gui/%s %s\n' \
    "${BOOTSTRAP_HEALTH_WINDOW_SECS}" "${UID}" "${plist}" >&2
  return 0
}

# === CHANGE 3: non-launchd orphan stop for the install health gate ==========
# monitor_is_launchd_owned (above) recognizes ONLY a launchd-MANAGED monitor (a loaded
# com.glass-atrium.monitor job whose pid owns the monitor port). A NON-launchd orphan — a
# stray `node dist/server/main.js` left over from a crashed install, a manual dev run,
# etc. — is therefore MISSED by stop_launchd_monitor_for_install (it returns 0/no-op), so
# the orphan keeps the port bound and bootstrap_health_gate's precondition curl sees a 200
# from the stale instance and die()s — the root cause of the install "hang" (the dying
# step exits past stop_step_spinner; CHANGE 2 reaps the spinner, this CHANGE frees the port).
#
# monitor_orphan_pid_on_port — echo the PID of a monitor-port LISTENER that is NOT
# launchd-owned, else echo nothing. It is the shared NON-LAUNCHD-LISTENER DETECTOR and does
# NOT judge ours-vs-foreign (that ACTION policy lives in the caller — ADR-2 polarity note:
# detectors shared, action per-caller). Returns a PID ONLY when (a) lsof reports a LISTENER
# pid on the resolved port AND (b) monitor_is_launchd_owned is false (no loaded job owns
# that port). A launchd-owned monitor yields NOTHING here, so the launchd path
# (stop_launchd_monitor_for_install / bootout) stays its ONLY handler. The port derives via
# atrium_monitor_port (ADR-1) — never a literal. Always exits 0 (stdout verdict).
monitor_orphan_pid_on_port() {
  command -v lsof >/dev/null 2>&1 || return 0 # no lsof → cannot identify an orphan; defer to the gate's die
  local port
  port="$(atrium_monitor_port)" || return 0 # unresolvable port → cannot probe; defer to the gate's die
  # if a launchd job legitimately owns the port, this is NOT an orphan — emit nothing so
  # only stop_launchd_monitor_for_install (bootout) handles it. (`!` keeps set -e happy.)
  if monitor_is_launchd_owned; then
    return 0
  fi
  # -sTCP:LISTEN: the LISTENER pid only (a bare lsof also returns client connections, e.g.
  # a browser viewing the dashboard — never a kill target). head -1: a single owning pid.
  local listener_pid
  listener_pid="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ "${listener_pid}" =~ ^[0-9]+$ ]] || return 0 # nothing listening (or garbage) → no orphan
  printf '%s\n' "${listener_pid}"
}

# monitor_pid_is_ours — TRUE (rc 0) iff PID $1 is OUR monitor, defined (ADR-2 R1) as BOTH:
#   (a) its argv contains `dist/server/main.js` (identifies it as A monitor), AND
#   (b) its working directory == ${GA_ROOT}/monitor (pins it to OUR install root).
# The monitor is launched `cd ${GA_ROOT}/monitor && exec node dist/server/main.js`
# (lib/ga-db.sh), so `ps -o command=` reports the RELATIVE argv `node dist/server/main.js`
# — matching an ABSOLUTE ${GA_ROOT}/monitor/dist/server/main.js would NEVER hit and would
# MIS-FLAG our own stray as foreign (regressing the AC-S2.5b self-heal). The cwd is the
# disambiguator a bare argv match lacks: a foreign `node …/dist/server/main.js` running in
# a DIFFERENT tree passes (a) but fails (b). cwd via `lsof -p <pid> -a -d cwd -Fn` (parse
# the n-prefixed name field). ps/lsof absent, a non-numeric pid, or any missing signal →
# rc 1 (treated FOREIGN → fail-safe: never kill on incomplete evidence). Args: $1 = pid.
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
  # (b) cwd pins it to OUR install root. `-a -d cwd` restricts lsof's output to the cwd fd;
  # -Fn emits an `n`-prefixed name line for it — strip the leading `n`.
  local cwd
  cwd="$(lsof -p "${pid}" -a -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0, 2); exit}' || true)"
  [[ "${cwd}" == "${GA_ROOT}/monitor" ]] || return 1 # different tree → foreign
  return 0
}

# stop_orphan_monitor_for_install — if a NON-launchd LISTENER holds the monitor port, apply
# the ADR-2 ownership policy: our own stray (monitor_pid_is_ours: argv `dist/server/main.js`
# AND cwd ${GA_ROOT}/monitor) → SIGTERM→SIGKILL self-heal (UNCHANGED behavior); a FOREIGN
# holder (fails the argv+cwd test) → do NOT kill, FAIL the install loudly identifying it.
# No-op (return 0) when the port is free OR launchd-owned (the launchd path already handled
# the latter, having run first). SAFETY: only ever kills the verified :port non-launchd
# LISTENER pid that is VERIFIED-ours (never a blind kill, never a launchd-managed pid, never
# a foreign pid). SIGTERM first, verify the port frees (bounded ~5s), escalate to SIGKILL
# only if it does not. On a port that never frees, loud-fail (return non-zero) so the caller
# aborts the install cleanly. The port derives via atrium_monitor_port (ADR-1).
stop_orphan_monitor_for_install() {
  local orphan_pid
  orphan_pid="$(monitor_orphan_pid_on_port)"
  [[ -n "${orphan_pid}" ]] || return 0 # port free or launchd-owned → nothing to do
  local port
  port="$(atrium_monitor_port)" || return 1 # unresolvable port → abort before any action
  # Part B (ADR-2): a non-launchd holder is only OUR stray if its argv contains
  # dist/server/main.js AND its cwd is ${GA_ROOT}/monitor. A FOREIGN holder is NOT ours —
  # NEVER kill it; fail the install loudly so the operator resolves the conflict by hand.
  if ! monitor_pid_is_ours "${orphan_pid}"; then
    printf 'ERROR: :%s is held by a FOREIGN process (pid %s) that is NOT our monitor (argv/cwd mismatch) — install aborted WITHOUT killing it. Identify it: lsof -nP -iTCP:%s -sTCP:LISTEN\n' \
      "${port}" "${orphan_pid}" "${port}" >&2
    return 1
  fi
  log "== install: NON-launchd OUR-monitor stray on :${port} (pid ${orphan_pid}) — stopping it so the health gate port is free =="
  # SIGTERM the verified our-stray listener pid, then poll until :${port} frees (bounded ~5s).
  kill "${orphan_pid}" 2>/dev/null || true
  local waited=0
  while [[ "${waited}" -lt 5 ]]; do
    [[ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]] && {
      log "== install: orphan stopped — :${port} is now free for the health gate =="
      return 0
    }
    sleep 1
    waited=$((waited + 1))
  done
  # still bound after SIGTERM — escalate to SIGKILL on the SAME verified pid (untrappable),
  # then re-poll once. Re-derive the listener pid before the SIGKILL so a process that
  # already exited and whose port was reclaimed by a DIFFERENT pid is never -9'd blindly.
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

# monitor_install_present — install-completion gate for the Monitor shortcut (ITEM 5). The monitor
# launchd plist in ~/Library/LaunchAgents is written ONLY by a completed install (copy → LaunchAgents
# + bootstrap), so its presence is a cheap, durable "the program is installed" signal — no jq/curl/
# manifest parse on the menu hot path. Presence-only test; never reads the file's contents.
monitor_install_present() {
  [[ -f "${HOME}/Library/LaunchAgents/com.glass-atrium.monitor.plist" ]]
}

# parse_monitor_summary — ITEM 5: compose the Monitor done digest from the action rc. rc 0 = the
# browser was opened on the (installed) monitor; rc 2 = install-gated (program not installed yet);
# any other rc = the browser-open command failed. $2 = the dashboard URL (non-secret). Mirrors
# parse_token_summary's SUMMARY/ROW2 pattern; no secret ever enters the string.
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
