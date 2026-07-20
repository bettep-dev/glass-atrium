#!/usr/bin/env bash
# daemon-inject-entry.sh — inject the entry (/loop) prompt into a daemon claude session
# Usage: bash daemon-inject-entry.sh {autoagent|wiki}
#
# Architecture (fakechat channel): the daemon claude session runs the fakechat
#   channel plugin, a Bun HTTP server on 127.0.0.1:$FAKECHAT_PORT (config.toml
#   [ports].{autoagent,wiki}_fakechat, defaults 8787/8788). Inject = POST multipart
#   form-data (id + text) to /upload → plugin delivers via MCP notification, the
#   transcript shows `← fakechat · web: <text>`. No PTY wrapper or FIFO — pure HTTP.
#   Two-instance split routing (one port per role) supported.
#
# Behavior: (1) resolve session/prompt/port/log from role; (2) delegate healthcheck;
#   (3) idempotent skip (exit 0) if the per-session transcript already shows the
#   canonical `Scheduled recurring job <hex>` from a prior /loop submit; (4) POST
#   prompt to /upload (HTTP 204 = success); (5) verify by polling that transcript
#   2s×75s for `Scheduled recurring job <hex>` (sole registration certifier —
#   CronCreate lands ~55s post-POST), with the `← fakechat · web:` echo / non-zero
#   Usage pane signals demoted to "prompt received" breadcrumbs — fail loud on
#   timeout; (6) log to /tmp/daemon-inject-<role>.log.
#
# Test-mode overrides (non-production): DAEMON_INJECT_PORT / DAEMON_INJECT_SESSION
#   let the isolated PoC harness run without touching the real
#   `claude-{autoagent,wiki}-daemon` sessions or production ports (default to
#   production values when unset).
#
# Exit codes:
#   0 = success (injected OR idempotent skip — both healthy)
#   1 = unrecoverable error (bad role, missing/empty prompt, healthcheck fail, HTTP
#       non-204, verification fail). Bootstrap callers MUST tolerate non-zero.
#   2 = quota wall (verification timeout + pane shows "Limit reached" / "resets Nd Nh").
#       Distinguished from 1 so callers record status='quota_exceeded' in
#       core.daemon_runs (alert suppression), not an actionable infra error.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"

# Verification poll: interval between captures + total budget before failure.
# 75s budget covers CronCreate landing — the canonical "Scheduled recurring job
# <hex>" tool_result lands ~55s post-POST (entry prompt + /loop Skill rewrite +
# cron round-trip), with ~20s margin. Polls every 2s.
readonly VERIFY_POLL_INTERVAL_SEC=2
readonly VERIFY_TIMEOUT_SEC=75

# Canonical CronCreate acceptance pattern. The tool_result reads "Scheduled
# recurring job <8hex> ..." — the hex trails the phrase (not adjacent to
# "Scheduled") and the confirmation wording may be Korean, so match this stable
# ASCII fragment. A transcript match on it is the sole registration certifier.
readonly CRON_REGISTERED_RE='Scheduled recurring job [a-f0-9]{8}'

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

if ! command -v jq >/dev/null 2>&1; then
  fatal "jq not on PATH (required to parse the session state file)"
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

# 4. Healthcheck (pre-inject mode), delegated to the per-role script. Pass
#    --skip-cron-watchdog: /loop injection is what PRODUCES cron registration, so
#    asserting the cron terminal state pre-inject is a chicken-and-egg deadlock
#    (the no-arg system-health-check.sh path still enforces the full watchdog).
#    Test-mode override: DAEMON_INJECT_SESSION set → skip the delegated healthcheck
#    (it hardcodes the production session names); the HTTP liveness probe below
#    substitutes for the tmux/process checks.
if [[ -n "${DAEMON_INJECT_SESSION:-}" ]]; then
  log "skipping delegated healthcheck (test-mode override active)"
else
  if ! "${HEALTHCHECK}" --skip-cron-watchdog >/dev/null 2>&1; then
    fatal "healthcheck failed for session ${SESSION} (pre-inject mode)"
  fi
fi

# 5. HTTP liveness probe — fakechat's Bun server returns 200 on GET / (chat UI).
#    The authoritative "channel plugin running" signal: if curl can't reach it the
#    inject fails regardless of what tmux thinks.
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

