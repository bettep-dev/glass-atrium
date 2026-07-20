#!/usr/bin/env bats
# autoagent-daemon-healthcheck.sh cron-watchdog (step 5) regression suite — pins the
# transcript-based CronCreate detection (replaces the old `tmux capture-pane` scrollback
# grep). Contracts pinned:
# transcript detection: pane_pid → sessions/<pid>.json (sessionId+cwd) →
# projects/<cwd-slug>/<sessionId>.jsonl; the canonical "Scheduled recurring job <8-hex>"
# line in that transcript PASSES the step (cron=registered, exit 0).
# distinct no-cron fail: a transcript WITHOUT the canonical line fails with the specific
# "session alive but no cron registered" operator-remediation message (exit 1), NOT a
# generic error.
# canonical-phrasing pin: the old short form "Scheduled <hex>" (no "recurring job") no
# longer matches — only the full canonical phrase certifies registration.
# LOUD-fail on missing harness paths (NEVER silent-pass): an absent sessions/<pid>.json,
# an absent transcript, or a record missing sessionId/cwd each fails LOUD (exit 1) with a
# distinct "no pane fallback" message — the whole point of the change (no silent fallback
# to the pane grep).
# pre-inject bypass: --skip-cron-watchdog skips step 5 entirely (cron=skipped, exit 0)
# even with no session record — injection PRODUCES the terminal state, so asserting it
# pre-inject is a chicken-and-egg deadlock.
# Hermetic: copy the live script + lib/atrium-config.sh into a sandbox, stub the PATH
# binaries (tmux/curl/psql), point HOME at the sandbox for the harness-internal
# sessions/ + projects/ trees, and use $$ (this live bats PID) as the pane PID so the
# `kill -0 pane_pid` liveness probe passes. No tmux session, PG connection, or live
# transcript is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/scripts/autoagent-daemon-healthcheck.sh"
REAL_CONFIG_LIB="${GA}/scripts/lib/atrium-config.sh"

readonly SESSION="claude-autoagent-daemon"
readonly SESSION_ID="sess-abc123"
readonly SESSION_CWD="/Users/tester/proj.dir"
# cwd → project-dir slug: the harness maps every '/' and '.' to '-' (matches the script).
readonly CWD_SLUG="-Users-tester-proj-dir"
readonly CANONICAL_LINE='{"type":"tool_result","content":"Scheduled recurring job deadbeef — every 1 minute"}'

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "autoagent-daemon-healthcheck.sh not found: ${REAL_SCRIPT}"
  WORK="$(mktemp -d -t daemon-healthcheck-cron-bats.XXXXXX)"
  # $$ = the live bats process PID; the script's `kill -0 pane_pid` needs a real live
  # PID (the tmux stub echoes this back as the pane PID, established across the suite).
  PANE_PID=$$
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Sandboxed copy of the real healthcheck + lib/atrium-config.sh (so SCRIPT_DIR resolves
# the sibling lib), plus stub PATH binaries: tmux reports a live pane running claude,
# curl 200-OKs the fakechat probe, psql exits 0 (pg=ok). jq/sed/grep come from the real
# /usr/bin on PATH. FAKECHAT_PORT resolves to the 8787 default (no config.toml written).
make_healthcheck_sandbox() {
  SANDBOX="${WORK}/scripts"
  STUB_BIN="${WORK}/bin"
  FAKE_HOME="${WORK}/home"
  mkdir -p "${SANDBOX}/lib" "${STUB_BIN}" "${FAKE_HOME}"
  cp "${REAL_SCRIPT}" "${SANDBOX}/autoagent-daemon-healthcheck.sh"
  cp "${REAL_CONFIG_LIB}" "${SANDBOX}/lib/atrium-config.sh"
  chmod +x "${SANDBOX}/autoagent-daemon-healthcheck.sh"

  # tmux: session exists; pane_pid = PANE_PID env; pane_current_command = claude. The two
  # list-panes calls differ only by their -F format, so branch on the format token in $*.
  cat >"${STUB_BIN}/tmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes)
    case "$*" in
      *pane_current_command*) printf '%s\n' "${PANE_CMD:-claude}" ;;
      *pane_pid*) printf '%s\n' "${PANE_PID}" ;;
    esac
    ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${STUB_BIN}/tmux"

  printf '#!/usr/bin/env bash\nexit 0\n' >"${STUB_BIN}/curl"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${STUB_BIN}/psql"
  chmod +x "${STUB_BIN}/curl" "${STUB_BIN}/psql"
}

