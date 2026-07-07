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
#   * Interactive gates (Xcode CLT, grouped consent, claude auth) run in a
#     cooked-scrollback alt-screen bracket (preflight_bracket, mirroring _confirm_pregate).
#   * The two contiguous NON-interactive install groups render INSIDE the work box as framed
#     panel steps via preflight_panel_step[_or_bail] (function-local RENDER_MODE=panel), each
#     advancing a SHARED clamped i/STEP_TOTAL counter fixed ONCE up-front by
#     preflight_count_and_gate (unified step counter); an all-present group skips its enter_run_state engage so
#     no empty dimmed work box flashes (blank-work-box hang fix). fakechat/marketplace install via in-process
#     function tokens with a background+poll+kill hang guard (install-hang fix).
#   * The passthrough path RETAINS the framed runner (preflight_run_or_bail_framed,
#     function-local RENDER_MODE=install) + scrolling preflight_line/preflight_run_cmd.
#   * G7 fakechat marketplace-add carries a DISTINCT slow-clone ACTIVE label.
#   * G3 python pip --user stays framed; on a PEP-668 failure the --break-system-packages retry
#     AUTO-runs (no typed consent, no bracket) with a VISIBLE override log, non-fatal on retry-fail.
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
  ga_brew_missing_set() { printf 'postgresql@18\nbun\ntmux\n'; }
  run ga_cmd_brew_batch
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "brew install postgresql@18 bun tmux" ]]
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
  ga_brew_missing_set() { printf 'postgresql@18\nbun\n'; }
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
  grep -qF 'if [[ "${PREFLIGHT_TTY_OWNED}" == "false" && "${TTY}" == "/dev/fd/3" ]]; then' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  # both branch functions are defined.
  grep -qE '^_run_dependency_preflight_boxed\(\) \{' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qE '^_run_dependency_preflight_scroll\(\) \{' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  # the dispatcher body routes to each on the correct side.
  local body
  body="$(awk '/^run_dependency_preflight\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'_run_dependency_preflight_boxed'* ]]
  [[ "${body}" == *'_run_dependency_preflight_scroll'* ]]
}

# === interactive gates run in the alt-screen bracket (mirrors _confirm_pregate) =======

@test "gates(static): boxed interactive gates each run in a preflight_bracket" {
  # Xcode CLT + grouped consent + claude auth gates all drop to the cooked-scrollback bracket.
  grep -qF 'preflight_bracket preflight_guide_xcode_clt' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_bracket preflight_grouped_consent' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_bracket preflight_guide_claude_auth' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
}

@test "gates(static): preflight_bracket IS the alt-screen consent bracket (rmcup/smcup)" {
  # mirrors _confirm_pregate: drop the alt-screen + restore cooked stty for the gate, then
  # re-enter the alt-screen + raw mode on return.
  local body
  body="$(awk '/^preflight_bracket\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'tp rmcup'* ]]
  [[ "${body}" == *'tp smcup'* ]]
  [[ "${body}" == *'RAW_ACTIVE=false'* ]]
  [[ "${body}" == *'RAW_ACTIVE=true'* ]]
}

# === menu NON-interactive groups engage the work-box PANEL (RENDER_MODE=panel) ========

@test "panel(static): boxed brew/pg/claude steps engage preflight_panel_step_or_bail" {
  grep -qF 'preflight_panel_step_or_bail "brew batch (missing formulae)"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_panel_step_or_bail "postgres: start service"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_panel_step_or_bail "postgres: create superuser role"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_panel_step_or_bail "claude CLI (native installer, npm fallback)"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
}

@test "panel(static): preflight_panel_step advances a SHARED clamped STEP_INDEX (unified counter, no 1/1 hardcode)" {
  local body
  body="$(awk '/^preflight_panel_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # Shared-counter contract: advance the shared STEP_INDEX, NEVER reset STEP_TOTAL here,
  # CLAMP i <= N so an imperfect up-front estimate degrades to an N/N tail (never "7/5").
  [[ "${body}" == *'STEP_INDEX=$((${STEP_INDEX:-0} + 1))'* ]]
  [[ "${body}" == *'-gt "${STEP_TOTAL}"'* ]]        # the clamp condition (i > N)
  [[ "${body}" == *'STEP_INDEX="${STEP_TOTAL}"'* ]] # the clamp assignment (pin to N)
  # the OLD 1/1 single-step hardcode is GONE (STEP_TOTAL is owned by preflight_count_and_gate).
  [[ "${body}" != *'STEP_INDEX=1'* ]]
  [[ "${body}" != *'STEP_TOTAL=1'* ]]
  # still routes into the work box body as a panel step.
  [[ "${body}" == *'local RENDER_MODE="panel"'* ]]
  [[ "${body}" == *'draw_workbox'* ]]
}

@test "panel(static): preflight_panel_step_or_bail delegates to preflight_panel_step" {
  local body
  body="$(awk '/^preflight_panel_step_or_bail\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'preflight_panel_step "$1" "$2" "$3"'* ]]
}

# === passthrough (scroll) path RETAINS the framed runner + scrolling render ============

@test "scroll(static): passthrough brew/pg/claude steps keep preflight_run_or_bail_framed" {
  grep -qF 'preflight_run_or_bail_framed "brew batch (missing formulae)"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_run_or_bail_framed "postgres: start service"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_run_or_bail_framed "postgres: create superuser role"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF 'preflight_run_or_bail_framed "claude CLI (native installer, npm fallback)"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
}

@test "scroll(static): preflight_run_or_bail_framed frames via function-local RENDER_MODE=install" {
  local body
  body="$(awk '/^preflight_run_or_bail_framed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'local RENDER_MODE="install"'* ]]
  [[ "${body}" == *'preflight_run_or_bail "$1" "$2"'* ]]
}

@test "scroll(static): the passthrough path renders via scrolling preflight_line/preflight_run_cmd" {
  local body
  body="$(awk '/^_run_dependency_preflight_scroll\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
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
  grep -qF 'preflight_run_or_bail "Homebrew install"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  # boxed path: a cooked-scrollback bracket (NOT a panel step — a panel fd-capture would
  # swallow the sudo prompt; a bracket carries no TUI spinner at all → "spinner-suppressed").
  grep -qF 'preflight_bracket preflight_run_or_bail "Homebrew install"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  # NEVER framed and NEVER a panel step for the Homebrew installer.
  run awk -v p='preflight_run_or_bail_framed "Homebrew install"' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 0 ]]
  run awk -v p='preflight_panel_step_or_bail "Homebrew install"' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 0 ]]
  run awk -v p='preflight_panel_step "Homebrew install"' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 0 ]]
}

