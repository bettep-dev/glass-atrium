#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2016,SC2312  # SC2154: bats-injected globals (BATS_TEST_DIRNAME/output/status); SC2016: literal patterns fed to grep -F (no expansion wanted); SC2312: probe pipe-masking is intentional
# poll-wallclock-ceiling.bats — falsifiable coverage for the SECONDS-delta wall-clock hardening of the
# sibling poll loops the connect-deadline (#3) pass left on the stale iteration-counter idiom.
#
# Defect class: a `local waited=0` / `waited=$((waited + 1))` counter against `sleep 1` assumes each
# iteration costs ~1s. When a per-iteration probe BLOCKS (an uncapped curl on a half-open socket, an
# lsof stall), the true elapsed time drifts far past the intended ceiling — the very unbounded-hang
# class the installer hardens against. The fix mirrors ga-deps.sh (ga_pg_wait_ready / ga_marketplace_add):
# anchor `started="${SECONDS}"` and loop `while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]`, so the
# bound is TRUE wall-clock regardless of per-probe cost.
#
# HIGHEST priority: restore_launchd_monitor's per-iteration curl had NO --max-time/--connect-timeout, so
# a stalled connection could block a single iteration indefinitely. The fix adds both flags AND the
# wall-clock ceiling.
#
# Machine-safe: no real curl/lsof/launchctl/postgres. Behavioral tests PATH-stub the probes and run the
# function in a backgrounded `bash -c` under the repo's background+poll+kill hang guard (run_bounded —
# mirrors pg-detect-connect-deadline.bats; NOT the macOS-absent `timeout`). Static assertions grep the
# converted lib text.
#
# Run via: bats test/poll-wallclock-ceiling.bats
# Requires: bats (brew install bats-core), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
MON_SH="${GA}/lib/ga-tui-monitor.sh"
DAEMONS_SH="${GA}/lib/ga-daemons.sh"
LAUNCHD_SH="${GA}/lib/ga-launchd.sh"
PREFLIGHT_SH="${GA}/lib/ga-tui-preflight.sh"

setup() {
  [[ -f "${MON_SH}" ]] || skip "lib not found: ${MON_SH}"
  [[ -f "${DAEMONS_SH}" ]] || skip "lib not found: ${DAEMONS_SH}"
  [[ -f "${LAUNCHD_SH}" ]] || skip "lib not found: ${LAUNCHD_SH}"
  [[ -f "${PREFLIGHT_SH}" ]] || skip "lib not found: ${PREFLIGHT_SH}"
  # the libs are not strict-mode when sourced alone, but suspend any inherited ERR trap defensively.
  trap - ERR
  SANDBOX="$(mktemp -d -t ga-poll-wallclock.XXXXXX)"
}

teardown() {
  # best-effort reap of any stub curl/lsof/sleep a fail-before revert-check might have orphaned
  # (the green suite never reaches the kill path — the fixed code self-completes bounded).
  [[ -n "${SANDBOX:-}" ]] && pkill -f "${SANDBOX}" 2>/dev/null || true
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# run_bounded — run `bash -c "$1"` in the BACKGROUND (fresh shell, no stale command hash), poll for
# self-completion under a $2-second integer ceiling. Sets BOUNDED=1 when the command self-completed
# inside the ceiling, 0 when it had to be killed (the unbounded-block proof). The repo background+poll+kill
# idiom — no macOS-absent `timeout`.
run_bounded() {
  local script="$1" ceiling="$2"
  bash -c "${script}" >/dev/null 2>&1 &
  local pid=$! waited=0
  while kill -0 "${pid}" 2>/dev/null && [[ "${waited}" -lt "${ceiling}" ]]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "${pid}" 2>/dev/null; then
    BOUNDED=0
    kill "${pid}" 2>/dev/null || true
  else
    BOUNDED=1
  fi
  wait "${pid}" 2>/dev/null || true
}

# mk_stub_launchctl — a no-op launchctl (restore_launchd_monitor calls `launchctl bootstrap`, masked).
mk_stub_launchctl() {
  printf '#!/bin/bash\nexit 0\n' >"$1/launchctl"
  chmod +x "$1/launchctl"
}

# === restore_launchd_monitor: the HIGHEST-priority curl poll ====================

@test "wallclock(behavioral): restore_launchd_monitor's curl --max-time bounds a stalled probe (fail-before/pass-after)" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  mk_stub_launchctl "${stub}"
  # a curl stub modelling a STALLED connection: abandon at --connect-timeout (fall back to --max-time),
  # then FAIL. When the code passes NEITHER flag (the pre-fix repro) it blocks effectively forever — so
  # this stub is exactly what turns the untimed curl into a bounded one. Revert the flags ⇒ killed here.
  cat >"${stub}/curl" <<'CURL'
#!/bin/bash
ct=""; mt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --connect-timeout) ct="$2"; shift 2 ;;
    --max-time) mt="$2"; shift 2 ;;
    *) shift ;;
  esac
done
sleep "${ct:-${mt:-99999}}"
exit 1
CURL
  chmod +x "${stub}/curl"
  # BOOTSTRAP_HEALTH_WINDOW_SECS=1 → after the first bounded curl abandons, the wall-clock ceiling is
  # already past, so the loop exits. run_bounded's 15s ceiling is generous headroom for the ~2s probe.
  run_bounded "PATH='${stub}:${PATH}'; source '${MON_SH}'; log(){ :; }; atrium_monitor_port(){ printf '16145\n'; }; MONITOR_WAS_STOPPED=yes; MONITOR_PLIST_PATH='${SANDBOX}/x.plist'; BOOTSTRAP_HEALTH_WINDOW_SECS=1; restore_launchd_monitor" 15
  [[ "${BOUNDED}" -eq 1 ]] # self-completed bounded (fail-before: an uncapped curl blocks → killed)
}

