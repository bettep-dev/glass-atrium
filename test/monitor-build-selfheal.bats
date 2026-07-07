#!/usr/bin/env bats
# monitor-build-selfheal.bats — monitor-build force-quit fix (npm-ci self-heal + build_monitor return-not-exit).
#
# npm-ci self-heal: before `npm run build`, when monitor/node_modules/.bin/tsc is absent the
# build MUST self-heal by running `npm ci` first (partial-install recovery); when tsc is
# already present, `npm ci` MUST be skipped (no redundant reinstall).
#
# Return-not-exit: the TUI build_monitor MUST `return` its named build code (BOOTSTRAP_EXIT_BUILD=20)
# on failure, NEVER an in-step `exit`. run_step invokes the step fn as a SAME-SHELL brace group
# under `set +e`, so an in-step `exit` terminates the WHOLE process (masked force-quit, no FAIL
# panel); a `return` is captured as rc → run_plan renders the FAIL panel. The regression guard is
# the "same-scope sentinel": a `( build_monitor )` subshell would isolate the exit and print 20
# both pre/post (false-green), so the driver calls build_monitor at TOP LEVEL of a child process
# and asserts a `REACHED` marker AFTER the call — absent pre-fix (process died), present post-fix.
#
# Machine-safe: GA_ROOT overridden to a mktemp sandbox, npm PATH-stubbed (records ci-vs-build
# order, simulates ci populating tsc + build needing it). NO real npm/brew/psql, no machine state.
# Mirrors the stubbing pattern in test/oss-db-setup.bats + the launcher-as-library source pattern
# in test/install-orphan-ownership-exec-harness.sh.
#
# Run via: bats test/monitor-build-selfheal.bats
# Requires: bats (brew install bats-core), bash 3.2+

# SC2154: BATS_TEST_DIRNAME is injected by the bats runtime. SC2016: the static-scan
# assertions single-quote `${BOOTSTRAP_EXIT_BUILD}` deliberately — they match the LITERAL
# source text, never expand it. SC2312: masking a command's exit in a test assertion (e.g.
# `$(cat "${MARKER}")` inside `[[ ]]`) is intentional — the string value is the assertion.
# shellcheck disable=SC2154,SC2016,SC2312
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
TUI="${GA}/glass-atrium"
CORE="${GA}/lib/ga-core.sh"

setup() {
  [[ -f "${TUI}" ]] || skip "glass-atrium launcher not found: ${TUI}"
  [[ -f "${CORE}" ]] || skip "ga-core.sh not found: ${CORE}"
  SANDBOX="$(mktemp -d -t ga-buildheal-bats.XXXXXX)"
  SANDBOX_ROOT="${SANDBOX}/ga-root"     # the overridden GA_ROOT
  STUB_BIN="${SANDBOX}/bin"
  MARKER="${SANDBOX}/npm-calls.log"     # ordered npm invocation record (absolute — stub cwd is monitor/)
  DRIVER="${SANDBOX}/driver.sh"
  mkdir -p "${SANDBOX_ROOT}/monitor" "${STUB_BIN}"

  # npm stub: record each invocation, simulate `ci` populating .bin/tsc and `run build`
  # needing it (so a tsc-absent build fails until ci self-heals). NPM_FORCE_BUILD_FAIL=1
  # makes `run build` ALWAYS fail (the return-not-exit test needs a failure independent of the self-heal).
  cat >"${STUB_BIN}/npm" <<'NPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${MARKER_LOG}"
case "$1" in
  ci)
    mkdir -p node_modules/.bin
    : >node_modules/.bin/tsc
    chmod +x node_modules/.bin/tsc
    exit 0
    ;;
  run)
    if [[ "${NPM_FORCE_BUILD_FAIL:-0}" == "1" ]]; then
      printf 'npm run build: forced failure (test)\n' >&2
      exit 2
    fi
    [[ -x node_modules/.bin/tsc ]] && exit 0
    printf 'sh: tsc: command not found\n' >&2
    exit 127
    ;;
esac
exit 0
NPM
  chmod +x "${STUB_BIN}/npm"

  # driver: source the REAL launcher as a library with GA_ROOT pre-pinned to the sandbox
  # (ga_init_env runs BEFORE the launcher's own no-op re-init), then call the REAL
  # build_monitor at TOP LEVEL (not a subshell — a pre-fix in-step `exit` kills THIS process).
  cat >"${DRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck source=/dev/null disable=SC1091