# === D1 (static) — the launcher exports HOMEBREW_NO_ASK before the Homebrew step ======

@test "D1(static): NONINTERACTIVE + HOMEBREW_NO_ASK + NO_ENV_HINTS as one local -x per path" {
  # ONE single-line three-var export in EACH render path (boxed + scroll = 2 total) — never
  # split into three separate exports, and colocated with the consented auto-work block.
  run awk '/^[[:space:]]*local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1 HOMEBREW_NO_ENV_HINTS=1[[:space:]]*$/{c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 2 ]]
}

@test "D1(static): the HOMEBREW_NO_ASK export PRECEDES the Homebrew install call site" {
  local env_ln hb_ln
  env_ln="$(grep -nE '^\s*local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1' "${GA}"/lib/ga-tui-preflight.sh | head -n1 | cut -d: -f1)"
  hb_ln="$(grep -nF 'preflight_run_or_bail "Homebrew install"' "${GA}"/lib/ga-tui-preflight.sh | head -n1 | cut -d: -f1)"
  [[ -n "${env_ln}" && -n "${hb_ln}" ]]
  [[ "${env_ln}" -lt "${hb_ln}" ]]
}

# === G7 — fakechat framed as a panel step with a DISTINCT slow-clone ACTIVE label =====

@test "G7(static): _preflight_fakechat_boxed frames its steps as panel steps" {
  local body
  body="$(awk '/^_preflight_fakechat_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'preflight_panel_step "fakechat: add official marketplace"'* ]]
  [[ "${body}" == *'preflight_panel_step "fakechat: install plugin"'* ]]
}

@test "G7(static): marketplace-add carries a DISTINCT present-progressive slow-clone label" {
  local body
  body="$(awk '/^_preflight_fakechat_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # the active label flags the ~30s git clone so the box does not read as stalled.
  [[ "${body}" == *'adding marketplace (git clone, may take a minute)…'* ]]
}

@test "G7(static): preflight_panel_step drives STEP_LABEL_ACTIVE_CUR from its active arg" {
  local body
  body="$(awk '/^preflight_panel_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # $2 (active) feeds the live label, falling back to $1 (resolved) when empty.
  [[ "${body}" == *'STEP_LABEL_ACTIVE_CUR="${active:-${resolved}}"'* ]]
}

# === G3 — python pip --user framed; PEP-668 --break-system-packages retry AUTO-runs =====

@test "G3(static): _preflight_python_libs_boxed frames pip --user AND the --break retry" {
  local body
  body="$(awk '/^_preflight_python_libs_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'preflight_panel_step "python libs (pip --user)"'* ]]
  [[ "${body}" == *'preflight_panel_step "python libs (--break-system-packages)"'* ]]
}

@test "G3(static): the boxed --break retry AUTO-runs — NO bracket, NO typed consent" {
  local body
  body="$(awk '/^_preflight_python_libs_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # the override no longer sits behind a second gate: no alt-screen bracket, no confirm_typed.
  [[ "${body}" != *'preflight_bracket'* ]]
  [[ "${body}" != *'confirm_typed'* ]]
  # with no bracket tearing down the frame, no enter_run_state re-engage is needed either.
  [[ "${body}" != *'enter_run_state'* ]]
}

@test "G3(static): the boxed override is surfaced VISIBLY (active-label documents --break)" {
  local body
  body="$(awk '/^_preflight_python_libs_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # the retry panel step carries a non-empty ACTIVE label naming the override (visible, not silent).
  [[ "${body}" == *'auto-retrying with --break-system-packages'* ]]
}

@test "G3(static): the scroll variant AUTO-retries with a VISIBLE override log, no typed consent" {
  local body
  body="$(awk '/^preflight_install_python_libs\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'preflight_run_cmd "python libs (pip --user)"'* ]]
  [[ "${body}" == *'preflight_run_cmd "python libs (--break-system-packages)"'* ]]
  # NO second typed gate — the retry auto-proceeds.
  [[ "${body}" != *'confirm_typed'* ]]
  # the override is LOGGED visibly via preflight_line naming --break-system-packages.
  [[ "${body}" == *'preflight_line'* ]]
  [[ "${body}" == *'auto-retrying with --break-system-packages'* ]]
}

@test "G3(static): the dead _preflight_python_break_consent helper is REMOVED" {
  # the second typed gate is gone → its helper must not linger anywhere in the launcher.
  ! grep -qF '_preflight_python_break_consent' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
}

# === G4 — fakechat + python steps stay NON-FATAL (warn-and-continue) ==================

@test "G4(static): the boxed fakechat + python steps are non-fatal (|| true, never bail)" {
  grep -qF '_preflight_fakechat_boxed || true' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  grep -qF '_preflight_python_libs_boxed || true' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
}

# === consent gate not weakened ========================================================

