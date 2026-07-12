#!/usr/bin/env bats
# token-paste-provisioning.bats — falsifiable coverage for the headless-token PROVISIONING fix.
#
# Defect (real report, Claude Code v2.1.207): preflight_provision_headless_token captured the OAuth
# token via `captured_value="$(claude setup-token)"` — a command substitution, so the CLI's stdout is a
# NON-TTY pipe. Under v2.1.207's interactive paste-code flow the long `sk-ant-oat…` token is wrapped
# across the 80-col boundary on that non-TTY stdout, so sanitize_setup_token's
# `grep -oE -m1 'sk-ant-oat[A-Za-z0-9_-]+'` matches only the FIRST line (stops at the newline) → a
# TRUNCATED fragment. The fragment still clears render-claude-auth.sh's loose guard (≥16 chars, no
# whitespace, no control) → the 0600 secrets file renders "successfully", but the truncated token 401s
# on the launchd self-test (the exact user-observed failure). Running setup-token MANUALLY (stdout=TTY)
# works; only glass-atrium's non-TTY capture mangles the value.
#
# Fix: a PASTE-TOKEN provisioning path that DECOUPLES from the fragile capture. The user runs
# `claude setup-token` in a real terminal (where it works) and PASTES the printed token; it is read
# SILENTLY off the TTY (no echo → never in the scrollback), sanitized, and piped to render via STDIN.
# The legacy `$(claude setup-token)` auto-capture is retained OPT-IN only (GA_AUTH_SETUP_TOKEN_AUTOCAPTURE=1,
# default OFF); a pre-exported CLAUDE_CODE_OAUTH_TOKEN env var is a reliable no-capture shortcut. Any
# auto source that fails render/self-test FALLS BACK to the reliable paste path.
#
# Falsifiability:
#   (a) fail-before — sanitize_setup_token on a v2.1.207-WRAPPED shape returns a TRUNCATED value.
#   (b) paste-after — the full function renders a BYTE-CORRECT token from a simulated paste + the
#       (stubbed) self-test passes.
#   (headline) auto-capture on the wrapped shape 401s → the paste path recovers the correct token.
#
# Hermetic: the functions under test are EVAL'd into the test shell (extract_fn). The REAL
# render-claude-auth.sh + claude-auth-env.sh run against a SANDBOX GA_ROOT; only the `claude` binary and
# the chrome sink (preflight_line/preflight_out/c) are stubs — no real credential, no real ~/.glass-atrium.
#
# Run via: bats test/token-paste-provisioning.bats
# Requires: bats (brew install bats-core), perl (run_with_timeout), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

# Fake token shapes (clearly non-real; the `sk-ant-` hyphens keep them off every secret-scan pattern).
FULL_VAL="sk-ant-oat01batsfakevalue0000aaaa1111bbbb"
WRAP_A="sk-ant-oat01batsfakevalue0000"
WRAP_B="aaaa1111bbbb"