# Write ${HOME}/.claude/sessions/<PANE_PID>.json. Args: $1=sessionId $2=cwd.
write_session_record() {
  local session_id="$1" cwd="$2"
  mkdir -p "${FAKE_HOME}/.claude/sessions"
  printf '{"sessionId":"%s","cwd":"%s"}\n' "${session_id}" "${cwd}" \
    >"${FAKE_HOME}/.claude/sessions/${PANE_PID}.json"
}

# Write ${HOME}/.claude/projects/<slug>/<sessionId>.jsonl. Args: $1=sessionId $2=slug $3=content.
write_transcript() {
  local session_id="$1" slug="$2" content="$3"
  mkdir -p "${FAKE_HOME}/.claude/projects/${slug}"
  printf '%s\n' "${content}" >"${FAKE_HOME}/.claude/projects/${slug}/${session_id}.jsonl"
}

# Runs the sandboxed healthcheck hermetically. Any extra args pass through to the script.
run_healthcheck() {
  run env PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${FAKE_HOME}" PANE_PID="${PANE_PID}" \
    bash "${SANDBOX}/autoagent-daemon-healthcheck.sh" "$@"
}

@test "cron watchdog: canonical transcript line → step passes, cron=registered, exit 0" {
  make_healthcheck_sandbox
  write_session_record "${SESSION_ID}" "${SESSION_CWD}"
  write_transcript "${SESSION_ID}" "${CWD_SLUG}" "${CANONICAL_LINE}"
  run_healthcheck
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"session=${SESSION}"* ]]
  [[ "${output}" == *"cron=registered"* ]]
}

@test "cron watchdog: transcript without the canonical line → distinct no-cron fail, exit 1" {
  make_healthcheck_sandbox
  write_session_record "${SESSION_ID}" "${SESSION_CWD}"
  write_transcript "${SESSION_ID}" "${CWD_SLUG}" '{"type":"assistant","content":"idle, nothing scheduled"}'
  run_healthcheck
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"session alive but no cron registered"* ]]
  [[ "${output}" == *"daemon-inject-entry.sh autoagent"* ]]
  [[ "${output}" != *"cron=registered"* ]]
}

@test "cron watchdog: old short form 'Scheduled <hex>' no longer matches the canonical phrase" {
  make_healthcheck_sandbox
  write_session_record "${SESSION_ID}" "${SESSION_CWD}"
  # Pre-change phrasing (no "recurring job") must NOT certify registration anymore.
  write_transcript "${SESSION_ID}" "${CWD_SLUG}" '{"type":"tool_result","content":"Scheduled deadbeef"}'
  run_healthcheck
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"session alive but no cron registered"* ]]
}

@test "cron watchdog: missing sessions/<pid>.json → LOUD fail (no pane fallback), exit 1" {
  make_healthcheck_sandbox
  # No session record written; transcript existence is irrelevant — the record gate fires first.
  run_healthcheck
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"cron watchdog: session record"* ]]
  [[ "${output}" == *"absent"* ]]
  [[ "${output}" == *"no pane fallback"* ]]
  [[ "${output}" != *"cron=registered"* ]]
}

@test "cron watchdog: session record present but transcript absent → LOUD fail, exit 1" {
  make_healthcheck_sandbox
  write_session_record "${SESSION_ID}" "${SESSION_CWD}"
  # Deliberately do NOT write the transcript file.
  run_healthcheck
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"cron watchdog: transcript"* ]]
  [[ "${output}" == *"absent"* ]]
  [[ "${output}" == *"no pane fallback"* ]]
  [[ "${output}" != *"cron=registered"* ]]
}

@test "cron watchdog: record missing sessionId/cwd → LOUD fail, exit 1" {
  make_healthcheck_sandbox
  mkdir -p "${FAKE_HOME}/.claude/sessions"
  printf '{"unrelated":"field"}\n' >"${FAKE_HOME}/.claude/sessions/${PANE_PID}.json"
  run_healthcheck
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"missing sessionId/cwd"* ]]
  [[ "${output}" != *"cron=registered"* ]]
}

@test "cron watchdog: --skip-cron-watchdog bypasses step 5 (cron=skipped, exit 0) with no session record" {
  make_healthcheck_sandbox
  # No session record and no transcript — the pre-inject bypass must not touch step 5.
  run_healthcheck --skip-cron-watchdog
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"cron=skipped(pre-inject)"* ]]
  [[ "${output}" != *"cron watchdog"* ]]
}