@test "consent: grouped gate still fronts the batch on a typed confirmation" {
  # the fix must NOT bypass consent — the grouped gate still calls confirm_typed.
  local body
  body="$(awk '/^preflight_grouped_consent\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
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

# === Up-front count pass: shared STEP_TOTAL + per-group runnable counts ===========

# extract_launcher_fn — eval a single named launcher function into the test shell so it can be
# DRIVEN dynamically (its detect/render deps are stubbed by each caller) without booting the TUI.
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

@test "count(cold): cold Mac (postgresql@18 in brew missing-set) counts BOTH pg steps → 7 total" {
  extract_launcher_fn preflight_count_and_gate
  # cold bare-Mac: the brew missing-set carries postgresql@18 (a FRESH cluster) + claude absent.
  # The STALE live ga_detect_postgres reads 'absent' up-front (psql is still inside the brew batch),
  # so a live-detect count would WRONGLY zero the pg steps — the missing-set derivation must win.
  ga_brew_missing_set() { printf 'postgresql@18\nnode@24\nbun\nsqlite\n'; }
  ga_detect_postgres() { printf 'absent\n'; }            # stale — must NOT drive the pg count
  ga_detect_postgres_role() { printf 'present-but-down\n'; }
  ga_detect_claude_cli() { printf 'absent\n'; }
  ga_detect_fakechat() { printf 'present-but-down\n'; }
  ga_marketplace_present() { printf 'no\n'; }
  ga_detect_python_libs() { printf 'absent\n'; }
  STEP_TOTAL=""
  STEP_INDEX="sentinel"
  preflight_count_and_gate
  # GROUP1 = brew(1) + pg service+role(2, missing-set-derived) + claude(1) = 4
  [[ "${PREFLIGHT_GROUP1_RUNNABLE}" -eq 4 ]]
  # GROUP2 = fakechat marketplace+plugin(2, claude-absent-derived) + python(1) = 3
  [[ "${PREFLIGHT_GROUP2_RUNNABLE}" -eq 3 ]]
  # BOXED-STEPS-ONLY shared total (Homebrew + gates excluded), fixed ONCE = 7.
  [[ "${STEP_TOTAL}" -eq 7 ]]
  # STEP_INDEX reset to empty (no 0/N pre-flash before the first framed step increments it).
  [[ -z "${STEP_INDEX}" ]]
}

@test "count(warm): warm machine (pg NOT in missing-set) uses live down/role-absent fallback" {
  extract_launcher_fn preflight_count_and_gate
  ga_brew_missing_set() { printf ''; }                   # nothing brew-missing
  ga_detect_postgres() { printf 'present-but-down\n'; }  # warm: server down
  ga_detect_postgres_role() { printf 'absent\n'; }       # warm: role missing
  ga_detect_claude_cli() { printf 'present\n'; }
  ga_detect_fakechat() { printf 'present\n'; }           # fakechat present → 0 fakechat steps
  ga_marketplace_present() { printf 'yes\n'; }
  ga_detect_python_libs() { printf 'present\n'; }
  preflight_count_and_gate
  # GROUP1 = brew(0) + pg service(1)+role(1) via WARM fallback + claude(0) = 2
  [[ "${PREFLIGHT_GROUP1_RUNNABLE}" -eq 2 ]]
  # GROUP2 = 0 (fakechat present + python present) → blank-box skip-empty engage
  [[ "${PREFLIGHT_GROUP2_RUNNABLE}" -eq 0 ]]
  [[ "${STEP_TOTAL}" -eq 2 ]]
}

@test "count(plugin-only): claude present + fakechat absent + marketplace present counts plugin only" {
  extract_launcher_fn preflight_count_and_gate
  ga_brew_missing_set() { printf ''; }
  ga_detect_postgres() { printf 'present\n'; }
  ga_detect_postgres_role() { printf 'present\n'; }
  ga_detect_claude_cli() { printf 'present\n'; }
  ga_detect_fakechat() { printf 'absent\n'; }            # plugin WILL install
  ga_marketplace_present() { printf 'yes\n'; }           # marketplace-add SKIPPED (already present)
  ga_detect_python_libs() { printf 'present\n'; }
  preflight_count_and_gate
  [[ "${PREFLIGHT_GROUP1_RUNNABLE}" -eq 0 ]]
  [[ "${PREFLIGHT_GROUP2_RUNNABLE}" -eq 1 ]] # plugin only
  [[ "${STEP_TOTAL}" -eq 1 ]]
}

@test "count(all-present): all-present machine yields STEP_TOTAL=0 + both groups empty (full skip)" {
  extract_launcher_fn preflight_count_and_gate
  ga_brew_missing_set() { printf ''; }
  ga_detect_postgres() { printf 'present\n'; }
  ga_detect_postgres_role() { printf 'present\n'; }
  ga_detect_claude_cli() { printf 'present\n'; }
  ga_detect_fakechat() { printf 'present\n'; }
  ga_marketplace_present() { printf 'yes\n'; }
  ga_detect_python_libs() { printf 'present\n'; }
  preflight_count_and_gate
  [[ "${PREFLIGHT_GROUP1_RUNNABLE}" -eq 0 ]]
  [[ "${PREFLIGHT_GROUP2_RUNNABLE}" -eq 0 ]]
  [[ "${STEP_TOTAL}" -eq 0 ]]
}

@test "counter(clamp): preflight_panel_step advances a shared STEP_INDEX + CLAMPS at STEP_TOTAL" {
  # stub the heavy render/run deps so only the shared-counter arithmetic executes.
  draw_workbox() { :; }
  build_run_bar() { :; }
  preflight_run_cmd() { return 0; }
  C_ACCENT=""
  STEP_LAST_FAIL_LOG=""
  extract_launcher_fn preflight_panel_step
  # the count pass fixes the total ONCE at 5; the index starts empty.
  STEP_TOTAL=5
  STEP_INDEX=""
  local seen="" i
  for i in 1 2 3 4 5 6 7; do
    preflight_panel_step "step ${i}" "" "true"
    seen="${seen}${STEP_INDEX} "
  done
  # increments 1..5 across BOTH groups' worth of steps, then CLAMPS at 5 (never 6/5 or 7/5).
  [[ "${seen}" == "1 2 3 4 5 5 5 " ]]
  # STEP_TOTAL is NEVER reset by the writer (stays the shared 5).
  [[ "${STEP_TOTAL}" -eq 5 ]]
}

# === Skip-empty enter_run_state engage (no empty dimmed work box) =================

@test "blank-box(static): both enter_run_state engages are gated on their group runnable-count" {
  local body
  body="$(awk '/^_run_dependency_preflight_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # the up-front count pass runs BEFORE the engages.
  [[ "${body}" == *'preflight_count_and_gate'* ]]
  # ENGAGE1 gated on GROUP1 > 0; ENGAGE2 gated on GROUP2 > 0 (skip the empty dimmed box).
  [[ "${body}" == *'[[ "${PREFLIGHT_GROUP1_RUNNABLE}" -gt 0 ]] && enter_run_state'* ]]
  [[ "${body}" == *'[[ "${PREFLIGHT_GROUP2_RUNNABLE}" -gt 0 ]] && enter_run_state'* ]]
  # The blank-box guard's real rule is "a dimmed box must never be EMPTY". The two ENGAGE points stay group-gated
  # (above); any OTHER bare 'enter_run_state' is permitted ONLY when the very next line is
  # start_idle_spinner — the async-feel animated enter (the box is alive, never an empty dimmed
  # frame). So: assert ZERO bare enter_run_state lines that are NOT immediately idle-animated.
  run awk '
    /^[[:space:]]*enter_run_state[[:space:]]*$/ { pend=1; next }
    pend==1 { if ($0 !~ /start_idle_spinner/) { bad++ } pend=0 }
    END { print bad + 0 }
  ' <<<"${body}"
  [[ "${output}" -eq 0 ]]
}

# === STEP 1 — run_step pins the CAPTURED exec's stdin to /dev/null (P1 install-stall) ====

@test "STEP1(static): run_step redirects the captured exec stdin from /dev/null in BOTH branches" {
  local body
  body="$(awk '/^run_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # install/panel branch: fd1+fd2 captured AND stdin pinned to EOF.
  [[ "${body}" == *'{ "$@" </dev/null >"${STEP_LOG}" 2>&1; }'* ]]
  # else (historical fd-2-only) branch: stdin pinned to EOF too.
  [[ "${body}" == *'{ "$@" </dev/null 2>"${STEP_LOG}"; }'* ]]
  # the OLD un-pinned captures are GONE (no branch execs with an inherited terminal stdin).
  [[ "${body}" != *'{ "$@" >"${STEP_LOG}" 2>&1; }'* ]]
  [[ "${body}" != *'{ "$@" 2>"${STEP_LOG}"; }'* ]]
}

# === STEP 2 — ga_pg_wait_ready: bounded live-server poll after an attempted start ========

@test "STEP2: ga_pg_wait_ready is defined + bounded (hard ceiling, no unbounded until-loop)" {
  declare -F ga_pg_wait_ready
  local body
  body="$(declare -f ga_pg_wait_ready)"
  # a HARD counter ceiling gates the loop — the mandatory bound against a NEW infinite-hang path.
  [[ "${body}" == *'ceiling=15'* ]]
  [[ "${body}" == *'-lt "${ceiling}"'* ]]
  [[ "${body}" == *'waited=$((waited + 1))'* ]]
  # probes: pg_isready primary, psql SELECT 1 fallback — both on the peer-auth socket SoT.
  [[ "${body}" == *'pg_isready -h "${PG_SOCKET}"'* ]]
  [[ "${body}" == *"psql -h \"\${PG_SOCKET}\" -d postgres -tAc 'SELECT 1'"* ]]
  # non-zero on timeout (the caller bails loudly).
  [[ "${body}" == *'return 1'* ]]
}

@test "STEP2(live): ga_pg_wait_ready returns 0 as soon as pg_isready reports ready" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # a pg_isready that reports ready immediately → the poll returns 0 on the first iteration.
  printf '#!/bin/bash\nexit 0\n' >"${stub}/pg_isready"
  chmod +x "${stub}/pg_isready"
  PG_SOCKET="/tmp"
  local rc=0
  PATH="${stub}:${PATH}" ga_pg_wait_ready || rc=$?
  [[ "${rc}" -eq 0 ]]
}

