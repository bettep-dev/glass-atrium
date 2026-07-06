#!/usr/bin/env bats
# deps-preflight-noninteractive.bats — falsifiable coverage for the bare-Mac dependency
# preflight NON-INTERACTIVE fix (three gate-found defects):
#
#   D1  Homebrew 6.x DEFAULT ASK MODE (`brew install` [Y/n]) hangs against the raw-mode
#       TUI. Fix = export HOMEBREW_NO_ASK=1 (NOT NONINTERACTIVE, which does not govern ask
#       mode) in the consented preflight block; ga_cmd_brew_batch stays a clean formula
#       list (no --no-ask flag threaded into the builder).
#   D2  ga_cmd_homebrew_install emitted a `/bin/bash -c "$(curl …)"` STRING that the entry
#       point's word-split argv runner cannot expand — the installer never ran. Fix = emit
#       the single function token `ga_homebrew_install`, run in-process (curl|bash lives in
#       the function), mirroring ga_claude_install.
#   D3  The Homebrew installer step has a LIVE sudo prompt that must stay visible, so it is
#       EXCLUDED from the framed install-capture path; the non-interactive steps (brew
#       batch / pg service+role / claude CLI) ARE framed via preflight_run_or_bail_framed.
#
# Run via: bats test/deps-preflight-noninteractive.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic: ga-deps.sh is a pure sourceable lib (no strict mode, no main guard, no side
# effects) — sourced directly; the missing-set is stubbed so the brew-batch format assert
# never probes the real machine. Launcher assertions are STATIC (grep the file text) so no
# TUI / TTY / real brew is ever driven. The one env-delivery test uses a PATH-stubbed brew.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
DEPS_SH="${GA}/lib/ga-deps.sh"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${DEPS_SH}" ]] || skip "lib not found: ${DEPS_SH}"
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the lib is not strict-mode, but suspend any inherited ERR trap defensively.
  trap - ERR
  # shellcheck source=/dev/null
  source "${DEPS_SH}"
  SANDBOX="$(mktemp -d -t ga-deps-bats.XXXXXX)"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# === D2 — ga_cmd_homebrew_install emits the in-process function token ===============

@test "D2: ga_cmd_homebrew_install emits exactly the function token ga_homebrew_install" {
  run ga_cmd_homebrew_install
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "ga_homebrew_install" ]]
}

@test "D2: ga_homebrew_install is a defined function after sourcing (run in-process)" {
  declare -F ga_homebrew_install
}

@test "D2: ga_homebrew_install body runs the official curl|bash Homebrew installer" {
  local body
  body="$(declare -f ga_homebrew_install)"
  # real in-process execution: /bin/bash -c "$(curl … install.sh)" (expanded HERE).
  [[ "${body}" == *'/bin/bash -c'* ]]
  [[ "${body}" == *'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'* ]]
}

@test "D2: emitted token is a SINGLE bare word (survives the word-split argv runner)" {
  local tok
  tok="$(ga_cmd_homebrew_install)"
  # exactly one whitespace-delimited field — no $(...) that would split into a broken argv.
  set -- ${tok}
  [[ "$#" -eq 1 ]]
  [[ "$1" == "ga_homebrew_install" ]]
}

# === D1 — ga_cmd_brew_batch stays a clean formula list (no --no-ask threaded in) =====

@test "D1: ga_cmd_brew_batch emits 'brew install <formulae>' with NO --no-ask / -y flag" {
  # deterministic missing-set (override the real-machine probe).
  ga_brew_missing_set() { printf 'postgresql@17\nbun\ntmux\n'; }
  run ga_cmd_brew_batch
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "brew install postgresql@17 bun tmux" ]]
  # the builder must NOT carry non-interactivity — that is the env's job (HOMEBREW_NO_ASK).
  [[ "${output}" != *"--no-ask"* ]]
  [[ "${output}" != *"--yes"* ]]
  [[ "${output}" != *" -y"* ]]
}

@test "D1: ga_cmd_brew_batch emits empty when the missing-set is empty (skip guard)" {
  ga_brew_missing_set() { printf ''; }
  run ga_cmd_brew_batch
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}

