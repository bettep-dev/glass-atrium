#!/usr/bin/env bats
# daemon-inject-entry.sh virgin-session regression suite (sibling of
# daemon-healthcheck-cron.bats, same sandbox/stub style). Contracts pinned:
# virgin tolerance: sessions/<pid>.json present but the transcript .jsonl ABSENT
# (pre-first-prompt session) → resolve_transcript_path does NOT fatal; the flow
# proceeds past the idempotency guard to the POST stage (the curl stub 500s the
# POST so the run stops THERE instead of entering the real 75s verify poll — the
# POST fatal message is the "reached POST" proof).
# idempotency guard: a transcript WITH the canonical "Scheduled recurring job <8-hex>"
# line → idempotent skip, exit 0, no POST.
# Hermetic: copy the live script + lib/atrium-config.sh into a sandbox, stub the PATH
# binaries (tmux/curl), point HOME at the sandbox for the harness-internal sessions/ +
# projects/ trees, and use $$ as the pane PID. DAEMON_INJECT_SESSION/-PORT test-mode
# overrides skip the delegated healthcheck and avoid production ports. The script's
# LOG_FILE is a fixed /tmp path, so log assertions grep only the bytes appended by
# THIS run (byte-offset capture before the run).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/scripts/daemon-inject-entry.sh"
REAL_CONFIG_LIB="${GA}/scripts/lib/atrium-config.sh"

readonly SESSION="inject-bats-session"
readonly SESSION_ID="sess-inject123"
readonly SESSION_CWD="/Users/tester/proj.dir"
# cwd → project-dir slug: the harness maps every '/' and '.' to '-' (matches the script).
readonly CWD_SLUG="-Users-tester-proj-dir"
readonly CANONICAL_LINE='{"type":"tool_result","content":"Scheduled recurring job deadbeef — every 1 minute"}'
# Fixed script-side log sink (not overridable without a behavior change the suite
# must not make) — assertions use byte offsets to read only this run's appendix.
readonly INJECT_LOG="/tmp/daemon-inject-autoagent.log"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-inject-entry.sh not found: ${REAL_SCRIPT}"
  WORK="$(mktemp -d -t daemon-inject-entry-bats.XXXXXX)"
  # $$ = the live bats process PID; the tmux stub echoes this back as the pane PID.
  PANE_PID=$$
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Sandboxed copy of the real inject script + lib/atrium-config.sh (so SCRIPT_DIR
# resolves the sibling lib), plus the pre-flight-required role siblings (entry prompt +
# an executable healthcheck stub — never invoked: DAEMON_INJECT_SESSION test-mode skips
# the delegated call). Stub PATH binaries: tmux reports the pane PID, curl 200-OKs the
# liveness GET and 500s the POST. jq/grep/head come from the real /usr/bin on PATH.
make_inject_sandbox() {
  SANDBOX="${WORK}/scripts"
  STUB_BIN="${WORK}/bin"
  FAKE_HOME="${WORK}/home"
  mkdir -p "${SANDBOX}/lib" "${STUB_BIN}" "${FAKE_HOME}"
  cp "${REAL_SCRIPT}" "${SANDBOX}/daemon-inject-entry.sh"
  cp "${REAL_CONFIG_LIB}" "${SANDBOX}/lib/atrium-config.sh"
  chmod +x "${SANDBOX}/daemon-inject-entry.sh"

  printf 'entry prompt content for the inject bats sandbox\n' \
    >"${SANDBOX}/autoagent-daemon-entry-prompt.md"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${SANDBOX}/autoagent-daemon-healthcheck.sh"
  chmod +x "${SANDBOX}/autoagent-daemon-healthcheck.sh"

  # tmux: list-panes echoes the pane PID; capture-pane (verify-loop breadcrumbs)
  # returns nothing. Branch on the -F format token in $*, matching the sibling suite.
  cat >"${STUB_BIN}/tmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  list-panes)
    case "$*" in
      *pane_pid*) printf '%s\n' "${PANE_PID}" ;;
    esac
    ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${STUB_BIN}/tmux"

  # curl: the script only reads -w '%{http_code}' output. Liveness GET → 200;
  # POST /upload → 500 so a run that REACHES the POST stage fatals right there
  # (distinct message) instead of entering the real 75s verify poll.
  cat >"${STUB_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *POST*)
    cat >/dev/null 2>&1 || true
    printf '500'
    ;;
  *) printf '200' ;;
esac
STUB
  chmod +x "${STUB_BIN}/curl"
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

# Byte size of the fixed /tmp inject log BEFORE the run (0 when absent) — lets
# assertions read only this run's appended lines.
inject_log_offset() {
  wc -c <"${INJECT_LOG}" 2>/dev/null || printf '0'
}

# Lines the run under test appended to the fixed /tmp inject log. Arg: $1=pre-run offset.
inject_log_appendix() {
  tail -c "+$(($1 + 1))" "${INJECT_LOG}" 2>/dev/null || true
}

# Runs the sandboxed inject script hermetically (test-mode session/port overrides).
run_inject() {
  run env PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${FAKE_HOME}" PANE_PID="${PANE_PID}" \
    DAEMON_INJECT_SESSION="${SESSION}" DAEMON_INJECT_PORT=18787 \
    bash "${SANDBOX}/daemon-inject-entry.sh" autoagent
}

@test "inject: session record present + transcript ABSENT → no fatal, virgin path reaches POST stage" {
  make_inject_sandbox
  write_session_record "${SESSION_ID}" "${SESSION_CWD}"
  # Deliberately NO transcript — virgin (pre-first-prompt) session.
  local offset
  offset="$(inject_log_offset)"
  run_inject
  # The POST-stage fatal (stubbed HTTP 500) is the "reached POST" proof — the old
  # resolve-stage "session transcript missing" fatal must NOT fire.
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"returned HTTP 500"* ]]
  [[ "${output}" != *"session transcript missing"* ]]
  inject_log_appendix "${offset}" | grep -qF "virgin session: transcript not yet created"
}

@test "inject: transcript present WITH canonical cron line → idempotent skip, exit 0, no POST" {
  make_inject_sandbox
  write_session_record "${SESSION_ID}" "${SESSION_CWD}"
  write_transcript "${SESSION_ID}" "${CWD_SLUG}" "${CANONICAL_LINE}"
  local offset
  offset="$(inject_log_offset)"
  run_inject
  [[ "${status}" -eq 0 ]]
  local appendix
  appendix="$(inject_log_appendix "${offset}")"
  grep -qF "idempotent skip" <<<"${appendix}"
  ! grep -qF "POST http" <<<"${appendix}"
}