setup() {
  [[ -f "${GA}/lib/ga-env.sh" ]] || skip "lib not found: ${GA}/lib/ga-env.sh"
  [[ -f "${GA}/lib/ga-tui-preflight.sh" ]] || skip "lib not found: ${GA}/lib/ga-tui-preflight.sh"
  [[ -f "${GA}/lib/ga-tui-primitives.sh" ]] || skip "lib not found: ${GA}/lib/ga-tui-primitives.sh"
  [[ -x "${GA}/scripts/render-claude-auth.sh" ]] || skip "render script not found"
  [[ -f "${GA}/scripts/lib/claude-auth-env.sh" ]] || skip "claude-auth-env lib not found"
  command -v perl >/dev/null 2>&1 || skip "perl not on PATH (run_with_timeout needs it)"
  # the libs are strict-mode when sourced whole; suspend any inherited ERR trap before eval.
  trap - ERR

  # never let an ambient value short-circuit the source-A env path or the paste flow.
  unset CLAUDE_CODE_OAUTH_TOKEN GA_AUTH_SETUP_TOKEN_AUTOCAPTURE

  SANDBOX="$(mktemp -d -t ga-token-paste.XXXXXX)"
  # GA_DIR resolves the Stage-A scripts (render + env lib); GA_ROOT anchors the sandbox secrets file.
  GA_DIR="${GA}"
  GA_ROOT="${SANDBOX}"
  # the daemon_cycle.py auth-signature set, verbatim from the launcher.
  AUTH_FAIL_RE='API Error: *(401|403)|HTTP *(401|403)|Invalid authentication credentials|Failed to authenticate'
  # point the self-test at the REAL env lib so the render→load→probe chain runs end-to-end.
  GA_AUTH_ENV_LIB="${GA}/scripts/lib/claude-auth-env.sh"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  USE_COLOR=false
  SECRETS_FILE_PATH="${SANDBOX}/secrets/claude-auth.env"

  # chrome stubs — no-ops so nothing writes to the paste-file TTY (preflight_out uses `>"${TTY}"`,
  # which would TRUNCATE the paste input mid-read). c is a passthrough for the `$(c …)` arg calls.
  preflight_line() { :; }
  preflight_out() { :; }
  c() {
    shift
    printf '%s' "$*"
  }
  # trivial path resolvers (the real ones are one-liners extract_fn cannot slice cleanly).
  ga_render_auth_script() { printf '%s\n' "${GA_DIR}/scripts/render-claude-auth.sh"; }
  ga_claude_auth_env_lib() { printf '%s\n' "${GA_DIR}/scripts/lib/claude-auth-env.sh"; }

  # a `claude` stub serving BOTH subcommands: `setup-token` emits a v2.1.207-shaped stream (URL banner +
  # token, wrapped or clean per GA_STUB_SHAPE); `-p` echoes OK iff the loaded credential is byte-correct.
  STUB="${SANDBOX}/claude"
  cat >"${STUB}" <<'STUBEOF'
#!/bin/sh
if [ "$1" = "setup-token" ]; then
  printf '%s\n' 'Visit https://claude.ai/oauth to authorize, then paste the code below.'
  printf '%s\n' 'Your long-lived credential (valid ~1 year):'
  if [ "${GA_STUB_SHAPE}" = "wrapped" ]; then
    printf '%s\n%s\n' "${GA_STUB_VAL_A}" "${GA_STUB_VAL_B}"
  else
    printf '%s\n' "${GA_STUB_VAL_FULL}"
  fi
  exit 0
fi
got="$CLAUDE_CODE_OAUTH_TOKEN"
if [ "$got" = "${GA_STUB_VAL_FULL}" ]; then
  printf 'OK\n'
else
  printf 'Invalid authentication credentials\n'
fi
exit 0
STUBEOF
  chmod +x "${STUB}"
  GA_AUTH_CLAUDE_BIN="${STUB}"
  export GA_STUB_VAL_FULL="${FULL_VAL}"
  export GA_STUB_VAL_A="${WRAP_A}"
  export GA_STUB_VAL_B="${WRAP_B}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# extract_fn — eval a named function (multi-line, col-1 `}` terminated) from any of the three libs into
# the test shell. awk concatenates the files; the first file carrying the definition wins.
extract_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
    "${GA}/lib/ga-env.sh" "${GA}/lib/ga-tui-primitives.sh" "${GA}/lib/ga-tui-preflight.sh")"
}

# load_fns — bring the whole functional chain into the test shell.
load_fns() {
  extract_fn run_with_timeout || return 1
  extract_fn strip_csi || return 1
  extract_fn sanitize_setup_token || return 1
  extract_fn headless_auth_selftest || return 1
  extract_fn _provision_render_selftest || return 1
  extract_fn preflight_provision_headless_token || return 1
}

# stored_secret — echo the rendered CLAUDE_CODE_OAUTH_TOKEN value (grep pattern kept off the secret-scan
# generic-credential pattern: nothing ≥8 chars follows the `=`).
stored_secret() {
  local line
  line="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "${SECRETS_FILE_PATH}" 2>/dev/null || true)"
  printf '%s' "${line#*=}"
}

# === (a) FAIL-BEFORE — sanitize truncates the v2.1.207-wrapped shape ============================