@test "STEP2(live): ga_pg_wait_ready TIMES OUT non-zero when the server never answers" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # a pg_isready that NEVER reports ready + a psql that never connects → runs to the ceiling.
  printf '#!/bin/bash\nexit 1\n' >"${stub}/pg_isready"
  printf '#!/bin/bash\nexit 1\n' >"${stub}/psql"
  chmod +x "${stub}/pg_isready" "${stub}/psql"
  # collapse the poll interval to instant so the 15-iteration ceiling completes at once.
  sleep() { return 0; }
  PG_SOCKET="/tmp"
  local rc=0
  PATH="${stub}:${PATH}" ga_pg_wait_ready || rc=$?
  [[ "${rc}" -eq 1 ]]
}

@test "STEP2(static): both run-sites wait for readiness INSIDE the present-but-down start block" {
  # scroll path: the wait step is framed AND sits inside the start branch (start attempted only).
  grep -qF 'preflight_run_or_bail_framed "postgres: wait until ready" "ga_pg_wait_ready"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  # boxed path: the wait is a framed panel step, same placement.
  grep -qF 'preflight_panel_step_or_bail "postgres: wait until ready" "" "ga_pg_wait_ready"' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  # ordering: in EACH path the wait step immediately follows the service-start step.
  local scroll boxed
  scroll="$(awk '/^_run_dependency_preflight_scroll\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  boxed="$(awk '/^_run_dependency_preflight_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  local start_ln wait_ln
  start_ln="$(grep -nF 'postgres: start service' <<<"${scroll}" | head -n1 | cut -d: -f1)"
  wait_ln="$(grep -nF 'postgres: wait until ready' <<<"${scroll}" | head -n1 | cut -d: -f1)"
  [[ -n "${start_ln}" && -n "${wait_ln}" && "${start_ln}" -lt "${wait_ln}" ]]
  start_ln="$(grep -nF 'postgres: start service' <<<"${boxed}" | head -n1 | cut -d: -f1)"
  wait_ln="$(grep -nF 'postgres: wait until ready' <<<"${boxed}" | head -n1 | cut -d: -f1)"
  [[ -n "${start_ln}" && -n "${wait_ln}" && "${start_ln}" -lt "${wait_ln}" ]]
}

# === STEP 3 — role-create RUN-site gate `!= present`; COUNT stays conservative `== absent` =

@test "STEP3(static): both role-create RUN-sites gate on != present (post-readiness idempotent)" {
  local scroll boxed
  scroll="$(awk '/^_run_dependency_preflight_scroll\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  boxed="$(awk '/^_run_dependency_preflight_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  # scroll keeps the inline substitution gate; boxed (idle-bracketed) captures the verdict first,
  # then gates the CAPTURED var on != present — identical != present semantics, no == absent RUN-site gate.
  [[ "${scroll}" == *'if [[ "$(ga_detect_postgres_role)" != "present" ]]; then'* ]]
  [[ "${boxed}" == *'pg_role_verdict="$(ga_detect_postgres_role)"'* ]]
  [[ "${boxed}" == *'if [[ "${pg_role_verdict}" != "present" ]]; then'* ]]
  # the OLD `== absent` RUN-site gate is gone from BOTH create call-sites.
  [[ "${scroll}" != *'ga_detect_postgres_role)" == "absent"'* ]]
  [[ "${boxed}" != *'ga_detect_postgres_role)" == "absent"'* ]]
}

@test "STEP3(static): preflight_count_and_gate KEEPS the conservative == absent role count" {
  # the count must NOT mirror `!= present` — that OVER-counts a warm machine whose role already
  # exists (post-readiness role=='present' → step skipped → bar stuck at N-1/N). Under-count +
  # clamp is the safe direction.
  local body
  body="$(awk '/^preflight_count_and_gate\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'ga_detect_postgres_role)" == "absent"'* ]]
  [[ "${body}" != *'ga_detect_postgres_role)" != "present"'* ]]
}

@test "STEP3(count): warm machine whose role ALREADY exists does NOT count the role step" {
  # regression guard for the stuck N-1/N bar: role present up-front → role NOT counted, only pg-service.
  extract_launcher_fn preflight_count_and_gate
  ga_brew_missing_set() { printf ''; }                   # pg NOT in the brew missing-set (warm)
  ga_detect_postgres() { printf 'present-but-down\n'; }  # service WILL start (+1)
  ga_detect_postgres_role() { printf 'present\n'; }      # role already exists → NOT counted
  ga_detect_claude_cli() { printf 'present\n'; }
  ga_detect_fakechat() { printf 'present\n'; }
  ga_marketplace_present() { printf 'yes\n'; }
  ga_detect_python_libs() { printf 'present\n'; }
  preflight_count_and_gate
  [[ "${PREFLIGHT_GROUP1_RUNNABLE}" -eq 1 ]] # pg-service only, role uncounted (conservative)
  [[ "${STEP_TOTAL}" -eq 1 ]]
}

# === STEP 4 — version-agnostic keg-inject (brew-keg-first, not stale-psql-first) =========

@test "STEP4: ga_pg_keg_major prefers the highest brew keg, IGNORING a stale lower-major psql on PATH" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # a stale psql 14 on PATH — the psql-client-first resolver would WRONGLY pick 14 for the inject.
  printf '#!/bin/bash\n[[ "$1" == "--version" ]] && echo "psql (PostgreSQL) 14.11"\nexit 0\n' >"${stub}/psql"
  # brew list --versions reports BOTH kegs installed → sort -rn must pick the highest (17).
  printf '#!/bin/bash\nif [[ "$1" == "list" ]]; then echo "postgresql@14 14.11"; echo "postgresql@17 17.2"; fi\nexit 0\n' >"${stub}/brew"
  chmod +x "${stub}/psql" "${stub}/brew"
  # keg-inject resolver is brew-keg-first → 17 (NOT the stale psql 14).
  [[ "$(PATH="${stub}:${PATH}" ga_pg_keg_major)" == "17" ]]
  # contrast (falsifiable): the service-NAMING resolver IS psql-client-first → 14 — the exact
  # pitfall ga_pg_keg_major exists to avoid for the keg-inject purpose.
  [[ "$(PATH="${stub}:${PATH}" ga_pg_installed_major)" == "14" ]]
}

@test "STEP4: ga_pg_keg_major is empty when no brew keg exists (caller then defaults to the pin)" {
  local empty="${SANDBOX}/emptybin"
  mkdir -p "${empty}"
  # no brew on PATH → command -v brew fails → empty (never a spurious major).
  [[ -z "$(PATH="${empty}" ga_pg_keg_major)" ]]
}

@test "STEP4: preflight_keg_path_inject_pg injects the resolved major, defaulting to @18 when none" {
  extract_launcher_fn preflight_keg_path_inject_pg
  local captured=""
  preflight_keg_path_inject() { captured="$1"; }
  # resolved major present → inject THAT keg (a present-but-down PG14 → postgresql@14).
  ga_pg_keg_major() { printf '14'; }
  preflight_keg_path_inject_pg
  [[ "${captured}" == "postgresql@14" ]]
  # empty resolver → default to the fresh-install pin @18.
  ga_pg_keg_major() { printf ''; }
  preflight_keg_path_inject_pg
  [[ "${captured}" == "postgresql@18" ]]
}

@test "STEP4(static): both keg-inject sites use preflight_keg_path_inject_pg (no literal postgresql@N)" {
  # 1 definition + 2 call-sites.
  run awk -v p='preflight_keg_path_inject_pg' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -ge 3 ]]
  # no literal postgresql@N KEG-INJECT call — the resolver owns the version (fresh-pin @18
  # references live in the missing-set / default fallbacks, NOT as a keg-inject literal).
  run awk '/preflight_keg_path_inject postgresql@[0-9]/{c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 0 ]]
  # node@24 keg-inject stays literal at both sites (single pinned major, unchanged).
  run awk -v p='preflight_keg_path_inject node@24' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 2 ]]
}

