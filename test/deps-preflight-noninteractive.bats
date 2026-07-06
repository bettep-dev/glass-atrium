#!/usr/bin/env bats
# deps-preflight-noninteractive.bats — falsifiable coverage for the bare-Mac dependency
# preflight, spanning the original NON-INTERACTIVE fix (D1/D2/D3) AND the boxed-panel UX
# restructure (the Install preflight now mirrors the Uninstall/Token/Monitor work-box
# pattern in the interactive menu, while the passthrough/CLI path keeps scrolling).
#
# ORIGINAL non-interactive defects:
#   D1  Homebrew 6.x DEFAULT ASK MODE (`brew install` [Y/n]) hangs against the raw-mode
#       TUI. Fix = export HOMEBREW_NO_ASK=1 (NOT NONINTERACTIVE, which does not govern ask
#       mode) in the consented preflight block; ga_cmd_brew_batch stays a clean formula
#       list (no --no-ask flag threaded into the builder).
#   D2  ga_cmd_homebrew_install emitted a `/bin/bash -c "$(curl …)"` STRING that the entry
#       point's word-split argv runner cannot expand — the installer never ran. Fix = emit
#       the single function token `ga_homebrew_install`, run in-process (curl|bash lives in
#       the function), mirroring ga_claude_install.
#   D3  The Homebrew installer step has a LIVE sudo prompt that must stay visible, so it is
#       EXCLUDED from any framed/panel capture path.
#
# BOXED-PANEL restructure contract (the NEW surface this suite pins):
#   * DUAL call-context dispatch: run_dependency_preflight branches into
#     _run_dependency_preflight_boxed (menu: non-owned TTY == /dev/fd/3, work-box render)
#     vs _run_dependency_preflight_scroll (passthrough/CLI: owned fd4, scrolling render).
#   * Interactive gates (Xcode CLT, grouped consent, claude auth, python --break) run in a
#     cooked-scrollback alt-screen bracket (preflight_bracket, mirroring _confirm_pregate).
#   * The two contiguous NON-interactive install groups render INSIDE the work box as 1/1
#     panel steps via preflight_panel_step[_or_bail] (function-local RENDER_MODE=panel).
#   * The passthrough path RETAINS the framed runner (preflight_run_or_bail_framed,
#     function-local RENDER_MODE=install) + scrolling preflight_line/preflight_run_cmd.
#   * G7 fakechat marketplace-add carries a DISTINCT slow-clone ACTIVE label.
#   * G3 python pip --user stays framed; the PEP-668 --break override consent is bracketed.
#   * G8 sqlite is FTS5-CAPABILITY-gated (brew sqlite added only when system sqlite3 lacks
#     the FTS5 module), NOT bare-presence-gated.
#
# Run via: bats test/deps-preflight-noninteractive.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic: ga-deps.sh is a pure sourceable lib (no strict mode, no main guard, no side
# effects) — sourced directly; detect probes are stubbed so no real machine state is read.
# Launcher assertions are STATIC (grep/awk the file text) so no TUI / TTY / real
# brew/pip/claude is ever driven. The one env-delivery test uses a PATH-stubbed brew.

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

# === G8 — sqlite is FTS5-CAPABILITY-gated (not bare presence) =========================

@test "G8: ga_detect_sqlite_fts5 is 'present' when system sqlite3 supports FTS5" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # a sqlite3 that SUCCEEDS the in-memory FTS5 create (module compiled in).
  printf '#!/bin/bash\nexit 0\n' >"${stub}/sqlite3"
  chmod +x "${stub}/sqlite3"
  [[ "$(PATH="${stub}:${PATH}" ga_detect_sqlite_fts5)" == "present" ]]
}

@test "G8: ga_detect_sqlite_fts5 is 'wrong-version' when sqlite3 exists but LACKS FTS5" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # a sqlite3 present on PATH but FAILING the FTS5 create (no FTS5 module).
  printf '#!/bin/bash\nexit 1\n' >"${stub}/sqlite3"
  chmod +x "${stub}/sqlite3"
  [[ "$(PATH="${stub}:${PATH}" ga_detect_sqlite_fts5)" == "wrong-version" ]]
}

@test "G8: ga_detect_sqlite_fts5 is 'absent' when no sqlite3 is on PATH" {
  # empty PATH dir → command -v sqlite3 fails; the detect body is pure builtins otherwise.
  local empty="${SANDBOX}/emptybin"
  mkdir -p "${empty}"
  [[ "$(PATH="${empty}" ga_detect_sqlite_fts5)" == "absent" ]]
}

