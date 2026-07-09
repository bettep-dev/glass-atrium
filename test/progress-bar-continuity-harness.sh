#!/usr/bin/env bash
# progress-bar-continuity-harness.sh — EXECUTION verification of the progress-bar work (unified continuous
# progress bar) on the UNCOMMITTED working tree. Unlike deps-preflight-exec-harness.sh (which
# focuses on step ORDER + keg resolution and captures only STEP_INDEX/STEP_TOTAL), this harness
# keeps the REAL bar/counter RENDERERS live (build_counter_str / build_progress_bar / build_run_bar
# / _bar_fill / progress_bar_width / preflight_count_and_gate / preflight_panel_step + its clamp)
# and drives _run_dependency_preflight_boxed end-to-end to PROVE the single continuous bar:
#   * STEP_TOTAL is published ONCE and stays constant across ENGAGE1 -> auth -> ENGAGE2 (no reset).
#   * STEP_INDEX is strictly non-decreasing (monotonic) — it never resets to a lower value when
#     the second engage group starts (no blink).
#   * The UNCOUNTED A3 initdb over-count is absorbed by the line-3385 clamp (i <= N), so the bar
#     never overflows (never "N+1/N") and ends EXACTLY at N/N (no stuck N-1/N).
#   * The REAL rendered filled-cell count is monotonic non-decreasing (no visual shrink/blink).
#   * run_plan (install mode) propagates engine exit codes BYTE-FOR-BYTE unchanged.
#
# READ-ONLY toward the live system: every detect / install-command / interactive / tool is stubbed;
# ga_pg_wait_ready is stubbed to return 0 (NOT re-extracted — that is what killed the sibling
# harness's D section). Nothing real (brew/psql/initdb/tmux/lsof/pg_isready/curl) ever runs.
#
# ShellCheck: this harness sources the 4500-line launcher and OVERRIDES its symbols, so several
# checks are inherent false-positives of static analysis against dynamically-sourced code —
#   SC2034 vars read by the sourced fns · SC2154 launcher globals (C_ACCENT/C_ALERT) assigned at
#   source time · SC2312 return-masking in display-only subs · SC2016 literal stub bodies · SC2329
#   fns invoked indirectly by the sourced launcher.
# shellcheck disable=SC2034,SC2154,SC2312,SC2016,SC2329
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

# === render-sequence recorder ==========================================================
# Each draw_workbox call appends one record: "<index> <total> <fill>" where fill is the REAL
# run-state filled-cell count from _bar_fill at the real progress_bar_width. Empty index (pre-first
# step) is skipped. The REAL build_run_bar is ALSO invoked (c() stripped) to prove it renders.
GA_SEQ="$(mktemp "${TMPDIR:-/tmp}/ga-r4-seq.XXXXXX")"
_seq_reset() { : >"${GA_SEQ}"; }
_seq_dump() { cat "${GA_SEQ}"; }

# === scenario detect verdicts (defaults: fresh bare-Mac that installs everything) ======
SC_MISSING="postgresql@18
node@24
bun
sqlite"
SC_HOMEBREW="absent"
SC_PG="present-but-down"
SC_ROLE="absent"
SC_KEG="" # empty => keg-inject default @18
SC_CLAUDE="absent"
SC_AUTH="present"
SC_FAKECHAT="absent"
SC_MARKET="no"
SC_PYTHON="absent"
SC_PG_UTC="down" # guard no-op
SC_PG_INIT="no"  # data dir uninitialized => A3 initdb FIRES (the uncounted over-count step)

ga_detect_xcode_clt() { printf 'present\n'; }
ga_detect_homebrew() { printf '%s\n' "${SC_HOMEBREW}"; }
ga_detect_node() { printf 'present\n'; }
ga_detect_bun() { printf 'present\n'; }
ga_detect_cli_tool() { printf 'present\n'; }
ga_detect_sqlite_fts5() { printf 'present\n'; }
ga_detect_postgres() { printf '%s\n' "${SC_PG}"; }
ga_detect_postgres_role() { printf '%s\n' "${SC_ROLE}"; }
ga_detect_claude_cli() { printf '%s\n' "${SC_CLAUDE}"; }
ga_detect_claude_auth() { printf '%s\n' "${SC_AUTH}"; }
ga_detect_fakechat() { printf '%s\n' "${SC_FAKECHAT}"; }
ga_marketplace_present() { printf '%s\n' "${SC_MARKET}"; }
ga_detect_python_libs() { printf '%s\n' "${SC_PYTHON}"; }
ga_detect_postgres_utc() { printf '%s\n' "${SC_PG_UTC}"; }
ga_pg_data_dir_initialized() { printf '%s\n' "${SC_PG_INIT}"; }
ga_brew_missing_set() {
  [[ -n "${SC_MISSING}" ]] && printf '%s\n' "${SC_MISSING}"
  return 0
}
ga_python_missing_set() { printf 'psycopg\n'; }
ga_pg_keg_major() { printf '%s' "${SC_KEG}"; }