source "${GA_REAL}/lib/ga-core.sh"
ga_init_env "${GA_SANDBOX_ROOT}"
source "${GA_REAL}/glass-atrium" >/dev/null 2>&1
set +e
trap - ERR EXIT INT TERM
build_monitor
rc=$?
printf 'REACHED rc=%s\n' "${rc}"
exit 0
DRV
  chmod +x "${DRIVER}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# GA_LIB_DIR points ga_init_env's E5-lib source at the real repo (the sandbox root has none).
drive() {
  run env \
    GA_REAL="${GA}" \
    GA_SANDBOX_ROOT="${SANDBOX_ROOT}" \
    GA_LIB_DIR="${GA}/scripts/lib" \
    MARKER_LOG="${MARKER}" \
    NPM_FORCE_BUILD_FAIL="${1:-0}" \
    PATH="${STUB_BIN}:${PATH}" \
    bash "${DRIVER}"
}

# === Self-heal npm ci before build ====================================

# NB: bats fails a test only on its LAST command's status — intermediate `[[ ]]` failures
# do NOT abort. Every multi-condition assertion below is therefore a short-circuiting `&&`
# chain, so ANY unmet condition propagates to the final status and fails the test.

@test "npm-ci-selfheal: build_monitor runs npm ci BEFORE npm run build when tsc is absent" {
  # tsc absent (fresh sandbox monitor) → self-heal must fire.
  drive 0
  [[ "${status}" -eq 0 ]] \
    && [[ "${output}" == *"REACHED rc=0"* ]] \
    && [[ "$(cat "${MARKER}")" == $'ci\nrun build' ]]   # exact order: ci first, then build
}

@test "npm-ci-selfheal: build_monitor SKIPS npm ci when node_modules/.bin/tsc already present" {
  # pre-populate a valid install → ci must NOT run (no redundant reinstall).
  mkdir -p "${SANDBOX_ROOT}/monitor/node_modules/.bin"
  : >"${SANDBOX_ROOT}/monitor/node_modules/.bin/tsc"
  chmod +x "${SANDBOX_ROOT}/monitor/node_modules/.bin/tsc"
  drive 0
  [[ "${status}" -eq 0 ]] \
    && [[ "${output}" == *"REACHED rc=0"* ]] \
    && [[ "$(cat "${MARKER}")" == "run build" ]]         # ONLY build, no ci
}

# === build_monitor returns (not exit) on failure ======================

@test "build-return: build_monitor RETURNS BOOTSTRAP_EXIT_BUILD on build failure (control continues, no process kill)" {
  # force the build to fail regardless of self-heal; a pre-fix `exit 20` would kill the
  # driver before REACHED prints. Post-fix `return 20` lets control continue.
  drive 1
  [[ "${output}" == *"REACHED rc=20"* ]] \
    && [[ "${status}" -eq 0 ]]                             # driver ran to its own exit 0 (not killed)
}

# === static guards (machine-safe; the divergent CLI copy + return-not-exit contract) ===

@test "build-return: build_monitor uses return (not exit/die) for its failure paths" {
  local body
  body="$(sed -n '/^build_monitor() {/,/^}/p' "${TUI}" "${GA}"/lib/ga-tui-*.sh)"
  [[ "${body}" == *'return "${BOOTSTRAP_EXIT_BUILD}"'* ]] \
    && [[ "${body}" != *'exit "${BOOTSTRAP_EXIT_BUILD}"'* ]] \
    && [[ "${body}" != *"die "* ]]                        # npm-absent path no longer die()s
}

@test "selfheal+return: CLI run_bootstrap self-heals AND deliberately keeps exit (passthrough semantics)" {
  local body
  body="$(sed -n '/^run_bootstrap() {/,/^}/p' "${CORE}")"
  [[ "${body}" == *"node_modules/.bin/tsc"* ]] \
    && [[ "${body}" == *"npm ci"* ]] \
    && [[ "${body}" == *'exit "${BOOTSTRAP_EXIT_BUILD}"'* ]]  # CLI copy deliberately stays exit
}
