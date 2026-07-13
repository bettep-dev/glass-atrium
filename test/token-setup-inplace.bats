#!/usr/bin/env bats
# token-setup-inplace.bats — falsifiable coverage for the IN-PLACE `claude setup-token` provisioning
# option (choice [1]).
#
# Feature: preflight_provision_headless_token now offers "[1] run setup-token here / [2] paste a token I
# already have". Option 1 hands the FULL real TTY to `claude setup-token` (stdin+stdout+stderr = the
# terminal) so its output stays UNWRAPPED — the launcher NEVER captures that stdout (which is the exact
# v2.1.207 non-TTY 80-col wrap the old auto-capture hit). The token reaches the render path ONLY via the
# silent paste-back read, so it never lands on argv / a pipe / a log. Option 2 (the reliable manual paste)
# stays as the DEFAULT fallback.
#
# Falsifiability:
#   (fail-before/static) the pre-change body has NO in-place setup-token invocation; the static test pins
#     the `setup-token <"${TTY}" >"${TTY}"` inherited-TTY form (would fail on the old body).
#   (inplace-run) choice 1 INVOKES `claude setup-token`, then the paste-back token renders byte-correct.
#   (routing) choice 2 does NOT invoke setup-token (the unchanged manual paste path).
#   (security) the token never appears on the `claude` argv log.
#
# Hermetic: the functions under test are EVAL'd into the test shell (extract_fn). The REAL
# render-claude-auth.sh + claude-auth-env.sh run against a SANDBOX GA_ROOT; only `claude` and the chrome
# sink (preflight_line/preflight_out/c) are stubs — no real credential, no real ~/.glass-atrium.
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

  # never let an ambient value short-circuit Source A or enable the opt-in auto-capture.
  unset CLAUDE_CODE_OAUTH_TOKEN GA_AUTH_SETUP_TOKEN_AUTOCAPTURE

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
  # v2.1.207 interactive flow: it OWNS the inherited TTY for the URL + auth-code paste and prints the token
  # to it — the launcher never reads that stdout, so this stub writes NOTHING to its std fds (which keeps
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
  extract_fn preflight_provision_headless_token || return 1
}

stored_secret() {
  local line
  line="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "${SECRETS_FILE_PATH}" 2>/dev/null || true)"
  printf '%s' "${line#*=}"
}

# open_tty / close_tty — model a single terminal STREAM with a regular file. The function reads TWICE off
# the TTY (the [1/2] choice, then the paste); opening the file ONCE as fd 9 and pointing TTY at /dev/fd/9
# makes both reads SHARE fd 9's offset (macOS /dev/fd dup semantics) so they consume sequentially. `<>`
# (rw) so choice 1's `>"${TTY}"` in-place redirect resolves; a dup write does not truncate the file.
open_tty() {
  exec 9<>"$1"
  TTY="/dev/fd/9"
}
close_tty() { exec 9<&- 2>/dev/null || true; }

# === (fail-before/static) the in-place branch hands the FULL TTY to setup-token (no capture) ===========

@test "static: option 1 runs 'setup-token' with the TTY inherited on all std fds (no stdout capture)" {
  local body
  body="$(awk '/^preflight_provision_headless_token\(\) \{/{f=1} f{print} f&&/^}/{exit}' \
    "${GA}/lib/ga-tui-preflight.sh")" || return 1
  [[ -n "${body}" ]] || return 1
  # the in-place run inherits the real TTY on stdin+stdout+stderr — this line does NOT exist pre-change.
  # The redirect form proves the token is NOT captured off setup-token's stdout (which would reintroduce
  # the v2.1.207 non-TTY 80-col wrap-truncation); its stdout goes straight to the terminal, unread.
  [[ "${body}" == *'"${setup_bin}" setup-token <"${TTY}" >"${TTY}" 2>"${TTY}"'* ]] || return 1
  # the rendered value still flows ONLY via the shared silent paste read → STDIN pipe.
  [[ "${body}" == *'IFS= read -rs pasted <"${TTY}"'* ]] || return 1
  [[ "${body}" == *'printf '"'"'%s\n'"'"' "${pasted}" | _provision_render_selftest'* ]] || return 1
}

# === (inplace-run) choice 1 invokes setup-token, then the paste-back token renders byte-correct =========

@test "inplace-run: choice 1 runs setup-token in place + the paste-back token renders (return 0)" {
  load_fns || return 1
  # stream: choice 1, then the token the user copies from setup-token's output + pastes back.
  printf '1\n%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
  open_tty "${SANDBOX}/tin"
  local rc=0
  preflight_provision_headless_token || rc=$?
  close_tty
  [[ "${rc}" -eq 0 ]] || return 1
  # the in-place run actually invoked `claude setup-token`.
  grep -q 'setup-token' "${ARGV_LOG}" || return 1
  # the pasted token rendered byte-for-byte into the 0600 secrets file.
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
}

# === (security) the token never lands on the `claude` argv ============================================

@test "security: the in-place run never puts the token on argv (STDIN/tty/render path only)" {
  load_fns || return 1
  printf '1\n%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
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

# === (routing) choice 2 keeps the manual paste path — setup-token is NOT auto-run ======================

@test "routing: choice 2 does NOT invoke setup-token (the unchanged manual paste path)" {
  load_fns || return 1
  printf '2\n%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
  open_tty "${SANDBOX}/tin"
  local rc=0
  preflight_provision_headless_token || rc=$?
  close_tty
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
  # option 2 must NOT auto-run setup-token; the only `claude` calls are the `-p` self-test probes.
  ! grep -q 'setup-token' "${ARGV_LOG}" || return 1
}

# === (default) a bare Enter defaults to paste — no unexpected browser OAuth flow =======================

@test "default: an empty choice defaults to the paste path (setup-token NOT auto-run)" {
  load_fns || return 1
  # stream: empty choice line, then the pasted token.
  printf '\n%s\n' "${FULL_VAL}" >"${SANDBOX}/tin"
  open_tty "${SANDBOX}/tin"
  local rc=0
  preflight_provision_headless_token || rc=$?
  close_tty
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
  ! grep -q 'setup-token' "${ARGV_LOG}" || return 1
}
