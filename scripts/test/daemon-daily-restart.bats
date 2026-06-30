#!/usr/bin/env bats
# daemon-daily-restart.sh regression suite — pins:
#   * pg_write_run        — daemon_name is role-qualified (daily-restart-<role>)
#     so the two roles do not collide on the (run_date, daemon_name) UPSERT key.
#   * quota_reset_passed  — a pane without a "resets …" footer must NOT fire the
#     inherited ERR trap (pipefail + grep no-match inside the command
#     substitution); the WARN fallback + proceed (rc 0) is the only signal.
#   * supervision-death family (DR-1) — kill-after-verify (missing/dangling
#     claude aborts BEFORE kill-session), bootstrap retry with backoff instead
#     of terminal teardown, and the restart-window symlink lock (single-flight
#     across kill→recreate, exit 7 on a live concurrent holder).
#   * pre-restart quota gate (caller) — the parse-failure fallback proceeds but
#     must log "quota status unknown", never assert the reset time passed as
#     fact (the gate's WARN line is the primary signal).
#
# Run via: bats scripts/test/daemon-daily-restart.bats
# Requires: bats >= 1.5.0 (brew install bats-core), bash 3.2+, python3
#
# Hermetic strategy: unit tests awk-extract one function from the real script
# into a sourceable shim; full-flow tests copy the script + lib/daemon-lock.sh
# + lib/atrium-config.sh
# into a sandbox with stub siblings (healthcheck/bootstrap) and stub PATH
# binaries (tmux/launchctl/timeout/claude), role=wiki so the real autoagent
# quota marker in /tmp is never touched, and HOME/LOG_FILE/DAEMON_LOCK_DIR all
# point into the sandbox. No tmux session, PG connection, launchd job, or live
# log is touched.

bats_require_minimum_version 1.5.0

REAL_SCRIPT="${HOME}/.glass-atrium/scripts/daemon-daily-restart.sh"
REAL_LOCK_LIB="${HOME}/.glass-atrium/scripts/lib/daemon-lock.sh"
REAL_CONFIG_LIB="${HOME}/.glass-atrium/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-daily-restart.sh not found: ${REAL_SCRIPT}"
  WORK="$(mktemp -d -t daemon-restart-bats.XXXXXX)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# Extract one top-level function (start pattern → first column-0 brace) into a
# sourceable shim file.
extract_fn() {
  local fn_name="$1" shim="$2"
  awk -v fn="${fn_name}" '
    $0 == fn "() {" { capture = 1 }
    capture { print }
    capture && /^\}/ { exit }
  ' "${REAL_SCRIPT}" >"${shim}"
  [[ -s "${shim}" ]] || skip "function extraction yielded an empty shim: ${fn_name}"
}

# ---------------------------------------------------------------------------
# pg_write_run — role-qualified daemon_name in the PG envelope
# ---------------------------------------------------------------------------

# Stub helper echoing the envelope back; pg_write_run pipes helper output into
# LOG_FILE, so the envelope lands there for assertion.
make_pg_helper_stub() {
  PG_HELPER="${WORK}/_pg_dual_write_daemon.py"
  cat >"${PG_HELPER}" <<'PY'
#!/usr/bin/env python3
import sys
sys.stdout.write(sys.stdin.read())
PY
  chmod +x "${PG_HELPER}"
}

# Globals pg_write_run reads (dynamic source — export marks them as used).
set_pg_globals() {
  export ROLE="$1"
  export RUN_DATE="2026-06-10"
  export STARTED_AT="2026-06-10T00:00:00Z"
  export LOG_FILE="${WORK}/run.log"
}

@test "pg_write_run: autoagent role writes daemon_name=daily-restart-autoagent" {
  extract_fn pg_write_run "${WORK}/pg_write_run.sh"
  make_pg_helper_stub
  set_pg_globals autoagent
  # shellcheck source=/dev/null
  source "${WORK}/pg_write_run.sh"
  pg_write_run "ok" "2026-06-10T00:01:00Z"
  grep -qF '"daemon_name":"daily-restart-autoagent"' "${LOG_FILE}"
}

