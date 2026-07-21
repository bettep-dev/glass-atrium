#!/usr/bin/env bats
# headless-auth-selftest-cred-isolation.bats — falsifiable coverage for the headless auth self-test's
# CREDENTIAL ISOLATION + DIAGNOSTIC DISAMBIGUATION.
#
# Defect: the render->load->export chain is correct (the rendered CLAUDE_CODE_OAUTH_TOKEN DOES reach
# `claude -p`), but the self-test probe subshell inherited the install shell FULL env, so a competing
# higher-precedence Anthropic credential (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) SHADOWED the
# freshly-rendered OAuth token -> a FALSE 401 even though the token is valid. The opaque failure gave
# the user no actionable signal.
#
# Fix: headless_auth_selftest (lib/ga-tui-preflight.sh) now runs the `claude -p` probe under
# `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN` so ONLY the just-loaded CLAUDE_CODE_OAUTH_TOKEN can
# authenticate; on failure it emits an actionable stderr message branching on whether the OAuth token
# actually reached the probe env (token-absent vs token-rejected) — never printing the token value.
#
# Falsifiability: the isolation test uses a stub `claude` that emits a 401 signature IFF it still sees a
# competing credential. Pre-fix the stub sees it -> 401 -> return 1; post-fix `env -u` strips it -> the
# stub sees only the loaded OAuth marker -> OK -> return 0. The diagnostic tests assert the two distinct
# branch messages fire (and that the loaded marker never surfaces in the output).
#
# Hermetic: the two functions under test (run_with_timeout, headless_auth_selftest) are EVAL'd into the
# test shell (extract_fn) — no TUI, no TTY, no real `claude`, no real credential (a non-secret marker).
#
# Run via: bats test/headless-auth-selftest-cred-isolation.bats
# Requires: bats (brew install bats-core), perl (run_with_timeout), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

# a non-secret presence marker — the code only tests the OAuth var for -n (non-empty), so a plain
# word suffices; asserted to be ABSENT from any user-facing output.
LOADED_MARK="oauth-present-marker"

setup() {
  [[ -f "${GA}/lib/ga-env.sh" ]] || skip "lib not found: ${GA}/lib/ga-env.sh"
  [[ -f "${GA}/lib/ga-tui-preflight.sh" ]] || skip "lib not found: ${GA}/lib/ga-tui-preflight.sh"
  command -v perl >/dev/null 2>&1 || skip "perl not on PATH (run_with_timeout needs it)"
  # the libs are strict-mode when sourced whole; suspend any inherited ERR trap before eval.
  trap - ERR
  # atrium_resolve_haiku_model (pure) lives in atrium-config.sh, which extract_fn does not scan — source
  # it so the eval'd headless_auth_selftest can call it (ga-env.sh's E5 loop does this at runtime).
  # shellcheck source=../scripts/lib/atrium-config.sh
  source "${GA}/scripts/lib/atrium-config.sh"
  SANDBOX="$(mktemp -d -t ga-auth-isolation.XXXXXX)"
  # the daemon_cycle.py auth-signature set, verbatim from the launcher (glass-atrium:249).
  AUTH_FAIL_RE='API Error: *(401|403)|HTTP *(401|403)|Invalid authentication credentials|Failed to authenticate'
  # start from a known-clean credential axis so a real inherited value cannot skew the presence check.
  unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  # hermetic model seam: point the daemon-config resolver at a sandbox path (absent by default -> the
  # alias-literal fallback) so no test reads the real ${HOME}/.glass-atrium/data/daemon-config.json.
  GA_AUTH_DAEMON_CONFIG="${SANDBOX}/daemon-config.json"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# _export_kv — name-indirect export ($1=name, $2=value), so no literal credential-name assignment
# appears in this test file. Used to plant the competing Anthropic credential in the parent env.
_export_kv() {
  export "$1=$2"
}

# extract_fn — eval a single named function (from ga-env.sh or ga-tui-preflight.sh) into the test shell.
extract_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
    "${GA}/lib/ga-env.sh" "${GA}/lib/ga-tui-preflight.sh")"
}

