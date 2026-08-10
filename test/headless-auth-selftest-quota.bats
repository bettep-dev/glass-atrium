#!/usr/bin/env bats
# headless-auth-selftest-quota.bats — falsifiable coverage for QUOTA-vs-CREDENTIAL disambiguation in
# the headless auth self-test.
#
# Defect: headless_auth_selftest (lib/ga-tui-preflight.sh) folded EVERY non-zero probe rc into a
# credential failure BEFORE inspecting the body, and the only body test was AUTH_FAIL_RE. A Claude Max
# session-limit response — which proves the credential AUTHENTICATED and then hit a usage wall — was
# therefore rendered as `self-test FAILED (401/credential) — run … 'claude setup-token'`, misdirecting
# the operator into re-provisioning a token that already works.
#
# Fix: a quota-signature branch runs BEFORE the rc/AUTH_FAIL_RE fold, returns the distinct rc 3, and
# emits an advisory naming the reset time when the body carries one. The provisioning gates call the
# headless_auth_ok predicate (rc 0 OR rc 3 = accepted) so a quota window never routes to Token Setup.
#
# Falsifiability: at HEAD the quota stubs return 1 with the credential diagnostic on stderr; post-fix
# they return 3 with the quota advisory and NEITHER credential string. The polarity cases pin that a
# genuine AUTH_FAIL_RE body still returns 1 with the unchanged advisory (AC-A3) and that the lib-absent
# rc 2 path is untouched (AC-A4).
#
# Hermetic: the functions under test are EVAL'd into the test shell (extract_fn) — no TUI, no TTY, no
# real `claude`, no real credential. Mirrors the cred-isolation / timeout sibling suites.
#
# Run via: bats test/headless-auth-selftest-quota.bats
# Requires: bats (brew install bats-core), perl (run_with_timeout), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

# a non-secret presence marker — the code only tests the OAuth var for -n (non-empty).
LOADED_MARK="oauth-present-marker"

# the live session-limit body shape, reset time in the parenthesised TZ form the advisory must name.
QUOTA_RESET="resets 6:10pm (Asia/Seoul)"

setup() {
  [[ -f "${GA}/lib/ga-env.sh" ]] || skip "lib not found: ${GA}/lib/ga-env.sh"
  [[ -f "${GA}/lib/ga-tui-preflight.sh" ]] || skip "lib not found: ${GA}/lib/ga-tui-preflight.sh"
  command -v perl >/dev/null 2>&1 || skip "perl not on PATH (run_with_timeout needs it)"
  # the libs are strict-mode when sourced whole; suspend any inherited ERR trap before eval.
  trap - ERR
  # shellcheck source=../scripts/lib/atrium-config.sh
  source "${GA}/scripts/lib/atrium-config.sh"
  SANDBOX="$(mktemp -d -t ga-auth-quota.XXXXXX)"
  # the daemon_cycle.py auth-signature set, verbatim from the launcher.
  AUTH_FAIL_RE='API Error: *(401|403)|HTTP *(401|403)|Invalid authentication credentials|Failed to authenticate'
  unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  GA_AUTH_DAEMON_CONFIG="${SANDBOX}/daemon-config.json"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# extract_fn — eval a single named function (from ga-env.sh or ga-tui-preflight.sh) into the test shell.
extract_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
    "${GA}/lib/ga-env.sh" "${GA}/lib/ga-tui-preflight.sh")"
}

# _write_env_lib — a sandbox claude-auth-env.sh stub exporting the non-secret presence marker.
_write_env_lib() {
  local path="${SANDBOX}/claude-auth-env.sh"
  {
    printf '%s\n' 'claude_auth_load_env() {'
    printf '  export %s=%s\n' 'CLAUDE_CODE_OAUTH_TOKEN' "${LOADED_MARK}"
    printf '%s\n' '  return 0'
    printf '%s\n' '}'
  } >"${path}"
  printf '%s' "${path}"
}

# _write_stub_claude — a `claude` stub printing $1 as its body and exiting $2. The body is printed
# BEFORE any sleep so it always reaches the capture pipe even on the timeout path.
_write_stub_claude() {
  local path="${SANDBOX}/claude" body="$1" rc="$2" sleep_secs="${3:-0}"
  {
    printf '%s\n' '#!/bin/sh'
    printf "printf '%%s\\\\n' '%s'\n" "${body}"
    [[ "${sleep_secs}" != "0" ]] && printf 'sleep %s\n' "${sleep_secs}"
    printf 'exit %s\n' "${rc}"
  } >"${path}"
  chmod +x "${path}"
  printf '%s' "${path}"
}

# _assert_no_cred_advisory — the doctor-facing credential strings must not appear on a quota path.
_assert_no_cred_advisory() {
  local out="$1"
  [[ "${out}" != *"FAILED (401/credential)"* ]] || return 1
  [[ "${out}" != *"setup-token"* ]] || return 1
  [[ "${out}" != *"token delivered to claude but rejected"* ]] || return 1
  [[ "${out}" != *"provisioning did not deliver a token"* ]] || return 1
}