@test "pg_write_run: wiki role + notes branch writes daemon_name=daily-restart-wiki" {
  extract_fn pg_write_run "${WORK}/pg_write_run.sh"
  make_pg_helper_stub
  set_pg_globals wiki
  # shellcheck source=/dev/null
  source "${WORK}/pg_write_run.sh"
  pg_write_run "quota_exceeded" "2026-06-10T00:01:00Z" "pre-restart quota gate"
  grep -qF '"daemon_name":"daily-restart-wiki"' "${LOG_FILE}"
  grep -qF '"notes":"pre-restart quota gate"' "${LOG_FILE}"
}

@test "pg_write_run: unqualified daily-restart name no longer emitted" {
  extract_fn pg_write_run "${WORK}/pg_write_run.sh"
  make_pg_helper_stub
  set_pg_globals autoagent
  # shellcheck source=/dev/null
  source "${WORK}/pg_write_run.sh"
  pg_write_run "error" "2026-06-10T00:01:00Z" "fatal: boom"
  run ! grep -qF '"daemon_name":"daily-restart"' "${LOG_FILE}"
}

# ---------------------------------------------------------------------------
# quota_reset_passed — no spurious ERR-trap fire on a footer-less quota pane
# ---------------------------------------------------------------------------

# Harness reproducing the real script's runtime: strict mode + the same ERR
# trap, tmux mocked to replay a pane fixture. Run as a separate bash process
# (not inside bats) so trap/pipefail semantics match production exactly.
make_quota_harness() {
  extract_fn quota_reset_passed "${WORK}/quota_reset_passed.sh"
  cat >"${WORK}/harness.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
LOG_FILE="$1"
PANE_FIXTURE="$2"
SHIM="$3"
log() { printf '%s\n' "$*" >>"${LOG_FILE}"; }
trap 'log "ERROR: line ${LINENO}: ${BASH_COMMAND}"' ERR
tmux() { cat "${PANE_FIXTURE}"; }
# shellcheck source=/dev/null
source "${SHIM}"
if quota_reset_passed test-session; then
  printf 'PROCEED\n'
else
  printf 'SKIP\n'
fi
SH
}

@test "quota_reset_passed: footer-less quota pane proceeds with WARN, no ERR-trap noise" {
  make_quota_harness
  printf 'Limit reached for today\nsome unrelated REPL output\n' >"${WORK}/pane.txt"
  run bash "${WORK}/harness.sh" "${WORK}/quota.log" "${WORK}/pane.txt" "${WORK}/quota_reset_passed.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "PROCEED" ]]
  grep -qF 'WARN: quota reset timestamp parse failed (no match)' "${WORK}/quota.log"
  run ! grep -qF 'ERROR: line' "${WORK}/quota.log"
}

@test "quota_reset_passed: future resets footer still matches and skips (guard kept the match path)" {
  [[ "$(uname -s)" == "Darwin" ]] || skip "BSD date -j required"
  make_quota_harness
  # Tomorrow 11pm KST is always in the future relative to now.
  local month day
  month="$(TZ='Asia/Seoul' date -v+1d +%B)"
  day="$(TZ='Asia/Seoul' date -v+1d +%d)"
  printf 'Limit reached\nresets %s %s at 11pm (Asia/Seoul)\n' "${month}" "${day}" >"${WORK}/pane.txt"
  run bash "${WORK}/harness.sh" "${WORK}/quota.log" "${WORK}/pane.txt" "${WORK}/quota_reset_passed.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "SKIP" ]]
  grep -qF 'quota reset time not yet reached' "${WORK}/quota.log"
  run ! grep -qF 'ERROR: line' "${WORK}/quota.log"
}

