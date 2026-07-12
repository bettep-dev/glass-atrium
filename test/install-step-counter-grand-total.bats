#!/usr/bin/env bats
# install-step-counter-grand-total.bats — unify the install step counter into ONE frozen grand
# total so the preflight->install handoff no longer jumps the DENOMINATOR (the visible 6->19).
#
# Root cause: the preflight box (base=0, STEP_TOTAL=g1+g2) and the install box
# (base=preflight-final, STEP_TOTAL=14=INSTALL_PLAN_LEN) share ONE renderer computing
# disp_n = base + STEP_TOTAL, so the denominator changed at the handoff (6 -> 19). The
# numerator was made continuous (STEP_INDEX_BASE) but the denominator was never unified.
#
# Fix: preflight_count_and_gate freezes GRAND_TOTAL = (g1+g2) + INSTALL_PLAN_LEN; the 3 disp_n
# render sites fall back to it — disp_n=${GRAND_TOTAL:-$(( base + STEP_TOTAL ))} — so the SHARED
# uninstall/db/token/purge callers (which never set GRAND_TOTAL) stay byte-identical.
#
# Falsifiability: test (1) is the PRIMARY repro — it asserts the preflight-step denominator EQUALS
# the install-step denominator. Pre-fix build_run_bar ignores GRAND_TOTAL -> 6 vs 20 -> FAILS;
# post-fix both resolve to GRAND_TOTAL=20 -> equal -> PASSES.
#
# Hermetic: each test EVALs a SINGLE launcher function into the test shell (extract_launcher_fn) —
# the TUI never boots, no TTY, no system mutation. RENDER-ONLY (these helpers never touch exit codes).
#
# Run via: bats test/install-step-counter-grand-total.bats
# Requires: bats (brew install bats-core), awk, sed, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the launcher is strict-mode; suspend any inherited ERR trap defensively before eval.
  trap - ERR
}

# extract_launcher_fn — eval a single named launcher function into the test shell so it can be
# driven in isolation without booting the TUI (mirrors continuous-index.bats).
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

# stub build_run_bar's collaborators so the recorded output IS the DISPLAY index/total it computed.
_stub_bar_collaborators() {
  build_progress_bar() { printf 'BAR[%s/%s]' "$1" "$2"; }
  progress_bar_width() { printf '8'; }
  C_ACCENT="94"
  STEP_BAR_ACCENT_CUR=""
}

# parse the denominator out of a BAR[i/n] capture.
_denom() { printf '%s' "$1" | sed -n 's/^BAR\[[0-9]*\/\([0-9]*\)\]$/\1/p'; }

# === (1) PRIMARY REPRO — one frozen denominator across the preflight->install handoff ==========

@test "denominator is IDENTICAL during a preflight step and the install step (no 6->19 jump)" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  # missing-deps scenario: g1+g2 = 6 predicted preflight steps; install plan = 14 -> GRAND_TOTAL = 20.
  GRAND_TOTAL=20

  # preflight step 3 of 6: base is empty (unset until the handoff), STEP_TOTAL = g1+g2 = 6.
  STEP_INDEX_BASE=""
  STEP_INDEX=3
  STEP_TOTAL=6
  run build_run_bar
  [ "${status}" -eq 0 ]
  local pre_denom
  pre_denom="$(_denom "${output}")"

  # install step 5 of 14: base = 6 (carried preflight-final), STEP_TOTAL = INSTALL_PLAN_LEN = 14.
  STEP_INDEX_BASE=6
  STEP_INDEX=5
  STEP_TOTAL=14
  run build_run_bar
  [ "${status}" -eq 0 ]
  local ins_denom
  ins_denom="$(_denom "${output}")"

  # the WHOLE POINT: ONE frozen grand total. Pre-fix 6 != 20 (FAILS); post-fix 20 == 20.
  [ "${pre_denom}" = "${ins_denom}" ]
  [ "${pre_denom}" = "20" ]
}