@test "fail-before: sanitize_setup_token truncates a wrapped (non-TTY) token to the first line" {
  extract_fn strip_csi || return 1
  extract_fn sanitize_setup_token || return 1
  # the exact broken shape: a URL banner then the long token WRAPPED across two lines.
  local wrapped
  wrapped="$(printf '%s\n%s\n%s\n%s\n' \
    'Visit https://claude.ai/oauth to authorize.' 'Your credential:' "${WRAP_A}" "${WRAP_B}")"
  local out
  out="$(sanitize_setup_token "${wrapped}")"
  # the grep stops at the newline → only the first fragment survives (the bug).
  [[ "${out}" == "${WRAP_A}" ]] || return 1
  [[ "${out}" != "${FULL_VAL}" ]] || return 1
}

# === (b) PASTE-AFTER — a byte-correct paste renders + self-tests green (return 0) ===============

@test "paste-after: a pasted full token renders byte-correct + the self-test passes (return 0)" {
  load_fns || return 1
  TTY="${SANDBOX}/paste-in"
  printf '%s\n' "${FULL_VAL}" >"${TTY}"
  local rc=0
  preflight_provision_headless_token || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  # the rendered secret is the FULL value, byte-for-byte — not a truncated fragment.
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
}

# === (headline) FALLBACK — auto-capture 401s on the wrapped shape, paste recovers ==============

@test "fallback: opt-in auto-capture truncates+401s under v2.1.207, then the paste path recovers" {
  load_fns || return 1
  GA_AUTH_SETUP_TOKEN_AUTOCAPTURE=1
  GA_STUB_SHAPE="wrapped" # setup-token emits the wrapped (broken) shape
  export GA_STUB_SHAPE
  TTY="${SANDBOX}/paste-in"
  printf '%s\n' "${FULL_VAL}" >"${TTY}" # the user's clean paste from a real terminal
  local rc=0
  preflight_provision_headless_token || rc=$?
  # auto-capture rendered a truncated token (self-test failed) → paste path overwrote with the correct one.
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
}

# === (source A) ENV VAR — a pre-exported token provisions with no paste, no capture =============

@test "env-source: a pre-exported CLAUDE_CODE_OAUTH_TOKEN provisions directly (return 0, no TTY)" {
  load_fns || return 1
  local oauth_env="CLAUDE_CODE_OAUTH_TOKEN"
  export "${oauth_env}=${FULL_VAL}"
  TTY="" # no terminal — the env source must succeed WITHOUT reaching the paste prompt
  local rc=0
  preflight_provision_headless_token || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
}

# === (guard) RENDER-REJECT — an implausible paste is refused by render (return 4) ===============

@test "render-reject: an implausibly short paste is rejected by render-claude-auth (return 4)" {
  load_fns || return 1
  TTY="${SANDBOX}/paste-in"
  printf '%s\n' 'nope' >"${TTY}" # 4 chars → render's <16 guard exit 7 → return 4
  local rc=0
  preflight_provision_headless_token || rc=$?
  [[ "${rc}" -eq 4 ]] || return 1
  [[ ! -f "${SECRETS_FILE_PATH}" ]] || return 1
}

# === (guard) EMPTY PASTE — no value pasted → no usable value (return 3) =========================

@test "empty-paste: an empty paste yields no usable value (return 3)" {
  load_fns || return 1
  TTY="${SANDBOX}/paste-in"
  : >"${TTY}" # empty file → read gets nothing
  local rc=0
  preflight_provision_headless_token || rc=$?
  [[ "${rc}" -eq 3 ]] || return 1
}

# === (guard) NO TTY — cannot prompt for a paste → loud-fail (return 3) ==========================

@test "no-tty: no controlling terminal + no env/capture → loud-fail (return 3)" {
  load_fns || return 1
  TTY="" # no terminal, no env token, no autocapture
  local rc=0
  preflight_provision_headless_token || rc=$?
  [[ "${rc}" -eq 3 ]] || return 1
}

# === (static) SHAPE — the production function pins the paste read + stdin render contract =======