# install-command builders => recorder tokens (real fns executed by run_step return 0)
ga_cmd_homebrew_install() { printf 'rec_ok\n'; }
ga_cmd_brew_batch() {
  [[ -n "${SC_MISSING}" ]] && printf 'rec_ok\n'
  return 0
}
ga_cmd_pg_service_start() { printf 'rec_ok\n'; }
ga_cmd_pg_service_restart() { printf 'rec_ok\n'; }
ga_cmd_pg_initdb() { printf 'rec_ok\n'; }
ga_cmd_pg_create_role() { printf 'rec_ok\n'; }
ga_cmd_claude_cli_install() { printf 'rec_ok\n'; }
ga_cmd_fakechat_install() { printf 'rec_ok\n'; }
ga_cmd_marketplace_add() { printf 'rec_ok\n'; }
ga_cmd_python_libs_user() { printf 'rec_ok\n'; }
ga_cmd_python_libs_break_system() { printf 'rec_ok\n'; }
rec_ok() { return 0; }

# ga_pg_wait_ready STUBBED to ready (do NOT re-extract the real bounded poll — it would fail
# with no pg_isready on PATH and abort the run under run_step's re-armed set -e).
ga_pg_wait_ready() { return 0; }

# keg-inject terminal capture (keep the real resolver above it)
preflight_keg_path_inject() { return 0; }

# interactive gates => non-blocking
confirm_typed() { return 0; }
preflight_guide_xcode_clt() { return 0; }
preflight_grouped_consent() { return 0; }
preflight_guide_claude_auth() { return 0; }
preflight_provision_headless_token() { return 0; }
token_already_provisioned() { return 0; }
preflight_install_fakechat() { return 0; }
preflight_install_python_libs() { return 0; }
preflight_bracket() { "$@"; } # run the gate, no alt-screen/stty
ENGAGE_CALLS=0
enter_run_state() { ENGAGE_CALLS=$((ENGAGE_CALLS + 1)); }

# TTY paint fns => no-op / color-strip
redraw_frame_inplace() { :; }
build_install_progress_body() { printf ''; }
redraw_install_progress() { :; }
paint_workbox_body_inner() { :; }
paint_workbox_body_row2_inner() { :; } # LINE 2 painter stub (async-feel 2-row box)
start_step_spinner() { :; }
stop_step_spinner() { :; }
# idle-spinner (async-feel animator) stubs — no-op by default; the idle-window balance section overrides
# these with counters to prove the detection/handoff windows are animated with no PID leak.
start_idle_spinner() { :; }
stop_idle_spinner() { :; }
classify_step_log() { STEP_SUPPRESSED_COUNT=0; }
_dump_step_log() { :; }
c() { printf '%s' "${2:-}"; } # strip SGR so the rendered bar string is measurable
tp() { :; }
tty_line() { :; }
tty_out() { :; }
preflight_line() { :; }
preflight_out() { :; }
preflight_eval_brew_shellenv() { :; }
preflight_path_prepend() { :; }
preflight_persist_rc_line() { :; }
preflight_release_tty() { :; }

# draw_workbox OVERRIDE: capture the REAL rendered counter. build_run_bar/build_counter_str stay
# REAL below this — we invoke them (not stub them) to prove they render without error, and we
# independently record the REAL _bar_fill result at the real width for a numeric monotonicity check.
draw_workbox() {
  local idx="${STEP_INDEX:-}" tot="${STEP_TOTAL:-}"
  [[ -z "${idx}" ]] && return 0
  local width fill run_bar cstr
  width="$(progress_bar_width)"
  fill="$(_bar_fill "${idx}" "${tot}" "${width}")" # REAL fill math (SoT)
  run_bar="$(build_run_bar)"                       # REAL dominant bar (must be non-empty)
  cstr="$(build_counter_str "${idx}" "${tot}")"    # REAL counter string
  printf '%s %s %s %s | %s\n' "${idx}" "${tot}" "${fill}" "${run_bar:+nonempty}" "${cstr}" >>"${GA_SEQ}"
}

TTY="/dev/null"
PREFLIGHT_TTY_OWNED="false"
PREFLIGHT_SUMMARY="scripted-auto-work"
MENU_INNER=52

# === run one preflight path (set -e safe against run_step's internal re-arm) ============
run_path() {
  local pathfn="$1" rc=0
  set +e
  trap - ERR
  _seq_reset
  STEP_INDEX=""
  STEP_TOTAL=""
  STEP_INDEX_BASE="" # 4a: preflight is phase 1 (no carried offset) — start each run with a clean base
  ENGAGE_CALLS=0
  "${pathfn}" </dev/null || rc=$?
  set +e
  trap - ERR
  return "${rc}"
}

echo "============================================================================"
echo "boxed preflight — single continuous bar w/ A3 initdb over-count clamp"
echo "============================================================================"
run_path _run_dependency_preflight_boxed
rc=$?
seq="$(_seq_dump)"
echo "  rc=${rc}  engage_calls=${ENGAGE_CALLS}"
echo "  rendered counter sequence (idx tot fill bar | counterstr):"
printf '%s\n' "${seq}" | sed 's/^/    /'

assert_eq "boxed preflight returns 0 (engine exit unchanged)" "0" "${rc}"

# --- parse the sequence into arrays ---
idxs=()
tots=()
fills=()
bars=()
while IFS=' ' read -r i t f b _rest; do
  [[ -z "${i}" ]] && continue
  idxs+=("${i}")
  tots+=("${t}")
  fills+=("${f}")
  bars+=("${b}")
done <<<"${seq}"

n_rec="${#idxs[@]}"
if [[ "${n_rec}" -lt 2 ]]; then
  fail "expected >=2 rendered steps, got ${n_rec}"
else
  pass "rendered ${n_rec} framed steps"
fi

