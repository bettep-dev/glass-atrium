#!/usr/bin/env bash
# preflight-frame-composition-harness.sh — falsifiable coverage for the blank-work-box hang (the intermittent full-screen
# refresh) on the UNCOMMITTED working tree. It drives the REAL box-phase control flow with the TTY
# renderers stubbed and records a FRAME-STATE event stream, then verifies two invariants:
#
#   (I1) NEVER FRAMELESS — every box-phase idle-window start (start_idle_spinner) AND every framed
#        panel step (preflight_panel_step*) is preceded by a COMPOSED frame. A bracket (grouped
#        consent / Homebrew / Xcode-CLT GUIDE / claude-auth) leaves the alt-screen CLEARED, so a box
#        render that follows a bracket with NO intervening enter_run_state would paint a frameless /
#        railless box. Exercised on the partial-provision paths the v1 plan missed: CLT-missing,
#        group-empty (ENGAGE1 skipped), and not-yet-authed.
#
#   (I2) NO GRATUITOUS FULL-FRAME REDRAW — inside the boxed preflight no enter_run_state re-composes
#        a frame that is ALREADY composed (the blank-work-box hang symptom). In particular the W4 "Resolving
#        PostgreSQL" re-engage is CONDITIONAL on ENGAGE1 having been skipped (GROUP1 empty): when
#        ENGAGE1 fired, the frame is intact and W4 must NOT re-compose.
#
#   (I3) dispatch_action_install_panel emits EXACTLY ONE guaranteed boundary re-engage after the
#        preflight, so the W2 monitor gates + the W3 run_action_panel handoff are BODY-ONLY. A clean
#        fully-provisioned install performs exactly TWO enter_run_state calls (W1 + the single
#        preflight->monitor boundary), NOT the pre-fix four (W1 + launchd + orphan + handoff).
#
# READ-ONLY toward the live system: every detect / install-command / interactive / gate / TTY op is
# stubbed. Nothing real (brew/psql/launchctl/lsof/curl) runs; no alt-screen, no stty.
#
# ShellCheck: this harness sources the ~4900-line launcher and OVERRIDES its symbols, so several
# checks are inherent false-positives of static analysis against dynamically-sourced code —
#   SC2034 vars read by the sourced fns · SC2154 launcher globals assigned at source time ·
#   SC2312 return-masking in display-only subs · SC2016 literal stub bodies · SC2329 fns invoked
#   indirectly by the sourced launcher · SC2249 the frame-event case is an exhaustive allowlist.
# shellcheck disable=SC2034,SC2154,SC2312,SC2016,SC2329,SC2249
set -uo pipefail

HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GA_DIR_ROOT="$(cd -- "${HARNESS_DIR}/.." && pwd)"
LAUNCHER="${GA_DIR_ROOT}/glass-atrium"

# shellcheck source=/dev/null
source "${LAUNCHER}"
set +e
trap - ERR EXIT INT TERM

FAILS=0
PASSES=0
pass() {
  PASSES=$((PASSES + 1))
  printf '    PASS  %s\n' "$1"
}
fail() {
  FAILS=$((FAILS + 1))
  printf '    FAIL  %s\n' "$1"
}
assert_eq() { if [[ "$2" == "$3" ]]; then pass "$1 (= $3)"; else fail "$1 (expected [$2] got [$3])"; fi; }

# === frame-state event recorder =======================================================
# One event per line into GA_EVT. The instrumentation overrides below emit:
#   COMPOSE       — enter_run_state (a full-frame redraw → frame becomes COMPOSED)
#   BRACKET_CLEAR — a preflight_bracket ran rmcup+clear (frame becomes CLEARED)
#   IDLE_START    — start_idle_spinner (MUST land on a COMPOSED frame)
#   BODY_PANEL    — a framed panel step (MUST land on a COMPOSED frame)
#   IDLE_STOP     — stop_idle_spinner (clears the body rows only, NOT the frame)
GA_EVT="$(mktemp "${TMPDIR:-/tmp}/ga-bug1-evt.XXXXXX")"
_evt_reset() { : >"${GA_EVT}"; }
_evt() { printf '%s\n' "$1" >>"${GA_EVT}"; }

