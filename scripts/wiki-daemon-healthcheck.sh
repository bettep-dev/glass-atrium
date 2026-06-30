#!/usr/bin/env bash
# wiki-daemon-healthcheck.sh — verify claude-wiki-daemon is alive and responsive
# Exit 0 = healthy (session exists + claude process active in pane + fakechat HTTP server live)
# Exit 1 = unhealthy (any check fails)
# Designed for invocation from system-health-check.sh (09:00 daily integration).
#
# Modes:
#   (no args)           — full steady-state check including cron-registered watchdog (step 5)
#   --skip-cron-watchdog — pre-inject mode: run steps 1-4 only (no cron evidence required)
#
# Architecture (fakechat channel):
#   The pane runs `claude --channels plugin:fakechat@claude-plugins-official`
#   directly. Liveness check is a curl against the channel plugin's HTTP
#   server (127.0.0.1:[ports].wiki_fakechat, default 8788) — that is the
#   authoritative "the daemon can accept inject" signal. There is no
#   wrapper-PID or child-claude-PID check.
#
# Rationale for --skip-cron-watchdog: daemon-inject-entry.sh uses this
# healthcheck as a pre-flight gate BEFORE sending /loop to the REPL.
# Requiring the cron-registered terminal state (step 5) in that pre-flight
# creates a chicken-and-egg deadlock — injection is what produces the cron
# registration. See the "watchdog-as-gate antipattern" entry in learning-log
# for the underlying design principle.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SESSION="claude-wiki-daemon"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"

# fakechat port — [ports].wiki_fakechat (config.toml), default 8788; MUST
# resolve the same value as wiki-daemon-bootstrap.sh (same config key).
FAKECHAT_PORT="$(atrium_config_port '[ports]' 'wiki_fakechat' 8788)" || exit 1
readonly FAKECHAT_PORT
# Use 127.0.0.1 directly instead of localhost. macOS resolves localhost to
# [::1, 127.0.0.1] IPv6-first; Bun binds only 127.0.0.1 (server.ts:
# hostname: '127.0.0.1') so curl gets connect-refused on ::1 and falls through
# via Happy Eyeballs to 127.0.0.1. Under daemon load the IPv6 RST + IPv4 retry
# can eat the 2s -m budget, producing false FAIL during post-restart
# healthcheck. Bootstrap already probes 127.0.0.1 directly
# (wiki-daemon-bootstrap.sh) — this brings healthcheck in line.
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

# 3. Pane PID still alive? pane_pid is the leaf process inside the pane (now
#    claude itself, post-fakechat-pivot — no PTY wrapper in the path).
#    bash-3.2-safe `head -n 1`.
pane_pid="$(tmux list-panes -t "${SESSION}" -F '#{pane_pid}' 2>/dev/null | head -n 1)"
if [[ -z "${pane_pid}" ]]; then
  fail "no pane PID for session '${SESSION}'"
fi

if ! kill -0 "${pane_pid}" 2>/dev/null; then
  fail "pane PID ${pane_pid} not running"
fi

# 4. Pane current command is claude (or its node interpreter on macOS — the
#    claude CLI is a node script, so pane_current_command sometimes reports
#    `node` depending on how the binary is launched). Reject `python3` (the
#    falsified pty_wrapper.py model) loud — that means a stale daemon is
#    still running the old architecture and needs to be respawned.
pane_cmd="$(tmux list-panes -t "${SESSION}" -F '#{pane_current_command}' 2>/dev/null | head -n 1)"
case "${pane_cmd}" in
  claude | claude.exe | node) ;;
  python3 | python3.* | Python | python)
    fail "pane command is '${pane_cmd}' — stale pty_wrapper.py daemon detected, kill the session and re-bootstrap"
    ;;
  *) fail "pane command is '${pane_cmd}', expected claude (or node)" ;;
esac

# 4-bis. fakechat HTTP server liveness probe. The channel plugin's Bun server
#    binds 127.0.0.1:${FAKECHAT_PORT} and serves the chat UI HTML at GET /. A 200 response
#    proves: (a) the plugin loaded, (b) the HTTP socket is bound, (c) the
#    process can accept POST /upload calls. -sf returns non-zero on any HTTP
#    error AND on connect-refused, so a single curl call covers all failure
#    modes. -m bounds the request including connect.
if ! curl -sf -m "${HTTP_TIMEOUT_SEC}" -o /dev/null "${FAKECHAT_BASE_URL}/" 2>/dev/null; then
  fail "fakechat HTTP server not responding on ${FAKECHAT_BASE_URL}/ — channel plugin not running?"
fi

# 4-ter. PostgreSQL Unix-socket reachability probe.
#    `glass_atrium` DB lives on the local Unix socket (/tmp), peer auth as $USER.
#    NEVER use -h / TCP — listen_addresses is empty by design.
#    PG unreachability is degradation, not daemon death — log to stderr but
#    do NOT fail. The daemon can still inject; only DB-backed features
#    (Prisma queries, search-first lookups) silently degrade. Bounding the
#    psql call: `timeout` is not in PATH on this macOS, so we background
#    the probe and SIGKILL after 5s. SC2009-safe via $! rather than ps grep.
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

# 5. Cron registration watchdog. /loop is a Skill that immediately rewrites
#    to a CronCreate Tool call, registers a cron job, and returns to idle —
#    there is NO persistent "/loop" text in the pane. The actual durable
#    evidence is the "Scheduled <8-hex-id>" line emitted by CronCreate. We
#    capture deeper scrollback (-S -1500) because the entry prompt + Skill
#    rewrite + Scheduled line scroll off quickly during normal cycles.
#    Failure here means an operator MUST re-run daemon-inject-entry.sh —
#    bootstrap will not retry.
#    Bypassed under --skip-cron-watchdog (pre-inject gate use — injection is
#    the operation that PRODUCES this terminal state, so asserting it
#    pre-inject creates a chicken-and-egg deadlock).
if [[ "${skip_cron_watchdog}" -eq 0 ]]; then
  pane_snapshot="$(tmux capture-pane -t "${SESSION}" -p -S -1500 2>/dev/null || true)"
  if ! printf '%s' "${pane_snapshot}" | grep -qE 'Scheduled [a-f0-9]{8}'; then
    fail "session alive but no cron registered — re-run: bash ~/.claude/scripts/daemon-inject-entry.sh wiki"
  fi
  printf 'OK: session=%s claude_pid=%s fakechat=200 cron=registered pg=%s\n' \
    "${SESSION}" "${pane_pid}" "${pg_status}"
else
  printf 'OK: session=%s claude_pid=%s fakechat=200 cron=skipped(pre-inject) pg=%s\n' \
    "${SESSION}" "${pane_pid}" "${pg_status}"
fi
exit 0
