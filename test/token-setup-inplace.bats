#!/usr/bin/env bats
# token-setup-inplace.bats — falsifiable coverage for the AUTO-RUN in-place `claude setup-token`
# provisioning path.
#
# Feature: preflight_provision_headless_token AUTO-RUNS `claude setup-token` in place (no menu). The child
# INHERITS the launcher's fd 0/1 (the kqueue-able pty SLAVES, /dev/ttysNNN) with stderr merged via 2>&1 —
# the ONLY form Bun's node:tty WriteStream can kqueue; redirecting the child's std fds to the ${TTY}
# /dev/tty handle (the OLD `<"${TTY}" >"${TTY}" 2>"${TTY}"` form) throws EINVAL and crashes it. The auto-run
# is gated on _provision_tty_gate_ok (fd 0 AND fd 1 real terminals); when the gate is false (passthrough /
# piped / CI) it routes to the reliable manual paste instead. A non-zero setup-token exit (crash / decline)
# falls back gracefully to the paste path so a crash never strands the user. The token reaches the render
# path ONLY via the silent paste-back read, so it never lands on argv / a pipe / a log.
#
# Falsifiability:
#   (fail-before/static) the new body invokes `setup-token 2>&1` (inherit fd 0/1) and NO LONGER carries the
#     old crashing `<"${TTY}" >"${TTY}"` redirect (would fail on the old body).
#   (auto-run) gate-true INVOKES `claude setup-token`, then the paste-back token renders byte-correct.
#   (gate-false) no inherited terminal → paste-only; setup-token is NOT auto-run.
#   (fallback) gate-true + a crashing setup-token prints a clean fallback line + still renders via paste.
#   (security) the token never appears on the `claude` argv log.
#
# Hermetic: the functions under test are EVAL'd into the test shell (extract_fn). The REAL
# render-claude-auth.sh + claude-auth-env.sh run against a SANDBOX GA_ROOT; only `claude` and the chrome
# sink (preflight_line/preflight_out/c) are stubs — no real credential, no real ~/.glass-atrium.
#
# TTY limitation: the real-Bun-binary kqueue SUCCESS path is NOT auto-verifiable here — a bats harness /
# subagent has no controlling terminal, so the auto-run is driven through the GA_AUTH_FORCE_TTY seam and a
# stubbed `claude`. Real kqueue success needs a user real-terminal check; the graceful fallback below is
# the safety net that makes a crash non-fatal.
#
# Run via: bats test/token-setup-inplace.bats
# Requires: bats (brew install bats-core), perl (run_with_timeout), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

# Fake token (clearly non-real; the `sk-ant-` hyphens keep it off every secret-scan pattern).
FULL_VAL="sk-ant-oat01batsfakevalue0000aaaa1111bbbb"

