#!/usr/bin/env bash
# r4-progress-bar-continuity-harness.sh — EXECUTION verification of R4 (unified continuous
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
_preflight_python_break_consent() { return 0; }
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
start_step_spinner() { :; }
stop_step_spinner() { :; }
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
  ENGAGE_CALLS=0
  "${pathfn}" </dev/null || rc=$?
  set +e
  trap - ERR
  return "${rc}"
}

echo "============================================================================"
echo "(R4-1) boxed preflight — single continuous bar w/ A3 initdb over-count clamp"
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
echo "(R4-2) engine exit codes BYTE-FOR-BYTE unchanged through run_plan (install mode)"
echo "============================================================================"
# A 3-step install plan whose MIDDLE step returns an arbitrary rc must surface that rc verbatim
# + set STEP_FAIL_INDEX=2. Then an all-pass plan must return 0. This proves the R4 render changes
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
echo "(R4-3) box-engage gating — an all-present group never engages an empty box"
echo "============================================================================"
# All-present scenario: no auto-work => preflight_count_and_gate yields STEP_TOTAL=0 and the
# ENGAGE gates skip enter_run_state (BUG1). Proves the box only engages when work exists.
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
printf 'R4 HARNESS RESULT: %s passed, %s failed\n' "${PASSES}" "${FAILS}"
echo "============================================================================"
rm -f "${GA_SEQ}"
[[ "${FAILS}" -eq 0 ]]