@test "numerator stays CONTINUOUS across the handoff on the frozen denominator (6/20 -> 7/20 -> 20/20)" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  GRAND_TOTAL=20
  # last preflight step: 6/20
  STEP_INDEX_BASE=""
  STEP_INDEX=6
  STEP_TOTAL=6
  run build_run_bar
  [ "${output}" = "BAR[6/20]" ]
  # first install step continues at 7/20 (no reset/blink)
  STEP_INDEX_BASE=6
  STEP_INDEX=1
  STEP_TOTAL=14
  run build_run_bar
  [ "${output}" = "BAR[7/20]" ]
  # last install step lands EXACTLY at 20/20 (perfect prediction => exact N/N tail)
  STEP_INDEX=14
  run build_run_bar
  [ "${output}" = "BAR[20/20]" ]
}

# === (2) all-deps-present — GRAND_TOTAL collapses to INSTALL_PLAN_LEN, stable 1/14..14/14 =======

@test "all-deps-present: GRAND_TOTAL = INSTALL_PLAN_LEN (14), stable 1/14..14/14" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  # g1+g2 = 0 => no preflight steps => base stays 0; GRAND_TOTAL = 0 + 14 = 14.
  GRAND_TOTAL=14
  STEP_INDEX_BASE=0
  STEP_INDEX=1
  STEP_TOTAL=14
  run build_run_bar
  [ "${output}" = "BAR[1/14]" ]
  STEP_INDEX=14
  run build_run_bar
  [ "${output}" = "BAR[14/14]" ]
}

# === (3) shared callers — GRAND_TOTAL unset => raw base+STEP_TOTAL, byte-identical ==============

@test "shared caller (GRAND_TOTAL unset) renders the RAW base+STEP_TOTAL, byte-identical" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  unset GRAND_TOTAL || true
  STEP_INDEX_BASE=""
  STEP_INDEX=2
  STEP_TOTAL=5
  run build_run_bar
  [ "${output}" = "BAR[2/5]" ] # uninstall/db/token/purge unchanged
}

# === (4) preflight_count_and_gate — freeze GRAND_TOTAL = (g1+g2) + INSTALL_PLAN_LEN ============

@test "preflight_count_and_gate freezes GRAND_TOTAL = (g1+g2) + INSTALL_PLAN_LEN as a GLOBAL" {
  extract_launcher_fn preflight_count_and_gate
  INSTALL_PLAN_LEN=14
  # g1: brew missing-set carries postgresql@18 (+1 brew, +2 pg) + claude absent (+1) = 4
  ga_brew_missing_set() { printf 'postgresql@18 git'; }
  ga_detect_postgres() { printf 'present'; }
  ga_detect_postgres_role() { printf 'present'; }
  ga_detect_claude_cli() { printf 'absent'; }
  # g2: claude absent => fakechat marketplace+plugin (+2); python libs missing (+1) = 3
  ga_detect_fakechat() { printf 'absent'; }
  ga_marketplace_present() { printf 'no'; }
  ga_detect_python_libs() { printf 'absent'; }
  GRAND_TOTAL=""
  STEP_TOTAL=""
  STEP_INDEX="sentinel"
  preflight_count_and_gate
  [ "${STEP_TOTAL}" -eq 7 ]   # g1 (4) + g2 (3)
  [ "${GRAND_TOTAL}" -eq 21 ] # 7 + 14
  [ -z "${STEP_INDEX}" ]      # reset to empty (no 0/N pre-flash)
}

# === (5) _clear_step_state sweeps GRAND_TOTAL (no stale grand total leaks to a later caller) ====

@test "_clear_step_state sweeps GRAND_TOTAL alongside STEP_INDEX_BASE (leak guard)" {
  extract_launcher_fn _clear_step_state
  STEP_INDEX=3
  STEP_TOTAL=14
  STEP_INDEX_BASE=6
  GRAND_TOTAL=20
  STEP_LABEL_ACTIVE_CUR="x"
  STEP_BAR_CUR="y"
  STEP_BAR_ACCENT_CUR="z"
  _clear_step_state
  [ -z "${GRAND_TOTAL}" ]
  [ -z "${STEP_INDEX_BASE}" ]
  [ -z "${STEP_INDEX}" ]
  [ -z "${STEP_TOTAL}" ]
}

