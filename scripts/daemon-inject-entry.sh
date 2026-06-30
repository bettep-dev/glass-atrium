#!/usr/bin/env bash
# daemon-inject-entry.sh — inject the entry (/loop) prompt into a daemon claude session
# Usage: bash daemon-inject-entry.sh {autoagent|wiki}
#
# Architecture (fakechat channel):
#   The daemon claude session runs with the fakechat channel plugin, which
#   exposes a Bun HTTP server on 127.0.0.1:$FAKECHAT_PORT — config.toml
#   [ports].autoagent_fakechat / [ports].wiki_fakechat (defaults 8787 /
#   8788). To inject a prompt we POST multipart form-data (id + text)
#   to /upload. The plugin delivers the text to the claude session via an
#   MCP notification, and the transcript shows `← fakechat · web: <text>`.
#   There is no PTY wrapper or FIFO in the path — pure HTTP. Two-instance
#   split routing (one port per role) is supported.
#
# Behavior:
#   1. Validate role argument and resolve session/prompt-file/port/log paths.
#   2. Healthcheck the target session (delegate to existing *-daemon-healthcheck.sh).
#   3. Idempotency: if HTTP server is up AND tmux capture-pane already shows
#      `Scheduled <8-hex>` cron-registration line (from a prior /loop submit),
#      skip with exit 0.
#   4. POST the prompt to /upload via curl. HTTP 204 = success, anything else
#      = failure. No tmux send-keys, no FIFO writes — pure HTTP.
#   5. Verification: poll tmux capture-pane every 2s up to 30s for either
#      "Scheduled <hex>" cron-registration or `← fakechat · web:` echo of the
#      first 40 chars of the entry prompt + non-zero Usage. Fail loud on timeout.
#   6. Log everything to /tmp/daemon-inject-<role>.log.
#
# Test-mode env-var overrides (non-production paths only):
#   DAEMON_INJECT_PORT     — override the resolved fakechat port
#   DAEMON_INJECT_SESSION  — override the resolved tmux session name
#   These let the isolated PoC harness exercise this script without touching
#   the real `claude-{autoagent,wiki}-daemon` sessions or production fakechat
#   ports. Both default to the production values when unset.
#
# Exit codes:
#   0 = success (injected OR idempotent skip — both are healthy outcomes)
#   1 = unrecoverable error (bad role, missing prompt file, healthcheck fail,
#       HTTP non-204, verification fail). Bootstrap callers MUST tolerate
#       non-zero (best-effort).
#   2 = quota wall (verification timed out AND pane tail shows Claude Max
#       quota markers like "Limit reached" or "resets Nd Nh").
#       Distinguishes quota-driven failures from other (1) so callers can
#       record status='quota_exceeded' in core.daemon_runs (alert suppression)
#       instead of treating it as an actionable infra error.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"

# Verification poll: how long to wait between captures and how long total
# before declaring failure. 30s upper bound = entry prompt + /loop Skill
# rewrite + cron registration round-trip. Polls every 2s.
readonly VERIFY_POLL_INTERVAL_SEC=2
readonly VERIFY_TIMEOUT_SEC=30

# HTTP request timeout — the fakechat /upload handler is synchronous (writes
# the file then broadcasts the MCP notification before returning 204), so a
# 5s budget is generous for localhost.
readonly HTTP_TIMEOUT_SEC=5

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

# 2. Resolve session + port via ROLE→PORT mapping table. The port resolves
#    from config.toml ([ports].{autoagent,wiki}_fakechat) with the stock value
#    as fallback — same key the bootstrap/healthcheck siblings read. Test
#    harnesses can override either value with DAEMON_INJECT_SESSION /
#    DAEMON_INJECT_PORT without modifying production defaults.
case "${ROLE}" in
  autoagent)
    role_session_default="claude-autoagent-daemon"
    role_port_key="autoagent_fakechat"
    role_port_fallback=8787
    ;;
  wiki)
    role_session_default="claude-wiki-daemon"
    role_port_key="wiki_fakechat"
    role_port_fallback=8788
    ;;
  *)
    # Defensive: validation above already restricts ROLE to autoagent|wiki,
    # but ShellCheck SC2249 wants every case statement to have a default.
    printf 'FATAL: unknown role %q (validation bug)\n' "${ROLE}" >&2
    exit 1
    ;;