# === fakechat/marketplace in-process tokens + background+poll+kill hang guard =====

@test "hang-guard: ga_cmd_fakechat_install emits the in-process function token ga_fakechat_install" {
  run ga_cmd_fakechat_install
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "ga_fakechat_install" ]]
  set -- ${output} # a single bare word survives the word-split argv runner
  [[ "$#" -eq 1 ]]
  declare -F ga_fakechat_install # the token resolves to a real in-process function
}

@test "hang-guard: ga_cmd_marketplace_add emits the in-process function token ga_marketplace_add" {
  run ga_cmd_marketplace_add
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "ga_marketplace_add" ]]
  set -- ${output}
  [[ "$#" -eq 1 ]]
  declare -F ga_marketplace_add
}

@test "hang-guard(body): ga_fakechat_install backgrounds w/ fd hygiene, polls, KILLS on success AND timeout, reaps" {
  local body
  body="$(awk '/^ga_fakechat_install\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${DEPS_SH}")"
  [[ -n "${body}" ]]
  # background the claude install with BOTH fds to /dev/null (STEP_LOG hygiene), capture the pid.
  [[ "${body}" == *'>/dev/null 2>&1 &'* ]]
  [[ "${body}" == *'pid=$!'* ]]
  # poll the detect verdict with a >=2s interval under a 120s ceiling.
  [[ "${body}" == *'ga_detect_fakechat'* ]]
  [[ "${body}" == *'sleep 2'* ]]
  [[ "${body}" == *'-lt 120'* ]]
  # kill on BOTH success and timeout, then wait/reap — TWO kill+wait pairs, errors suppressed.
  [[ "$(grep -c 'kill "${pid}" 2>/dev/null || true' <<<"${body}")" -eq 2 ]]
  [[ "$(grep -c 'wait "${pid}" 2>/dev/null || true' <<<"${body}")" -eq 2 ]]
  # NON-FATAL: the timeout tail returns failure (the caller ||true-s it).
  [[ "${body}" == *'return 1'* ]]
}