# _write_env_lib — a sandbox claude-auth-env.sh stub. $1 == "loaded" -> claude_auth_load_env exports the
# non-secret presence marker (simulates a rendered secrets file); else -> load is a no-op (simulates an
# unprovisioned machine). The stub path is echoed to stdout for GA_AUTH_ENV_LIB. The generated
# assignment is built name-first + value-var so no literal credential assignment lives in this file.
_write_env_lib() {
  local mode="${1:-none}" path="${SANDBOX}/claude-auth-env.sh"
  if [[ "${mode}" == "loaded" ]]; then
    {
      printf '%s\n' 'claude_auth_load_env() {'
      printf '  export %s=%s\n' 'CLAUDE_CODE_OAUTH_TOKEN' "${LOADED_MARK}"
      printf '%s\n' '  return 0'
      printf '%s\n' '}'
    } >"${path}"
  else
    printf '%s\n' 'claude_auth_load_env() { return 0; }' >"${path}"
  fi
  printf '%s' "${path}"
}

# _write_stub_claude_isolation — a `claude` stub that emits a 401 signature IFF it can still see a
# competing credential (proving the probe did NOT isolate), OK otherwise. exit 0 in both cases so the
# gate decision rides on the body scan, not the exit code.
_write_stub_claude_isolation() {
  local path="${SANDBOX}/claude"
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' 'if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then'
    printf '%s\n' "  printf 'API Error: 401\\n'"
    printf '%s\n' '  exit 0'
    printf '%s\n' 'fi'
    printf '%s\n' "printf 'OK\\n'"
    printf '%s\n' 'exit 0'
  } >"${path}"
  chmod +x "${path}"
  printf '%s' "${path}"
}

# _write_stub_claude_always401 — a `claude` stub that ALWAYS emits a 401 signature (rc 0). Drives the
# failure path so the diagnostic disambiguation branch runs regardless of env.
_write_stub_claude_always401() {
  local path="${SANDBOX}/claude"
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' "printf 'API Error: 401\\n'"
    printf '%s\n' 'exit 0'
  } >"${path}"
  chmod +x "${path}"
  printf '%s' "${path}"
}

# _write_stub_claude_capture — a `claude` stub that records its full argv to $CLAUDE_STUB_ARGS_OUT then
# passes (OK, rc 0), so a test can inspect the resolved --model value the probe passed.
_write_stub_claude_capture() {
  local path="${SANDBOX}/claude"
  cat >"${path}" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" > "$CLAUDE_STUB_ARGS_OUT"
printf 'OK\n'
exit 0
STUB
  chmod +x "${path}"
  printf '%s' "${path}"
}

# _write_daemon_config — write a daemon-config.json at the seam path with $1 as the haiku_model value.
_write_daemon_config() {
  printf '{"haiku_model":"%s"}\n' "$1" >"${GA_AUTH_DAEMON_CONFIG}"
}

# === (1) THE PRIMARY REPRO — a competing ANTHROPIC_API_KEY is isolated, so a valid token passes =====

@test "selftest: env -u isolates a competing ANTHROPIC_API_KEY so the OAuth token authenticates (return 0)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  _export_kv ANTHROPIC_API_KEY would-shadow-the-oauth
  GA_AUTH_ENV_LIB="$(_write_env_lib loaded)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude_isolation)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local rc=0
  headless_auth_selftest || rc=$?
  # pre-fix the stub sees the competing key -> 401 -> rc 1; post-fix env -u strips it -> OK -> rc 0.
  [[ "${rc}" -eq 0 ]] || return 1
}

# === (2) isolation also strips ANTHROPIC_AUTH_TOKEN (the second competing axis) ======================

@test "selftest: env -u also isolates a competing ANTHROPIC_AUTH_TOKEN (return 0)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  _export_kv ANTHROPIC_AUTH_TOKEN would-shadow-the-oauth
  GA_AUTH_ENV_LIB="$(_write_env_lib loaded)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude_isolation)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
}