esac

role_port_default="$(atrium_config_port '[ports]' "${role_port_key}" "${role_port_fallback}")" || exit 1

SESSION="${DAEMON_INJECT_SESSION:-${role_session_default}}"
PORT="${DAEMON_INJECT_PORT:-${role_port_default}}"
readonly SESSION
readonly PORT

readonly PROMPT_FILE="${SCRIPT_DIR}/${ROLE}-daemon-entry-prompt.md"
readonly HEALTHCHECK="${SCRIPT_DIR}/${ROLE}-daemon-healthcheck.sh"
readonly LOG_FILE="/tmp/daemon-inject-${ROLE}.log"
# Use 127.0.0.1 directly. Same rationale as autoagent-daemon-healthcheck.sh —
# Bun binds 127.0.0.1 only, localhost resolves IPv6-first on macOS, curl
# Happy-Eyeballs fallback eats timeout budget under load. Bootstrap already
# uses 127.0.0.1 (autoagent-daemon-bootstrap.sh, wiki-daemon-bootstrap.sh);
# this brings inject in line for cross-script consistency.
readonly FAKECHAT_BASE_URL="http://127.0.0.1:${PORT}"
readonly UPLOAD_URL="${FAKECHAT_BASE_URL}/upload"

log() {
  # ISO 8601 UTC, matches sibling *-daemon-bootstrap.sh format for cross-grep.
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] [daemon-inject-%s] %s\n' "${ts}" "${ROLE}" "$*" >>"${LOG_FILE}"
}

trap 'log "ERROR: line ${LINENO}: ${BASH_COMMAND}"' ERR

# Convenience: also surface fatal errors to stderr for direct CLI invocation.
fatal() {
  log "FATAL: $*"
  printf 'FATAL: %s (see %s)\n' "$*" "${LOG_FILE}" >&2
  exit 1
}

# 3. Pre-flight checks.
if ! command -v tmux >/dev/null 2>&1; then
  fatal "tmux not on PATH"
fi

if ! command -v curl >/dev/null 2>&1; then
  fatal "curl not on PATH"
fi

if [[ ! -f "${PROMPT_FILE}" ]]; then
  fatal "entry prompt file missing: ${PROMPT_FILE}"
fi

if [[ ! -s "${PROMPT_FILE}" ]]; then
  fatal "entry prompt file is empty: ${PROMPT_FILE}"
fi

if [[ ! -x "${HEALTHCHECK}" ]]; then
  fatal "healthcheck not executable: ${HEALTHCHECK}"
fi

log "starting injection for session=${SESSION} port=${PORT}"

# 4. Healthcheck (pre-inject mode). Delegate to existing per-role script
#    (single source of truth for "is this daemon alive"). We pass
#    --skip-cron-watchdog because /loop injection is the very operation that
#    produces the cron registration — asserting the cron terminal state
#    BEFORE injection creates an unrecoverable chicken-and-egg deadlock.
#    Default (no-arg) invocation from system-health-check.sh still enforces
#    the full cron watchdog. Suppress stdout/stderr — we only need the exit
#    code; details land in the healthcheck's own log on failure.
#
#    Test-mode override: when DAEMON_INJECT_SESSION is set we skip the
#    delegated healthcheck because production healthchecks hardcode the
#    `claude-{autoagent,wiki}-daemon` session names. The HTTP liveness probe
#    immediately below substitutes for the tmux/process checks.
if [[ -n "${DAEMON_INJECT_SESSION:-}" ]]; then
  log "skipping delegated healthcheck (test-mode override active)"
else
  if ! "${HEALTHCHECK}" --skip-cron-watchdog >/dev/null 2>&1; then
    fatal "healthcheck failed for session ${SESSION} (pre-inject mode)"
  fi
fi

# 5. HTTP liveness probe — the fakechat plugin's Bun server returns 200 on
#    GET / (the chat UI HTML). This is the authoritative "is the channel
#    plugin running" signal; if curl can't reach it the inject will fail
#    regardless of whether tmux thinks the session is alive.
http_get_status() {
  curl -s -o /dev/null -w '%{http_code}' \
    -m "${HTTP_TIMEOUT_SEC}" \
    "${FAKECHAT_BASE_URL}/" 2>/dev/null || true
}