@test "wallclock(behavioral): restore_launchd_monitor terminates on the wall-clock ceiling when the monitor never answers" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  mk_stub_launchctl "${stub}"
  # curl fast-fails every probe (connection refused) → the loop spins on the SECONDS-delta ceiling.
  printf '#!/bin/bash\nexit 1\n' >"${stub}/curl"
  chmod +x "${stub}/curl"
  run_bounded "PATH='${stub}:${PATH}'; source '${MON_SH}'; log(){ :; }; atrium_monitor_port(){ printf '16145\n'; }; MONITOR_WAS_STOPPED=yes; MONITOR_PLIST_PATH='${SANDBOX}/x.plist'; BOOTSTRAP_HEALTH_WINDOW_SECS=2; restore_launchd_monitor" 10
  [[ "${BOUNDED}" -eq 1 ]] # exits at ~2s (fail-before: an unbounded loop never exits → killed)
}

# === clear_unmanaged_pg_orphan: the ga-daemons socket-free poll =================

@test "wallclock(behavioral): clear_unmanaged_pg_orphan terminates on the wall-clock ceiling when the socket never frees" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # lsof always reports an owner → the socket never frees, driving the poll to its ceiling. The pid is a
  # non-existent 999999, so the function's `kill -INT` is a harmless no-op (logs "could not signal").
  cat >"${stub}/lsof" <<'LSOF'
#!/bin/bash
printf '999999\n'
exit 0
LSOF
  chmod +x "${stub}/lsof"
  : >"${SANDBOX}/.s.PGSQL.5432" # the socket path must EXIST so the `-e` guard does not break early
  run_bounded "PATH='${stub}:${PATH}'; source '${DAEMONS_SH}'; log(){ :; }; is_sandbox_target(){ printf 'no\n'; }; DRY_RUN=false; PG_SOCKET='${SANDBOX}'; GA_PG_SOCKET_FREE_TIMEOUT_SECS=1; clear_unmanaged_pg_orphan" 8
  [[ "${BOUNDED}" -eq 1 ]] # exits at ~1s (fail-before: an unbounded socket-wait never exits → killed)
}

# === static coverage across every converted site ================================

@test "wallclock(static): every converted poll uses a SECONDS-delta ceiling, no iteration counter remains" {
  # ga-tui-monitor.sh — three loops (two lsof port-free + one curl health)
  run grep -cF 'while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]' "${MON_SH}"
  [[ "${output}" -eq 3 ]]
  run grep -cF 'waited=$((waited + 1))' "${MON_SH}"
  [[ "${output}" -eq 0 ]]
  run grep -cF 'while [[ "${waited}" -lt' "${MON_SH}"
  [[ "${output}" -eq 0 ]]
  # ga-daemons.sh — postmaster socket-free poll
  run grep -cF 'while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]' "${DAEMONS_SH}"
  [[ "${output}" -eq 1 ]]
  run grep -cF 'waited=$((waited + 1))' "${DAEMONS_SH}"
  [[ "${output}" -eq 0 ]]
  # ga-launchd.sh — launchd settle poll (own var names, keeps sleep 0.2 responsiveness)
  run grep -cF 'while [[ "$((SECONDS - settle_started))" -lt "${settle_ceiling}" ]]' "${LAUNCHD_SH}"
  [[ "${output}" -eq 1 ]]
  run grep -cF 'settle_i=$((settle_i + 1))' "${LAUNCHD_SH}"
  [[ "${output}" -eq 0 ]]
  # ga-tui-preflight.sh — Xcode-CLT heartbeat
  run grep -cF '$((SECONDS - last_dot))' "${PREFLIGHT_SH}"
  [[ "${output}" -eq 1 ]]
  run grep -cF 'waited=$((waited + 1))' "${PREFLIGHT_SH}"
  [[ "${output}" -eq 0 ]]
}

@test "wallclock(static): the restore curl carries --connect-timeout and --max-time (a stalled probe self-abandons)" {
  local curl_line
  curl_line="$(grep -F 'curl -sf -o /dev/null' "${MON_SH}" | head -1)"
  [[ -n "${curl_line}" ]]
  [[ "${curl_line}" == *'--connect-timeout 2'* ]]
  [[ "${curl_line}" == *'--max-time 5'* ]]
}

@test "wallclock(static): the Xcode-CLT wait stays user-paced UNBOUNDED (heartbeat SECONDS-delta, no hard ceiling)" {
  # the loop condition is the detect probe, NOT a SECONDS ceiling — a hard ceiling would abort a slow
  # but legitimate user-driven toolchain install (Ctrl-C is the intended abort).
  run grep -cF 'while [[ "$(ga_detect_xcode_clt)" != "present" ]]' "${PREFLIGHT_SH}"
  [[ "${output}" -eq 1 ]]
  # the heartbeat dot is gated on wall-clock elapsed, not a per-iteration count.
  run grep -cF 'if [[ "$((SECONDS - last_dot))" -ge 5 ]]' "${PREFLIGHT_SH}"
  [[ "${output}" -eq 1 ]]
}