# === (6) done-line consistency — run_action_panel offsets the failed-at-step to the grand scale ==
# The running bar ends on the grand total; the done line's "failed at step N/T" must match it,
# not the old 5/14. run_action_panel snapshots GRAND_TOTAL/base BEFORE run_plan's teardown sweeps
# them. Shared uninstall callers (GRAND_TOTAL unset) stay byte-identical.

@test "run_action_panel done-line uses the frozen GRAND_TOTAL denominator on the install path" {
  extract_launcher_fn run_action_panel
  start_idle_spinner() { :; }
  stop_idle_spinner() { :; }
  build_step_plan() { STEP_FN=(a b c d e f g h i j k l m n); } # 14-entry install plan
  # run_plan: FAIL at step 5, then sweep GRAND_TOTAL/base exactly like the real end-of-plan teardown.
  run_plan() {
    STEP_FAIL_INDEX=5
    GRAND_TOTAL=""
    STEP_INDEX_BASE=""
    return 1
  }
  SL_ARGS=""
  status_line() { SL_ARGS="$*"; }
  enter_nav_state() { :; }
  TTY="/dev/null"
  # install-panel handoff state at run_action_panel entry: base = 6 preflight steps, GRAND_TOTAL = 20.
  STEP_INDEX_BASE=6
  GRAND_TOTAL=20
  run_action_panel install "Install" "94" || true
  # failed at step (6+5)=11 / 20 — on the grand scale, NOT 5/14.
  [ "${SL_ARGS}" = "1 Install 11 20" ]
}

@test "run_action_panel done-line: shared caller (GRAND_TOTAL unset) keeps the raw N/T (byte-identical)" {
  extract_launcher_fn run_action_panel
  start_idle_spinner() { :; }
  stop_idle_spinner() { :; }
  build_step_plan() { STEP_FN=(a b c d e f g h i j); } # 10-entry uninstall plan
  run_plan() {
    STEP_FAIL_INDEX=3
    return 1
  }
  SL_ARGS=""
  status_line() { SL_ARGS="$*"; }
  enter_nav_state() { :; }
  TTY="/dev/null"
  unset GRAND_TOTAL || true
  unset STEP_INDEX_BASE || true
  run_action_panel uninstall "Uninstall" "91" || true
  [ "${SL_ARGS}" = "1 Uninstall 3 10" ] # unchanged: raw fail_idx / plan length
}

# === (7) drift guard — INSTALL_PLAN_LEN must equal the live install STEP_FN length ==============

@test "INSTALL_PLAN_LEN equals the live install STEP_FN length after build_step_plan install" {
  # source in an isolated subprocess (source-guard skips main); the boxed preflight never runs,
  # so build_step_plan install populates STEP_FN to the real plan. A future 15th step that forgets
  # to bump INSTALL_PLAN_LEN trips this guard (mirrors step-plan-sync.bats intent).
  run bash -c '
    set -Eeuo pipefail
    source "$1" >/dev/null 2>&1
    trap - EXIT INT TERM ERR
    build_step_plan install
    printf "%s %s\n" "${INSTALL_PLAN_LEN}" "${#STEP_FN[@]}"
  ' _ "${LAUNCHER}"
  [ "${status}" -eq 0 ]
  local len fn_count
  read -r len fn_count <<<"${output}"
  [ "${len}" = "14" ]
  [ "${len}" = "${fn_count}" ]
}

# === (8) ABORT boundary — _panel_abort sweeps the leaked counter state (abort -> next action) ====
# An aborted install (blocked preflight / stuck :16145) funnels through _panel_abort with the shared
# counters left FROZEN (the boxed preflight only clears on its SUCCESS tail; a later gate abort keeps
# the preflight's preserved handoff values). The next menu action's build_run_bar then renders a stale
# GRAND_TOTAL denominator (the Token-Setup 1/19 symptom). Fix: _panel_abort calls _clear_step_state.
# Falsifiability: pre-fix GRAND_TOTAL=19 survives => the next 1-step bar reads 1/19; post-fix 1/1.

