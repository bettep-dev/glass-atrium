#!/usr/bin/env bats
# r4-continuous-index.bats — hermetic unit coverage for the R4 4a (continuous index) + 4e (rolling
# label) render helpers in glass-atrium. Complements the end-to-end r4-progress-bar-continuity-harness.sh
# (which drives the whole preflight->install run_plan handoff) with isolated, falsifiable assertions on
# the two PURE helpers a time-based forked spinner otherwise makes hard to test:
#
#   * STEP_INDEX_BASE (4a) — the opt-in continuous-sequence render offset carried across the
#     install-panel preflight->install handoff. build_run_bar renders base+i / base+n; an empty base is
#     byte-for-byte the raw i/N (every shared uninstall/db/token/purge caller). _clear_step_state sweeps it.
#   * _spinner_rolling_label (4e) — the per-tick animated label: the running step's latest captured
#     output line (STEP_LOG_CUR tail) when emitting, else the base label + a tick-cycled working phrase.
#
# Hermetic: each test EVALs a SINGLE launcher function into the test shell (extract_launcher_fn) — the
# TUI never boots, no TTY, NO system mutation. RENDER-ONLY: these helpers never touch exit codes.
#
# Run via: bats test/r4-continuous-index.bats
# Requires: bats (brew install bats-core), awk, tail, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the launcher is strict-mode; suspend any inherited ERR trap defensively before eval.
  trap - ERR
}

# extract_launcher_fn — eval a single named launcher function into the test shell so it can be driven
# in isolation without booting the TUI (mirrors spinner-jobcontrol-restore.bats / deps-preflight).
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}")"
}

# === 4a — build_run_bar STEP_INDEX_BASE offset =======================================

# stub the two collaborators so the recorded output IS the DISPLAY index/total build_run_bar computes.
_stub_bar_collaborators() {
  build_progress_bar() { printf 'BAR[%s/%s]' "$1" "$2"; } # record disp i / disp n
  progress_bar_width() { printf '8'; }
  C_ACCENT="94"
  STEP_BAR_ACCENT_CUR=""
}

@test "build_run_bar: empty STEP_INDEX_BASE renders the RAW i/N (byte-for-byte, shared callers)" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  STEP_INDEX_BASE=""
  STEP_INDEX=2
  STEP_TOTAL=5
  run build_run_bar
  [ "${status}" -eq 0 ]
  [ "${output}" = "BAR[2/5]" ]
}

@test "build_run_bar: STEP_INDEX_BASE offsets index AND total (continuous grand sequence)" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  STEP_INDEX_BASE=7
  STEP_INDEX=1
  STEP_TOTAL=3
  run build_run_bar
  [ "${status}" -eq 0 ]
  [ "${output}" = "BAR[8/10]" ] # base+1 .. base+n → 8/10 (the R4-4 harness's exact handoff case)
}

@test "build_run_bar: final offset step lands at base+n / base+n (no stuck N-1/N)" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  STEP_INDEX_BASE=7
  STEP_INDEX=3
  STEP_TOTAL=3
  run build_run_bar
  [ "${output}" = "BAR[10/10]" ]
}