# 6. Capture pane — serves ONLY the demoted fallback verify breadcrumbs below
#    (fakechat echo / Usage%). Registration evidence lives in the durable transcript
#    (see resolve_transcript_path); the pane repaints (-S -1500 deep scrollback still
#    drops scrolled-off one-time echoes), so it cannot certify registration.
capture_pane() {
  tmux capture-pane -t "${SESSION}" -p -S -1500 2>/dev/null || true
}

# Durable evidence contract: resolve this session's transcript .jsonl from the live
# pane_pid. CronCreate is session-only/in-memory, so the durable record of a
# registration is the per-session transcript, not the ephemeral pane. Chain:
#   pane_pid -> ~/.claude/sessions/<pane_pid>.json {sessionId, cwd}
#            -> ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl   (slug: '/' '.' -> '-')
# Loud-fail with a DISTINCT path-naming message on any missing link — a silent pane
# fallback would lose the scrolled-off echo this durable read exists to preserve
# (Precondition Loud-Fail Principle). Writes the global TRANSCRIPT_PATH (no command
# substitution) so fatal's exit propagates to the whole script, not just a subshell.
TRANSCRIPT_PATH=""
resolve_transcript_path() {
  local pane_pid session_json session_id cwd cwd_slug
  pane_pid="$(tmux list-panes -t "${SESSION}" -F '#{pane_pid}' 2>/dev/null | head -n 1)"
  if [[ -z "${pane_pid}" ]]; then
    fatal "no pane PID for session ${SESSION} — cannot resolve transcript"
  fi

  session_json="${HOME}/.claude/sessions/${pane_pid}.json"
  if [[ ! -f "${session_json}" ]]; then
    fatal "session state file missing: ${session_json} (pane_pid=${pane_pid})"
  fi

  session_id="$(jq -r '.sessionId // empty' "${session_json}" 2>/dev/null || true)"
  cwd="$(jq -r '.cwd // empty' "${session_json}" 2>/dev/null || true)"
  if [[ -z "${session_id}" || -z "${cwd}" ]]; then
    fatal "session state file lacks sessionId/cwd: ${session_json}"
  fi

  # Harness slug convention: every '/' then every '.' in cwd becomes '-' (bash-3.2
  # parameter expansion, no external tr).
  cwd_slug="${cwd//\//-}"
  cwd_slug="${cwd_slug//./-}"
  TRANSCRIPT_PATH="${HOME}/.claude/projects/${cwd_slug}/${session_id}.jsonl"
  if [[ ! -f "${TRANSCRIPT_PATH}" ]]; then
    fatal "session transcript missing: ${TRANSCRIPT_PATH} (cwd=${cwd} sessionId=${session_id})"
  fi
}

resolve_transcript_path
log "resolved transcript: ${TRANSCRIPT_PATH}"

# 6a. Idempotency guard. The canonical cron line already in the transcript means
#     /loop ran in this session — re-injecting would duplicate the cron entry, so
#     skip + exit 0. Reads the durable transcript so a genuinely-registered session
#     actually skips (HTTP 204 from /upload proves receipt, not registration).
if grep -qE "${CRON_REGISTERED_RE}" "${TRANSCRIPT_PATH}"; then
  log "session already registered (canonical cron line in transcript) — idempotent skip"
  exit 0
fi

# 7. Read prompt content. fakechat forwards the form field verbatim, so embedded
#    backslash/$ characters reach claude unmodified.
prompt_content="$(cat "${PROMPT_FILE}")"

if [[ -z "${prompt_content}" ]]; then
  fatal "prompt content empty after read"
fi

# First ~40 chars (newline-stripped) as a durable verification substring: avoid
# leading whitespace and the "/loop" slash — /loop fires the Skill rewrite which
# can mutate the echoed line.
prompt_echo_marker="$(printf '%s' "${prompt_content}" | tr '\n' ' ' | head -c 40)"

# 8. Submit via HTTP POST. /upload wants multipart form-data: `id` (timestamp-based
#    for traceability) + `text`. -F "text=<-" reads the value from stdin, preserving
#    embedded newlines/special chars without shell-quoting hazards.
#    Why <- (stdin) not @file or inline: @file uploads as a FILE part; inline
#    `-F "text=${prompt_content}"` would exceed argv length limits for large prompts
#    AND trip shell-escaping bugs on $/`/" characters.
#    HTTP 204 = success per server.ts.
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

