#!/usr/bin/env bash
# wiki-daemon-healthcheck.sh — verify claude-wiki-daemon is alive and responsive.
# Exit 0 = healthy (session + claude process in pane + fakechat HTTP server live) · Exit 1 = any check fails.
# Invoked from system-health-check.sh (09:00 daily integration).
#
# Modes:
#   (no args)           — full steady-state check including cron-registered watchdog (step 5)
#   --skip-cron-watchdog — pre-inject mode: steps 1-4 only (no cron evidence required)
#
# Architecture (fakechat channel): the pane runs
# `claude --channels plugin:fakechat@claude-plugins-official` directly; liveness = a curl
# against the plugin's HTTP server (127.0.0.1:[ports].wiki_fakechat, default 8788) — the
# authoritative "can accept inject" signal. No wrapper-PID / child-claude-PID check.
#
# --skip-cron-watchdog: daemon-inject-entry.sh uses this as a pre-flight gate BEFORE
# sending /loop; requiring step-5's cron terminal state pre-inject is a chicken-and-egg
# deadlock — injection is what produces the cron registration.
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
# Use 127.0.0.1 directly, not localhost: macOS resolves localhost IPv6-first
# ([::1, 127.0.0.1]) but Bun binds only 127.0.0.1, so ::1 gets connect-refused
# and Happy-Eyeballs falls through. Under load that IPv6-RST + IPv4-retry can
# eat the 2s -m budget → false FAIL. Matches wiki-daemon-bootstrap.sh.
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

# 3. Pane PID still alive? pane_pid = the leaf process in the pane (now claude
#    itself, post-fakechat-pivot, no PTY wrapper). bash-3.2-safe `head -n 1`.
pane_pid="$(tmux list-panes -t "${SESSION}" -F '#{pane_pid}' 2>/dev/null | head -n 1)"
if [[ -z "${pane_pid}" ]]; then
  fail "no pane PID for session '${SESSION}'"
fi

if ! kill -0 "${pane_pid}" 2>/dev/null; then
  fail "pane PID ${pane_pid} not running"
fi

# 4. Pane command is claude (or node — the claude CLI is a node script, so
#    pane_current_command sometimes reports `node`). Reject `python3` (the
#    falsified pty_wrapper.py model) loud = a stale daemon on the old
#    architecture that must be respawned.
pane_cmd="$(tmux list-panes -t "${SESSION}" -F '#{pane_current_command}' 2>/dev/null | head -n 1)"
case "${pane_cmd}" in
  claude | claude.exe | node) ;;
  python3 | python3.* | Python | python)
    fail "pane command is '${pane_cmd}' — stale pty_wrapper.py daemon detected, kill the session and re-bootstrap"
    ;;
  *) fail "pane command is '${pane_cmd}', expected claude (or node)" ;;
esac

# 4-bis. fakechat HTTP server liveness probe. The Bun server binds
#    127.0.0.1:${FAKECHAT_PORT} and serves the chat UI at GET /. A 200 proves plugin
#    loaded + socket bound + can accept POST /upload. -sf returns non-zero on any
#    HTTP error AND on connect-refused → one curl covers all modes; -m bounds connect.
if ! curl -sf -m "${HTTP_TIMEOUT_SEC}" -o /dev/null "${FAKECHAT_BASE_URL}/" 2>/dev/null; then
  fail "fakechat HTTP server not responding on ${FAKECHAT_BASE_URL}/ — channel plugin not running?"
fi

# 4-ter. PostgreSQL Unix-socket reachability probe. `glass_atrium` DB is on the
#    local Unix socket (/tmp), peer auth as $USER. NEVER -h / TCP —
#    listen_addresses is empty by design. PG-unreachable = degradation, not death:
#    log but do NOT fail (daemon still injects; only DB-backed features degrade).
#    No `timeout` binary on this macOS → background the probe + SIGKILL after 5s;
#    SC2009-safe via $! rather than ps grep.
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
#    Tool call, registers a cron job, returns to idle — NO persistent "/loop"
#    text. Durable evidence = the canonical "Scheduled recurring job <8-hex>"
#    tool_result. The tmux pane repaints and scrolls that one-time echo off-screen,
#    so read the persistent per-session transcript instead: pane_pid →
#    sessions/<pid>.json (sessionId+cwd) → projects/<cwd-slug>/<sessionId>.jsonl.
#    Any missing harness-internal path fails LOUD with a distinct message — NEVER a
#    silent fallback to the pane grep.
#    Failure → an operator MUST re-run daemon-inject-entry.sh (bootstrap won't
#    retry). Bypassed under --skip-cron-watchdog (injection PRODUCES this terminal
#    state, so asserting it pre-inject is a chicken-and-egg deadlock).
if [[ "${skip_cron_watchdog}" -eq 0 ]]; then
  session_record="${HOME}/.claude/sessions/${pane_pid}.json"
  if [[ ! -f "${session_record}" ]]; then
    fail "cron watchdog: session record '${session_record}' absent — cannot resolve transcript (no pane fallback)"
  fi
  if ! command -v jq >/dev/null 2>&1; then
    fail "cron watchdog: jq not on PATH — required to parse '${session_record}'"
  fi
  session_fields="$(jq -r '[.sessionId, .cwd] | @tsv' "${session_record}" 2>/dev/null || true)"
  IFS=$'\t' read -r session_id session_cwd <<<"${session_fields}"
  if [[ -z "${session_id}" || -z "${session_cwd}" ]]; then
    fail "cron watchdog: '${session_record}' missing sessionId/cwd — cannot resolve transcript"
  fi
  # cwd → project-dir slug: the harness maps every '/' and '.' to '-'.
  cwd_slug="$(printf '%s' "${session_cwd}" | sed 's#[/.]#-#g')"
  transcript="${HOME}/.claude/projects/${cwd_slug}/${session_id}.jsonl"
  if [[ ! -f "${transcript}" ]]; then
    fail "cron watchdog: transcript '${transcript}' absent — cannot verify cron registration (no pane fallback)"
  fi
  # Canonical CronCreate line, model-phrasing-independent (immune to Korean wording).
  if ! grep -qE 'Scheduled recurring job [a-f0-9]{8}' "${transcript}"; then
    fail "session alive but no cron registered — re-run: bash ~/.glass-atrium/scripts/daemon-inject-entry.sh wiki"
  fi
  printf 'OK: session=%s claude_pid=%s fakechat=200 cron=registered pg=%s\n' \
    "${SESSION}" "${pane_pid}" "${pg_status}"
else
  printf 'OK: session=%s claude_pid=%s fakechat=200 cron=skipped(pre-inject) pg=%s\n' \
    "${SESSION}" "${pane_pid}" "${pg_status}"
fi
exit 0