@test "hang-guard(live): ga_fakechat_install exits 0 on stubbed-present, killing+reaping the hung bg pid" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # a 'claude' that HANGS after 'success' (the live no-exit repro); exec keeps a SINGLE pid to kill
  # (matches the live repro: no surviving children). A UNIQUE sleep sentinel makes pgrep precise.
  printf '#!/bin/bash\nexec sleep 918273645\n' >"${stub}/claude"
  chmod +x "${stub}/claude"
  # detect flips to present on the FIRST poll → the loop kills the stuck pid and returns 0 fast.
  ga_detect_fakechat() { printf 'present\n'; }
  PATH="${stub}:${PATH}"
  local rc=0
  ga_fakechat_install || rc=$?
  [[ "${rc}" -eq 0 ]]
  # the backgrounded claude was killed+reaped — no leaked child survives.
  run pgrep -f '918273645'
  [[ "${status}" -ne 0 ]]
}

@test "hang-guard(live): ga_fakechat_install is NON-FATAL (returns 1) + reaps the pid on the timeout ceiling" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # a live-forever 'claude' (UNIQUE sentinel) so the timeout branch has a real pid to reap.
  printf '#!/bin/bash\nexec sleep 918273646\n' >"${stub}/claude"
  chmod +x "${stub}/claude"
  # detect NEVER reports present → the loop runs to the 120s ceiling.
  ga_detect_fakechat() { printf 'absent\n'; }
  # collapse the poll interval to instant so the 60-iteration ceiling completes at once. NOT
  # exported → the child 'claude' stub keeps the REAL sleep (stays alive to be killed at timeout).
  sleep() { return 0; }
  PATH="${stub}:${PATH}"
  local rc=0
  ga_fakechat_install || rc=$?
  [[ "${rc}" -eq 1 ]] # non-fatal failure verdict
  run pgrep -f '918273646'
  [[ "${status}" -ne 0 ]] # the live bg claude was killed+reaped at the ceiling
}

# === R1 — PostgreSQL @18 fresh pin + initdb fallback (uninitialized data dir) ============

@test "R1(pin): postgresql@18 is the fresh-install missing-set pin (absent PG), never @17" {
  ga_detect_postgres() { printf 'absent\n'; }
  ga_detect_node() { printf 'present\n'; }
  ga_detect_bun() { printf 'present\n'; }
  ga_detect_sqlite_fts5() { printf 'present\n'; }
  ga_detect_cli_tool() { printf 'present\n'; }
  run ga_brew_missing_set
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"postgresql@18"* ]]
  [[ "${output}" != *"postgresql@17"* ]]
}

@test "R1(service): ga_cmd_pg_service_start defaults to @18 when no major resolves" {
  # neither psql on PATH nor a brew keg → the fresh-install pin default.
  command() { return 1; } # force `command -v psql/brew` to miss
  run ga_cmd_pg_service_start
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "brew services start postgresql@18" ]]
}

@test "R1(restart): ga_cmd_pg_service_restart emits a RESTART line, default @18" {
  command() { return 1; }
  run ga_cmd_pg_service_restart
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "brew services restart postgresql@18" ]]
}

@test "R1(initdb-token): ga_cmd_pg_initdb emits the single in-process token ga_pg_initdb" {
  run ga_cmd_pg_initdb
  [[ "${status}" -eq 0 ]]
  local tok; tok="$(printf '%s' "${output}" | tr -d '[:space:]')"
  set -- ${output}
  [[ "$#" -eq 1 ]]
  [[ "${tok}" == "ga_pg_initdb" ]]
}

# NOTE: the stub var is PGSTUB_PREFIX, NOT `prefix` — ga_pg_data_dir declares a `local
# prefix`, so a same-named stub var would be shadowed under bash dynamic scope (the stub
# would read the function's empty local instead of the test's path).
@test "R1(detect): ga_pg_data_dir_initialized is 'no' for an UNINITIALIZED brew keg data dir" {
  PGSTUB_PREFIX="${SANDBOX}/brew"
  mkdir -p "${PGSTUB_PREFIX}/var/postgresql@18" # dir exists but NO PG_VERSION marker
  ga_pg_keg_major() { printf '18'; }
  ga_brew_prefix() { printf '%s' "${PGSTUB_PREFIX}"; }
  run ga_pg_data_dir_initialized
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "no" ]]
}

@test "R1(detect): ga_pg_data_dir_initialized is 'yes' once the PG_VERSION marker exists" {
  PGSTUB_PREFIX="${SANDBOX}/brew"
  mkdir -p "${PGSTUB_PREFIX}/var/postgresql@18"
  printf '18\n' >"${PGSTUB_PREFIX}/var/postgresql@18/PG_VERSION"
  ga_pg_keg_major() { printf '18'; }
  ga_brew_prefix() { printf '%s' "${PGSTUB_PREFIX}"; }
  run ga_pg_data_dir_initialized
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "yes" ]]
}

@test "R1(detect): ga_pg_data_dir_initialized is 'yes' when NO brew keg (non-brew cluster, skip initdb)" {
  ga_pg_keg_major() { printf ''; } # no brew postgresql@N keg installed
  run ga_pg_data_dir_initialized
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "yes" ]]
}

@test "R1(initdb-guard): ga_pg_initdb HARD-SKIPS an already-initialized cluster (never re-initdb)" {
  PGSTUB_PREFIX="${SANDBOX}/brew"
  mkdir -p "${PGSTUB_PREFIX}/var/postgresql@18"
  printf '18\n' >"${PGSTUB_PREFIX}/var/postgresql@18/PG_VERSION"
  ga_pg_keg_major() { printf '18'; }
  ga_brew_prefix() { printf '%s' "${PGSTUB_PREFIX}"; }
  # a poisoned initdb stub must NEVER be reached (skip on PG_VERSION present).
  local stub="${SANDBOX}/bin"; mkdir -p "${stub}"
  printf '#!/bin/bash\ntouch "%s/initdb-RAN"\nexit 0\n' "${SANDBOX}" >"${stub}/initdb"
  chmod +x "${stub}/initdb"
  PATH="${stub}:${PATH}" ga_pg_initdb
  [[ ! -e "${SANDBOX}/initdb-RAN" ]] # destructive re-init was prevented
}