@test "quota_reset_passed: non-default ATRIUM_TIMEZONE honored (footer in that tz matches)" {
  [[ "$(uname -s)" == "Darwin" ]] || skip "BSD date -j required"
  make_quota_harness
  local month day
  month="$(TZ='America/New_York' date -v+1d +%B)"
  day="$(TZ='America/New_York' date -v+1d +%d)"
  printf 'Limit reached\nresets %s %s at 11pm (America/New_York)\n' "${month}" "${day}" >"${WORK}/pane.txt"
  run env ATRIUM_TIMEZONE='America/New_York' \
    bash "${WORK}/harness.sh" "${WORK}/quota.log" "${WORK}/pane.txt" "${WORK}/quota_reset_passed.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "SKIP" ]]
  grep -qF 'quota reset time not yet reached' "${WORK}/quota.log"
  run ! grep -qF 'WARN: quota reset timestamp parse failed' "${WORK}/quota.log"
}

@test "quota_reset_passed: ERE-metachar timezone (Etc/GMT+9) still matches the footer" {
  [[ "$(uname -s)" == "Darwin" ]] || skip "BSD date -j required"
  make_quota_harness
  local month day
  month="$(TZ='Etc/GMT+9' date -v+1d +%B)"
  day="$(TZ='Etc/GMT+9' date -v+1d +%d)"
  printf 'Limit reached\nresets %s %s at 11pm (Etc/GMT+9)\n' "${month}" "${day}" >"${WORK}/pane.txt"
  run env ATRIUM_TIMEZONE='Etc/GMT+9' \
    bash "${WORK}/harness.sh" "${WORK}/quota.log" "${WORK}/pane.txt" "${WORK}/quota_reset_passed.sh"
  [[ "${status}" -eq 0 ]]
  # an unescaped '+' would mismatch the footer → PROCEED via the WARN fallback;
  # the inline ERE escape keeps the match path (SKIP on a future reset)
  [[ "${output}" == "SKIP" ]]
  run ! grep -qF 'WARN: quota reset timestamp parse failed' "${WORK}/quota.log"
}

# ---------------------------------------------------------------------------
# verify_claude_runnable — kill-after-verify probe (unit, command shadowed)
# ---------------------------------------------------------------------------

# Runs the extracted probe with `command -v` shadowed to return FAKE_CLAUDE —
# the only way to exercise the dereferencing -x branch deterministically (PATH
# lookup itself never yields a dangling entry).
run_verify_with_fake_claude() {
  local fake_path="$1"
  extract_fn verify_claude_runnable "${WORK}/verify.sh"
  run env FAKE_CLAUDE="${fake_path}" bash -c '
    source "$1"
    command() { printf "%s\n" "${FAKE_CLAUDE}"; }
    verify_claude_runnable
  ' _ "${WORK}/verify.sh"
}

@test "verify_claude_runnable: dangling symlink target → not runnable" {
  ln -s "${WORK}/gone-target" "${WORK}/claude-link"
  run_verify_with_fake_claude "${WORK}/claude-link"
  [[ "${status}" -eq 1 ]]
}

@test "verify_claude_runnable: healthy binary runnable, empty lookup not" {
  run_verify_with_fake_claude "/bin/ls"
  [[ "${status}" -eq 0 ]]
  run_verify_with_fake_claude ""
  [[ "${status}" -eq 1 ]]
}

# ---------------------------------------------------------------------------
# Full-flow sandbox (DR-1 supervision-death family)
# ---------------------------------------------------------------------------