# 1) STEP_TOTAL published ONCE + constant across every render (no per-phase reset)
total_const="yes"
total0="${tots[0]}"
for t in "${tots[@]}"; do [[ "${t}" == "${total0}" ]] || total_const="no"; done
assert_eq "STEP_TOTAL constant across ENGAGE1->ENGAGE2 (published once)" "yes" "${total_const}"

# 2) STEP_INDEX strictly non-decreasing (monotonic — no reset/blink at the phase boundary)
mono="yes"
prev=0
for i in "${idxs[@]}"; do
  [[ "${i}" -ge "${prev}" ]] || mono="no"
  prev="${i}"
done
assert_eq "STEP_INDEX monotonic non-decreasing (no reset between phases)" "yes" "${mono}"

# 3) never overflow — clamp holds even with the UNCOUNTED initdb advance
overflow="no"
for k in "${!idxs[@]}"; do [[ "${idxs[${k}]}" -gt "${tots[${k}]}" ]] && overflow="yes"; done
assert_eq "STEP_INDEX never exceeds STEP_TOTAL (clamp absorbs initdb over-count)" "no" "${overflow}"

# 4) ends EXACTLY at N/N (no stuck N-1/N)
last=$((n_rec - 1))
assert_eq "final render lands at N/N (no stuck N-1/N)" "${tots[${last}]}" "${idxs[${last}]}"

# 5) the uncounted initdb DID cause a clamp engagement: #framed panel steps executed exceeds
#    STEP_TOTAL (initdb is an extra advance) yet index never passed N. Prove the clamp fired by
#    counting how many records sit AT the ceiling (>=2 consecutive N/N == an over-count was capped).
ceil_hits=0
for k in "${!idxs[@]}"; do [[ "${idxs[${k}]}" -eq "${tots[${k}]}" ]] && ceil_hits=$((ceil_hits + 1)); done
if [[ "${n_rec}" -gt "${total0}" && "${ceil_hits}" -ge 2 ]]; then
  pass "clamp engaged: ${n_rec} advances vs STEP_TOTAL=${total0}, ${ceil_hits} records capped at N/N"
else
  # not necessarily a failure (depends on which steps ran) — report as info
  printf '    INFO  n_rec=%s total=%s ceil_hits=%s (initdb over-count path)\n' "${n_rec}" "${total0}" "${ceil_hits}"
fi

# 6) rendered filled-cell count monotonic non-decreasing (no visual shrink/blink)
fmono="yes"
pf=0
for f in "${fills[@]}"; do
  [[ "${f}" -ge "${pf}" ]] || fmono="no"
  pf="${f}"
done
assert_eq "rendered bar fill monotonic non-decreasing (no blink/shrink)" "yes" "${fmono}"

# 7) build_run_bar rendered a non-empty dominant bar at every framed step
allbar="yes"
for b in "${bars[@]}"; do [[ "${b}" == "nonempty" ]] || allbar="no"; done
assert_eq "build_run_bar produced a non-empty bar at every step" "yes" "${allbar}"

echo ""
echo "============================================================================"
echo "engine exit codes BYTE-FOR-BYTE unchanged through run_plan (install mode)"
echo "============================================================================"
# A 3-step install plan whose MIDDLE step returns an arbitrary rc must surface that rc verbatim
# + set STEP_FAIL_INDEX=2. Then an all-pass plan must return 0. This proves the progress-bar render changes
# left run_plan's exit-code propagation untouched.
_step_ok_a() { return 0; }
_step_fail_42() { return 42; }
_step_ok_c() { return 0; }

set +e
trap - ERR
STEP_LABEL=("a" "b" "c")
STEP_LABEL_ACTIVE=("a" "b" "c")
STEP_FN=("_step_ok_a" "_step_fail_42" "_step_ok_c")
STEP_SUPPRESS=("" "" "")
STEP_FAIL_INDEX=""
rc=0
run_plan "exit-code plan" "${C_ACCENT}" "install" </dev/null || rc=$?
set +e
trap - ERR
printf '  run_plan(mid-step rc=42) => rc=%s STEP_FAIL_INDEX=%s\n' "${rc}" "${STEP_FAIL_INDEX:-}"
assert_eq "run_plan surfaces the failing step's rc byte-for-byte" "42" "${rc}"
assert_eq "STEP_FAIL_INDEX marks the 1-based failing step" "2" "${STEP_FAIL_INDEX:-}"

set +e
trap - ERR
STEP_LABEL=("a" "b")
STEP_LABEL_ACTIVE=("a" "b")
STEP_FN=("_step_ok_a" "_step_ok_c")
STEP_SUPPRESS=("" "")
STEP_FAIL_INDEX=""
rc=0
run_plan "all-pass plan" "${C_ACCENT}" "install" </dev/null || rc=$?
set +e
trap - ERR
printf '  run_plan(all pass) => rc=%s\n' "${rc}"
assert_eq "run_plan returns 0 when every step passes" "0" "${rc}"

# uninstall mode (RENDER_MODE empty) — the historical scrolling path — exit code unchanged too
set +e
trap - ERR
STEP_LABEL=("a" "b")
STEP_LABEL_ACTIVE=("a" "b")
STEP_FN=("_step_ok_a" "_step_fail_42")
STEP_SUPPRESS=("" "")
STEP_FAIL_INDEX=""
rc=0
run_plan "uninstall-mode plan" "${C_ALERT}" </dev/null || rc=$?
set +e
trap - ERR
printf '  run_plan(uninstall mode, last-step rc=42) => rc=%s\n' "${rc}"
assert_eq "uninstall-mode run_plan surfaces rc unchanged" "42" "${rc}"

