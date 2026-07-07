#!/usr/bin/env bash
# install-orphan-ownership-exec-harness.sh — HEADLESS EXECUTION harness for the Part B
# (ADR-2) foreign-vs-ours install-conflict refinement. Sources ./glass-atrium as a library,
# then drives the REAL conflict helpers (monitor_orphan_pid_on_port / monitor_pid_is_ours /
# stop_orphan_monitor_for_install / stop_launchd_monitor_for_install) against SHELL-FUNCTION
# stubs for ps / lsof / launchctl / kill. Proves:
#   (A) our-stray self-heal (AC-S2.5b) — a non-launchd LISTENER whose argv is the RELATIVE
#       `node dist/server/main.js` AND whose cwd is ${GA_ROOT}/monitor is SIGTERM'd and the
#       flow proceeds (rc 0). Fixture uses the REAL relative-argv + cwd shape; an ABSOLUTE
#       cmdline fixture would green-wash the defect.
#   (B) foreign fail (AC-S2.5c) — a non-launchd LISTENER that FAILS the ownership test
#       (argv lacks dist/server/main.js  OR  cwd != ${GA_ROOT}/monitor) FAILS the install
#       loudly (rc != 0, "FOREIGN" + pid) WITHOUT any kill.
#   (C) launchd-bootout-unchanged (AC-S2.5a) — a launchd-owned LISTENER yields NOTHING from
#       the orphan detector (the kill path never fires on it), while stop_launchd bootouts +
#       settles + proceeds (rc 0).
#   (D) never-frees SIGKILL escalation (AC-S2.5d) — an our-stray whose port never frees
#       escalates SIGTERM->SIGKILL and then loud-fails bounded (rc != 0).
#
# READ-ONLY toward the live system: ps/lsof/launchctl/kill are ALL intercepted by shell
# functions (kill is a bash BUILTIN, so a PATH stub would be bypassed — a function overrides
# it). No real process is signalled, no launchctl bootout is issued, the live monitor on the
# resolved port is NEVER touched. ATRIUM_MONITOR_PORT is exported so atrium_monitor_port
# resolves deterministically without reading any file.
#
# ShellCheck note: GA_ROOT / UID are assigned by the sourced launcher (SC2154 false-positive).
# shellcheck disable=SC2154
set -uo pipefail

HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GA_DIR_ROOT="$(cd -- "${HARNESS_DIR}/.." && pwd)"

# Deterministic port resolution (env-prefer, no file read).
export ATRIUM_MONITOR_PORT=16145

# shellcheck source=/dev/null
source "${GA_DIR_ROOT}/glass-atrium" >/dev/null 2>&1
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ga-orphan.XXXXXX")"
cleanup_all() { rm -rf "${WORK}"; }
trap cleanup_all EXIT

KILLLOG="${WORK}/kill.log"
FREED="${WORK}/freed.marker"

# === stub state (reset per scenario) ==================================================
STUB_LISTENER_PID="" # pid the port-listener lsof reports (empty => port free)
STUB_LAUNCHD_PID=""  # if set, `launchctl list` reports the label row with this pid
STUB_PS_ARGV=""      # what `ps -o command= -p <pid>` returns
STUB_CWD=""          # what `lsof -p <pid> -a -d cwd -Fn` reports as the cwd
STUB_NEVER_FREE=0    # 1 => kill never marks the port freed (settle-poll times out)

reset_stubs() {
  STUB_LISTENER_PID=""
  STUB_LAUNCHD_PID=""
  STUB_PS_ARGV=""
  STUB_CWD=""
  STUB_NEVER_FREE=0
  : >"${KILLLOG}"
  rm -f "${FREED}"
}

# === command stubs (shell functions — override builtins + PATH) =======================
# lsof: branch on the request kind via SINGLE-TOKEN markers — the sourced launcher sets
# IFS=$'\n\t', so "$*" joins args with newlines and a multi-token pattern like "-d cwd"
# (embedded space) would NEVER match. `-Fn` is unique to the cwd query (lsof -p <pid> -a
# -d cwd -Fn) => echo an `n`-prefixed name line; `tcp:` is unique to the LISTENER query
# (empty once the freed marker exists).
lsof() {
  local args="$*"
  case "${args}" in
    *-Fn*)
      printf 'n%s\n' "${STUB_CWD}"
      return 0
      ;;
    *tcp:*)
      [[ -f "${FREED}" ]] && return 0 # port freed => no listener
      [[ -n "${STUB_LISTENER_PID}" ]] && printf '%s\n' "${STUB_LISTENER_PID}"
      return 0
      ;;
  esac
  return 0
}