# === (3) DIAGNOSTIC — token WAS delivered but rejected -> the "competing credential" branch ==========

@test "selftest: a delivered-but-rejected token yields the token-rejected diagnostic (never the value)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib loaded)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude_always401)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 1 ]] || return 1
  # the marker WAS present in the probe env -> the rejected/competing-credential branch.
  [[ "${out}" == *"token delivered to claude but rejected"* ]] || return 1
  [[ "${out}" == *"competing credential"* ]] || return 1
  # SECURITY: the loaded marker must NEVER surface in any user-facing message.
  [[ "${out}" != *"${LOADED_MARK}"* ]] || return 1
}

# === (4) DIAGNOSTIC — no token delivered -> the "re-run Token Setup" branch =========================

@test "selftest: an undelivered token yields the provisioning/token-setup diagnostic" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib none)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude_always401)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 1 ]] || return 1
  # no OAuth marker reached the probe env -> the provisioning branch.
  [[ "${out}" == *"provisioning did not deliver a token"* ]] || return 1
  [[ "${out}" == *"re-run Token Setup"* ]] || return 1
}

# === (5) a passing self-test emits NEITHER diagnostic branch (no false alarm on the happy path) =====

@test "selftest: a passing probe emits no diagnostic message (return 0, clean output)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib loaded)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude_isolation)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "${out}" != *"token delivered to claude but rejected"* ]] || return 1
  [[ "${out}" != *"provisioning did not deliver a token"* ]] || return 1
}

# === (6) MODEL PIN — the probe passes the daemon-config'd haiku model to --model ====================

@test "selftest: the probe pins --model to the daemon-config haiku_model value" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH (model resolution needs it)"
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  _write_daemon_config "claude-haiku-cfg-9-9"
  GA_AUTH_ENV_LIB="$(_write_env_lib loaded)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude_capture)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  export CLAUDE_STUB_ARGS_OUT="${SANDBOX}/claude-args"
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  [[ -f "${CLAUDE_STUB_ARGS_OUT}" ]] || return 1
  # the probe carried --model with the config'd cheap model, not the default.
  grep -qF -- '--model claude-haiku-cfg-9-9' "${CLAUDE_STUB_ARGS_OUT}" || return 1
}

# === (7) MODEL PIN fallback — absent config -> the alias-literal claude-haiku-4-5 =====================

@test "selftest: absent daemon-config falls back to --model claude-haiku-4-5" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  # GA_AUTH_DAEMON_CONFIG points at a NON-existent sandbox path (setup default) -> fallback literal.
  [[ ! -f "${GA_AUTH_DAEMON_CONFIG}" ]] || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib loaded)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude_capture)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  export CLAUDE_STUB_ARGS_OUT="${SANDBOX}/claude-args"
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  [[ -f "${CLAUDE_STUB_ARGS_OUT}" ]] || return 1
  grep -qF -- '--model claude-haiku-4-5' "${CLAUDE_STUB_ARGS_OUT}" || return 1
}

# === (9) STATIC — the centralized jq idiom + alias literal now live in atrium_resolve_haiku_model =====

@test "resolver(static): atrium_resolve_haiku_model owns the jq idiom + the claude-haiku-4-5 fallback literal" {
  local body
  body="$(awk '/^atrium_resolve_haiku_model\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${GA}/scripts/lib/atrium-config.sh")" || return 1
  [[ -n "${body}" ]] || return 1
  # the jq key read + alias-literal fallback moved OUT of the 4 call sites INTO this single resolver.
  [[ "${body}" == *"jq -r '.haiku_model // empty'"* ]] || return 1
  [[ "${body}" == *'model="claude-haiku-4-5"'* ]] || return 1
  # the config path is a parameter (each caller passes its own seam), defaulting to the canonical path.
  [[ "${body}" == *'local config_path="${1:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-config.json}"'* ]] || return 1
}