echo ""
echo "============================================================================"
echo "box-engage gating — an all-present group never engages an empty box"
echo "============================================================================"
# All-present scenario: no auto-work => preflight_count_and_gate yields STEP_TOTAL=0 and the
# ENGAGE gates skip enter_run_state. Proves the box only engages when work exists.
SC_MISSING="" SC_HOMEBREW="present" SC_PG="present" SC_ROLE="present" SC_KEG="18"
SC_CLAUDE="present" SC_AUTH="present" SC_FAKECHAT="present" SC_MARKET="yes" SC_PYTHON="present"
SC_PG_UTC="down" SC_PG_INIT="yes"
PREFLIGHT_SUMMARY="" # no auto work
run_path _run_dependency_preflight_boxed
rc=$?
printf '  all-present boxed rc=%s engage_calls=%s\n' "${rc}" "${ENGAGE_CALLS}"
assert_eq "all-present boxed returns 0" "0" "${rc}"
assert_eq "no enter_run_state engage when nothing runs (box not flashed)" "0" "${ENGAGE_CALLS}"

echo ""
echo "============================================================================"
echo "ONE continuous index across the preflight->install run_plan handoff (4a)"
echo "============================================================================"
# The load-bearing 4a proof: drive the boxed preflight (fresh bare-Mac, framed steps run), then drive
# the install run_plan and PROVE its DISPLAYED index continues at base+1..base+n (never resets to 1).
# STEP_INDEX_BASE carries the preflight FINAL clamped index across the handoff; build_run_bar renders
# the OFFSET index/total. We record the DISPLAY (offset) pair by wrapping build_progress_bar (the SoT
# both build_run_bar callers funnel through), so the recorded values ARE what the user would see.

# reset to the fresh bare-Mac scenario (the box-engage scenario mutated the SC_* detect verdicts to all-present)
SC_MISSING="postgresql@18
node@24
bun
sqlite"
SC_HOMEBREW="absent"
SC_PG="present-but-down"
SC_ROLE="absent"
SC_KEG=""
SC_CLAUDE="absent"
SC_AUTH="present"
SC_FAKECHAT="absent"
SC_MARKET="no"
SC_PYTHON="absent"
SC_PG_UTC="down"
SC_PG_INIT="no"
PREFLIGHT_SUMMARY="scripted-auto-work"

run_path _run_dependency_preflight_boxed
rc=$?
seq="$(_seq_dump)"
# the LAST preflight render's idx is the real preflight step count carried into the base
last_pf_idx=""
while IFS=' ' read -r i _t _f _b _rest; do
  [[ -z "${i}" ]] && continue
  last_pf_idx="${i}"
done <<<"${seq}"
base_after="${STEP_INDEX_BASE:-}"
# Unified grand total: preflight_count_and_gate freezes GRAND_TOTAL = (g1+g2 preflight) + INSTALL_PLAN_LEN and
# the preflight->install handoff PRESERVES it (partial clear keeps STEP_INDEX_BASE + GRAND_TOTAL). Capture
# it HERE — the install run_plan below is on the install-panel path and its end-of-plan _clear_step_state
# sweeps GRAND_TOTAL, so it must be read before that teardown to assert the install denominator.
grand_frozen="${GRAND_TOTAL:-}"
printf '  boxed preflight rc=%s  last preflight idx=%s  STEP_INDEX_BASE after handoff=%s  GRAND_TOTAL=%s\n' \
  "${rc}" "${last_pf_idx}" "${base_after}" "${grand_frozen}"
assert_eq "boxed preflight (fresh) returns 0" "0" "${rc}"
assert_eq "handoff CARRIES the preflight FINAL clamped index into STEP_INDEX_BASE" "${last_pf_idx}" "${base_after}"
# Grand-total formula pin: the frozen grand total is the preflight step count (base) + the fixed 14-step install plan.
assert_eq "handoff PRESERVES the frozen GRAND_TOTAL = base + INSTALL_PLAN_LEN (unified denominator)" "$((base_after + INSTALL_PLAN_LEN))" "${grand_frozen}"
if [[ "${base_after}" =~ ^[0-9]+$ && "${base_after}" -ge 1 ]]; then
  pass "carried base is a positive integer (preflight steps ran): ${base_after}"
else
  fail "carried base should be a positive integer, got [${base_after}]"
fi

# record the DISPLAY (offset) index/total that build_run_bar feeds build_progress_bar per step.
R4_DISP="$(mktemp "${TMPDIR:-/tmp}/ga-r4-disp.XXXXXX")"
build_progress_bar() { printf '%s %s\n' "$1" "$2" >>"${R4_DISP}"; } # capture DISPLAY i/n (offset applied)

# drive the install run_plan (panel mode) exactly as dispatch does after the handoff — base carries.
set +e
trap - ERR
: >"${R4_DISP}"
STEP_LABEL=("s1" "s2" "s3")
STEP_LABEL_ACTIVE=("s1" "s2" "s3")
STEP_FN=("rec_ok" "rec_ok" "rec_ok")
STEP_SUPPRESS=("" "" "")
run_plan "install-after-preflight" "${C_ACCENT}" "panel" </dev/null || true
set +e
trap - ERR

d_idxs=()
d_tots=()
while IFS=' ' read -r di dt _rest; do
  [[ -z "${di}" ]] && continue
  d_idxs+=("${di}")
  d_tots+=("${dt}")