# === AC-A1 — non-zero rc + session-limit body with a reset time -> rc 3 + reset-naming advisory ======

@test "selftest(quota): a non-zero session-limit body returns rc 3 and names the reset time" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "Limit reached ∙ ${QUOTA_RESET}" 1)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 3 ]] || return 1
  [[ "${out}" == *"quota window active"* ]] || return 1
  [[ "${out}" == *"${QUOTA_RESET}"* ]] || return 1
  _assert_no_cred_advisory "${out}" || return 1
  # SECURITY: the loaded marker must NEVER surface in any user-facing message.
  [[ "${out}" != *"${LOADED_MARK}"* ]] || return 1
}

@test "selftest(quota): the /rate-limit-options signature alone (no reset time) still returns rc 3" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "see /rate-limit-options for details" 1)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 3 ]] || return 1
  [[ "${out}" == *"quota window active"* ]] || return 1
  _assert_no_cred_advisory "${out}" || return 1
}

# === AC-A2 — bounded-probe timeout (rc 124) carrying a quota body is a QUOTA event ==================

@test "selftest(quota): a timed-out probe whose body carries the quota signature returns rc 3" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  # body printed BEFORE the sleep so it reaches the capture pipe; run_with_timeout kills at 1s.
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "Usage ⚠ out of extra usage — ${QUOTA_RESET}" 0 20)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=1
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 3 ]] || return 1
  [[ "${out}" == *"quota window active"* ]] || return 1
  [[ "${out}" == *"${QUOTA_RESET}"* ]] || return 1
  _assert_no_cred_advisory "${out}" || return 1
}

@test "selftest(quota): a BARE timeout with no body stays a credential failure (rc 1, not quota)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "" 0 20)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=1
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  # a network hang printing nothing must NOT be mislabelled quota.
  [[ "${rc}" -eq 1 ]] || return 1
  [[ "${out}" != *"quota window active"* ]] || return 1
}

# === AC-A3 — polarity: a genuine credential body is unchanged (rc 1 + credential advisory) ==========

@test "selftest(cred): a genuine 401 body still returns rc 1 with the credential advisory" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "API Error: 401" 0)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 1 ]] || return 1
  [[ "${out}" == *"token delivered to claude but rejected"* ]] || return 1
  [[ "${out}" != *"quota window active"* ]] || return 1
}

@test "selftest(cred): a non-zero probe with a non-quota body still returns rc 1" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "Failed to authenticate" 1)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local rc=0
  headless_auth_selftest >/dev/null 2>&1 || rc=$?
  [[ "${rc}" -eq 1 ]] || return 1
}

@test "selftest(ok): a passing probe still returns rc 0 with no advisory" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "OK" 0)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
  [[ "${out}" != *"quota window active"* ]] || return 1
  _assert_no_cred_advisory "${out}" || return 1
}

# === AC-A4 — rc 2 (auth-env lib absent) semantics untouched by the quota branch =====================

@test "selftest(lib-absent): an absent claude-auth-env lib still returns rc 2" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="${SANDBOX}/absent-claude-auth-env.sh"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "Limit reached ∙ ${QUOTA_RESET}" 1)"
  local out rc=0
  out="$(headless_auth_selftest 2>&1)" || rc=$?
  # the lib gate precedes the probe entirely — a quota-emitting stub must not change it.
  [[ "${rc}" -eq 2 ]] || return 1
  [[ "${out}" == *"claude-auth-env lib absent"* ]] || return 1
  [[ "${out}" != *"quota window active"* ]] || return 1
}

# === GATE PREDICATE — headless_auth_ok treats rc 3 as accepted, rc 1 as not ==========================

@test "gate: headless_auth_ok accepts a quota window (rc 3) and rejects a credential failure (rc 1)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  extract_fn headless_auth_ok || return 1
  GA_AUTH_ENV_LIB="$(_write_env_lib)"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5

  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "Limit reached ∙ ${QUOTA_RESET}" 1)"
  headless_auth_ok 2>/dev/null || return 1

  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude "API Error: 401" 0)"
  local rc=0
  headless_auth_ok 2>/dev/null || rc=$?
  [[ "${rc}" -ne 0 ]] || return 1
}

# === STATIC — the doctor branch renders a distinct rc-3 arm and sets no credential advise flag ======

@test "doctor(static): the rc-3 arm renders the quota advisory without the credential guidance" {
  local body
  body="$(awk '/^  case "\$\{selftest_rc\}" in/{f=1} f{print} f&&/^  esac/{exit}' \
    "${GA}/lib/ga-tui-preflight.sh")" || return 1
  [[ -n "${body}" ]] || return 1
  [[ "${body}" == *"3) log "* ]] || return 1
  [[ "${body}" == *"quota window"* ]] || return 1
  # the rc-3 arm must NOT raise advise (that flag drives the token-repair guidance).
  local arm
  arm="$(printf '%s\n' "${body}" | awk '/^    3\)/{print; exit}')"
  [[ "${arm}" != *"advise=1"* ]] || return 1
}