# verify_frame_events — walk the event stream from an initial frame state and report I1 (frameless)
# + I2 (gratuitous) violations. $1 = initial frame state (COMPOSED|CLEARED). Prints one line per
# violation; returns the violation count via the global VIO_COUNT.
VIO_COUNT=0
verify_frame_events() {
  local frame="$1" evt
  VIO_COUNT=0
  while IFS= read -r evt; do
    case "${evt}" in
      COMPOSE)
        # I2: composing an already-composed frame = a gratuitous full-frame refresh.
        if [[ "${frame}" == "COMPOSED" ]]; then
          printf '      VIOLATION(I2 gratuitous-redraw): COMPOSE on an already-COMPOSED frame\n'
          VIO_COUNT=$((VIO_COUNT + 1))
        fi
        frame="COMPOSED"
        ;;
      BRACKET_CLEAR) frame="CLEARED" ;;
      IDLE_START)
        # I1: an idle window must never animate a cleared (frameless) box.
        if [[ "${frame}" != "COMPOSED" ]]; then
          printf '      VIOLATION(I1 frameless): IDLE_START on a %s frame\n' "${frame}"
          VIO_COUNT=$((VIO_COUNT + 1))
        fi
        ;;
      BODY_PANEL)
        if [[ "${frame}" != "COMPOSED" ]]; then
          printf '      VIOLATION(I1 frameless): BODY_PANEL on a %s frame\n' "${frame}"
          VIO_COUNT=$((VIO_COUNT + 1))
        fi
        ;;
      IDLE_STOP) : ;; # body-row clear only — frame state unchanged
      *) : ;;         # ignore any unrecognized marker
    esac
  done <"${GA_EVT}"
}

_count_evt() { grep -cxF "$1" "${GA_EVT}" 2>/dev/null || true; }

# === scenario knobs (per-run detect verdicts + gate counts) ============================
SC_CLT="present"
SC_AUTOWORK="yes"
SC_HOMEBREW="present"
SC_MISSING="" # empty => ga_cmd_brew_batch returns nothing => no brew panel step
SC_PG="present"
SC_ROLE="present"
SC_CLI="present"
SC_AUTH="present"
SC_PROVISIONED="yes" # token_already_provisioned → 0 when yes
SC_PG_INIT="yes"     # "no" => A3 initdb panel step fires
SC_PYTHON="present"
SC_G1="0" # PREFLIGHT_GROUP1_RUNNABLE
SC_G2="0" # PREFLIGHT_GROUP2_RUNNABLE

# --- detect / gate stubs (read the scenario knobs) ---
preflight_count_and_gate() {
  PREFLIGHT_GROUP1_RUNNABLE="${SC_G1}"
  PREFLIGHT_GROUP2_RUNNABLE="${SC_G2}"
  STEP_TOTAL=1
}
ga_detect_xcode_clt() { printf '%s\n' "${SC_CLT}"; }
preflight_has_auto_work() { printf '%s\n' "${SC_AUTOWORK}"; }
ga_detect_homebrew() { printf '%s\n' "${SC_HOMEBREW}"; }
ga_cmd_brew_batch() {
  [[ -n "${SC_MISSING}" ]] && printf 'rec_ok\n'
  return 0
}
ga_detect_postgres() { printf '%s\n' "${SC_PG}"; }
ga_detect_postgres_role() { printf '%s\n' "${SC_ROLE}"; }
ga_detect_claude_cli() { printf '%s\n' "${SC_CLI}"; }
ga_detect_claude_auth() { printf '%s\n' "${SC_AUTH}"; }
ga_pg_data_dir_initialized() { printf '%s\n' "${SC_PG_INIT}"; }
ga_detect_python_libs() { printf '%s\n' "${SC_PYTHON}"; }
token_already_provisioned() { [[ "${SC_PROVISIONED}" == "yes" ]]; }
ga_cmd_pg_initdb() { printf 'rec_ok\n'; }
ga_cmd_pg_service_start() { printf 'rec_ok\n'; }
ga_cmd_pg_create_role() { printf 'rec_ok\n'; }
ga_cmd_claude_cli_install() { printf 'rec_ok\n'; }