# ps -o command= -p <pid> => the (relative) argv fixture.
ps() {
  printf '%s\n' "${STUB_PS_ARGV}"
  return 0
}

# launchctl: `list` emits the label row (numeric pid only when STUB_LAUNCHD_PID set) plus a
# `-`-pid sibling row (exact-label match guard); `bootout` logs + frees the port.
launchctl() {
  case "${1:-}" in
    list)
      [[ -n "${STUB_LAUNCHD_PID}" ]] \
        && printf '%s\t0\tcom.glass-atrium.monitor\n' "${STUB_LAUNCHD_PID}"
      printf -- '-\t0\tcom.glass-atrium.monitor-log-rotate\n'
      return 0
      ;;
    bootout)
      printf 'bootout %s\n' "${2:-}" >>"${KILLLOG}"
      touch "${FREED}" # a real bootout frees the port
      return 0
      ;;
    *) return 0 ;;
  esac
}

# kill: record every invocation (SPACE-joined so the log is stable under IFS=$'\n\t', where
# "$*" would newline-join the args); a real signal (not -0) frees the port UNLESS NEVER_FREE.
kill() {
  {
    printf 'kill'
    printf ' %s' "$@"
    printf '\n'
  } >>"${KILLLOG}"
  if [[ "${STUB_NEVER_FREE}" != "1" && "${1:-}" != "-0" ]]; then
    touch "${FREED}"
  fi
  return 0
}

OUR_CWD="${GA_ROOT}/monitor"

echo "============================================================================"
echo "(A) our-stray self-heal — relative argv + cwd == \${GA_ROOT}/monitor => stop, proceed"
echo "============================================================================"
reset_stubs
STUB_LISTENER_PID="4242"
STUB_PS_ARGV="node dist/server/main.js" # RELATIVE argv (the real launch shape)
STUB_CWD="${OUR_CWD}"
A_OUT="$({ stop_orphan_monitor_for_install; } 2>&1)"
A_RC=$?
if [[ "${A_RC}" -eq 0 ]]; then
  pass "our-stray: stop_orphan returned 0 (proceed)"
else
  fail "our-stray: expected rc 0, got ${A_RC} (out: ${A_OUT})"
fi
if grep -Fq 'kill 4242' "${KILLLOG}"; then
  pass "our-stray: SIGTERM issued to the verified pid"
else
  fail "our-stray: expected a SIGTERM to 4242 (killlog: $(tr '\n' '|' <"${KILLLOG}"))"
fi
if grep -Fq -- '-KILL' "${KILLLOG}"; then
  fail "our-stray: SIGKILL escalated even though the port freed on SIGTERM"
else
  pass "our-stray: no SIGKILL escalation (port freed on SIGTERM)"
fi
case "${A_OUT}" in
  *FOREIGN*) fail "our-stray: mis-classified as FOREIGN" ;;
  *) pass "our-stray: not mis-classified as FOREIGN" ;;
esac

echo ""
echo "============================================================================"
echo "(B1) foreign fail — argv lacks dist/server/main.js => FAIL loudly, NO kill"
echo "============================================================================"
reset_stubs
STUB_LISTENER_PID="9101"
STUB_PS_ARGV="nginx: worker process"
STUB_CWD="${OUR_CWD}" # cwd would match, but argv does not — still FOREIGN
B1_OUT="$({ stop_orphan_monitor_for_install; } 2>&1)"
B1_RC=$?
if [[ "${B1_RC}" -ne 0 ]]; then
  pass "foreign(argv): install FAILED (rc ${B1_RC})"
else
  fail "foreign(argv): expected non-zero rc, got 0"
fi
case "${B1_OUT}" in
  *FOREIGN*9101*) pass "foreign(argv): loud error names FOREIGN + pid 9101" ;;
  *) fail "foreign(argv): missing FOREIGN/pid message (out: ${B1_OUT})" ;;
esac
if [[ -s "${KILLLOG}" ]]; then
  fail "foreign(argv): a kill was issued (killlog: $(tr '\n' '|' <"${KILLLOG}"))"
else
  pass "foreign(argv): NO kill issued"
fi

echo ""
echo "============================================================================"
echo "(B2) foreign fail — cwd != \${GA_ROOT}/monitor (different tree) => FAIL, NO kill"
echo "============================================================================"
reset_stubs
STUB_LISTENER_PID="9202"
STUB_PS_ARGV="node dist/server/main.js" # argv matches, but wrong tree
STUB_CWD="/opt/someone-else/monitor"
B2_OUT="$({ stop_orphan_monitor_for_install; } 2>&1)"
B2_RC=$?
if [[ "${B2_RC}" -ne 0 ]]; then
  pass "foreign(cwd): install FAILED (rc ${B2_RC})"
