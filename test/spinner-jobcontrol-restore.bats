#!/usr/bin/env bats
# spinner-jobcontrol-restore.bats — falsifiable coverage for the step-spinner job-control
# save/restore fix (the "type install" consent hang).
#
# ROOT CAUSE: start_step_spinner / stop_step_spinner wrapped their background-spinner
# launch/kill in `set +m` … `set -m` to suppress the job-control "[n] PID" / "Terminated"
# notices. The RESTORE side ran an UNCONDITIONAL `set -m` — but this launcher is a
# NON-INTERACTIVE script where job control is OFF by default, so `set -m` wrongly LEFT it
# enabled. With job control on, a later terminal-mode write `stty "${TTY_SAVED}" <"${TTY}"`
# (confirm_typed / preflight_bracket cooked-mode toggle) runs in its own background process
# group, takes SIGTTOU, and STOPS (state T); the launcher then blocks forever on the stopped
# stty at the typed install-consent prompt.
#
# FIX: snapshot the prior monitor state (_job_control_state) before `set +m`, then restore it
# (_restore_job_control) — a non-interactive run stays job-control-OFF (no SIGTTOU), while a
# genuinely-on interactive shell is preserved.
#
# Run via: bats test/spinner-jobcontrol-restore.bats
# Requires: bats, bash 3.2+, and (for the pty integration test) the `script` pty allocator.
#
# Hermetic: the unit tests eval a SINGLE launcher function into the test shell (no TUI/TTY).
# The pty test sources the launcher read-only under a `script`-allocated pty and drives the
# REAL spinner functions — it performs NO system mutation (no brew/pip/launchctl), only a
# terminal-mode stty against the pty it owns.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the launcher is strict-mode; suspend any inherited ERR trap defensively before eval.
  trap - ERR
}

# extract_launcher_fn — eval a single named launcher function into the test shell so it can be
# driven in isolation without booting the TUI (mirrors deps-preflight-noninteractive.bats).
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

# === unit — _job_control_state reads the monitor ($-) flag ============================

@test "_job_control_state prints 'off' when monitor mode is disabled" {
  extract_launcher_fn _job_control_state
  set +m
  [[ "$(_job_control_state)" == "off" ]]
}

@test "_job_control_state prints 'on' when monitor mode is enabled" {
  extract_launcher_fn _job_control_state
  set -m
  [[ "$(_job_control_state)" == "on" ]]
  set +m # do not leak monitor mode past the assertion
}

# === unit — _restore_job_control applies the snapshot to the caller's shell ===========

@test "_restore_job_control off disables monitor mode in the caller's shell" {
  extract_launcher_fn _restore_job_control
  set -m
  _restore_job_control off
  [[ "$-" != *m* ]]
}

@test "_restore_job_control on enables monitor mode in the caller's shell" {
  extract_launcher_fn _restore_job_control
  set +m
  _restore_job_control on
  [[ "$-" == *m* ]]
  set +m
}

# === unit — round trip preserves the PRIOR state across a set +m window ===============

@test "round trip: an already-OFF shell stays OFF (the non-interactive fix path)" {
  extract_launcher_fn _job_control_state
  extract_launcher_fn _restore_job_control
  set +m
  local prev
  prev="$(_job_control_state)"
  set +m # the spinner's suspend window
  _restore_job_control "${prev}"
  [[ "$-" != *m* ]] # must NOT be left enabled → no SIGTTOU on a later stty
}

@test "round trip: a genuinely-ON shell is restored back ON (interactive preservation)" {
  extract_launcher_fn _job_control_state
  extract_launcher_fn _restore_job_control
  set -m
  local prev
  prev="$(_job_control_state)"
  set +m # the spinner's suspend window
  _restore_job_control "${prev}"
  [[ "$-" == *m* ]] # a real interactive monitor state is preserved
  set +m
}

# === static — the spinner functions restore state, never an unconditional set -m ======

@test "static: start_step_spinner snapshots + restores, no bare 'set -m'" {
  local body
  body="$(awk '/^start_step_spinner\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'jobctl_prev="$(_job_control_state)"'* ]]
  [[ "${body}" == *'_restore_job_control "${jobctl_prev}"'* ]]
  # the unconditional restore is GONE (no `set -m` on its own line).
  run grep -cE '^[[:space:]]*set -m[[:space:]]*$' <<<"${body}"
  [[ "${output}" -eq 0 ]]
}