# --- instrumentation overrides (emit the frame-state events) ---
ENGAGE_CALLS=0
enter_run_state() {
  ENGAGE_CALLS=$((ENGAGE_CALLS + 1))
  WORK_STATE=run
  _evt COMPOSE
}
start_idle_spinner() { _evt IDLE_START; }
stop_idle_spinner() { _evt IDLE_STOP; }
# preflight_bracket leaves a CLEARED alt-screen (rmcup+clear); run the gate (stubbed → 0), then the
# caller repaints via enter_run_state when a box render follows [G5].
preflight_bracket() {
  _evt BRACKET_CLEAR
  shift # drop the gate-fn name; the stubbed gates all succeed
  return 0
}
preflight_panel_step() {
  _evt BODY_PANEL
  return 0
}
preflight_panel_step_or_bail() {
  _evt BODY_PANEL
  return 0
}

# --- neutralized (no frame effect) ---
preflight_keg_path_inject() { return 0; }
preflight_keg_path_inject_pg() { return 0; }
preflight_pg_utc_guard() { return 0; }
preflight_eval_brew_shellenv() { return 0; }
preflight_path_prepend() { return 0; }
ga_pg_wait_ready() { return 0; }
_preflight_fakechat_boxed() { return 0; }
_preflight_python_libs_boxed() { return 0; }
redraw_frame_inplace() { :; }
draw_workbox() { :; }
paint_workbox_body_inner() { :; }
paint_workbox_body_row2_inner() { :; }
start_step_spinner() { :; }
stop_step_spinner() { :; }
c() { printf '%s' "${2:-}"; }
tp() { :; }
tty_line() { :; }
preflight_line() { :; }

TTY="/dev/null"
PREFLIGHT_TTY_OWNED="false"
PREFLIGHT_SUMMARY="scripted-auto-work"
MENU_INNER=52

# run_boxed — run _run_dependency_preflight_boxed once under the current scenario knobs, entering
# with a COMPOSED frame (dispatch's W1 engage ran + the "Detecting" idle animated it before this).
run_boxed() {
  set +e
  trap - ERR
  _evt_reset
  ENGAGE_CALLS=0
  STEP_INDEX=""
  STEP_TOTAL=""
  STEP_INDEX_BASE=""
  _run_dependency_preflight_boxed </dev/null
  local rc=$?
  set +e
  trap - ERR
  return "${rc}"
}

echo "============================================================================"
echo "S1 group-empty + not-yet-authed — W4 re-engage FIRES (never frameless)"
echo "============================================================================"
SC_CLT="present"
SC_AUTOWORK="yes"
SC_HOMEBREW="present"
SC_MISSING=""
SC_PG="present"
SC_ROLE="present"
SC_CLI="present"
SC_PG_INIT="yes"
SC_PYTHON="present"
SC_AUTH="absent"
SC_PROVISIONED="no" # not-yet-authed → auth bracket fires
SC_G1="0"
SC_G2="0" # both groups empty → ENGAGE1 + ENGAGE2 skipped
run_boxed
rc=$?
echo "  rc=${rc}  engage_calls=${ENGAGE_CALLS}  events:"
sed 's/^/      /' "${GA_EVT}"
assert_eq "S1 boxed returns 0 (engine exit unchanged)" "0" "${rc}"
verify_frame_events "COMPOSED"
assert_eq "S1 no frame violations (never frameless, no gratuitous redraw)" "0" "${VIO_COUNT}"
# W4 must fire exactly once (ENGAGE1 skipped → the box would be frameless without it).
assert_eq "S1 W4 conditional re-engage fired once (COMPOSE count)" "1" "$(_count_evt COMPOSE)"
# Per-detect idle brackets (re-target): pg detect was split from ONE cluster-wide idle bracket into THREE PER-DETECT
# brackets (utc-guard, postgres detect, role detect — launcher lines ~4756/4783/4796), so the bounded
# ~2s connect never flashes a blank box body. Each fires start_idle_spinner "Resolving PostgreSQL" →
# 3 IDLE_START events (each STOP-paired), all on the composed frame (verify_frame_events COMPOSED +
# VIO_COUNT=0 above prove none is frameless). The count moved 1→3; the "on the composed frame" invariant holds.
assert_eq "S1 the Resolving idle windows (per-detect brackets) ran on the composed frame" "3" "$(_count_evt IDLE_START)"