@test "G8: the FTS5 probe is the cheap read-only in-memory :memory: capability test" {
  local body
  body="$(declare -f ga_detect_sqlite_fts5)"
  # no file, no server, no mutation — a throwaway FTS5 vtable in a :memory: db.
  [[ "${body}" == *'sqlite3 :memory:'* ]]
  [[ "${body}" == *'CREATE VIRTUAL TABLE t USING fts5(x)'* ]]
}

@test "G8: ga_brew_missing_set ADDS 'sqlite' when FTS5 is absent (wrong-version)" {
  # neutralize every other probe so 'sqlite' is the ONLY possible entry.
  ga_detect_sqlite_fts5() { printf 'wrong-version\n'; }
  ga_detect_postgres() { printf 'present\n'; }
  ga_detect_node() { printf 'present\n'; }
  ga_detect_bun() { printf 'present\n'; }
  ga_detect_cli_tool() { printf 'present\n'; }
  run ga_brew_missing_set
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "sqlite" ]]
}

@test "G8: ga_brew_missing_set OMITS 'sqlite' when system sqlite3 already has FTS5" {
  ga_detect_sqlite_fts5() { printf 'present\n'; }
  ga_detect_postgres() { printf 'present\n'; }
  ga_detect_node() { printf 'present\n'; }
  ga_detect_bun() { printf 'present\n'; }
  ga_detect_cli_tool() { printf 'present\n'; }
  run ga_brew_missing_set
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"sqlite"* ]]
}

@test "G8: GA_BREW_CLI_TOOLS no longer bare-presence-gates sqlite (moved to FTS5 branch)" {
  # sqlite must NOT be a plain command:formula entry — it is capability-gated separately.
  local entry
  for entry in "${GA_BREW_CLI_TOOLS[@]}"; do
    [[ "${entry}" != "sqlite3:sqlite" ]]
    [[ "${entry%%:*}" != "sqlite3" ]]
  done
}

# === python — the pip --user / --break-system-packages builder split =================

@test "python: ga_cmd_python_libs_user emits pip --user with NO --break-system-packages" {
  ga_python_missing_set() { printf 'psycopg\nPyYAML\n'; }
  run ga_cmd_python_libs_user
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "python3 -m pip install --user psycopg PyYAML" ]]
  [[ "${output}" != *"--break-system-packages"* ]]
}

@test "python: ga_cmd_python_libs_break_system adds --break-system-packages to the SAME set" {
  ga_python_missing_set() { printf 'psycopg\nPyYAML\n'; }
  run ga_cmd_python_libs_break_system
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "python3 -m pip install --user --break-system-packages psycopg PyYAML" ]]
}

@test "python: both builders emit empty when nothing is missing (skip guard)" {
  ga_python_missing_set() { printf ''; }
  run ga_cmd_python_libs_user
  [[ -z "${output}" ]]
  run ga_cmd_python_libs_break_system
  [[ -z "${output}" ]]
}

# === DUAL call-context dispatch (static) — boxed(menu) vs scroll(passthrough) =========

@test "dispatch(static): run_dependency_preflight discriminates menu fd3 from passthrough" {
  # the guard: non-owned TTY that is exactly the menu's fd3 → boxed; everything else scroll.
  grep -qF 'if [[ "${PREFLIGHT_TTY_OWNED}" == "false" && "${TTY}" == "/dev/fd/3" ]]; then' "${LAUNCHER}"
  # both branch functions are defined.
  grep -qE '^_run_dependency_preflight_boxed\(\) \{' "${LAUNCHER}"
  grep -qE '^_run_dependency_preflight_scroll\(\) \{' "${LAUNCHER}"
  # the dispatcher body routes to each on the correct side.
  local body
  body="$(awk '/^run_dependency_preflight\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'_run_dependency_preflight_boxed'* ]]
  [[ "${body}" == *'_run_dependency_preflight_scroll'* ]]
}

# === interactive gates run in the alt-screen bracket (mirrors _confirm_pregate) =======

@test "gates(static): boxed interactive gates each run in a preflight_bracket" {
  # Xcode CLT + grouped consent + claude auth gates all drop to the cooked-scrollback bracket.
  grep -qF 'preflight_bracket preflight_guide_xcode_clt' "${LAUNCHER}"
  grep -qF 'preflight_bracket preflight_grouped_consent' "${LAUNCHER}"
  grep -qF 'preflight_bracket preflight_guide_claude_auth' "${LAUNCHER}"
}