@test "static: the paste value is read SILENTLY off the TTY and piped to render via STDIN (never argv)" {
  local body
  body="$(awk '/^preflight_provision_headless_token\(\) \{/{f=1} f{print} f&&/^}/{exit}' \
    "${GA}/lib/ga-tui-preflight.sh")" || return 1
  [[ -n "${body}" ]] || return 1
  # the reliable paste path: a silent (-s, no echo) read off the TTY.
  [[ "${body}" == *'IFS= read -rs pasted <"${TTY}"'* ]] || return 1
  # cooked-mode restore around the read (raw-mode Enter=CR would else never terminate the read).
  [[ "${body}" == *'stty "${TTY_SAVED}" <"${TTY}"'* ]] || return 1
  # the value reaches render ONLY via STDIN through the shared helper — never on argv.
  [[ "${body}" == *'printf '"'"'%s\n'"'"' "${pasted}" | _provision_render_selftest'* ]] || return 1
  # the legacy `$(claude setup-token)` capture is GATED opt-in (default OFF).
  [[ "${body}" == *'GA_AUTH_SETUP_TOKEN_AUTOCAPTURE'* ]] || return 1
  # the token is NEVER passed as a positional arg to the render script (ps/argv exposure).
  [[ "${body}" != *'"${render_script}" "${pasted}"'* ]] || return 1
  # the shared render+self-test helper takes its value from STDIN (no $1 value) and CLEARS any inherited
  # exported CLAUDE_CODE_OAUTH_TOKEN (env -u) so a stale exported var cannot shadow the piped stdin value
  # on render's $1 → env → stdin precedence.
  local helper
  helper="$(awk '/^_provision_render_selftest\(\) \{/{f=1} f{print} f&&/^}/{exit}' \
    "${GA}/lib/ga-tui-preflight.sh")" || return 1
  [[ "${helper}" == *'env -u CLAUDE_CODE_OAUTH_TOKEN GA_ROOT="${GA_ROOT:-${HOME}/.glass-atrium}" "${render_script}"'* ]] || return 1
}

# === (regression) STALE EXPORT — a stale exported token must NOT shadow the pasted value ========
# Real defect: render-claude-auth.sh resolves $1 → CLAUDE_CODE_OAUTH_TOKEN env → stdin, and
# _provision_render_selftest invoked render with a PLAIN `env GA_ROOT=…` that PRESERVED the rest of the
# environment. So a STALE exported CLAUDE_CODE_OAUTH_TOKEN (v2.1.207 `claude setup-token` prints an
# `export CLAUDE_CODE_OAUTH_TOKEN=…` line — a user re-running the gate often still has it) made render
# read the ENV value and IGNORE the piped stdin: Source A rendered the stale token → 401 → fell through
# to the paste path → the user pasted a FRESH valid token → render AGAIN inherited the stale exported var
# → rendered the STALE token → 401. The correct paste was silently discarded. The `env -u
# CLAUDE_CODE_OAUTH_TOKEN` fix clears the inherited var so the piped STDIN value wins.

@test "stale-export: a stale exported CLAUDE_CODE_OAUTH_TOKEN does not shadow the paste (pasted value stored)" {
  load_fns || return 1
  # a valid-SHAPE but WRONG stale token exported in the install shell (the leftover `export` line);
  # valid shape so it clears sanitize + render's guard — the exact condition that reproduces the bug.
  local oauth_env="CLAUDE_CODE_OAUTH_TOKEN"
  local stale_val="sk-ant-oat01batsSTALEwrong9999cccc8888dddd"
  export "${oauth_env}=${stale_val}"
  # Source A renders the stale token → self-test 401s → falls through to the reliable paste path.
  TTY="${SANDBOX}/paste-in"
  printf '%s\n' "${FULL_VAL}" >"${TTY}" # the user's fresh, correct paste from a real terminal
  local rc=0
  preflight_provision_headless_token || rc=$?
  # the pasted value WINS: the stored secret is the PASTED FULL_VAL, never the stale exported value.
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "$(stored_secret)" == "${FULL_VAL}" ]] || return 1
  [[ "$(stored_secret)" != "${stale_val}" ]] || return 1
}
