#!/usr/bin/env bats
# spinner-cursor-visibility.bats — falsifiable coverage for the cursor-visibility bug (the cursor stays a visible block
# after a panel-mode spinner stops).
#
# ROOT CAUSE: stop_step_spinner ended on an UNCONDITIONAL `tp cnorm`, and stop_idle_spinner ended
# on `tp cnorm`. Both spinner families hide the cursor (civis) while animating the fullscreen work
# box, but the box render model NEVER re-emits cnorm on a normal nav/redraw path — so ending a
# panel-mode stop on cnorm left a live cursor block on the menu edge + right body row.
#
# FIX: fold the cursor op into the RENDER_MODE branch of stop_step_spinner — panel mode RE-HIDES
# (`tp civis`), scrolling mode keeps `tp cnorm` for scrollback. stop_idle_spinner (fullscreen-box
# only) ends on `tp civis`. The cooked-prompt callers (_confirm_pregate / preflight_bracket / token
# pre-gate) re-assert their OWN cnorm AFTER the stop, so the typed consent prompts stay visible.
# The forked-child cnorm death-traps (Ctrl-C scrollback safety) are PRESERVED.
#
# Run via: bats test/spinner-cursor-visibility.bats
# Hermetic: each test evals a SINGLE launcher function into the test shell and records the cursor
# ops via a `tp` stub. No TUI, no TTY mutation, no system side effects.
#
# ShellCheck: BATS_* are runtime-injected (SC2154); TTY/SPIN_PID/RENDER_MODE are read by the
# dynamically-eval'd launcher functions, not this file (SC2034); the $(tail)/$(grep) captures in
# assertions deliberately mask return values (SC2312). Same dynamic-code class the sibling
# spinner-jobcontrol-restore.bats carries.
# shellcheck disable=SC2034,SC2154,SC2312

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the launcher is strict-mode; suspend any inherited ERR trap defensively before eval.
  trap - ERR
  TP_LOG="${BATS_TEST_TMPDIR}/tp.log"
  : >"${TP_LOG}"
}

# extract_launcher_fn — eval a single named launcher function into the test shell so it can be
# driven in isolation without booting the TUI (mirrors spinner-jobcontrol-restore.bats).
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}")"
}

# _fn_body — the raw text of a single launcher function (for static assertions).
_fn_body() {
  awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}"
}

# _stub_spinner_env — record every `tp` cursor op to TP_LOG and neutralize the kill/wait/paint/
# job-control machinery so ONLY the cursor-visibility decision runs for real.
_stub_spinner_env() {
  tp() { printf '%s\n' "$*" >>"${TP_LOG}"; }
  _job_control_state() { printf 'off\n'; }
  _restore_job_control() { :; }
  paint_workbox_body_inner() { :; }
  paint_workbox_body_row2_inner() { :; }
  kill() { return 0; }
  wait() { return 0; }
  TTY="/dev/null"
}

_last_cursor_op() { tail -n 1 "${TP_LOG}"; }

# === unit — stop_step_spinner ends on the correct cursor op per RENDER_MODE =============

@test "unit: stop_step_spinner in panel mode ends on civis (box has no live cursor)" {
  extract_launcher_fn stop_step_spinner
  _stub_spinner_env
  SPIN_PID=4242
  RENDER_MODE="panel"
  stop_step_spinner
  [[ "$(_last_cursor_op)" == "civis" ]]        # RE-HIDE — the panel box never shows a cursor
  run grep -qx 'cnorm' "${TP_LOG}"
  [[ "${status}" -ne 0 ]]                       # NO stray cnorm on the panel path (the bug)
}

@test "unit: stop_step_spinner in scrolling mode ends on cnorm (scrollback visibility)" {
  extract_launcher_fn stop_step_spinner
  _stub_spinner_env
  SPIN_PID=4242
  RENDER_MODE="scroll"                          # any non-panel value → scrolling model
  stop_step_spinner
  [[ "$(_last_cursor_op)" == "cnorm" ]]         # scrolling install/uninstall keeps the cursor
  run grep -qx 'civis' "${TP_LOG}"
  [[ "${status}" -ne 0 ]]                        # NO civis on the scrolling path
}