@test "build_run_bar: unset STEP_INDEX/STEP_TOTAL returns empty (guard — no bar)" {
  extract_launcher_fn build_run_bar
  _stub_bar_collaborators
  STEP_INDEX_BASE=7
  STEP_INDEX=""
  STEP_TOTAL=""
  run build_run_bar
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

# === 4a — _clear_step_state sweeps the base (reset lifecycle) =========================

@test "_clear_step_state sweeps STEP_INDEX_BASE (no stale base leaks to a later shared caller)" {
  extract_launcher_fn _clear_step_state
  STEP_INDEX=3
  STEP_TOTAL=3
  STEP_INDEX_BASE=7
  STEP_LABEL_ACTIVE_CUR="x"
  STEP_BAR_CUR="y"
  STEP_BAR_ACCENT_CUR="z"
  _clear_step_state
  [ -z "${STEP_INDEX_BASE}" ]
  [ -z "${STEP_INDEX}" ]
  [ -z "${STEP_TOTAL}" ]
  [ -z "${STEP_BAR_CUR}" ]
}

# === LINE 2 detail resolver — _spinner_rolling_label (tail) + _spinner_dots (fallback) ==========
# The async-feel 2-line box moved the step LABEL to LINE 1 (the stable headline); _spinner_rolling_label
# now resolves ONLY the LINE 2 DETAIL — the real-time output tail when the step emits, else the SLOW
# dots animation (_spinner_dots), which REPLACES the buggy R4-4e per-tick "(working)" text roll.

@test "_spinner_rolling_label: output-producing step shows the LATEST captured line (real-time)" {
  extract_launcher_fn _spinner_rolling_label
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  printf 'compiling A\ncompiling B\n' >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0
  [ "${output}" = "compiling B" ]
}

@test "_spinner_rolling_label: LINE2 detail FOLLOWS a newly appended output line (calm refresh)" {
  extract_launcher_fn _spinner_rolling_label
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  printf 'step one\n' >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0
  [ "${output}" = "step one" ]
  printf 'linking\n' >>"${f}"
  run _spinner_rolling_label 6
  [ "${output}" = "linking" ]
}

@test "_spinner_rolling_label: no-output step falls back to the SLOW dots (not the old (working) roll)" {
  extract_launcher_fn _spinner_dots # collaborator (dots fallback)
  extract_launcher_fn _spinner_rolling_label
  SPIN_SLOW_DIV=6
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  : >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0
  [ "${output}" = "." ]
  run _spinner_rolling_label "${SPIN_SLOW_DIV}"
  [ "${output}" = ".." ]
  run _spinner_rolling_label $((SPIN_SLOW_DIV * 2))
  [ "${output}" = "..." ]
  run _spinner_rolling_label $((SPIN_SLOW_DIV * 3))
  [ "${output}" = "." ] # 3-phase cycle wraps back to one dot
}

@test "_spinner_rolling_label: unset STEP_LOG_CUR is set-u safe and falls back to the dots" {
  extract_launcher_fn _spinner_dots
  extract_launcher_fn _spinner_rolling_label
  SPIN_SLOW_DIV=6
  STEP_LOG_CUR=""
  run _spinner_rolling_label 0
  [ "${status}" -eq 0 ]
  [ "${output}" = "." ]
}

@test "_spinner_rolling_label: an over-long output line is trimmed to a single row (no wrap)" {
  extract_launcher_fn _spinner_rolling_label
  local f long
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  long="$(printf 'X%.0s' $(seq 1 90))"
  printf '%s\n' "${long}" >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0
  [ "${#output}" -le 58 ]
  [[ "${output}" == *... ]]
}

# === _spinner_dots — SLOW-cadence "slowly in progress" dots (decoupled from the 100ms frame) =====

@test "_spinner_dots: dots are STABLE across every tick within a slow window (not a per-tick roll)" {
  extract_launcher_fn _spinner_dots
  SPIN_SLOW_DIV=6
  local k
  for k in 0 1 2 3 4 5; do
    run _spinner_dots "${k}"
    [ "${output}" = "." ] # every 100ms tick in the window yields the SAME dots
  done
}

@test "_spinner_dots: dots ADVANCE by one phase at each slow-window boundary, cycling 1->2->3->1" {
  extract_launcher_fn _spinner_dots
  SPIN_SLOW_DIV=6
  run _spinner_dots 0
  [ "${output}" = "." ]
  run _spinner_dots 6
  [ "${output}" = ".." ]
  run _spinner_dots 12
  [ "${output}" = "..." ]
  run _spinner_dots 18
  [ "${output}" = "." ]
}

@test "_spinner_dots: default divisor is set-u safe when SPIN_SLOW_DIV is unset" {
  extract_launcher_fn _spinner_dots
  unset SPIN_SLOW_DIV || true
  run _spinner_dots 0
  [ "${status}" -eq 0 ]
  [ "${output}" = "." ]
}

@test "_spinner_rolling_label: CR/TAB in the captured line are sanitized to a single row" {
  extract_launcher_fn _spinner_rolling_label
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  printf 'busy\ttask\r\n' >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0
  [ "${output}" = "busy task" ]
}

# === 2-row box geometry + rail-safe LINE 2 painter ==============================================
# The async-feel box grew to 4 rows (top rail + LINE1 + LINE2 + bottom rail). Prove the LINE 2 anchor
# derives one row below LINE 1, and the row-parameterized inner painter targets the correct row so
# both box rails survive a per-tick LINE 2 repaint.

@test "compute_menu_geometry: WORKBOX_BODY_ROW2 is exactly one row below WORKBOX_BODY_ROW (2-row body)" {
  extract_launcher_fn compute_menu_geometry
  # stub the TTY-size + cursor-addressing probes so FULLSCREEN engages deterministically.
  term_size() { printf '120 50'; }
  tput() { return 0; }
  PLATE_MARGIN=2
  MAX_READABLE=64
  MIN_COLS=50
  MIN_ROWS=22
  MENU_COUNT=6
  FULLSCREEN=false
  compute_menu_geometry
  [ "${FULLSCREEN}" = "true" ]
  [ "${WORKBOX_BODY_ROW}" -eq "$((WORKBOX_FIRST_ROW + 1))" ]
  [ "${WORKBOX_BODY_ROW2}" -eq "$((WORKBOX_BODY_ROW + 1))" ]
  # the 4-row box bottom rail (WORKBOX_FIRST_ROW+3) stays strictly above the pinned keyhint (rail-safe)
  [ "$((WORKBOX_FIRST_ROW + 3))" -lt "${MENU_KEYHINT_ROW}" ]
}

@test "paint helpers: LINE 1 targets WORKBOX_BODY_ROW, LINE 2 targets WORKBOX_BODY_ROW2 (row-parameterized)" {
  # _paint_workbox_inner_at is the multi-line SoT (extractable); the two public wrappers are trivial
  # one-liners (the awk extractor over-captures a one-line fn), so mirror them inline — identical to
  # the source — to prove each forwards the correct box-body row.
  extract_launcher_fn _paint_workbox_inner_at
  paint_workbox_body_inner() { _paint_workbox_inner_at "${WORKBOX_BODY_ROW}" "$1"; }
  paint_workbox_body_row2_inner() { _paint_workbox_inner_at "${WORKBOX_BODY_ROW2}" "$1"; }
  # stubs: capture the row cup_to targets; width helpers return fixed values; swallow the TTY write.
  CUP_ROW=""
  cup_to() { CUP_ROW="$1"; }
  plate_inner() { printf '40'; }
  visible_len() { printf '%s' "${#1}"; }
  plate_truncate() { printf '%s' "$1"; }
  MENU_LEFT=4
  WORKBOX_BODY_ROW=31
  WORKBOX_BODY_ROW2=32
  TTY="/dev/null"
  paint_workbox_body_inner "hi"
  [ "${CUP_ROW}" -eq 31 ]
  paint_workbox_body_row2_inner "detail"
  [ "${CUP_ROW}" -eq 32 ]
}
