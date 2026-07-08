#!/usr/bin/env bash
# autoagent-daemon-healthcheck.sh — verify claude-autoagent-daemon is alive and responsive
# Exit 0 = healthy (session exists + claude process active in pane + fakechat HTTP server live)
# Exit 1 = unhealthy (any check fails)
# Designed for invocation from system-health-check.sh (09:00 daily integration).
#
# Modes:
#   (no args)           — full steady-state check including cron-registered watchdog (step 5)
#   --skip-cron-watchdog — pre-inject mode: run steps 1-4 only (no cron evidence required)
#
# Architecture (fakechat channel): the pane runs `claude --channels
#   plugin:fakechat@claude-plugins-official` directly. Liveness = a curl against
#   the plugin's HTTP server (127.0.0.1:[ports].autoagent_fakechat, default 8787),
#   the authoritative "daemon can accept inject" signal. No wrapper-PID or
#   child-claude-PID check.
#
# --skip-cron-watchdog rationale: daemon-inject-entry.sh runs this as a pre-flight
# gate BEFORE sending /loop. Requiring the cron terminal state (step 5) there is a
# chicken-and-egg deadlock — injection is what PRODUCES cron registration.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SESSION="claude-autoagent-daemon"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"

# fakechat port — [ports].autoagent_fakechat (config.toml), default 8787; MUST
# resolve the same value as autoagent-daemon-bootstrap.sh (same config key).
FAKECHAT_PORT="$(atrium_config_port '[ports]' 'autoagent_fakechat' 8787)" || exit 1
readonly FAKECHAT_PORT
# Use 127.0.0.1 directly, not localhost. macOS resolves localhost IPv6-first
# ([::1, 127.0.0.1]) but Bun binds only 127.0.0.1, so curl gets connect-refused
# on ::1 and Happy-Eyeballs-falls through to 127.0.0.1; under load the IPv6 RST +
# IPv4 retry can eat the 2s -m budget → false FAIL post-restart. Matches the
# bootstrap probe.
readonly FAKECHAT_BASE_URL="http://127.0.0.1:${FAKECHAT_PORT}"
readonly HTTP_TIMEOUT_SEC=2

# Default: full steady-state check. --skip-cron-watchdog disables only step 5.
skip_cron_watchdog=0
if [[ $# -gt 0 ]]; then
  case "$1" in
    --skip-cron-watchdog) skip_cron_watchdog=1 ;;
    *)
      printf 'usage: %s [--skip-cron-watchdog]\n' "${0##*/}" >&2
      exit 2
      ;;
  esac
fi
readonly skip_cron_watchdog

# Output is intentionally terse so the parent health-check can grep it.
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# 1. tmux + curl available?
if ! command -v tmux >/dev/null 2>&1; then
  fail "tmux not on PATH"
fi
if ! command -v curl >/dev/null 2>&1; then
  fail "curl not on PATH"
fi

# 2. Session exists?
if ! tmux has-session -t "${SESSION}" 2>/dev/null; then
  fail "session '${SESSION}' does not exist"
fi

# 3. Pane PID still alive? pane_pid = the leaf process (now claude itself post-
#    fakechat-pivot, no PTY wrapper). bash-3.2-safe `head -n 1`.
pane_pid="$(tmux list-panes -t "${SESSION}" -F '#{pane_pid}' 2>/dev/null | head -n 1)"
if [[ -z "${pane_pid}" ]]; then
  fail "no pane PID for session '${SESSION}'"
fi

if ! kill -0 "${pane_pid}" 2>/dev/null; then
  fail "pane PID ${pane_pid} not running"
fi

# 4. Pane command is claude (or `node` — the claude CLI is a node script, so
#    pane_current_command sometimes reports node). Reject `python3` (the falsified
#    pty_wrapper.py model) loud: a stale daemon running the old architecture that
#    needs respawning.
pane_cmd="$(tmux list-panes -t "${SESSION}" -F '#{pane_current_command}' 2>/dev/null | head -n 1)"
case "${pane_cmd}" in
  claude | claude.exe | node) ;;
  python3 | python3.* | Python | python)
    fail "pane command is '${pane_cmd}' — stale pty_wrapper.py daemon detected, kill the session and re-bootstrap"
    ;;
  *) fail "pane command is '${pane_cmd}', expected claude (or node)" ;;
esac

# 4-bis. fakechat HTTP liveness probe. The plugin's Bun server serves the chat UI
#    at GET /; a 200 proves (a) plugin loaded, (b) socket bound, (c) can accept
#    POST /upload. -sf is non-zero on any HTTP error AND connect-refused, so one
#    curl covers all failure modes; -m bounds the request including connect.
if ! curl -sf -m "${HTTP_TIMEOUT_SEC}" -o /dev/null "${FAKECHAT_BASE_URL}/" 2>/dev/null; then
  fail "fakechat HTTP server not responding on ${FAKECHAT_BASE_URL}/ — channel plugin not running?"
fi

# 4-ter. PostgreSQL Unix-socket reachability probe. `glass_atrium` lives on the
#    local Unix socket (/tmp), peer auth as $USER. NEVER -h / TCP — listen_addresses
#    is empty by design. PG unreachability is degradation, NOT daemon death: log to
#    stderr, do NOT fail (the daemon still injects; only DB-backed features degrade).
#    `timeout` is not in PATH here, so background the probe + SIGKILL after 5s;
#    SC2009-safe via $! not ps grep.
pg_status="unreachable"
(
  psql -d glass_atrium -tAc 'SELECT 1' >/dev/null 2>&1
) &
pg_pid=$!
(
  sleep 5
  kill -0 "${pg_pid}" 2>/dev/null && kill -9 "${pg_pid}" 2>/dev/null
) &
watchdog_pid=$!
if wait "${pg_pid}" 2>/dev/null; then
  pg_status="ok"
fi
kill -9 "${watchdog_pid}" 2>/dev/null || true
wait "${watchdog_pid}" 2>/dev/null || true
if [[ "${pg_status}" != "ok" ]]; then
  printf '[healthcheck] postgres unreachable via Unix socket\n' >&2
fi

# 5. Cron registration watchdog. /loop is a Skill that rewrites to a CronCreate
#    call and returns to idle — no persistent "/loop" text; the durable evidence
#    is the "Scheduled <8-hex-id>" line from CronCreate. Capture deep scrollback
#    (-S -1500) since the prompt + rewrite + Scheduled line scroll off fast.
#    Failure here → an operator MUST re-run daemon-inject-entry.sh (bootstrap won't
#    retry). Bypassed under --skip-cron-watchdog (pre-inject: injection PRODUCES
#    this terminal state, so asserting it pre-inject is a chicken-and-egg deadlock).
if [[ "${skip_cron_watchdog}" -eq 0 ]]; then
  pane_snapshot="$(tmux capture-pane -t "${SESSION}" -p -S -1500 2>/dev/null || true)"
  if ! printf '%s' "${pane_snapshot}" | grep -qE 'Scheduled [a-f0-9]{8}'; then
    fail "session alive but no cron registered — re-run: bash ~/.glass-atrium/scripts/daemon-inject-entry.sh autoagent"
  fi
  printf 'OK: session=%s claude_pid=%s fakechat=200 cron=registered pg=%s\n' \
    "${SESSION}" "${pane_pid}" "${pg_status}"
else
  printf 'OK: session=%s claude_pid=%s fakechat=200 cron=skipped(pre-inject) pg=%s\n' \
    "${SESSION}" "${pane_pid}" "${pg_status}"
fi
exit 0