@test "D1: a stubbed brew invoked with the batch argv SEES HOMEBREW_NO_ASK=1" {
  ga_brew_missing_set() { printf 'postgresql@17\nbun\n'; }
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # stub brew records the ask-mode env it was called with, then no-ops.
  printf '#!/bin/bash\nprintf "%%s" "${HOMEBREW_NO_ASK:-UNSET}" > "%s/brew-noask"\nexit 0\n' \
    "${SANDBOX}" >"${stub}/brew"
  chmod +x "${stub}/brew"

  local cmd argv
  cmd="$(ga_cmd_brew_batch)"
  # mirror preflight_run_cmd: split the harness-built string into argv on space (no eval).
  IFS=' ' read -ra argv <<<"${cmd}"
  # run the batch under the consented-block env with the stub brew on PATH.
  PATH="${stub}:${PATH}" HOMEBREW_NO_ASK=1 "${argv[@]}"

  [[ "$(cat "${SANDBOX}/brew-noask")" == "1" ]]
}

# === D1 (static) — the launcher exports HOMEBREW_NO_ASK before the Homebrew step ======

@test "D1(static): launcher exports NONINTERACTIVE + HOMEBREW_NO_ASK + NO_ENV_HINTS as one local -x" {
  run grep -cE '^\s*local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1 HOMEBREW_NO_ENV_HINTS=1\s*$' "${LAUNCHER}"
  [[ "${output}" -eq 1 ]]
}

@test "D1(static): the HOMEBREW_NO_ASK export PRECEDES the Homebrew install call site" {
  local env_ln hb_ln
  env_ln="$(grep -nE '^\s*local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1' "${LAUNCHER}" | head -n1 | cut -d: -f1)"
  hb_ln="$(grep -nF 'preflight_run_or_bail "Homebrew install"' "${LAUNCHER}" | head -n1 | cut -d: -f1)"
  [[ -n "${env_ln}" && -n "${hb_ln}" ]]
  [[ "${env_ln}" -lt "${hb_ln}" ]]
}

# === D3 (static) — framed vs unframed routing per step ================================

@test "D3(static): brew batch / pg service / pg role / claude CLI use the FRAMED runner" {
  grep -qF 'preflight_run_or_bail_framed "brew batch (missing formulae)"' "${LAUNCHER}"
  grep -qF 'preflight_run_or_bail_framed "postgres: start service"' "${LAUNCHER}"
  grep -qF 'preflight_run_or_bail_framed "postgres: create superuser role"' "${LAUNCHER}"
  grep -qF 'preflight_run_or_bail_framed "claude CLI (native installer, npm fallback)"' "${LAUNCHER}"
}

@test "D3(static): the Homebrew installer (sudo) step stays UNframed (raw, visible prompt)" {
  # the unframed runner is used for the sudo step …
  grep -qF 'preflight_run_or_bail "Homebrew install"' "${LAUNCHER}"
  # … and the framed variant is NEVER applied to it (its sudo prompt must stay visible).
  run grep -cF 'preflight_run_or_bail_framed "Homebrew install"' "${LAUNCHER}"
  [[ "${output}" -eq 0 ]]
}

@test "D3(static): preflight_run_or_bail_framed frames via a function-local RENDER_MODE=install" {
  # grab the framed wrapper's body and assert it sets a LOCAL install RENDER_MODE.
  local body
  body="$(awk '/^preflight_run_or_bail_framed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'local RENDER_MODE="install"'* ]]
  [[ "${body}" == *'preflight_run_or_bail "$1" "$2"'* ]]
}

# === consent gate not weakened ========================================================

@test "consent: grouped gate still fronts the batch on a typed confirmation" {
  # the fix must NOT bypass consent — the grouped gate still calls confirm_typed.
  local body
  body="$(awk '/^preflight_grouped_consent\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'confirm_typed'* ]]
}

# === mechanism — function-local export auto-unsets (no leak into bootstrap/monitor) ===

@test "mechanism: a function-local 'local -x' export is UNSET after the function returns" {
  # this is the exact scoping the fix relies on: the consented block's env auto-reverts
  # when run_dependency_preflight returns, so nothing leaks downstream.
  _leak_probe() { local -x GA_TEST_NOASK=1; [[ "${GA_TEST_NOASK}" == "1" ]]; }
  unset GA_TEST_NOASK
  _leak_probe
  [[ -z "${GA_TEST_NOASK:-}" ]]
}

@test "mechanism: a wrapper's 'local RENDER_MODE' frames only its own call, not the caller" {
  # mirrors preflight_run_or_bail_framed: the inner callee sees install, the outer stays "".
  RENDER_MODE=""
  _inner() { printf '%s' "${RENDER_MODE}"; }
  _framed() { local RENDER_MODE="install"; _inner; }
  [[ "$(_framed)" == "install" ]]
  [[ -z "${RENDER_MODE}" ]]
}