@test "gates(static): preflight_bracket IS the alt-screen consent bracket (rmcup/smcup)" {
  # mirrors _confirm_pregate: drop the alt-screen + restore cooked stty for the gate, then
  # re-enter the alt-screen + raw mode on return.
  local body
  body="$(awk '/^preflight_bracket\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'tp rmcup'* ]]
  [[ "${body}" == *'tp smcup'* ]]
  [[ "${body}" == *'RAW_ACTIVE=false'* ]]
  [[ "${body}" == *'RAW_ACTIVE=true'* ]]
}

# === menu NON-interactive groups engage the work-box PANEL (RENDER_MODE=panel) ========

@test "panel(static): boxed brew/pg/claude steps engage preflight_panel_step_or_bail" {
  grep -qF 'preflight_panel_step_or_bail "brew batch (missing formulae)"' "${LAUNCHER}"
  grep -qF 'preflight_panel_step_or_bail "postgres: start service"' "${LAUNCHER}"
  grep -qF 'preflight_panel_step_or_bail "postgres: create superuser role"' "${LAUNCHER}"
  grep -qF 'preflight_panel_step_or_bail "claude CLI (native installer, npm fallback)"' "${LAUNCHER}"
}

@test "panel(static): preflight_panel_step frames via a function-local RENDER_MODE=panel" {
  local body
  body="$(awk '/^preflight_panel_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  # 1/1 single-step scaffolding routed into the work box body as a panel step.
  [[ "${body}" == *'STEP_INDEX=1'* ]]
  [[ "${body}" == *'STEP_TOTAL=1'* ]]
  [[ "${body}" == *'local RENDER_MODE="panel"'* ]]
  [[ "${body}" == *'draw_workbox'* ]]
}

@test "panel(static): preflight_panel_step_or_bail delegates to preflight_panel_step" {
  local body
  body="$(awk '/^preflight_panel_step_or_bail\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'preflight_panel_step "$1" "$2" "$3"'* ]]
}

# === passthrough (scroll) path RETAINS the framed runner + scrolling render ============

@test "scroll(static): passthrough brew/pg/claude steps keep preflight_run_or_bail_framed" {
  grep -qF 'preflight_run_or_bail_framed "brew batch (missing formulae)"' "${LAUNCHER}"
  grep -qF 'preflight_run_or_bail_framed "postgres: start service"' "${LAUNCHER}"
  grep -qF 'preflight_run_or_bail_framed "postgres: create superuser role"' "${LAUNCHER}"
  grep -qF 'preflight_run_or_bail_framed "claude CLI (native installer, npm fallback)"' "${LAUNCHER}"
}

@test "scroll(static): preflight_run_or_bail_framed frames via function-local RENDER_MODE=install" {
  local body
  body="$(awk '/^preflight_run_or_bail_framed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'local RENDER_MODE="install"'* ]]
  [[ "${body}" == *'preflight_run_or_bail "$1" "$2"'* ]]
}

@test "scroll(static): the passthrough path renders via scrolling preflight_line/preflight_run_cmd" {
  local body
  body="$(awk '/^_run_dependency_preflight_scroll\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  # scrolling chrome (NOT the work box): the historical banner + inline line renderer.
  [[ "${body}" == *'preflight_line'* ]]
  [[ "${body}" == *'dependency preflight (bare-Mac bootstrap)'* ]]
  # the scroll path must NOT paint into a (never-drawn) work box.
  [[ "${body}" != *'preflight_panel_step'* ]]
}

# === D3 / Homebrew — the sudo installer stays UNframed + off the panel in BOTH paths ==

@test "Homebrew(static): sudo installer stays UNframed + off the spinner panel" {
  # passthrough path: bare unframed runner (its live sudo prompt stays on the visible path).
  grep -qF 'preflight_run_or_bail "Homebrew install"' "${LAUNCHER}"
  # boxed path: a cooked-scrollback bracket (NOT a panel step — a panel fd-capture would
  # swallow the sudo prompt; a bracket carries no TUI spinner at all → "spinner-suppressed").
  grep -qF 'preflight_bracket preflight_run_or_bail "Homebrew install"' "${LAUNCHER}"
  # NEVER framed and NEVER a panel step for the Homebrew installer.
  run grep -cF 'preflight_run_or_bail_framed "Homebrew install"' "${LAUNCHER}"
  [[ "${output}" -eq 0 ]]
  run grep -cF 'preflight_panel_step_or_bail "Homebrew install"' "${LAUNCHER}"
  [[ "${output}" -eq 0 ]]
  run grep -cF 'preflight_panel_step "Homebrew install"' "${LAUNCHER}"
  [[ "${output}" -eq 0 ]]
}

# === D1 (static) — the launcher exports HOMEBREW_NO_ASK before the Homebrew step ======