# Sandboxed copy of the real script + lib/daemon-lock.sh with stub siblings and
# stub PATH binaries. Role=wiki keeps the flow off the real autoagent quota
# marker. The timeout stub strips --kill-after + duration and execs the command,
# so run_with_timeout never spawns its pure-bash watchdog (whose real 600s
# sleep would outlive the test).
make_flow_sandbox() {
  SANDBOX="${WORK}/scripts"
  STUB_BIN="${WORK}/bin"
  LOCK_DIR="${WORK}/locks"
  FAKE_HOME="${WORK}/home"
  SESSION_MARKER="${WORK}/session-exists"
  TMUX_CALLS="${WORK}/tmux-calls.log"
  BOOTSTRAP_CALLS="${WORK}/bootstrap-calls.log"
  LAUNCHCTL_CALLS="${WORK}/launchctl-calls.log"
  FLOW_LOG="${WORK}/restart.log"
  mkdir -p "${SANDBOX}/lib" "${STUB_BIN}" "${LOCK_DIR}" "${FAKE_HOME}"
  cp "${REAL_SCRIPT}" "${SANDBOX}/daemon-daily-restart.sh"
  cp "${REAL_LOCK_LIB}" "${SANDBOX}/lib/daemon-lock.sh"
  cp "${REAL_CONFIG_LIB}" "${SANDBOX}/lib/atrium-config.sh"
  chmod +x "${SANDBOX}/daemon-daily-restart.sh"

  printf '#!/usr/bin/env bash\nexit 0\n' >"${SANDBOX}/wiki-daemon-healthcheck.sh"
  chmod +x "${SANDBOX}/wiki-daemon-healthcheck.sh"

  # Per-attempt rc via BOOTSTRAP_RC_<n> env (default BOOTSTRAP_RC_DEFAULT, then
  # 0); a successful attempt recreates the session marker like the real one.
  cat >"${SANDBOX}/wiki-daemon-bootstrap.sh" <<STUB
#!/usr/bin/env bash
printf 'run\n' >>"${BOOTSTRAP_CALLS}"
n="\$(wc -l <"${BOOTSTRAP_CALLS}" | tr -d ' ')"
rc_var="BOOTSTRAP_RC_\${n}"
rc="\${!rc_var:-\${BOOTSTRAP_RC_DEFAULT:-0}}"
if [[ "\${rc}" -eq 0 ]]; then : >"${SESSION_MARKER}"; fi
exit "\${rc}"
STUB
  chmod +x "${SANDBOX}/wiki-daemon-bootstrap.sh"

  cat >"${STUB_BIN}/tmux" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${TMUX_CALLS}"
case "\$1" in
  has-session) [[ -f "${SESSION_MARKER}" ]] ;;
  kill-session) rm -f -- "${SESSION_MARKER}" ;;
  capture-pane) cat -- "${WORK}/pane-fixture.txt" 2>/dev/null || true ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${STUB_BIN}/tmux"

  cat >"${STUB_BIN}/launchctl" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${LAUNCHCTL_CALLS}"
exit 0
STUB
  chmod +x "${STUB_BIN}/launchctl"

  cat >"${STUB_BIN}/timeout" <<'STUB'
#!/usr/bin/env bash
shift 2
exec "$@"
STUB
  chmod +x "${STUB_BIN}/timeout"

  printf '#!/usr/bin/env bash\nexit 0\n' >"${STUB_BIN}/claude"
  chmod +x "${STUB_BIN}/claude"
}

# Runs the sandboxed script hermetically. Usage: run_flow [VAR=VAL ...] -- <role>
run_flow() {
  local envs=()
  while [[ "$1" != "--" ]]; do
    envs+=("$1")
    shift
  done
  shift
  run env PATH="${STUB_BIN}:/usr/bin:/bin" HOME="${FAKE_HOME}" \
    LOG_FILE="${FLOW_LOG}" DAEMON_LOCK_DIR="${LOCK_DIR}" \
    POST_BOOTSTRAP_WAIT_SEC=0 BOOTSTRAP_RETRY_BACKOFF_SEC=0 \
    "${envs[@]}" bash "${SANDBOX}/daemon-daily-restart.sh" "$@"
}