done <"${R4_DISP}"
printf '  install run_plan DISPLAY sequence (idx/total): '
for k in "${!d_idxs[@]}"; do printf '%s/%s ' "${d_idxs[${k}]}" "${d_tots[${k}]}"; done
printf '\n'

assert_eq "install run_plan rendered 3 display steps" "3" "${#d_idxs[@]}"
assert_eq "install FIRST display index continues at base+1 (NO reset to 1/n)" "$((base_after + 1))" "${d_idxs[0]:-}"

# Unified grand total (re-target): the install-panel denominator is the ONE frozen GRAND_TOTAL (base + INSTALL_PLAN_LEN),
# NOT the pre-unification base+local_plan_len. This scenario IS the install path (mode="panel", base carried from the
# real preflight that froze GRAND_TOTAL), so every display step renders over the unified grand total — here
# the 3-step mock plan renders base+1..base+3 / GRAND_TOTAL (a truncated stand-in for the real 14-step plan;
# the idx-continuity checks above/below still pin base+k+1). The shared-caller sweep is proved by the shared-caller scenario below.
grand_ok="yes"
for t in "${d_tots[@]}"; do [[ "${t}" == "${grand_frozen}" ]] || grand_ok="no"; done
assert_eq "install display TOTAL is the frozen GRAND_TOTAL (unified denominator) on every step" "yes" "${grand_ok}"

cont_ok="yes"
for k in "${!d_idxs[@]}"; do [[ "${d_idxs[${k}]}" == "$((base_after + k + 1))" ]] || cont_ok="no"; done
assert_eq "install display index is ONE continuous base+1..base+n run" "yes" "${cont_ok}"

noreset="yes"
for di in "${d_idxs[@]}"; do [[ "${di}" -gt "${base_after}" ]] || noreset="no"; done
assert_eq "no install display index falls back to <=base (no handoff blink/reset)" "yes" "${noreset}"

# reset lifecycle: run_plan's end-of-plan _clear_step_state MUST sweep the carried base so a later
# shared caller does not inherit it (QA engine-safety MUST-HANDLE).
assert_eq "run_plan end-of-plan teardown swept STEP_INDEX_BASE (no stale base)" "" "${STEP_INDEX_BASE:-}"

echo ""
echo "============================================================================"
echo "shared run_plan callers keep their OWN independent counter (base unset)"
echo "============================================================================"
# With the base swept, an uninstall/db/token/purge run_plan renders raw 1..n / n — byte-for-byte the
# pre-4a behavior. Proves the STEP_INDEX_BASE offset is confined to the install-panel handoff.
set +e
trap - ERR
: >"${R4_DISP}"
STEP_INDEX_BASE="" # explicit: a shared caller never carries a base
STEP_LABEL=("u1" "u2" "u3" "u4")
STEP_LABEL_ACTIVE=("u1" "u2" "u3" "u4")
STEP_FN=("rec_ok" "rec_ok" "rec_ok" "rec_ok")
STEP_SUPPRESS=("" "" "" "")
run_plan "uninstall-mode plan" "${C_ALERT}" </dev/null || true
set +e
trap - ERR

u_idxs=()
u_tots=()
while IFS=' ' read -r di dt _rest; do
  [[ -z "${di}" ]] && continue
  u_idxs+=("${di}")
  u_tots+=("${dt}")
done <"${R4_DISP}"
rm -f "${R4_DISP}"
printf '  uninstall run_plan DISPLAY sequence (idx/total): '
for k in "${!u_idxs[@]}"; do printf '%s/%s ' "${u_idxs[${k}]}" "${u_tots[${k}]}"; done
printf '\n'
assert_eq "shared caller FIRST index is 1 (no inherited base offset)" "1" "${u_idxs[0]:-}"
assert_eq "shared caller total is its own raw n (no base+n)" "4" "${u_tots[0]:-}"
assert_eq "shared caller ends at n/n (raw)" "4" "${u_idxs[$((${#u_idxs[@]} - 1))]:-}"

echo ""
echo "============================================================================"
echo "LINE 2 detail resolver — real-time tail + SLOW dots fallback"
echo "============================================================================"
# _spinner_rolling_label is a PURE helper (reads its tick arg + STEP_LOG_CUR), so the LINE 2 detail
# is unit-testable WITHOUT the time-based forked spinner (mocked to a no-op here). The step LABEL now
# lives on LINE 1 (the stable headline) — this resolver returns ONLY the LINE 2 detail: the output
# tail when the step is emitting, else the SLOW dots animation (NOT the buggy per-tick roll).
R4_LOG="$(mktemp "${TMPDIR:-/tmp}/ga-r4-log.XXXXXX")"

# (a) non-empty capture => the LATEST line (real-time sub-process output), across ticks
printf 'compiling module A\ncompiling module B\n' >"${R4_LOG}"
STEP_LOG_CUR="${R4_LOG}"
assert_eq "LINE2 detail shows the latest captured line (output-producing step, tick 0)" "compiling module B" "$(_spinner_rolling_label 0)"
# a NEW line appended => the detail follows it on the next slow-boundary tick (the calm refresh proof)
printf 'linking\n' >>"${R4_LOG}"
assert_eq "LINE2 detail FOLLOWS newly appended output (calm refresh)" "linking" "$(_spinner_rolling_label 6)"