@test "unit: stop_step_spinner with RENDER_MODE unset falls to the scrolling (cnorm) arm" {
  extract_launcher_fn stop_step_spinner
  _stub_spinner_env
  SPIN_PID=4242
  unset RENDER_MODE || true
  stop_step_spinner
  [[ "$(_last_cursor_op)" == "cnorm" ]]         # ${RENDER_MODE:-} default → non-panel → cnorm
}

@test "unit: stop_step_spinner is a no-op with no live SPIN_PID (records no cursor op)" {
  extract_launcher_fn stop_step_spinner
  _stub_spinner_env
  SPIN_PID=""
  RENDER_MODE="panel"
  stop_step_spinner
  [[ ! -s "${TP_LOG}" ]]                         # early return 0 before any cursor op
}

# === unit — stop_idle_spinner (fullscreen box only) ends on civis ======================

@test "unit: stop_idle_spinner ends on civis (fullscreen box, cursor re-hidden)" {
  extract_launcher_fn stop_idle_spinner
  _stub_spinner_env
  IDLE_PID=4243
  FULLSCREEN="true"
  stop_idle_spinner
  [[ "$(_last_cursor_op)" == "civis" ]]
  run grep -qx 'cnorm' "${TP_LOG}"
  [[ "${status}" -ne 0 ]]                        # the pre-fix trailing `tp cnorm` is GONE
}

@test "unit: stop_idle_spinner still ends on civis even when not fullscreen (paint skipped)" {
  extract_launcher_fn stop_idle_spinner
  _stub_spinner_env
  IDLE_PID=4243
  FULLSCREEN="false"
  stop_idle_spinner
  [[ "$(_last_cursor_op)" == "civis" ]]         # the body paints are skipped, the civis still fires
}

# === static — the fix shape + the preserved death-traps ================================

@test "static: stop_step_spinner folds the cursor op into the RENDER_MODE branch" {
  local body
  body="$(_fn_body stop_step_spinner)"
  [[ -n "${body}" ]]
  # panel arm re-hides, scrolling arm restores — both present.
  [[ "${body}" == *'tp civis'* ]]
  [[ "${body}" == *'tp cnorm'* ]]
  # the UNCONDITIONAL trailing cursor op is GONE: no `tp cnorm` sits after the closing `fi`.
  # (extract the tail after the last `fi` and assert it carries no bare cursor op.)
  local after_fi
  after_fi="$(awk '/^  fi$/{seen=NR} {line[NR]=$0} END{for(i=seen+1;i<=NR;i++) print line[i]}' <<<"${body}")"
  run grep -cE '^[[:space:]]*tp (cnorm|civis)[[:space:]]*$' <<<"${after_fi}"
  [[ "${output}" -eq 0 ]]
}

@test "static: stop_idle_spinner ends on civis, not a trailing cnorm" {
  local body
  body="$(_fn_body stop_idle_spinner)"
  [[ -n "${body}" ]]
  # the last cursor op in the function body is civis.
  local last_cursor
  last_cursor="$(grep -oE 'tp (civis|cnorm)' <<<"${body}" | tail -n 1)"
  [[ "${last_cursor}" == "tp civis" ]]
}

@test "static: the forked-child cnorm death-traps are PRESERVED (Ctrl-C scrollback safety)" {
  local step idle
  step="$(_fn_body start_step_spinner)"
  idle="$(_fn_body start_idle_spinner)"
  # both spinner children install the unconditional cnorm-on-EXIT + cnorm-on-INT/TERM traps.
  [[ "${step}" == *"trap 'tp cnorm' EXIT"* ]]
  [[ "${step}" == *"trap 'tp cnorm; exit 0' INT TERM"* ]]
  [[ "${idle}" == *"trap 'tp cnorm' EXIT"* ]]
  [[ "${idle}" == *"trap 'tp cnorm; exit 0' INT TERM"* ]]
}