echo "============================================================================"
echo "S2 group1-runnable + provisioned-auth — W4 SKIPS (no gratuitous redraw)"
echo "============================================================================"
SC_CLT="present"
SC_AUTOWORK="yes"
SC_HOMEBREW="present"
SC_MISSING="node@24"
SC_PG="present"
SC_ROLE="present"
SC_CLI="present"
SC_PG_INIT="yes"
SC_PYTHON="present"
SC_AUTH="present"
SC_PROVISIONED="yes" # already authed → auth bracket SKIPPED
SC_G1="2"
SC_G2="0" # group1 has work → ENGAGE1 fires; group2 empty → ENGAGE2 skip
run_boxed
rc=$?
echo "  rc=${rc}  engage_calls=${ENGAGE_CALLS}  events:"
sed 's/^/      /' "${GA_EVT}"
assert_eq "S2 boxed returns 0" "0" "${rc}"
verify_frame_events "COMPOSED"
assert_eq "S2 no frame violations" "0" "${VIO_COUNT}"
# ONLY ENGAGE1 composes — W4 must NOT re-compose the already-intact frame (the gratuitous-redraw fix).
assert_eq "S2 exactly one COMPOSE (ENGAGE1 only; W4 skipped)" "1" "$(_count_evt COMPOSE)"
assert_eq "S2 brew batch rendered as a framed body panel" "1" "$(_count_evt BODY_PANEL)"

echo "============================================================================"
echo "S3 CLT-missing + bare machine — four brackets, each repainted"
echo "============================================================================"
SC_CLT="absent"
SC_AUTOWORK="yes"
SC_HOMEBREW="absent"
SC_MISSING="node@24"
SC_PG="present"
SC_ROLE="present"
SC_CLI="present"
SC_PG_INIT="yes"
SC_PYTHON="absent"
SC_AUTH="absent"
SC_PROVISIONED="no"
SC_G1="3"
SC_G2="1" # both groups have work → ENGAGE1 + ENGAGE2 both fire
run_boxed
rc=$?
echo "  rc=${rc}  engage_calls=${ENGAGE_CALLS}  events:"
sed 's/^/      /' "${GA_EVT}"
assert_eq "S3 boxed returns 0" "0" "${rc}"
verify_frame_events "COMPOSED"
assert_eq "S3 no frame violations (CLT+consent+homebrew+auth brackets all repainted)" "0" "${VIO_COUNT}"
assert_eq "S3 four brackets cleared the frame (CLT+consent+homebrew+auth)" "4" "$(_count_evt BRACKET_CLEAR)"
# ENGAGE1 + ENGAGE2 compose; W4 skips (ENGAGE1 fired). Exactly two composes.
assert_eq "S3 two composes (ENGAGE1 + ENGAGE2; W4 skipped)" "2" "$(_count_evt COMPOSE)"

echo "============================================================================"
echo "S4 fully-provisioned fast path — boxed touches no frame at all"
echo "============================================================================"
SC_CLT="present"
SC_AUTOWORK="no"
SC_AUTH="present"
SC_PROVISIONED="yes"
SC_G1="0"
SC_G2="0"
run_boxed
rc=$?
echo "  rc=${rc}  engage_calls=${ENGAGE_CALLS}  events:"
sed 's/^/      /' "${GA_EVT}"
assert_eq "S4 boxed returns 0" "0" "${rc}"
verify_frame_events "COMPOSED"
assert_eq "S4 no frame violations" "0" "${VIO_COUNT}"
assert_eq "S4 zero composes on the fast path (W1 frame carries through)" "0" "$(_count_evt COMPOSE)"
assert_eq "S4 zero idle windows in boxed on the fast path" "0" "$(_count_evt IDLE_START)"

echo "============================================================================"
echo "dispatch dispatch_action_install_panel — ONE boundary re-engage, gates body-only"
echo "============================================================================"
# stub the dispatch-level gates + the run_action_panel handoff (body-only: it must NOT self-engage).
apply_plate_geometry() { :; }
run_dependency_preflight() { return 0; } # fully-provisioned: preflight succeeds, no abort
stop_launchd_monitor_for_install() { return 0; }
stop_orphan_monitor_for_install() { return 0; }
restore_launchd_monitor() { return 0; }
_gate_surface_on_fail() { :; }
_panel_abort() { :; }
HANDOFF_CALLS=0
run_action_panel() {
  HANDOFF_CALLS=$((HANDOFF_CALLS + 1))
  _evt HANDOFF
  return 0
}
# PREFLIGHT_EXIT_BLOCKED is a launcher readonly (already set at source time) — do not reassign.
GATE_QUIET_LOG="$(mktemp "${TMPDIR:-/tmp}/ga-bug1-gate.XXXXXX")"