@test "abort sweep: _panel_abort clears the leaked step counters so the NEXT action's bar reads 1/1 (not 1/19)" {
  extract_launcher_fn _clear_step_state
  extract_launcher_fn _panel_abort
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  # _panel_abort's own render/input/nav collaborators -> no-ops (this test asserts STATE, not chrome).
  status_line() { :; }
  enter_nav_state() { :; }
  TTY="/dev/null"
  # LEAKED state from an aborted boxed preflight: a frozen grand total + carried base + step totals.
  GRAND_TOTAL=19
  STEP_INDEX_BASE=6
  STEP_TOTAL=6
  STEP_INDEX=6
  STEP_LABEL_ACTIVE_CUR="stale"
  STEP_BAR_CUR="stale"
  STEP_BAR_ACCENT_CUR="stale"
  # call DIRECTLY (not `run`) so the global sweep persists into the test shell for assertion.
  _panel_abort "blocked preflight" || return 1
  # every shared counter is swept on the abort boundary.
  [[ -z "${GRAND_TOTAL}" ]] || return 1
  [[ -z "${STEP_INDEX_BASE}" ]] || return 1
  [[ -z "${STEP_TOTAL}" ]] || return 1
  [[ -z "${STEP_INDEX}" ]] || return 1
  # the NEXT menu action (e.g. Token Setup) enters RUN state with a single-step bar.
  STEP_INDEX=1
  STEP_TOTAL=1
  run build_run_bar
  [[ "${status}" -eq 0 ]] || return 1
  # pre-fix: leaked GRAND_TOTAL=19 => build_run_bar renders 1/19; post-fix swept => 1/1.
  [[ "$(_denom "${output}")" = "1" ]] || return 1
}

# === (9) SUCCESS tail — the boxed preflight PRESERVES GRAND_TOTAL + base (characterization) ======
# The install handoff DEPENDS on _run_dependency_preflight_boxed's success tail preserving GRAND_TOTAL
# + STEP_INDEX_BASE (the fix must NOT over-clear the success path — that would reintroduce the 6->19
# denominator jump). This pins that the abort sweep and the success handoff stay disjoint.

@test "success handoff: the boxed preflight SUCCESS tail PRESERVES GRAND_TOTAL + STEP_INDEX_BASE (no over-clear)" {
  extract_launcher_fn _run_dependency_preflight_boxed
  # minimal all-present success path: no auto-work, no interactive bracket, no framed step -> the
  # function runs straight to its success tail. Stub every collaborator the tail's predecessors call.
  preflight_count_and_gate() {
    PREFLIGHT_GROUP1_RUNNABLE=0
    PREFLIGHT_GROUP2_RUNNABLE=0
    STEP_TOTAL=6
    STEP_INDEX=""
    GRAND_TOTAL=20 # (g1+g2 = 6) + INSTALL_PLAN_LEN (14)
  }
  ga_detect_xcode_clt() { printf 'present'; }
  preflight_has_auto_work() { printf 'no'; }
  ga_detect_claude_auth() { printf 'present'; }
  token_already_provisioned() { return 0; }
  _preflight_fakechat_boxed() { return 0; }
  ga_detect_python_libs() { printf 'present'; }
  # the `[[ -x "${HOME}/.local/bin/claude" ]]` guard must be false -> point HOME at an empty dir.
  HOME="$(mktemp -d -t ga-empty-home.XXXXXX)"
  STEP_INDEX_BASE="sentinel"
  _run_dependency_preflight_boxed || return 1
  # the deliberate install handoff: GRAND_TOTAL + base SURVIVE (NOT reset on the success path).
  [[ "${GRAND_TOTAL}" = "20" ]] || return 1
  # no framed step ran (all-present) => final STEP_INDEX was "" => base carries "0".
  [[ "${STEP_INDEX_BASE}" = "0" ]] || return 1
  # the render-detail counters ARE swept so no stale i/N leaks into dispatch's install run_plan.
  [[ -z "${STEP_INDEX}" ]] || return 1
  [[ -z "${STEP_TOTAL}" ]] || return 1
}