@test "missing claude: aborts before kill-session, session untouched" {
  make_flow_sandbox
  rm -f "${STUB_BIN}/claude"
  if env PATH="${STUB_BIN}:/usr/bin:/bin" bash -c 'command -v claude' >/dev/null 2>&1; then
    skip "claude unexpectedly reachable via /usr/bin:/bin"
  fi
  : >"${SESSION_MARKER}"
  run_flow -- wiki
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"claude missing or not runnable"* ]]
  [[ -f "${SESSION_MARKER}" ]]
  if [[ -f "${TMUX_CALLS}" ]]; then
    run ! grep -q '^kill-session' "${TMUX_CALLS}"
  fi
}

@test "bootstrap retry: transient failure recovers on attempt 2, lock released, kickstart issued" {
  make_flow_sandbox
  : >"${SESSION_MARKER}"
  run_flow BOOTSTRAP_RC_1=1 -- wiki
  [[ "${status}" -eq 0 ]]
  grep -qF 'bootstrap attempt 1/3 failed (rc=1)' "${FLOW_LOG}"
  grep -qF 'daily restart completed successfully' "${FLOW_LOG}"
  [[ "$(wc -l <"${BOOTSTRAP_CALLS}" | tr -d ' ')" -eq 2 ]]
  grep -qF 'kickstart gui/' "${LAUNCHCTL_CALLS}"
  [[ ! -L "${LOCK_DIR}/daemon-restart-wiki.lock" ]]
}

@test "bootstrap retry exhaustion: bounded attempts then fatal, lock released" {
  make_flow_sandbox
  : >"${SESSION_MARKER}"
  run_flow BOOTSTRAP_RC_DEFAULT=1 BOOTSTRAP_RETRY_MAX=2 -- wiki
  [[ "${status}" -eq 1 ]]
  [[ "$(wc -l <"${BOOTSTRAP_CALLS}" | tr -d ' ')" -eq 2 ]]
  grep -qF 'bootstrap attempt 1/2 failed (rc=1)' "${FLOW_LOG}"
  grep -qF 'FATAL: bootstrap failed (rc=1)' "${FLOW_LOG}"
  [[ ! -L "${LOCK_DIR}/daemon-restart-wiki.lock" ]]
}

@test "restart-window lock held by live sibling: exit 7, session never killed" {
  make_flow_sandbox
  : >"${SESSION_MARKER}"
  ln -s "$$" "${LOCK_DIR}/daemon-restart-wiki.lock"
  run_flow -- wiki
  [[ "${status}" -eq 7 ]]
  [[ "${output}" == *"concurrent restart window"* ]]
  [[ -f "${SESSION_MARKER}" ]]
  run ! grep -q '^kill-session' "${TMUX_CALLS}"
  [[ ! -f "${BOOTSTRAP_CALLS}" ]]
}

# ---------------------------------------------------------------------------
# Pre-restart quota gate (caller) — parse-failure fallback wording
# ---------------------------------------------------------------------------

@test "quota gate parse-failure fallback: proceeds, logs quota-status-unknown (never asserts reset passed)" {
  make_flow_sandbox
  : >"${SESSION_MARKER}"
  # Quota token without a "resets …" footer → detect fires, timestamp parse fails.
  printf 'Limit reached for today\n' >"${WORK}/pane-fixture.txt"
  run_flow -- wiki
  [[ "${status}" -eq 0 ]]
  grep -qF 'WARN: quota reset timestamp parse failed (no match)' "${FLOW_LOG}"
  grep -qF 'quota detect ignored — gate cleared (reset time passed, or parse failed: quota status unknown; see preceding line), proceeding with restart' "${FLOW_LOG}"
  run ! grep -qF 'reset time passed, proceeding with restart' "${FLOW_LOG}"
  grep -qF 'daily restart completed successfully' "${FLOW_LOG}"
}

# ---------------------------------------------------------------------------
# Timezone resolution — the daemon resolves [meta].timezone via the shared
# atrium_resolve_timezone helper so a literal 'auto' (the config default) never
# reaches a TZ=… date call. Host detection is injected (readlink shadow) so the
# auto/host path is deterministic regardless of the runner's ambient tz (under
# launchd the TZ pin would otherwise shadow it).
# ---------------------------------------------------------------------------