# (b) empty capture => the SLOW dots animation (no base label — the label is on LINE 1)
: >"${R4_LOG}"
assert_eq "empty-log (no-output step) fallback tick 0 = one dot" "." "$(_spinner_rolling_label 0)"
assert_eq "empty-log fallback at the FIRST slow boundary = two dots" ".." "$(_spinner_rolling_label "${SPIN_SLOW_DIV}")"
assert_eq "empty-log fallback at the SECOND slow boundary = three dots" "..." "$(_spinner_rolling_label $((SPIN_SLOW_DIV * 2)))"
assert_eq "empty-log fallback cycles back to one dot at the THIRD slow boundary" "." "$(_spinner_rolling_label $((SPIN_SLOW_DIV * 3)))"

# (c) unset capture (non-capturing step) => the dots, never a crash under set -u
STEP_LOG_CUR=""
assert_eq "no-capture step falls back to the slow dots (set -u safe)" "." "$(_spinner_rolling_label 0)"

# (d) an over-long output line is width-trimmed to a single row (no wrap)
printf 'X%.0s' $(seq 1 90) >"${R4_LOG}"
STEP_LOG_CUR="${R4_LOG}"
trimmed="$(_spinner_rolling_label 0)"
if [[ "${#trimmed}" -le 58 && "${trimmed}" == *... ]]; then
  pass "over-long output line trimmed to a single row (len=${#trimmed}, ellipsized)"
else
  fail "over-long line should be trimmed+ellipsized, got len=${#trimmed}"
fi
rm -f "${R4_LOG}"

echo ""
echo "============================================================================"
echo "SLOW-cadence dots + 2-row box geometry + idle-window balance"
echo "============================================================================"
# (a) _spinner_dots: the dots advance on the SLOW boundary (every SPIN_SLOW_DIV ticks ≈ 600ms), NOT
# every 100ms tick. Prove every tick WITHIN a slow window yields the SAME dots (decoupled from the
# 100ms frame), and the dots ADVANCE only at the window boundary.
dots_stable="yes"
k=0
while [[ "${k}" -lt "${SPIN_SLOW_DIV}" ]]; do
  [[ "$(_spinner_dots "${k}")" == "." ]] || dots_stable="no"
  k=$((k + 1))
done
assert_eq "dots are STABLE across every 100ms tick within a slow window (not a per-tick roll)" "yes" "${dots_stable}"
assert_eq "dots ADVANCE to '..' only at the slow-window boundary" ".." "$(_spinner_dots "${SPIN_SLOW_DIV}")"
assert_eq "dots phase is set-u safe at tick 0" "." "$(_spinner_dots 0)"

# (b) 2-row box geometry: WORKBOX_BODY_ROW2 is the row directly below LINE 1, and the bottom rail
# sits one row below THAT (WORKBOX_FIRST_ROW+3), all STRICTLY above the pinned keyhint. Drive the
# REAL compute_menu_geometry with a generous stubbed TTY so FULLSCREEN engages.
term_size() { printf '120 50'; }
tput() { case "$1" in cup) return 0 ;; *) return 0 ;; esac; }
GEOMETRY_DIRTY=true
compute_menu_geometry
assert_eq "LINE 2 anchor is exactly one row below LINE 1 (2-row body)" "$((WORKBOX_BODY_ROW + 1))" "${WORKBOX_BODY_ROW2}"
assert_eq "LINE 1 anchor is one row below the box top rail" "$((WORKBOX_FIRST_ROW + 1))" "${WORKBOX_BODY_ROW}"
if [[ "$((WORKBOX_FIRST_ROW + 3))" -lt "${MENU_KEYHINT_ROW}" ]]; then
  pass "4-row box (top+LINE1+LINE2+bottom) bottom rail stays STRICTLY above the pinned keyhint (rail-safe)"
else
  fail "box bottom rail ($((WORKBOX_FIRST_ROW + 3))) collides the keyhint (${MENU_KEYHINT_ROW})"
fi

# (c) idle-window balance: the boxed preflight's async-feel animation MUST start at least one idle
# window (no frozen blank frame) AND every start MUST be matched by a stop (single-active invariant,
# no leaked idle PID). Override start/stop_idle_spinner with counters, re-drive the boxed preflight.
IDLE_STARTS=0
IDLE_STOPS=0
start_idle_spinner() { IDLE_STARTS=$((IDLE_STARTS + 1)); }
stop_idle_spinner() { IDLE_STOPS=$((IDLE_STOPS + 1)); }
run_path _run_dependency_preflight_boxed
echo "  idle windows: starts=${IDLE_STARTS} stops=${IDLE_STOPS}"
if [[ "${IDLE_STARTS}" -ge 1 ]]; then
  pass "boxed preflight animates at least one idle window (no frozen/blank detection frame): ${IDLE_STARTS}"
else
  fail "boxed preflight started NO idle window — a blank detection frame would render"
fi
assert_eq "every idle start is matched by a stop (single-active invariant, no leaked idle PID)" "${IDLE_STARTS}" "${IDLE_STOPS}"

