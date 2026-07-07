#!/usr/bin/env bats
# workbox-bar-count-visible-during-resolve.bats — falsifiable regression coverage for the blank-box
# render defect: in a run-state work box WITH an active step bar, stop_idle_spinner used to blank BOTH
# body rows unconditionally, so between the often-skipped conditional panel steps (the pg resolve
# cluster) the box body went blank instead of resting on the i/N bar.
#
# RENDER CONTRACT (RC-1): in WORK_STATE=run WITH a non-empty build_run_bar, the resting body is ALWAYS
# the bar+count; a stopped animator MUST restore it, never leave it blank. The no-step-count windows
# (Detecting/Freeing/Preparing) run under WORK_STATE=run too but have an EMPTY bar and correctly rest
# blank — so the restore is gated on the COMPOUND (run AND non-empty bar), never on run-state alone.
#
# The discriminator drives the REAL stop_idle_spinner and CAPTURES the REAL painter argument (the
# actual painted body, not a re-synthesized line): pre-fix LINE 1 is empty; post-fix it carries the
# bar-fill glyph + the i/N count. Cross-checked against the REAL build_run_bar / build_counter_str.
#
# Hermetic: each launcher function is awk-eval'd into the test shell (extract_launcher_fn) — no TUI,
# no TTY mutation, no real install/brew/psql/postgres. The only child is a short-lived `sleep` given
# to IDLE_PID so stop_idle_spinner's clearing/restore tail runs (it early-returns on an empty IDLE_PID).
#
# Run via: bats test/workbox-bar-count-visible-during-resolve.bats
#
# ShellCheck: BATS_* are runtime-injected (SC2154); launcher globals (STEP_*/C_*/PROG_*/USE_COLOR) are
# read by the eval'd launcher fns, not this file (SC2034); the $(cat)/$(build_*) captures deliberately
# mask return values (SC2312); the static grep -F patterns are LITERAL launcher source (single quotes
# intended, no expansion — SC2016). Same dynamic-code class as continuous-index.bats / spinner-*.bats.
# shellcheck disable=SC2034,SC2154,SC2312,SC2016

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the launcher is strict-mode; suspend any inherited ERR trap defensively before eval.
  trap - ERR
}

# extract_launcher_fn — eval a single named launcher function into the test shell (mirrors
# continuous-index.bats / spinner-cursor-visibility.bats).
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}")"
}

# _fn_body — the raw text of a single launcher function (for static shape assertions).
_fn_body() {
  awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}"
}

# _load_render_stack — eval the REAL render call-graph stop_idle_spinner's restore path needs (the
# string builders stay REAL so the captured body is the actual rendered bar, never a stub).
_load_render_stack() {
  local fn
  for fn in stop_idle_spinner build_run_bar build_progress_bar build_counter_str \
    progress_bar_width workbox_body_str _bar_fill hrule c; do
    extract_launcher_fn "${fn}"
  done
}

# _capture_env — neutralize the process/TTY machinery and capture the REAL painter arguments. The
# string renderers are LEFT REAL (loaded above). USE_COLOR=false makes c() a pass-through so the
# captured body is plain text; PROG_FULL/PROG_EMPTY + MENU_INNER pin a deterministic bar.
_capture_env() {
  USE_COLOR=false
  PROG_FULL='#'
  PROG_EMPTY='.'
  MENU_INNER=52 # progress_bar_width -> 18 cells
  C_INFO=""
  C_STRONG=""
  C_DIM=""
  C_ACCENT=""
  C_OK=""
  C_ALERT=""
  STEP_LABEL_ACTIVE_CUR="Resolving PostgreSQL"
  STEP_INDEX_BASE="" # no carried offset -> disp_i = raw STEP_INDEX
  GRAND_TOTAL=""     # no frozen denominator -> disp_n = raw STEP_TOTAL
  STEP_BAR_ACCENT_CUR=""
  CAP1="${BATS_TEST_TMPDIR}/line1"
  CAP2="${BATS_TEST_TMPDIR}/line2"
  : >"${CAP1}"
  : >"${CAP2}"
  # capture the REAL painter arguments (what stop_idle_spinner actually paints), not the TTY write.
  paint_workbox_body_inner() { printf '%s' "$1" >"${CAP1}"; }
  paint_workbox_body_row2_inner() { printf '%s' "$1" >"${CAP2}"; }
  tp() { :; }
  _job_control_state() { printf 'off\n'; }
  _restore_job_control() { :; }
}

# _idle_child — a real short-lived child so stop_idle_spinner does NOT early-return on empty IDLE_PID.
_idle_child() {
  sleep 2 &
  IDLE_PID=$!
}