# Shadow `readlink` so the auto cascade's TZ-immune primary (lib/atrium-config.sh
# atrium_get_host_timezone, reads /etc/localtime) resolves to a FIXED IANA zone.
# Non-/etc/localtime reads (e.g. daemon-lock's symlink probe) fall through to the
# real readlink. Writes into STUB_BIN, so call AFTER make_flow_sandbox.
stub_host_tz() {
  local zone="$1"
  cat >"${STUB_BIN}/readlink" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == "/etc/localtime" ]]; then
  printf '/var/db/timezone/zoneinfo/${zone}\n'
  exit 0
fi
exec /usr/bin/readlink "\$@"
STUB
  chmod +x "${STUB_BIN}/readlink"
}

# Shadow `date` to append each invocation's TZ env to DATE_CALLS (then exec the
# real date), so a literal 'auto' leaking into a `TZ=… date` call is caught.
stub_date_tz_recorder() {
  DATE_CALLS="${WORK}/date-calls.log"
  cat >"${STUB_BIN}/date" <<STUB
#!/usr/bin/env bash
printf 'TZ=%s\n' "\${TZ:-<unset>}" >>"${DATE_CALLS}"
exec /bin/date "\$@"
STUB
  chmod +x "${STUB_BIN}/date"
}

@test "tz wiring: ATRIUM_TIMEZONE resolution routes the config value through atrium_resolve_timezone" {
  # The daemon assigns ATRIUM_TIMEZONE via the shared atrium_load_timezone wrapper…
  local tz_line
  tz_line="$(grep -E '^ATRIUM_TIMEZONE=' "${REAL_SCRIPT}")"
  [[ -n "${tz_line}" ]]
  [[ "${tz_line}" == *"atrium_load_timezone"* ]]
  # …and that wrapper (lib/atrium-config.sh) is the one routing through the
  # resolver — a regression to a raw config passthrough or a hardcoded literal is
  # caught here before it can leak 'auto' downstream.
  local wrapper_line
  wrapper_line="$(grep -E 'atrium_resolve_timezone .*atrium_config_get' "${REAL_CONFIG_LIB}")"
  [[ -n "${wrapper_line}" ]]
  [[ "${wrapper_line}" == *"atrium_resolve_timezone"* ]]
  [[ "${wrapper_line}" == *"atrium_config_get"* ]]
  [[ "${wrapper_line}" == *"'auto'"* ]]
}

@test "tz resolution: config 'auto' resolves to the host zone — no literal 'auto' reaches a date call" {
  [[ "$(uname -s)" == "Darwin" ]] || skip "BSD date -j/-v required"
  make_flow_sandbox
  : >"${SESSION_MARKER}"
  # Inject a deterministic host zone (≠ the runner's real zone) + a TZ recorder.
  stub_host_tz "America/New_York"
  stub_date_tz_recorder
  printf '[meta]\ntimezone = "auto"\n' >"${WORK}/config.toml"
  # Future reset footer in the RESOLVED host zone drives the quota gate's
  # `TZ=<zone> date -j` parse path (SKIP branch: reset not yet reached, exit 0).
  local month day
  month="$(TZ='America/New_York' date -v+1d +%B)"
  day="$(TZ='America/New_York' date -v+1d +%d)"
  printf 'Limit reached\nresets %s %s at 11pm (America/New_York)\n' \
    "${month}" "${day}" >"${WORK}/pane-fixture.txt"
  run_flow ATRIUM_CONFIG_TOML="${WORK}/config.toml" -- wiki
  [[ "${status}" -eq 0 ]]
  # Gate parsed the footer → the date -j ran in the resolved zone.
  grep -qF 'quota reset time not yet reached' "${FLOW_LOG}"
  # …with the CONCRETE resolved zone, and the literal 'auto' never reached date.
  grep -qF 'TZ=America/New_York' "${DATE_CALLS}"
  run ! grep -qF 'TZ=auto' "${DATE_CALLS}"
}