echo ""
echo "============================================================================"
echo "per-window idle ANIMATION VALUE — detection / count_and_gate / handoff"
echo "============================================================================"
# Assertion (A): NO blank/static frame in the detection, preflight_count_and_gate, and
# preflight->run_plan handoff windows — an animation VALUE (a non-blank painted frame carrying
# the window label on LINE 1 + a live dots token on LINE 2) is present at EACH.
#
# The REAL start_idle_spinner forks a subshell that paints every 100ms; that fork is hard-gated
# on an interactive TTY (`[[ -t 1 ]]`) + FULLSCREEN, so under a piped harness it is a deliberate
# no-op (the terminal VISUAL is interactive-only). So this section (1) drives the REAL call sites
# — dispatch_action_install_panel (detection + the count_and_gate it spans, per glass-atrium:3215)
# and run_action_panel (the handoff, glass-atrium:2023-2029) and the boxed preflight (the pg
# cluster, glass-atrium:4603) — with (2) a FAITHFUL synchronous tick-0 reproducer of the fork's
# paint (mirrors glass-atrium:1849-1865: `  <frame0> <label>` on LINE 1, `  <_spinner_dots 0>` on
# LINE 2, using the REAL SPIN_FRAMES + the REAL _spinner_dots). It records one <label>\t<line1>\t
# <line2> row per window so the actual painted value at each real call site is asserted non-blank.
IDLE_CAP="$(mktemp "${TMPDIR:-/tmp}/ga-r4-idlecap.XXXXXX")"
: >"${IDLE_CAP}"
# a representative SPIN_FRAMES + a deterministic bar-glyph set (resolve_glyphs is main-only, never
# runs at source time) so the REAL build_run_bar renders a measurable progress track.
SPIN_FRAMES='- \ | /'
PROG_FULL='#'
PROG_EMPTY='.'

# T2 re-instrumentation: observe the REAL painter that stop_idle_spinner's run-state restore paints —
# NOT a re-synthesized frame+label (the old reproducer synthesized LINE 1 = frame+label independently
# of STEP_BAR_CUR, so it was INVARIANT to the blank-box fix and asserted nothing). The idle window runs
# in run-state; a dummy IDLE_PID + no-op kill/wait let the REAL stop_idle_spinner restore tail fire,
# painting the REAL body via the captured painter — bar+count on the bar-carrying resolve window (Edit 3
# sets STEP_BAR_CUR), blank on the no-step-count detection/port/handoff windows (RC-1's bar-presence
# carve-out). Mirrors test/workbox-bar-count-visible-during-resolve.bats's discriminator.
# the R4_DISP section above stubbed build_progress_bar to a file-capture; restore the REAL one so
# build_run_bar renders an actual progress track for the run-state restore body.
eval "$(awk 'index($0, "build_progress_bar() {") == 1 {f=1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA_DIR_ROOT}"/lib/ga-tui-*.sh)"
kill() { return 0; }
wait() { return 0; }
CUR_IDLE_LABEL=""
IN_STOP=0
start_idle_spinner() {
  IDLE_STARTS=$((IDLE_STARTS + 1))
  CUR_IDLE_LABEL="${1:-}"
  WORK_STATE=run          # the async-feel idle window is a run-state window (real enter_run_state is stubbed here)
  IDLE_PID="idle-harness" # non-empty so the REAL stop_idle_spinner runs its restore tail
}
# re-install the REAL (Edit-1) stop_idle_spinner (earlier sections stubbed it) and wrap it so the
# matched start/stop counter survives while the real run-state restore paints through the capture.
eval "$(awk 'index($0, "stop_idle_spinner() {") == 1 {f=1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA_DIR_ROOT}"/lib/ga-tui-*.sh | sed '1s/stop_idle_spinner/__real_stop_idle/')"
stop_idle_spinner() {
  IDLE_STOPS=$((IDLE_STOPS + 1))
  IN_STOP=1
  __real_stop_idle
  IN_STOP=0
}
# capture ONLY the stop_idle_spinner restore paint (Edit 1), tagged with the active window label —
# NOT the panel-step paints that also target this row — so each idle window yields exactly one row:
# its REAL run-state restore body.
paint_workbox_body_inner() {
  [[ "${IN_STOP}" == "1" ]] || return 0
  printf '%s\t%s\n' "${CUR_IDLE_LABEL}" "$1" >>"${IDLE_CAP}"
}
paint_workbox_body_row2_inner() { :; }

# assert one captured window's REAL restore body. mode=bar -> LINE 1 carries a progress track glyph
# (PROG_FULL/PROG_EMPTY) + an i/N count (VISIBLE, not merely animated; the fill % may be low early so
# the track glyph — not a specific fill count — is the invariant). mode=blank -> LINE 1 is blank (the
# correct no-step-count resting state, proving the compound gate does not over-paint). $1=name $2=label
# $3=mode.
assert_window_body() {
  local name="$1" want="$2" mode="$3" row l1
  row="$(awk -F'\t' -v w="${want}" '$1 == w {print; exit}' "${IDLE_CAP}")"
  if [[ -z "${row}" ]]; then
    fail "${name} window emitted NO restore frame (label='${want}' not captured)"
    return
  fi
  l1="$(printf '%s' "${row}" | cut -f2)"
  case "${mode}" in
    bar)
      if [[ -n "${l1// /}" ]] && { [[ "${l1}" == *"${PROG_FULL}"* ]] || [[ "${l1}" == *"${PROG_EMPTY}"* ]]; } && [[ "${l1}" =~ [0-9]+/[0-9]+ ]]; then
        pass "${name} window LINE 1 carries the bar+count (not blank-box) [${l1}]"
      else
        fail "${name} window LINE 1 missing bar+count (blank-box regression) [${l1}]"
      fi
      ;;
    blank)
      if [[ -z "${l1// /}" ]]; then
        pass "${name} no-step-count window LINE 1 correctly blank (compound gate, no over-paint)"
      else
        fail "${name} no-step-count window LINE 1 unexpectedly painted a bar (over-assert) [${l1}]"
      fi
      ;;
  esac
}