setup() {
  [[ -f "${GA}/lib/ga-env.sh" ]] || skip "lib not found: ${GA}/lib/ga-env.sh"
  [[ -f "${GA}/lib/ga-tui-preflight.sh" ]] || skip "lib not found: ${GA}/lib/ga-tui-preflight.sh"
  [[ -f "${GA}/lib/ga-tui-primitives.sh" ]] || skip "lib not found: ${GA}/lib/ga-tui-primitives.sh"
  [[ -x "${GA}/scripts/render-claude-auth.sh" ]] || skip "render script not found"
  [[ -f "${GA}/scripts/lib/claude-auth-env.sh" ]] || skip "claude-auth-env lib not found"
  command -v perl >/dev/null 2>&1 || skip "perl not on PATH (run_with_timeout needs it)"
  # the libs are strict-mode when sourced whole; suspend any inherited ERR trap before eval.
  trap - ERR

  # never let an ambient value short-circuit Source A, enable the opt-in auto-capture, or force the gate.
  unset CLAUDE_CODE_OAUTH_TOKEN GA_AUTH_SETUP_TOKEN_AUTOCAPTURE GA_AUTH_FORCE_TTY

  SANDBOX="$(mktemp -d -t ga-token-inplace.XXXXXX)"
  GA_DIR="${GA}"
  GA_ROOT="${SANDBOX}"
  AUTH_FAIL_RE='API Error: *(401|403)|HTTP *(401|403)|Invalid authentication credentials|Failed to authenticate'
  GA_AUTH_ENV_LIB="${GA}/scripts/lib/claude-auth-env.sh"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  USE_COLOR=false
  SECRETS_FILE_PATH="${SANDBOX}/secrets/claude-auth.env"
  ARGV_LOG="${SANDBOX}/claude-argv.log"
  : >"${ARGV_LOG}"

  # chrome stubs — no-ops (preflight_out uses `>"${TTY}"`, which would corrupt the shared input stream).
  preflight_line() { :; }
  preflight_out() { :; }
  c() {
    shift
    printf '%s' "$*"
  }
  ga_render_auth_script() { printf '%s\n' "${GA_DIR}/scripts/render-claude-auth.sh"; }
  ga_claude_auth_env_lib() { printf '%s\n' "${GA_DIR}/scripts/lib/claude-auth-env.sh"; }

  # a `claude` stub logging its argv to ARGV_LOG (for the security assertion). `setup-token` models the
  # v2.1.207 interactive flow: it OWNS the inherited fds for the URL + auth-code paste and prints the token
  # to them — the launcher never reads that stdout, so this stub writes NOTHING to its std fds (which keeps
  # the shared test-stream offset intact for the paste-back read that follows). `-p` = the self-test probe.
  STUB="${SANDBOX}/claude"
  cat >"${STUB}" <<'STUBEOF'
#!/bin/sh
printf '%s\n' "$*" >>"${GA_STUB_ARGV_LOG}"
if [ "$1" = "setup-token" ]; then
  exit 0
fi
if [ "${CLAUDE_CODE_OAUTH_TOKEN}" = "${GA_STUB_VAL_FULL}" ]; then
  printf 'OK\n'
else
  printf 'Invalid authentication credentials\n'
fi
exit 0
STUBEOF
  chmod +x "${STUB}"
  GA_AUTH_CLAUDE_BIN="${STUB}"
  export GA_STUB_VAL_FULL="${FULL_VAL}"
  export GA_STUB_ARGV_LOG="${ARGV_LOG}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# extract_fn — eval a named function (multi-line, col-1 `}` terminated) from any of the three libs.
extract_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
    "${GA}/lib/ga-env.sh" "${GA}/lib/ga-tui-primitives.sh" "${GA}/lib/ga-tui-preflight.sh")"
}

load_fns() {
  extract_fn run_with_timeout || return 1
  extract_fn strip_csi || return 1
  extract_fn sanitize_setup_token || return 1
  extract_fn headless_auth_selftest || return 1
  extract_fn _provision_render_selftest || return 1
  extract_fn _provision_tty_gate_ok || return 1
  extract_fn preflight_provision_headless_token || return 1
}

stored_secret() {
  local line
  line="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "${SECRETS_FILE_PATH}" 2>/dev/null || true)"
  printf '%s' "${line#*=}"
}

# open_tty / close_tty — model a single terminal STREAM with a regular file. The function reads the paste
# ONCE off the TTY; opening the file as fd 9 and pointing TTY at /dev/fd/9 gives the silent read a stable
# offset. `<>` (rw) so any tty write resolves without truncating the backing file.
open_tty() {
  exec 9<>"$1"
  TTY="/dev/fd/9"
}
close_tty() { exec 9<&- 2>/dev/null || true; }

# === (fail-before/static) the auto-run inherits fd 0/1 (2>&1), NOT the old crashing ${TTY} redirect =====

@test "static: the auto-run inherits fd 0/1 (setup-token 2>&1) with NO tty redirect (no stdout capture)" {
  local body
  body="$(awk '/^preflight_provision_headless_token\(\) \{/{f=1} f{print} f&&/^}/{exit}' \
    "${GA}/lib/ga-tui-preflight.sh")" || return 1
  [[ -n "${body}" ]] || return 1
  # the auto-run INHERITS fd 0/1 (the pty slaves) and merges stderr into stdout — the ONLY kqueue-able
  # form; the ${TTY} /dev/tty handle throws EINVAL. This exact line does NOT exist pre-change.
  [[ "${body}" == *'"${setup_bin}" setup-token 2>&1'* ]] || return 1
  # the OLD crashing form (redirecting the child's std fds to the ${TTY} /dev/tty handle) is GONE.
  [[ "${body}" != *'setup-token <"${TTY}"'* ]] || return 1
  [[ "${body}" != *'setup-token >"${TTY}"'* ]] || return 1
  [[ "${body}" != *'2>"${TTY}"'* ]] || return 1
  # the auto-run is gated on the stubbable fd 0/1 terminal seam.
  [[ "${body}" == *'if _provision_tty_gate_ok; then'* ]] || return 1
  # the rendered value still flows ONLY via the shared silent paste read → STDIN pipe.
  [[ "${body}" == *'IFS= read -rs pasted <"${TTY}"'* ]] || return 1
  [[ "${body}" == *'printf '"'"'%s\n'"'"' "${pasted}" | _provision_render_selftest'* ]] || return 1
}

