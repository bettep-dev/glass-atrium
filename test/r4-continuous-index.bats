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

# === 4e — _spinner_rolling_label ======================================================

@test "_spinner_rolling_label: non-empty capture shows the LATEST output line (real-time)" {
  extract_launcher_fn _spinner_rolling_label
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  printf 'compiling A\ncompiling B\n' >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0 'BASE'
  [ "${output}" = "compiling B" ]
}

@test "_spinner_rolling_label: label ROLLS to a newly appended line on the next tick" {
  extract_launcher_fn _spinner_rolling_label
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  printf 'step one\n' >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0 'BASE'
  [ "${output}" = "step one" ]
  printf 'linking\n' >>"${f}"
  run _spinner_rolling_label 1 'BASE'
  [ "${output}" = "linking" ]
}

@test "_spinner_rolling_label: empty capture cycles the base label + working phrase by tick" {
  extract_launcher_fn _spinner_rolling_label
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  : >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0 'BASE'
  [ "${output}" = "BASE" ]
  run _spinner_rolling_label 1 'BASE'
  [ "${output}" = "BASE (working)" ]
  run _spinner_rolling_label 2 'BASE'
  [ "${output}" = "BASE (still working)" ]
  run _spinner_rolling_label 3 'BASE'
  [ "${output}" = "BASE" ] # mod-3 cycle wraps
}

@test "_spinner_rolling_label: unset STEP_LOG_CUR is set-u safe and falls back to the base label" {
  extract_launcher_fn _spinner_rolling_label
  STEP_LOG_CUR=""
  run _spinner_rolling_label 0 'BASE'
  [ "${status}" -eq 0 ]
  [ "${output}" = "BASE" ]
}

@test "_spinner_rolling_label: an over-long output line is trimmed to a single row (no wrap)" {
  extract_launcher_fn _spinner_rolling_label
  local f long
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  long="$(printf 'X%.0s' $(seq 1 90))"
  printf '%s\n' "${long}" >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0 'BASE'
  [ "${#output}" -le 58 ]
  [[ "${output}" == *... ]]
}

@test "_spinner_rolling_label: CR/TAB in the captured line are sanitized to a single row" {
  extract_launcher_fn _spinner_rolling_label
  local f
  f="$(mktemp "${BATS_TEST_TMPDIR:-/tmp}/r4log.XXXXXX")"
  printf 'busy\ttask\r\n' >"${f}"
  STEP_LOG_CUR="${f}"
  run _spinner_rolling_label 0 'BASE'
  [ "${output}" = "busy task" ]
}