# --- drive the DETECTION (+ count_and_gate) window via the REAL dispatch_action_install_panel ---
# stub the surrounding gate machinery to a clean no-op so the three in-dispatch start_idle_spinner
# call sites fire, then observe the REAL stop_idle_spinner restore body via the captured painter.
apply_plate_geometry() { :; }
run_gate_quiet() {
  local rc=0
  "$@" || rc=$?
  return "${rc}"
}
run_dependency_preflight() { return 0; }
stop_launchd_monitor_for_install() { return 0; }
stop_orphan_monitor_for_install() { return 0; }
restore_launchd_monitor() { return 0; }
_panel_abort() { :; }
# run_action_panel is LEFT REAL (not stubbed) so dispatch drives its handoff idle window through
# real code; its engine callees are stubbed to a clean no-op so no real install work runs.
build_step_plan() {
  STEP_FN=("rec_ok")
  STEP_LABEL=("s1")
  STEP_LABEL_ACTIVE=("s1")
  STEP_SUPPRESS=("")
}
run_plan() { return 0; }
status_line() { :; }
FULLSCREEN=true
set +e
trap - ERR
: >"${IDLE_CAP}"
IDLE_STARTS=0
IDLE_STOPS=0
STEP_INDEX="" # detection/monitor-stop windows precede count_and_gate => empty bar => blank rest
STEP_TOTAL=""
STEP_BAR_CUR=""
WORK_STATE=nav
dispatch_action_install_panel </dev/null
disp_rc=$?
set +e
trap - ERR
printf '  dispatch_action_install_panel rc=%s  idle starts=%s stops=%s\n' "${disp_rc}" "${IDLE_STARTS}" "${IDLE_STOPS}"
printf '  captured detection-phase windows:\n'
sed 's/^/    /' "${IDLE_CAP}"
assert_eq "dispatch_action_install_panel returns 0 (engine exit unchanged)" "0" "${disp_rc}"
assert_window_body "detection" "Detecting dependencies" blank
# the detection idle window SPANS preflight_count_and_gate (glass-atrium:3215 — stopped only when the
# first bracket/panel step takes over) and precedes any step bar, so its correct resting state is BLANK
# (RC-1's bar-presence carve-out) — asserting blank proves the compound gate does NOT over-paint a bar
# on the no-step-count window (they are the SAME idle window, not two).
assert_window_body "preflight_count_and_gate (spanned by the detection window)" "Detecting dependencies" blank
assert_window_body "monitor-stop gate" "Freeing monitor port" blank
assert_eq "every dispatch idle start is matched by a stop (no leaked idle PID)" "${IDLE_STARTS}" "${IDLE_STOPS}"

# --- drive the HANDOFF window via the REAL run_action_panel (glass-atrium:2020-2039), standalone ---
set +e
trap - ERR
: >"${IDLE_CAP}"
IDLE_STARTS=0
IDLE_STOPS=0
STEP_INDEX="" # the handoff runs after the preflight tail cleared the step bar => blank rest
STEP_TOTAL=""
STEP_BAR_CUR=""
WORK_STATE=nav
run_action_panel install "Install" "${C_OK}" </dev/null
rap_rc=$?
set +e
trap - ERR
printf '  run_action_panel rc=%s  idle starts=%s stops=%s\n' "${rap_rc}" "${IDLE_STARTS}" "${IDLE_STOPS}"
printf '  captured handoff window:\n'
sed 's/^/    /' "${IDLE_CAP}"
assert_eq "run_action_panel returns 0 (engine exit unchanged)" "0" "${rap_rc}"
assert_window_body "preflight->run_plan handoff" "Preparing steps" blank
assert_eq "handoff idle start is matched by a stop (no leaked idle PID)" "${IDLE_STARTS}" "${IDLE_STOPS}"

# --- confirm the pg-cluster window (glass-atrium:4603) also paints a value in the boxed preflight ---
# reset to the fresh bare-Mac scenario that FIRES the pg resolve idle window
SC_MISSING="postgresql@18
node@24
bun
sqlite"
SC_HOMEBREW="absent"
SC_PG="present-but-down"
SC_ROLE="absent"
SC_KEG=""
SC_CLAUDE="absent"
SC_AUTH="present"
SC_FAKECHAT="absent"
SC_MARKET="no"
SC_PYTHON="absent"
SC_PG_UTC="down"
SC_PG_INIT="no"
PREFLIGHT_SUMMARY="scripted-auto-work"
: >"${IDLE_CAP}"
IDLE_STARTS=0
IDLE_STOPS=0
run_path _run_dependency_preflight_boxed
printf '  boxed preflight pg-window capture: idle starts=%s stops=%s\n' "${IDLE_STARTS}" "${IDLE_STOPS}"
sed 's/^/    /' "${IDLE_CAP}"
assert_window_body "pg keg/UTC-resolve" "Resolving PostgreSQL" bar
assert_eq "pg-window idle start is matched by a stop (no leaked idle PID)" "${IDLE_STARTS}" "${IDLE_STOPS}"
rm -f "${IDLE_CAP}"

echo ""
echo "============================================================================"
printf 'R4 HARNESS RESULT: %s passed, %s failed\n' "${PASSES}" "${FAILS}"
echo "============================================================================"
rm -f "${GA_SEQ}"
[[ "${FAILS}" -eq 0 ]]