liveness_status="$(http_get_status)"
if [[ "${liveness_status}" != "200" ]]; then
  fatal "fakechat HTTP server not responding on ${FAKECHAT_BASE_URL}/ (got '${liveness_status}', expected 200) — channel plugin not started yet?"
fi
log "fakechat HTTP server is live on ${FAKECHAT_BASE_URL} (200 OK)"

# 6. Capture current pane state for idempotency check. -p prints to stdout,
#    -S -1500 includes deep scrollback so the "Scheduled <hex>" line emitted
#    by /loop's CronCreate Tool call (which scrolls off quickly) remains
#    visible.
capture_pane() {
  tmux capture-pane -t "${SESSION}" -p -S -1500 2>/dev/null || true
}

pane_snapshot="$(capture_pane)"

# 6a. Idempotency guard. If the scrollback already shows a `Scheduled <8-hex>`
#     cron-registration line, the entry prompt's /loop directive has already
#     been processed in this session — re-injecting would just create a
#     duplicate cron entry. Skip and exit 0 (healthy outcome).
#
#     With the fakechat model there is no "input box residue" failure mode, so
#     the single Scheduled-line check suffices (no input-box second condition).
#     HTTP 204 from /upload is durable evidence the message reached claude.
if printf '%s' "${pane_snapshot}" | grep -qE 'Scheduled [a-f0-9]{8}'; then
  log "session already has Scheduled <hex> in scrollback — idempotent skip"
  exit 0
fi

# 7. Read prompt file content. The fakechat plugin forwards the form-field
#    text verbatim so embedded backslashes/$ characters arrive at claude
#    unmodified.
prompt_content="$(cat "${PROMPT_FILE}")"

if [[ -z "${prompt_content}" ]]; then
  fatal "prompt content empty after read"
fi

# Compute the first ~40 chars (newline-stripped) for verification grep below.
# We need a substring that is durable in the transcript — avoid leading
# whitespace and the literal slash of "/loop" because grep -F still treats it
# verbatim but /loop fires the Skill rewrite which can mutate the echoed line.
prompt_echo_marker="$(printf '%s' "${prompt_content}" | tr '\n' ' ' | head -c 40)"

# 8. Submit the prompt via HTTP POST. The fakechat /upload endpoint requires
#    multipart form-data with two fields: `id` (string) and `text` (string).
#    We use a timestamp-based id so each submit is uniquely traceable. curl
#    -F "name=value" emits multipart form-data; -F "name=<-" reads the value
#    from stdin which preserves embedded newlines/special chars without
#    shell-quoting hazards.
#
#    Why -F text=<- (stdin) vs -F text=@file: @file uploads as a FILE part
#    (Content-Disposition: filename=...) which the server's `String(form.get(
#    'text'))` would still coerce to the string contents, but stdin form is
#    cleaner and avoids creating temp files. Using <text> directly via
#    `-F "text=${prompt_content}"` would exceed argv length limits for large
#    prompts and triggers shell escaping bugs on $/`/" characters.
#
#    HTTP 204 = success per server.ts (`return new Response(null, { status: 204 })`).
inject_id="daemon-inject-${ROLE}-$(date +%s)"
prompt_bytes="$(printf '%s' "${prompt_content}" | wc -c | tr -d ' ' || true)"
log "POST ${UPLOAD_URL} id=${inject_id} text=${prompt_bytes}bytes"

# Capture HTTP status code; route response body to /dev/null because we only
# care about the status. -m bounds the entire request including connect.
http_status="$(printf '%s' "${prompt_content}" \
  | curl -s -o /dev/null -w '%{http_code}' \
    -m "${HTTP_TIMEOUT_SEC}" \
    -X POST "${UPLOAD_URL}" \
    -F "id=${inject_id}" \
    -F "text=<-" \
    2>/dev/null || true)"

if [[ "${http_status}" != "204" ]]; then
  fatal "POST ${UPLOAD_URL} returned HTTP ${http_status} (expected 204)"
fi
log "POST succeeded (HTTP 204)"