_evt_reset
ENGAGE_CALLS=0
dispatch_action_install_panel </dev/null
drc=$?
echo "  rc=${drc}  engage_calls=${ENGAGE_CALLS}  handoff_calls=${HANDOFF_CALLS}  events:"
sed 's/^/      /' "${GA_EVT}"
assert_eq "D dispatch returns 0 (clean install)" "0" "${drc}"
# EXACTLY two enter_run_state: W1 (immediate) + the single preflight->monitor boundary re-engage.
# Pre-fix this was four (W1 + launchd + orphan + run_action_panel handoff).
assert_eq "D exactly two composes (W1 + single boundary; no per-gate redraw)" "2" "${ENGAGE_CALLS}"
assert_eq "D run_action_panel handoff invoked once" "1" "${HANDOFF_CALLS}"
# the handoff (W3) lands AFTER both composes → the frame is composed, body-only handoff.
last_compose_before_handoff="$(awk '/COMPOSE/{c++} /HANDOFF/{print c; exit}' "${GA_EVT}")"
assert_eq "D the run_action_panel handoff follows a composed frame (body-only)" "2" "${last_compose_before_handoff}"

echo "============================================================================"
echo "STATIC structural invariants of the re-engage relocation"
echo "============================================================================"
_fn_body() { awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA_DIR_ROOT}"/lib/ga-tui-*.sh; }

# run_action_panel is BODY-ONLY: it no longer self-engages (the caller owns the engage). Match an
# actual CALL line (bare `enter_run_state`), not the word inside an explanatory comment.
rap="$(_fn_body run_action_panel)"
rap_engage_calls="$(grep -cE '^[[:space:]]*enter_run_state([[:space:]].*)?$' <<<"${rap}" || true)"
assert_eq "run_action_panel contains NO enter_run_state CALL (body-only handoff)" "0" "${rap_engage_calls}"

# the W4 re-engage is gated on the EXACT INVERSE of ENGAGE1 (GROUP1 empty).
boxed="$(_fn_body _run_dependency_preflight_boxed)"
if [[ "${boxed}" == *'[[ "${PREFLIGHT_GROUP1_RUNNABLE}" -le 0 ]] && enter_run_state'* ]]; then
  pass "W4 re-engage gated on PREFLIGHT_GROUP1_RUNNABLE -le 0 (inverse of ENGAGE1)"
else
  fail "W4 re-engage is not gated on the ENGAGE1 inverse"
fi
# ENGAGE1 + ENGAGE2 gates preserved.
if [[ "${boxed}" == *'[[ "${PREFLIGHT_GROUP1_RUNNABLE}" -gt 0 ]] && enter_run_state'* &&
  "${boxed}" == *'[[ "${PREFLIGHT_GROUP2_RUNNABLE}" -gt 0 ]] && enter_run_state'* ]]; then
  pass "ENGAGE1 + ENGAGE2 group-gated re-engages preserved"
else
  fail "ENGAGE1/ENGAGE2 group gates altered"
fi

# dispatch has exactly ONE enter_run_state on the orphan-gate path removed: the orphan gate block
# must NOT carry an enter_run_state (it reuses the single boundary frame body-only).
disp="$(_fn_body dispatch_action_install_panel)"
orphan_engages="$(awk '/stop_orphan_monitor_for_install/{print prev} {prev=$0}' <<<"${disp}" | grep -c 'enter_run_state' || true)"
assert_eq "dispatch orphan-gate line is NOT preceded by enter_run_state" "0" "${orphan_engages}"

# uninstall composes the frame before its body-only run_action_panel handoff, and keeps the purge
# engage (two enter_run_state total: the added pre-handoff one + the purge branch's own).
uninst="$(_fn_body dispatch_action_uninstall_panel)"
uninst_engages="$(grep -c 'enter_run_state' <<<"${uninst}" || true)"
if [[ "${uninst_engages}" -ge 2 ]]; then
  pass "uninstall has the pre-handoff engage + the preserved purge engage (${uninst_engages} total)"
else
  fail "uninstall missing an engage (found ${uninst_engages}, expected >=2)"
fi

echo "============================================================================"
printf 'RESULT: %d passed, %d failed\n' "${PASSES}" "${FAILS}"
rm -f "${GA_EVT}" "${GATE_QUIET_LOG:-}" 2>/dev/null || true
[[ "${FAILS}" -eq 0 ]]