@test "R1(initdb-fires): ga_pg_initdb runs initdb -D <dir> --encoding=UTF8 on an uninitialized dir" {
  PGSTUB_PREFIX="${SANDBOX}/brew"
  mkdir -p "${PGSTUB_PREFIX}/var/postgresql@18" # no PG_VERSION → uninitialized
  ga_pg_keg_major() { printf '18'; }
  ga_brew_prefix() { printf '%s' "${PGSTUB_PREFIX}"; }
  local stub="${SANDBOX}/bin"; mkdir -p "${stub}"
  # record the exact argv the real ga_pg_initdb passes to initdb.
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >"%s/initdb-argv"\nexit 0\n' "${SANDBOX}" >"${stub}/initdb"
  chmod +x "${stub}/initdb"
  PATH="${stub}:${PATH}" ga_pg_initdb
  [[ -e "${SANDBOX}/initdb-argv" ]]
  run cat "${SANDBOX}/initdb-argv"
  [[ "${output}" == "-D ${PGSTUB_PREFIX}/var/postgresql@18 --encoding=UTF8" ]]
}

# === R3 — foreign/broken postgres UTC-rejection detect ==================================

@test "R3(detect): ga_detect_postgres_utc is 'broken' when the server rejects SET timezone='UTC'" {
  local stub="${SANDBOX}/bin"; mkdir -p "${stub}"
  # psql: SELECT 1 succeeds (server answers) but the SET timezone='UTC' probe FAILS (22023).
  cat >"${stub}/psql" <<'PSQL'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    *"SET timezone='UTC'"*) exit 1 ;;  # broken server rejects UTC (pg 22023)
    "SELECT 1") exit 0 ;;
  esac
done
exit 0
PSQL
  chmod +x "${stub}/psql"
  run env PATH="${stub}:${PATH}" bash -c "source '${DEPS_SH}'; PG_SOCKET=/tmp ga_detect_postgres_utc"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "broken" ]]
}

@test "R3(detect): ga_detect_postgres_utc is 'ok' when the server accepts SET timezone='UTC'" {
  local stub="${SANDBOX}/bin"; mkdir -p "${stub}"
  printf '#!/bin/bash\nexit 0\n' >"${stub}/psql" # every probe (SELECT 1 + SET UTC) succeeds
  chmod +x "${stub}/psql"
  run env PATH="${stub}:${PATH}" bash -c "source '${DEPS_SH}'; PG_SOCKET=/tmp ga_detect_postgres_utc"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "ok" ]]
}

@test "R3(detect): ga_detect_postgres_utc is 'down' when no server answers the socket" {
  local stub="${SANDBOX}/bin"; mkdir -p "${stub}"
  printf '#!/bin/bash\nexit 1\n' >"${stub}/psql" # SELECT 1 fails → no live server
  chmod +x "${stub}/psql"
  run env PATH="${stub}:${PATH}" bash -c "source '${DEPS_SH}'; PG_SOCKET=/tmp ga_detect_postgres_utc"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "down" ]]
}

@test "R3(static): preflight_pg_utc_guard is wired into BOTH preflight paths after keg-inject" {
  # Both preflight paths invoke the guard WITH a failure-bail. The scroll path uses the direct
  # `|| return $?` idiom; the boxed path captures the rc BEFORE stop_idle_spinner (so the idle
  # spinner's kill/wait/tput cannot clobber $?) then returns it — the same bail, exit-code-safe.
  run awk '/preflight_pg_utc_guard \|\|/{c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 2 ]] # both paths invoke-and-check the guard
  run awk -v p='preflight_pg_utc_guard || return $?' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 1 ]] # scroll path: direct bail
  run awk -v p='preflight_pg_utc_guard || pg_guard_rc=$?' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -eq 1 ]] # boxed path: capture-then-bail (exit-code preserved across stop_idle_spinner)
}

@test "R1(static): the initdb step is wired into BOTH preflight paths (gated on uninitialized)" {
  run awk -v p='ga_pg_data_dir_initialized' 'index($0,p){c++} END{print c+0}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh
  [[ "${output}" -ge 2 ]]
}

# === AUTH-HARDENING — ga_detect_claude_auth keychain-first present + bounded probe ======
#
# DEFENSIVE hardening (NOT a repair of a valid subcommand): on macOS the OAuth credential
# lives in the login Keychain (service "Claude Code-credentials"), which the ~/.claude/
# .credentials.json PRESENCE check misses — so a Keychain-authed user previously depended on
# the UN-TIMED `claude auth status` subprocess as the sole macOS signal. A cold-start hang of
# that subprocess (run inside $() with no timeout) returned non-zero → "absent" → the hard
# gate looped. The fix: (1) a macOS Keychain PRESENT-path (uname-guarded, `security` WITHOUT
# -w — attributes only, no secret retrieved, no unlock GUI) that short-circuits BEFORE the
# subprocess, and (2) a TIME-BOUND (background+kill idiom, no macOS `timeout`) on the retained
# auth-status corroboration fallback. `auth status` is a VALID subcommand and is NOT renamed.
#
# The stubs are FAITHFUL (not green-washed): the claude stub models `auth status` SPECIFICALLY
# (a blanket rc0 would also pass `whoami`/junk tokens — modelling the exact subcommand is what
# makes the auth-status cases falsifiable), the security stub honours the no--w exit-code
# contract and emits NO secret, and the uname stub returns Darwin for the macOS cases and a
# non-Darwin value for the fall-through guard.

@test "AUTH(a): macOS + Keychain item present → 'present' (security WITHOUT -w, auth-status NOT reached)" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  export GA_STUB_SANDBOX="${SANDBOX}"
  # claude present (command -v resolves it); records IF 'auth status' is ever reached.
  cat >"${stub}/claude" <<'SH'
#!/bin/bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  touch "${GA_STUB_SANDBOX}/authstatus-called"
  exit "${GA_STUB_AUTH_RC:-1}"
fi
echo junk
exit 0
SH
  # uname → Darwin (macOS path).
  cat >"${stub}/uname" <<'SH'
#!/bin/bash
printf '%s\n' "${GA_STUB_UNAME:-Darwin}"
SH
  # security: records the argv (to assert no -w), Keychain item PRESENT (exit 0), emits NO secret.
  cat >"${stub}/security" <<'SH'
#!/bin/bash
printf '%s' "$*" >"${GA_STUB_SANDBOX}/security-argv"
exit "${GA_STUB_SEC_RC:-0}"
SH
  chmod +x "${stub}/claude" "${stub}/uname" "${stub}/security"
  local home="${SANDBOX}/home"
  mkdir -p "${home}/.claude" # NO creds file → creds check misses, Keychain must decide
  export GA_STUB_SEC_RC=0    # Keychain item exists
  [[ "$(HOME="${home}" PATH="${stub}:${PATH}" ga_detect_claude_auth)" == "present" ]]
  # security was invoked WITHOUT -w and WITH the exact service (attributes-only, no secret read).
  run cat "${SANDBOX}/security-argv"
  [[ "${output}" != *"-w"* ]]
  [[ "${output}" == *'-s Claude Code-credentials'* ]]
  # Keychain short-circuited BEFORE the fragile auth-status subprocess (the whole point).
  [[ ! -e "${SANDBOX}/authstatus-called" ]]
}