# 9. Verification. The SOLE registration certifier is the canonical cron line in
#    the durable transcript — CronCreate lands ~55s post-POST, so poll the transcript
#    up to VERIFY_TIMEOUT_SEC for it. The pane `← fakechat · web:` echo and non-zero
#    Usage% branches render at ~+2s (prompt arrival), far ahead of CronCreate, so
#    they attest delivery/processing only and are DEMOTED to fallback breadcrumbs:
#    logged once for timeout diagnosis, never certifying, poll continues. None of the
#    certifier within the timeout → FAIL LOUD: HTTP 204 only proves the plugin
#    RECEIVED, not that cron registered.
verify_now=""
verify_now="$(date +%s)"
verify_deadline=$((verify_now + VERIFY_TIMEOUT_SEC))
verify_passed=0
prompt_received=0
post_snapshot=""
while :; do
  verify_now="$(date +%s)"
  if [[ "${verify_now}" -ge "${verify_deadline}" ]]; then
    break
  fi
  sleep "${VERIFY_POLL_INTERVAL_SEC}"

  # PRIMARY (sole certifier): canonical cron line in the durable transcript.
  if grep -qE "${CRON_REGISTERED_RE}" "${TRANSCRIPT_PATH}"; then
    log "verified: canonical cron line in transcript (cron registered)"
    verify_passed=1
    break
  fi

  # Fallback breadcrumbs — pane-sourced, logged once, never certifying.
  post_snapshot="$(capture_pane)"

  # fakechat render `← fakechat · web: <first chars of text>`: channel marker plus a
  # prompt fragment, avoiding residual lines from a prior session.
  if [[ "${prompt_received}" -eq 0 ]] \
    && printf '%s' "${post_snapshot}" | grep -qF 'fakechat' \
    && printf '%s' "${post_snapshot}" | grep -qF "${prompt_echo_marker}"; then
    prompt_received=1
    log "fallback: fakechat echoed prompt prefix (prompt received, awaiting cron registration)"
  fi

  # Claude Code REPL usage-line "Usage [bar] NN%": any non-"0%" indicator means the
  # REPL is processing (accepts 1%..100%, rejects the 0%-idle baseline).
  if [[ "${prompt_received}" -eq 0 ]] \
    && printf '%s' "${post_snapshot}" | grep -qE 'Usage [^0]+[1-9][0-9]?%'; then
    prompt_received=1
    log "fallback: Usage > 0% (REPL processing, awaiting cron registration)"
  fi
done

if [[ "${verify_passed}" -eq 1 ]]; then
  exit 0
fi

# Verification failed — capture the final pane state to the log for diagnosis.
# No auto-retry: re-running is safe (idempotency guard) but silent retries hide bugs.
log "FAIL: post-send verification timed out after ${VERIFY_TIMEOUT_SEC}s (prompt_received=${prompt_received})"
log "pane tail:"
printf '%s' "${post_snapshot:-(no snapshot captured)}" | tail -n 25 >>"${LOG_FILE}"

# Differentiate quota-wall from other verification timeouts. Quota markers in the
# pane tail ("Limit reached" / "resets Nd Nh") = the daemon awaiting an external
# reset, not an infra error. Exit 2 lets the bootstrap caller write a marker file
# consumed by daemon-daily-restart.sh, which UPSERTs status='quota_exceeded' into
# core.daemon_runs so the alert evaluator suppresses daemon.report_missing.
if printf '%s' "${post_snapshot}" | grep -qiE 'Limit reached|resets [0-9]+d [0-9]+h'; then
  log "FAIL classification: quota wall detected in pane tail — exit 2 (quota)"
  printf 'FATAL: quota wall — verification timeout + Claude Max marker present (see %s)\n' "${LOG_FILE}" >&2
  exit 2
fi

fatal "verification timed out — canonical cron line 'Scheduled recurring job <hex>' never appeared in transcript within ${VERIFY_TIMEOUT_SEC}s (prompt_received=${prompt_received}, transcript=${TRANSCRIPT_PATH})"