@test "static: stop_step_spinner snapshots + restores, no bare 'set -m'" {
  local body
  body="$(awk '/^stop_step_spinner\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'jobctl_prev="$(_job_control_state)"'* ]]
  [[ "${body}" == *'_restore_job_control "${jobctl_prev}"'* ]]
  run grep -cE '^[[:space:]]*set -m[[:space:]]*$' <<<"${body}"
  [[ "${output}" -eq 0 ]]
}

@test "static: the launcher carries NO unconditional 'set -m' restore anywhere" {
  # the whole-file guard for item #2 — the two spinner sites were the only ones.
  run grep -cE '^[[:space:]]*set -m[[:space:]]*$' "${LAUNCHER}"
  [[ "${output}" -eq 0 ]]
}

# === pty integration — the REAL spinner cycle under a pty (falsifiable) ================

# _write_pty_harness — emit the harness that sources the launcher read-only, drives the REAL
# start/stop spinner, then reports (A) whether job control was left on and (B) whether a
# subsequent background terminal-mode stty write is SIGTTOU-stopped. GA_FORCE_JC=1 emulates the
# OLD unconditional `set -m` restore so the SAME harness demonstrates the bug the fix removes.
_write_pty_harness() {
  cat >"$1" <<'HARNESS'
#!/usr/bin/env bash
set +e
# shellcheck disable=SC1090
source "${GA_LAUNCHER}" >/dev/null 2>&1 || true
trap - ERR
set +eEu +o pipefail
set +m # non-interactive baseline: job control OFF
TTY="/dev/tty"
SPIN_FRAMES=""
tp() { :; }             # stub the pure renderers — the job-control path stays 100% real
c() { printf '%s' "${2:-}"; }
paint_workbox_body_inner() { :; }
start_step_spinner "probe" >/dev/null 2>&1
sleep 0.15
stop_step_spinner >/dev/null 2>&1
[[ "${GA_FORCE_JC:-0}" == "1" ]] && set -m # emulate the OLD unconditional restore
case $- in
  *m*) printf 'A_ON:%s\n' "$-" ;;
  *) printf 'A_OFF\n' ;;
esac
# a background terminal-mode stty WRITE: with job control ON it lands in its own process
# group and takes SIGTTOU (state T); with it OFF it shares the foreground pg and completes.
saved="$(stty -g </dev/tty 2>/dev/null)"
( stty "${saved}" </dev/tty >/dev/null 2>&1 ) &
bg=$!
res="B_TIMEOUT"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  st="$(ps -o stat= -p "${bg}" 2>/dev/null | tr -d ' ')"
  case "${st}" in
    T*)
      res="B_STOPPED"
      kill -CONT "${bg}" 2>/dev/null
      kill "${bg}" 2>/dev/null
      break
      ;;
    "")
      res="B_COMPLETED"
      break
      ;;
  esac
  sleep 0.05
done
wait "${bg}" 2>/dev/null
printf '%s\n' "${res}"
HARNESS
}

@test "pty(real): start+stop leaves job control OFF and a later bg stty is NOT SIGTTOU-stopped" {
  command -v script >/dev/null 2>&1 || skip "script (pty allocator) unavailable"
  local harness="${BATS_TEST_TMPDIR}/pty-harness.sh"
  _write_pty_harness "${harness}"
  export GA_LAUNCHER="${LAUNCHER}"
  unset GA_FORCE_JC
  run script -q /dev/null bash "${harness}"
  [[ "${output}" == *A_OFF* ]]       # job control not left enabled
  [[ "${output}" == *B_COMPLETED* ]] # the later terminal-mode stty completes (no SIGTTOU)
  [[ "${output}" != *A_ON* ]]
  [[ "${output}" != *B_STOPPED* ]]
}

@test "pty(control): forcing the OLD unconditional set -m DOES SIGTTOU-stop the later stty" {
  # falsification control — proves the harness detects the exact bug the fix removes.
  command -v script >/dev/null 2>&1 || skip "script (pty allocator) unavailable"
  local harness="${BATS_TEST_TMPDIR}/pty-harness.sh"
  _write_pty_harness "${harness}"
  export GA_LAUNCHER="${LAUNCHER}"
  export GA_FORCE_JC=1
  run script -q /dev/null bash "${harness}"
  [[ "${output}" == *A_ON* ]]      # the OLD restore leaves job control enabled
  [[ "${output}" == *B_STOPPED* ]] # the later terminal-mode stty is SIGTTOU-stopped (the hang)
  unset GA_FORCE_JC
}