@test "AUTH(b): macOS + no Keychain + no creds + auth-status FAILS → 'absent'" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  export GA_STUB_SANDBOX="${SANDBOX}"
  cat >"${stub}/claude" <<'SH'
#!/bin/bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  touch "${GA_STUB_SANDBOX}/authstatus-called"
  exit "${GA_STUB_AUTH_RC:-1}"
fi
echo junk
exit 0
SH
  cat >"${stub}/uname" <<'SH'
#!/bin/bash
printf '%s\n' "${GA_STUB_UNAME:-Darwin}"
SH
  cat >"${stub}/security" <<'SH'
#!/bin/bash
printf '%s' "$*" >"${GA_STUB_SANDBOX}/security-argv"
exit "${GA_STUB_SEC_RC:-0}"
SH
  chmod +x "${stub}/claude" "${stub}/uname" "${stub}/security"
  local home="${SANDBOX}/home"
  mkdir -p "${home}/.claude"
  export GA_STUB_SEC_RC=44 # errSecItemNotFound — no Keychain item
  export GA_STUB_AUTH_RC=1 # auth status: unauthenticated
  # no sleep stub: the bounded probe BLOCKS on the child (wait), so a fast-exiting stub
  # returns at once; the watchdog is killed before its real 10s sleep matters.
  [[ "$(HOME="${home}" PATH="${stub}:${PATH}" ga_detect_claude_auth)" == "absent" ]]
  # the auth-status probe WAS the deciding signal (Keychain missed) — modelled specifically.
  [[ -e "${SANDBOX}/authstatus-called" ]]
}

@test "AUTH(c): creds file present → 'present' (regression; neither Keychain nor probe reached)" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  export GA_STUB_SANDBOX="${SANDBOX}"
  cat >"${stub}/claude" <<'SH'
#!/bin/bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  touch "${GA_STUB_SANDBOX}/authstatus-called"
  exit 1
fi
echo junk
exit 0
SH
  # a security stub that would REGISTER if called — it must NOT be (creds short-circuits first).
  cat >"${stub}/security" <<'SH'
#!/bin/bash
printf '%s' "$*" >"${GA_STUB_SANDBOX}/security-argv"
exit 0
SH
  chmod +x "${stub}/claude" "${stub}/security"
  local home="${SANDBOX}/home"
  mkdir -p "${home}/.claude"
  printf '{}\n' >"${home}/.claude/.credentials.json" # PRESENCE only (contents never read)
  [[ "$(HOME="${home}" PATH="${stub}:${PATH}" ga_detect_claude_auth)" == "present" ]]
  # short-circuited at the creds-file check — neither Keychain nor auth-status was reached.
  [[ ! -e "${SANDBOX}/security-argv" ]]
  [[ ! -e "${SANDBOX}/authstatus-called" ]]
}

@test "AUTH(d): claude binary absent → 'present-but-down'" {
  # empty PATH dir → command -v claude fails; the guard fires before uname/security/probe.
  local empty="${SANDBOX}/emptybin"
  mkdir -p "${empty}"
  [[ "$(PATH="${empty}" ga_detect_claude_auth)" == "present-but-down" ]]
}

@test "AUTH(e): macOS + no Keychain + no creds + auth-status SUCCEEDS → 'present' (corroboration path)" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  export GA_STUB_SANDBOX="${SANDBOX}"
  cat >"${stub}/claude" <<'SH'
#!/bin/bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  touch "${GA_STUB_SANDBOX}/authstatus-called"
  exit "${GA_STUB_AUTH_RC:-1}"
fi
echo junk
exit 0
SH
  cat >"${stub}/uname" <<'SH'
#!/bin/bash
printf '%s\n' "${GA_STUB_UNAME:-Darwin}"
SH
  cat >"${stub}/security" <<'SH'
#!/bin/bash
printf '%s' "$*" >"${GA_STUB_SANDBOX}/security-argv"
exit "${GA_STUB_SEC_RC:-0}"
SH
  chmod +x "${stub}/claude" "${stub}/uname" "${stub}/security"
  local home="${SANDBOX}/home"
  mkdir -p "${home}/.claude"
  export GA_STUB_SEC_RC=44 # no Keychain item → fall through to the bounded probe
  export GA_STUB_AUTH_RC=0 # auth status: authenticated
  [[ "$(HOME="${home}" PATH="${stub}:${PATH}" ga_detect_claude_auth)" == "present" ]]
  [[ -e "${SANDBOX}/authstatus-called" ]] # the corroboration probe was exercised
}

@test "AUTH(f): non-Darwin fall-through skips the Keychain probe (uname guard), auth-status decides" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  export GA_STUB_SANDBOX="${SANDBOX}"
  cat >"${stub}/claude" <<'SH'
#!/bin/bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  touch "${GA_STUB_SANDBOX}/authstatus-called"
  exit "${GA_STUB_AUTH_RC:-1}"
fi
echo junk
exit 0
SH
  cat >"${stub}/uname" <<'SH'
#!/bin/bash
printf '%s\n' "${GA_STUB_UNAME:-Darwin}"
SH
  # security would exit 0 (item "present") IF called — the uname guard must prevent that.
  cat >"${stub}/security" <<'SH'
#!/bin/bash
printf '%s' "$*" >"${GA_STUB_SANDBOX}/security-argv"
exit 0
SH
  chmod +x "${stub}/claude" "${stub}/uname" "${stub}/security"
  local home="${SANDBOX}/home"
  mkdir -p "${home}/.claude"
  export GA_STUB_UNAME=Linux # non-Darwin → Keychain block skipped
  export GA_STUB_AUTH_RC=0   # auth status decides → present
  [[ "$(HOME="${home}" PATH="${stub}:${PATH}" ga_detect_claude_auth)" == "present" ]]
  # the macOS-only `security` probe was NEVER invoked on a non-Darwin host.
  [[ ! -e "${SANDBOX}/security-argv" ]]
  # the verdict came from the auth-status corroboration path instead.
  [[ -e "${SANDBOX}/authstatus-called" ]]
}