else
  fail "foreign(cwd): expected non-zero rc, got 0"
fi
case "${B2_OUT}" in
  *FOREIGN*9202*) pass "foreign(cwd): loud error names FOREIGN + pid 9202" ;;
  *) fail "foreign(cwd): missing FOREIGN/pid message (out: ${B2_OUT})" ;;
esac
if [[ -s "${KILLLOG}" ]]; then
  fail "foreign(cwd): a kill was issued (killlog: $(tr '\n' '|' <"${KILLLOG}"))"
else
  pass "foreign(cwd): NO kill issued"
fi

echo ""
echo "============================================================================"
echo "(C) launchd-owned unchanged — orphan detector yields nothing; stop_launchd bootouts"
echo "============================================================================"
reset_stubs
STUB_LAUNCHD_PID="5555"
STUB_LISTENER_PID="5555" # the launchd pid owns the LISTENER
if monitor_is_launchd_owned; then
  pass "launchd: monitor_is_launchd_owned TRUE for a launchd-owned listener"
else
  fail "launchd: monitor_is_launchd_owned should be TRUE"
fi
ORPH="$(monitor_orphan_pid_on_port)"
if [[ -z "${ORPH}" ]]; then
  pass "launchd: orphan detector yields NOTHING (kill path never fires on launchd)"
else
  fail "launchd: orphan detector wrongly returned [${ORPH}]"
fi
# the orphan stop is a strict no-op on a launchd-owned port …
: >"${KILLLOG}"
{ stop_orphan_monitor_for_install; } >/dev/null 2>&1
STOP_ORPH_RC=$?
if [[ "${STOP_ORPH_RC}" -eq 0 ]] && [[ ! -s "${KILLLOG}" ]]; then
  pass "launchd: stop_orphan is a no-op (rc 0, no kill)"
else
  fail "launchd: stop_orphan not a clean no-op (rc ${STOP_ORPH_RC}, killlog: $(tr '\n' '|' <"${KILLLOG}"))"
fi
# … and stop_launchd bootouts + settles + proceeds.
: >"${KILLLOG}"
rm -f "${FREED}"
STOP_LD_OUT="$({ stop_launchd_monitor_for_install; } 2>&1)"
STOP_LD_RC=$?
if [[ "${STOP_LD_RC}" -eq 0 ]]; then
  pass "launchd: stop_launchd returned 0 (bootout + settle + proceed)"
else
  fail "launchd: stop_launchd expected rc 0, got ${STOP_LD_RC} (out: ${STOP_LD_OUT})"
fi
if grep -Fq "bootout gui/${UID}/com.glass-atrium.monitor" "${KILLLOG}"; then
  pass "launchd: bootout issued for com.glass-atrium.monitor"
else
  fail "launchd: expected a bootout (killlog: $(tr '\n' '|' <"${KILLLOG}"))"
fi

echo ""
echo "============================================================================"
echo "(D) never-frees — our-stray whose port never frees => SIGTERM->SIGKILL then loud-fail"
echo "============================================================================"
reset_stubs
STUB_LISTENER_PID="4343"
STUB_PS_ARGV="node dist/server/main.js"
STUB_CWD="${OUR_CWD}"
STUB_NEVER_FREE=1 # the port stays bound through both signals
D_OUT="$({ stop_orphan_monitor_for_install; } 2>&1)"
D_RC=$?
if [[ "${D_RC}" -ne 0 ]]; then
  pass "never-frees: bounded loud-fail (rc ${D_RC})"
else
  fail "never-frees: expected non-zero rc, got 0"
fi
if grep -Fq 'kill 4343' "${KILLLOG}" && grep -Fq 'kill -KILL 4343' "${KILLLOG}"; then
  pass "never-frees: SIGTERM then SIGKILL both issued to the verified pid"
else
  fail "never-frees: expected TERM + KILL escalation (killlog: $(tr '\n' '|' <"${KILLLOG}"))"
fi
case "${D_OUT}" in
  *"still holds"*) pass "never-frees: loud abort message present" ;;
  *) fail "never-frees: missing the 'still holds' abort message (out: ${D_OUT})" ;;
esac

echo ""
echo "============================================================================"
printf 'ORPHAN-OWNERSHIP HARNESS RESULT: %s passed, %s failed\n' "${PASSES}" "${FAILS}"
echo "============================================================================"
[[ "${FAILS}" -eq 0 ]]