# === behavioral discriminator (the primary CI gate) ====================================

@test "stop_idle_spinner restores the bar+count body in run-state (pre-fix: blank; post-fix: visible)" {
  _load_render_stack
  _capture_env
  FULLSCREEN=true
  WORK_STATE=run
  STEP_INDEX=3
  STEP_TOTAL=6
  STEP_BAR_CUR="" # the REAL between-steps state: no bar prebuilt when the idle window stops
  _idle_child
  stop_idle_spinner

  local line1
  line1="$(cat "${CAP1}")"
  # pre-fix this is empty (unconditional blank); post-fix the run-state restore repaints the bar body.
  [[ -n "${line1}" ]]
  [[ "${line1}" == *"${PROG_FULL}"* ]] # bar-fill glyph VISIBLE (not merely animated)
  [[ "${line1}" == *"3/6"* ]]          # the i/N count VISIBLE

  # cross-check the captured body against the REAL renderers (Gaming-the-Judge avoidance).
  local expected_bar expected_count
  expected_bar="$(build_run_bar)"
  expected_count="$(build_counter_str 3 6)"
  [[ "${line1}" == *"${expected_bar}"* ]] # the exact build_run_bar output is embedded in the body
  [[ "${expected_count}" == *"3/6"* ]]    # build_counter_str is the i/N SoT this cross-checks against

  # LINE 2 is cleared (the async detail row rests blank once the animator stops).
  [[ -z "$(cat "${CAP2}")" ]]
}

# === compound-gate precision (no-bar windows MUST stay blank) ===========================

@test "stop_idle_spinner keeps the no-step-count run window blank (empty bar => blank, not a stale bar)" {
  _load_render_stack
  _capture_env
  FULLSCREEN=true
  WORK_STATE=run
  STEP_INDEX="" # Detecting/Freeing/Preparing: run-state but no step count yet
  STEP_TOTAL=""
  STEP_BAR_CUR=""
  _idle_child
  stop_idle_spinner
  # run-state ALONE must not paint a bar here — the compound gate keeps the empty-bar window blank.
  [[ -z "$(cat "${CAP1}")" ]]
}

@test "stop_idle_spinner blanks both rows outside run-state (nav)" {
  _load_render_stack
  _capture_env
  FULLSCREEN=true
  WORK_STATE=nav
  STEP_INDEX=3
  STEP_TOTAL=6
  STEP_BAR_CUR=""
  _idle_child
  stop_idle_spinner
  [[ -z "$(cat "${CAP1}")" ]]
  [[ -z "$(cat "${CAP2}")" ]]
}

# === static invariant (the three coordinated edits keep their shape) ====================

@test "static: stop_idle_spinner restore is COMPOUND-gated (run + build_run_bar) and still blanks otherwise" {
  local body
  body="$(_fn_body stop_idle_spinner)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'build_run_bar'* ]]    # the restore rebuilds the bar
  [[ "${body}" == *'workbox_body_str'* ]] # and paints the real resting body
  [[ "${body}" == *'WORK_STATE'* ]]       # gated on run-state (compound with the bar)
  # the OTHERWISE branch still blanks both rows (no-bar windows).
  run grep -cF 'paint_workbox_body_inner ""' <<<"${body}"
  [[ "${output}" -ge 1 ]]
}

@test "static: start_idle_spinner composites the bar UNDER the spinner when a run bar is active" {
  local body
  body="$(_fn_body start_idle_spinner)"
  [[ -n "${body}" ]]
  [[ "${body}" == *'STEP_BAR_CUR'* ]] # the per-tick painter carries the bar
  [[ "${body}" == *'WORK_STATE'* ]]   # gated on run-state
}

@test "static: each of the 3 pg-resolve idle sites rebuilds STEP_BAR_CUR + seeds STEP_INDEX before the fork" {
  local body
  body="$(_fn_body _run_dependency_preflight_boxed)"
  [[ -n "${body}" ]]
  run grep -cF 'start_idle_spinner "Resolving PostgreSQL"' <<<"${body}"
  [[ "${output}" -eq 3 ]]
  # each resolve site rebuilds the bar BEFORE the spinner fork (the subshell snapshots STEP_BAR_CUR).
  run grep -cF 'STEP_BAR_CUR="$(build_run_bar)"' <<<"${body}"
  [[ "${output}" -eq 3 ]]
  # each seeds STEP_INDEX only when empty (single mechanism; never overwrites a real mid-cluster index).
  run grep -cF 'STEP_INDEX="${STEP_INDEX:-0}"' <<<"${body}"
  [[ "${output}" -eq 3 ]]
}