# === (auto-run) gate-true runs setup-token in place, then the paste-back token renders byte-correct ======

@test "auto-run: gate-true runs setup-token in place + the paste-back token renders (return 0)" {
  load_fns || return 1
  GA_AUTH_FORCE_TTY=1
  # stream: just the token the user copies from setup-token's output + pastes back (no choice line).
  printf '%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
  open_tty "${SANDBOX}/tin"
  local rc=0
  preflight_provision_headless_token || rc=$?
  close_tty
  [[ "${rc}" -eq 0 ]] || return 1
  # the auto-run actually invoked `claude setup-token`.
  grep -q 'setup-token' "${ARGV_LOG}" || return 1
  # the pasted token rendered byte-for-byte into the 0600 secrets file.
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
}

# === (gate-false) no inherited terminal → paste-only, setup-token is NOT auto-run =======================

@test "gate-false: no inherited terminal routes to paste-only (setup-token NOT auto-run)" {
  load_fns || return 1
  GA_AUTH_FORCE_TTY=0
  printf '%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
  open_tty "${SANDBOX}/tin"
  local rc=0
  preflight_provision_headless_token || rc=$?
  close_tty
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
  # gate false → setup-token is NOT auto-run; the only `claude` calls are the `-p` self-test probes.
  ! grep -q 'setup-token' "${ARGV_LOG}" || return 1
}

# === (security) the token never lands on the `claude` argv =============================================

@test "security: the auto-run never puts the token on argv (STDIN/tty/render path only)" {
  load_fns || return 1
  GA_AUTH_FORCE_TTY=1
  printf '%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
  open_tty "${SANDBOX}/tin"
  local rc=0
  preflight_provision_headless_token || rc=$?
  close_tty
  [[ "${rc}" -eq 0 ]] || return 1
  # setup-token WAS called, but the secret token value NEVER appears on any `claude` argv.
  grep -q 'setup-token' "${ARGV_LOG}" || return 1
  ! grep -qF "${FULL_VAL}" "${ARGV_LOG}" || return 1
  # the render script is invoked with NO positional value (token on STDIN only) — no `claude`/render argv leak.
  ! grep -qF "render-claude-auth" "${ARGV_LOG}" || return 1
  # the value did reach the 0600 secrets file (via the STDIN render path).
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
}

# === (fallback) gate-true + a crashing setup-token drops to paste (clean message, token still renders) ===

@test "fallback: gate-true + a crashing setup-token falls back to paste (clean line, byte-correct render)" {
  load_fns || return 1
  GA_AUTH_FORCE_TTY=1
  # a `claude` stub whose setup-token CRASHES (exit 1) — models the real Bun EINVAL kqueue failure; `-p`
  # still serves the self-test so the paste-path render can green-light the byte-correct token.
  cat >"${STUB}" <<'STUBEOF'
#!/bin/sh
printf '%s\n' "$*" >>"${GA_STUB_ARGV_LOG}"
if [ "$1" = "setup-token" ]; then
  exit 1
fi
if [ "${CLAUDE_CODE_OAUTH_TOKEN}" = "${GA_STUB_VAL_FULL}" ]; then
  printf 'OK\n'
else
  printf 'Invalid authentication credentials\n'
fi
exit 0
STUBEOF
  chmod +x "${STUB}"
  # capture the chrome so the clean fallback line is assertable (setup() stubs preflight_line to a no-op).
  MSG_LOG="${SANDBOX}/msg.log"
  : >"${MSG_LOG}"
  preflight_line() { printf '%s\n' "$*" >>"${MSG_LOG}"; }
  printf '%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
  open_tty "${SANDBOX}/tin"
  local rc=0
  preflight_provision_headless_token || rc=$?
  close_tty
  # the crash did not strand the user: the paste path rendered the byte-correct token.
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
  # setup-token WAS attempted (and crashed), then a CLEAN contextual fallback line was printed.
  grep -q 'setup-token' "${ARGV_LOG}" || return 1
  grep -qF 'did not complete' "${MSG_LOG}" || return 1
  # the token never landed on any `claude` argv despite the crash.
  ! grep -qF "${FULL_VAL}" "${ARGV_LOG}" || return 1
}