# 9. Verification. Poll the pane every VERIFY_POLL_INTERVAL_SEC seconds up to
#    VERIFY_TIMEOUT_SEC seconds total. Look for any of:
#      (a) "Scheduled <8-hex>" — the CronCreate confirmation line emitted by
#          /loop. PASS signal #1, the strongest evidence.
#      (b) "← fakechat · web:" + first 40 chars of the prompt — proves the
#          MCP notification was delivered to the session and the transcript
#          rendered the message. PASS signal #2, useful for prompts that
#          do not start with /loop.
#      (c) Usage counter showing a non-zero percentage — proves claude
#          consumed tokens responding to the prompt. PASS signal #3.
#    If none appears within the timeout, FAIL LOUD: the HTTP 204 only proves
#    the plugin received the message; it does NOT prove claude consumed it.
verify_now=""
verify_now="$(date +%s)"
verify_deadline=$((verify_now + VERIFY_TIMEOUT_SEC))
verify_passed=0
post_snapshot=""
while :; do
  verify_now="$(date +%s)"
  if [[ "${verify_now}" -ge "${verify_deadline}" ]]; then
    break
  fi
  sleep "${VERIFY_POLL_INTERVAL_SEC}"
  post_snapshot="$(capture_pane)"

  if printf '%s' "${post_snapshot}" | grep -qE 'Scheduled [a-f0-9]{8}'; then
    log "verified: Scheduled <hex> appeared in pane (cron registered)"
    verify_passed=1
    break
  fi

  # fakechat transcript render: `← fakechat · web: <first chars of text>`.
  # We grep for the literal channel marker plus a fragment of the prompt to
  # avoid matching residual lines from a prior session.
  if printf '%s' "${post_snapshot}" | grep -qF 'fakechat'; then
    if printf '%s' "${post_snapshot}" | grep -qF "${prompt_echo_marker}"; then
      log "verified: fakechat transcript echoed prompt prefix (${prompt_echo_marker})"
      verify_passed=1
      break
    fi
  fi

  # Claude Code REPL usage-line format: "Usage [bar] NN%" or
  # "Usage ⚠ Limit reached". A non-zero NN% (or any non-"0%" indicator) shows
  # the REPL is processing. We accept ANY digit followed by '%' that is NOT
  # exactly "0%" — accommodates both 1% and 100% and avoids false-positive
  # on the 0%-idle baseline.
  if printf '%s' "${post_snapshot}" | grep -qE 'Usage [^0]+[1-9][0-9]?%'; then
    log "verified: Usage > 0% — REPL is processing the prompt"
    verify_passed=1
    break
  fi
done

if [[ "${verify_passed}" -eq 1 ]]; then
  exit 0
fi

# Verification failed — capture the final pane state into the log so an
# operator can diagnose without re-running. Don't auto-retry: re-running the
# script is safe (idempotency guard handles it), but silent retries hide bugs.
log "FAIL: post-send verification timed out after ${VERIFY_TIMEOUT_SEC}s"
log "pane tail:"
printf '%s' "${post_snapshot:-(no snapshot captured)}" | tail -n 25 >>"${LOG_FILE}"

# Differentiate quota-wall failures from other verification-timeout failures.
# When the pane tail contains Claude Max quota markers ("Limit reached" /
# "resets Nd Nh"), the daemon is waiting for an external reset window — not an
# actionable infra error. Exit 2 lets the bootstrap caller emit a marker file
# consumed by daemon-daily-restart.sh, which UPSERTs status='quota_exceeded'
# into core.daemon_runs so the alert evaluator (daemon-missing.ts whitelist)
# suppresses daemon.report_missing false positives.
# ERE alternation: case-insensitive match against the two canonical patterns.
if printf '%s' "${post_snapshot}" | grep -qiE 'Limit reached|resets [0-9]+d [0-9]+h'; then
  log "FAIL classification: quota wall detected in pane tail — exit 2 (quota)"
  printf 'FATAL: quota wall — verification timeout + Claude Max marker present (see %s)\n' "${LOG_FILE}" >&2
  exit 2
fi

fatal "verification timed out — none of (Scheduled <hex>, fakechat echo, Usage > 0%) appeared"