@test "D1(static): NONINTERACTIVE + HOMEBREW_NO_ASK + NO_ENV_HINTS as one local -x per path" {
  # ONE single-line three-var export in EACH render path (boxed + scroll = 2 total) — never
  # split into three separate exports, and colocated with the consented auto-work block.
  run grep -cE '^\s*local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1 HOMEBREW_NO_ENV_HINTS=1\s*$' "${LAUNCHER}"
  [[ "${output}" -eq 2 ]]
}

@test "D1(static): the HOMEBREW_NO_ASK export PRECEDES the Homebrew install call site" {
  local env_ln hb_ln
  env_ln="$(grep -nE '^\s*local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1' "${LAUNCHER}" | head -n1 | cut -d: -f1)"
  hb_ln="$(grep -nF 'preflight_run_or_bail "Homebrew install"' "${LAUNCHER}" | head -n1 | cut -d: -f1)"
  [[ -n "${env_ln}" && -n "${hb_ln}" ]]
  [[ "${env_ln}" -lt "${hb_ln}" ]]
}

# === G7 — fakechat framed as a panel step with a DISTINCT slow-clone ACTIVE label =====

@test "G7(static): _preflight_fakechat_boxed frames its steps as panel steps" {
  local body
  body="$(awk '/^_preflight_fakechat_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'preflight_panel_step "fakechat: add official marketplace"'* ]]
  [[ "${body}" == *'preflight_panel_step "fakechat: install plugin"'* ]]
}

@test "G7(static): marketplace-add carries a DISTINCT present-progressive slow-clone label" {
  local body
  body="$(awk '/^_preflight_fakechat_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  # the active label flags the ~30s git clone so the box does not read as stalled.
  [[ "${body}" == *'adding marketplace (git clone, may take a minute)…'* ]]
}

@test "G7(static): preflight_panel_step drives STEP_LABEL_ACTIVE_CUR from its active arg" {
  local body
  body="$(awk '/^preflight_panel_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  # $2 (active) feeds the live label, falling back to $1 (resolved) when empty.
  [[ "${body}" == *'STEP_LABEL_ACTIVE_CUR="${active:-${resolved}}"'* ]]
}

# === G3 — python pip --user framed; the PEP-668 --break override consent bracketed ====

@test "G3(static): _preflight_python_libs_boxed frames pip --user AND the --break retry" {
  local body
  body="$(awk '/^_preflight_python_libs_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'preflight_panel_step "python libs (pip --user)"'* ]]
  [[ "${body}" == *'preflight_panel_step "python libs (--break-system-packages)"'* ]]
  # the override consent is HOISTED to an alt-screen bracket (a cooked prompt cannot render
  # in the dimmed box), NOT run inline as a panel step.
  [[ "${body}" == *'preflight_bracket _preflight_python_break_consent'* ]]
}

@test "G3(static): the bracketed --break consent still requires a typed confirmation" {
  local body
  body="$(awk '/^_preflight_python_break_consent\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'confirm_typed "break"'* ]]
}

# === G4 — fakechat + python steps stay NON-FATAL (warn-and-continue) ==================

@test "G4(static): the boxed fakechat + python steps are non-fatal (|| true, never bail)" {
  grep -qF '_preflight_fakechat_boxed || true' "${LAUNCHER}"
  grep -qF '_preflight_python_libs_boxed || true' "${LAUNCHER}"
}

# === consent gate not weakened ========================================================

@test "consent: grouped gate still fronts the batch on a typed confirmation" {
  # the fix must NOT bypass consent — the grouped gate still calls confirm_typed.
  local body
  body="$(awk '/^preflight_grouped_consent\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'confirm_typed'* ]]
}

# === mechanism — function-local export / RENDER_MODE scoping (no leak) =================

@test "mechanism: a function-local 'local -x' export is UNSET after the function returns" {
  # this is the exact scoping the fix relies on: the consented block's env auto-reverts
  # when the preflight returns, so nothing leaks downstream.
  _leak_probe() { local -x GA_TEST_NOASK=1; [[ "${GA_TEST_NOASK}" == "1" ]]; }
  unset GA_TEST_NOASK
  _leak_probe
  [[ -z "${GA_TEST_NOASK:-}" ]]
}

@test "mechanism: a wrapper's 'local RENDER_MODE' frames only its own call, not the caller" {
  # mirrors preflight_panel_step / preflight_run_or_bail_framed: the inner callee sees the
  # framed mode, the outer stays "".
  RENDER_MODE=""
  _inner() { printf '%s' "${RENDER_MODE}"; }
  _framed() { local RENDER_MODE="panel"; _inner; }
  [[ "$(_framed)" == "panel" ]]
  [[ -z "${RENDER_MODE}" ]]
}
