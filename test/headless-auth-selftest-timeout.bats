#!/usr/bin/env bats
# headless-auth-selftest-timeout.bats — falsifiable coverage for the BOUNDED headless auth self-test.
#
# Defect: headless_auth_selftest (lib/ga-tui-preflight.sh) ran the `claude -p` credential probe with
# NO time bound and inherited (unpinned) stdin. It fires on menu hot paths (the Install/Token
# provisioning fast-path), so a hung CLI — network stall, a stuck credential prompt reading stdin —
# would freeze the whole installer with no ceiling. It was the ONE claude probe in the tree lacking a
# time bound.
#
# Fix: wrap the probe in run_with_timeout (lib/ga-env.sh — kills the whole process group on expiry,
# exit 124) with a GA_AUTH_SELFTEST_TIMEOUT_SECS (default 30s) ceiling, and pin stdin to /dev/null.
# A timeout (exit 124) is non-zero, so the EXISTING probe_rc gate already treats it as a self-test
# failure; the AUTH_FAIL_RE body scan for a rc-0-masking 401 is UNCHANGED.
#
# Falsifiability: the TIMEOUT test is the primary repro — a stub `claude` that sleeps LONGER than the
# 1s ceiling then exits 0. Pre-fix (no wrap) the probe waits out the sleep, sees exit 0 + empty body
# and returns 0 (PASS incorrectly). Post-fix run_with_timeout kills it at ~1s → exit 124 → return 1.
#
# Hermetic: the two functions under test are EVAL'd into the test shell (extract_fn) — no TUI, no
# TTY, no real `claude`, no credential. The probe's env-lib + `claude` binary are sandbox stubs.
#
# Run via: bats test/headless-auth-selftest-timeout.bats
# Requires: bats (brew install bats-core), perl (run_with_timeout), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

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
  SANDBOX="$(mktemp -d -t ga-auth-selftest.XXXXXX)"
  # the daemon_cycle.py auth-signature set, verbatim from the launcher (glass-atrium:249).
  AUTH_FAIL_RE='API Error: *(401|403)|HTTP *(401|403)|Invalid authentication credentials|Failed to authenticate'
  # a stub env-lib that satisfies the `. "${env_lib}"` source + claude_auth_load_env call (no real secrets).
  ENV_LIB="${SANDBOX}/claude-auth-env.sh"
  printf '%s\n' 'claude_auth_load_env() { return 0; }' >"${ENV_LIB}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# extract_fn — eval a single named function (from ga-env.sh or ga-tui-preflight.sh) into the test
# shell so it can be driven in isolation. run_with_timeout lives in ga-env.sh; headless_auth_selftest
# in ga-tui-preflight.sh — awk concatenates both, matching the one file that carries the definition.
extract_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
    "${GA}/lib/ga-env.sh" "${GA}/lib/ga-tui-preflight.sh")"
}

# _write_stub_claude — a sandbox `claude` stub. $1 = body written to stdout; $2 = the shell body's
# leading directive (e.g. "sleep 3" for the hang case). Kept off any dangerous-git literal.
_write_stub_claude() {
  local out_line="$1" pre="${2:-}" path="${SANDBOX}/claude"
  {
    printf '%s\n' '#!/bin/sh'
    [[ -n "${pre}" ]] && printf '%s\n' "${pre}"
    printf 'printf %s\n' "'${out_line}\n'"
    printf '%s\n' 'exit 0'
  } >"${path}"
  chmod +x "${path}"
  printf '%s' "${path}"
}

# === (1) happy path — rc-0 CLI + clean body → self-test PASSES (return 0) ======================

@test "selftest(live): a responsive CLI with a clean body passes (return 0)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="${ENV_LIB}"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude 'OK' '')"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 0 ]] || return 1
}

# === (2) 401 body scan — rc-0 CLI but a 401 signature in the body → FAILS (return 1) ===========

@test "selftest(live): a rc-0 CLI whose body carries a 401 signature FAILS (AUTH_FAIL_RE unchanged)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="${ENV_LIB}"
  # exit 0 but an in-band auth error — the exact rc-0-masking case the body scan must still catch.
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude 'Invalid authentication credentials' '')"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 1 ]] || return 1
}

# === (3) THE PRIMARY REPRO — a hung CLI is bounded by run_with_timeout (exit 124 → return 1) ===

@test "selftest(live): a CLI that hangs past the ceiling is killed and reported as a failure (no stall)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="${ENV_LIB}"
  # sleeps 3s then would exit 0 — pre-fix the unbounded probe waits it out + returns 0 (wrong);
  # post-fix run_with_timeout(1s) KILLs the process group at ~1s → exit 124 → return 1.
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude 'OK' 'sleep 3')"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=1
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 1 ]] || return 1
}

# === (4) non-zero CLI exit — still a failure (the wrap did not weaken the exit-code gate) ======

@test "selftest(live): a non-zero CLI exit is a self-test failure (return 1)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="${ENV_LIB}"
  # a claude that exits non-zero with no body — must FAIL via the probe_rc gate (not the body scan).
  printf '%s\n' '#!/bin/sh' 'exit 1' >"${SANDBOX}/claude"
  chmod +x "${SANDBOX}/claude"
  GA_AUTH_CLAUDE_BIN="${SANDBOX}/claude"
  GA_AUTH_SELFTEST_TIMEOUT_SECS=5
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 1 ]] || return 1
}

# === (5) lib-absent guard — env-lib missing → return 2 (unchanged early-return contract) =======

@test "selftest: an absent claude-auth-env lib returns 2 (unchanged)" {
  extract_fn run_with_timeout || return 1
  extract_fn headless_auth_selftest || return 1
  GA_AUTH_ENV_LIB="${SANDBOX}/does-not-exist.sh"
  GA_AUTH_CLAUDE_BIN="$(_write_stub_claude 'OK' '')"
  local rc=0
  headless_auth_selftest || rc=$?
  [[ "${rc}" -eq 2 ]] || return 1
}

# === (6) STATIC — the probe is wrapped in run_with_timeout with pinned stdin (regression guard) =

@test "selftest(static): the claude -p probe is run_with_timeout-bounded + stdin-pinned" {
  local body
  body="$(awk '/^headless_auth_selftest\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${GA}/lib/ga-tui-preflight.sh")" || return 1
  [[ -n "${body}" ]] || return 1
  # the bounded, stdin-pinned, credential-isolated, cheap-model-pinned probe.
  [[ "${body}" == *'run_with_timeout "${GA_AUTH_SELFTEST_TIMEOUT_SECS:-30}" env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "${claude_bin}" -p --output-format text --model "${haiku_model}" "reply with OK" </dev/null 2>&1'* ]] || return 1
  # the OLD unbounded probe (no run_with_timeout, no stdin pin) is GONE.
  [[ "${body}" != *'"${claude_bin}" -p --output-format text "reply with OK" 2>&1'* ]] || return 1
  # the AUTH_FAIL_RE body scan is UNCHANGED (still gates the rc-0-masking 401).
  [[ "${body}" == *'grep -qiE "${AUTH_FAIL_RE}"'* ]] || return 1
}
