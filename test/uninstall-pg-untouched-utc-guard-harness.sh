#!/usr/bin/env bash
# uninstall-pg-untouched-utc-guard-harness.sh — HEADLESS STUB EXECUTION harness proving the
# two pg-safety invariants of the deps-preflight-noninteractive branch:
#
#   (A) UNINSTALL never destroys a HEALTHY postgres. stop_detached_daemons (the STEP1b of
#       run_uninstall) is EXECUTED with every destructive tool shadowed by a RECORDER; the
#       recorder MUST show the daemon-tmux + fakechat reaps FIRING while showing ZERO
#       pg-destructive actions (no brew-services-stop, no SIGINT, no socket rm, no lsof/psql).
#       run_uninstall's OWN body is additionally verified (static) to wire stop_detached_daemons
#       and to contain NO pg-teardown call — the heavy destructive uninstall steps (launchctl /
#       node_modules rm / symlink sweep) are NOT executed (they would mutate the real tree).
#
#   (B) INSTALL preflight_pg_utc_guard discriminates correctly across four pg states:
#       B1 healthy 'ok'                    → no-op, guard never enters its body, ZERO actions.
#       B2 'broken' + brew-managed keg     → brew RESTART clears it, re-verify != broken → 0.
#       B3 'broken' + NO brew keg          → scoped orphan clear FIRES (SIGINT; layer-3 socket rm is
#                                            guard-conditional on a stale socket remaining) → 0.
#       B3b 'broken' + keg, restart NO-clear→ restart fires, does NOT clear, THEN scoped clear FIRES
#                                            (SIGINT; guard-conditional socket rm) → 0 (unresolvable-by-restart).
#       B4a DRY_RUN 'broken' unmanaged     → clear is a no-op, stays broken → LOUD-FAIL return 1,
#                                            NO SIGINT, NO socket rm (never a false 'cleared').
#       B4b sandbox 'broken' unmanaged     → same loud-fail, no destructive action.
#
# READ-ONLY toward the live SYSTEM: the real postgres@18 is HEALTHY and its peer-auth socket is
# /tmp/.s.PGSQL.5432. PG_SOCKET is REDIRECTED to a per-test temp dir via the GA_PG_SOCKET seam
# (exported BEFORE the launcher is sourced, since ga_init_env makes PG_SOCKET readonly at source
# time), so the guard/clear socket path resolves under the temp dir and can NEVER reach the live
# /tmp socket. On top of that, `rm`, `kill`, `lsof`, `psql`, `pg_isready`, `brew`, `tmux`, `pkill`
# are shadowed as PURE in-process RECORDERS that NEVER exec the real tool — the guard/clear logic
# under test runs for real, but no signal is sent, no socket is removed, no brew service is touched.
# The only real read is the `[[ -S ]]` socket-type test (read-only) — left real so the socket-rm
# branch is exercised faithfully against the REDIRECTED temp path's socket existence. Consequence:
# the layer-3 socket rm is guard-CONDITIONAL at runtime (it fires only when a socket file actually
# exists at the redirected path). B3/B3b therefore assert it via assert_socket_rm_matches_guard
# (mirroring the code's own `[[ -S ]]` guard) plus a deterministic [B-static] body-presence check —
# NOT an unconditional runtime fire, which was the stale, host-fragile expectation (it failed on any
# host with no socket at the checked path, where the code correctly skips the removal).
#
# The functions UNDER TEST run REAL: stop_detached_daemons, kill_daemon_tmux_sessions,
# clear_unmanaged_pg_orphan, preflight_pg_utc_guard. Only the leaf tools + the detect probes +
# the TTY/render helpers are stubbed.
#
# Exit 0 iff every (scenario × invariant) assertion passes.
#
# ShellCheck note: this harness sources a multi-thousand-line library and OVERRIDES its symbols,
# so several checks are inherent false-positives of static analysis against dynamically-sourced
# code — SC2034 (vars read only by the sourced launcher fns), SC2154 (launcher globals like
# PG_SOCKET assigned at source time), SC2312 (return-masking in display-only command subs),
# SC2016 (the [B-static] check matches a single-quoted LITERAL of the function's source text).
# shellcheck disable=SC2034,SC2154,SC2312,SC2016
set -uo pipefail

HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GA_DIR_ROOT="$(cd -- "${HARNESS_DIR}/.." && pwd)"
LAUNCHER="${GA_DIR_ROOT}/glass-atrium"

# PG_SOCKET redirect (GA_PG_SOCKET test seam) — MUST be exported BEFORE sourcing the launcher,
# because ga_init_env makes PG_SOCKET readonly at source time. Redirecting the socket dir at a temp
# dir means clear_unmanaged_pg_orphan's socket path resolves under it and can NEVER reach the live
# /tmp/.s.PGSQL.5432 by construction. Distinct mktemp subdir; cleaned up at harness exit.
GA_PG_SOCK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ga-pgsafe-sock.XXXXXX")"
export GA_PG_SOCKET="${GA_PG_SOCK_DIR}"

# --- source the launcher as a library (main skipped by its source-guard) ----------------
# This runs ga_init_env (PG_SOCKET → the GA_PG_SOCKET temp-dir redirect) + sources lib/ga-core.sh
# + lib/ga-deps.sh, giving stop_detached_daemons / clear_unmanaged_pg_orphan (ga-core) AND
# preflight_pg_utc_guard (glass-atrium) in one shot.
# shellcheck source=/dev/null
source "${LAUNCHER}"
# match run_gate_quiet's runtime: no -e, no ERR/EXIT trap (else an expected non-zero guard
# return would abort the harness).
set +e
trap - ERR EXIT INT TERM

# === recorder + log capture ===========================================================
GA_REC="$(mktemp "${TMPDIR:-/tmp}/ga-pgsafe-rec.XXXXXX")"
GA_LOG="$(mktemp "${TMPDIR:-/tmp}/ga-pgsafe-log.XXXXXX")"
_rec() { printf '%s\n' "$1" >>"${GA_REC}"; }
_rec_reset() { : >"${GA_REC}"; }
_rec_dump() { tr '\n' ' ' <"${GA_REC}"; }

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
assert_eq() { # $1=label $2=expected $3=actual
  if [[ "$2" == "$3" ]]; then pass "$1 (= $3)"; else fail "$1 (expected [$2] got [$3])"; fi
}
assert_rec_has() { # $1=label $2=needle
  if grep -qF "$2" "${GA_REC}"; then pass "$1 (recorded '$2')"; else fail "$1 (missing '$2')"; fi
}
assert_rec_absent() { # $1=label $2=needle
  if grep -qF "$2" "${GA_REC}"; then fail "$1 (UNEXPECTED '$2' — destructive action fired)"; else pass "$1 (absent)"; fi
}
# The layer-3 stale-socket removal in clear_unmanaged_pg_orphan is GUARDED by the code's REAL
# `[[ -S "${sock}" ]]` test against ${PG_SOCKET}/.s.PGSQL.5432 (redirected to a per-test temp dir via
# GA_PG_SOCKET), left un-stubbed above. So the record-only rm fires IFF a socket file actually exists there when the
# harness runs — mirror that guard rather than demand an unconditional fire (the old, host-fragile bug).
assert_socket_rm_matches_guard() { # $1=label
  local sock="${PG_SOCKET}/.s.PGSQL.5432"
  if [[ -S "${sock}" ]]; then
    assert_rec_has "$1 (live socket present → layer-3 rm fires)" "rm_socket:"
  else
    assert_rec_absent "$1 (no socket at ${sock} → layer-3 rm correctly skipped)" "rm_socket:"
  fi
}

# === scenario state (scripted per scenario) ===========================================
SC_PG_UTC="ok"          # ga_detect_postgres_utc verdict: ok|broken|down
SC_KEG=""               # ga_pg_keg_major: "" (no brew keg) | "18" (brew-managed)
GA_SANDBOX="no"         # is_sandbox_target verdict: no|yes
REC_RESTART_CLEARS="1"  # 1 => a brew restart flips broken→ok; 0 => restart does NOT clear
GA_ORPHAN_PIDS="424242" # lsof-reported pid owning the socket (fake — never a real pid)
GA_ORPHAN_CLEARS="0"    # 1 => a SIGINT frees the socket (orphan dies → detect reads 'down')

# === detect / query probes → scripted verdicts (no real psql/brew) ====================
ga_detect_postgres_utc() { printf '%s\n' "${SC_PG_UTC}"; }
ga_pg_keg_major() { printf '%s' "${SC_KEG}"; }
is_sandbox_target() { printf '%s\n' "${GA_SANDBOX}"; }
# ga_pg_wait_ready is bounded-real in production; here it just records + returns ready so the
# guard's post-restart re-verify is reached instantly (the REAL bounded poll is covered by the
# sibling deps-preflight-exec-harness.sh STEP-2 block, not re-proven here).
ga_pg_wait_ready() {
  _rec 'pg_wait_ready'
  return 0
}

# === brew service restart → recorder token (never a real brew) ========================
# The guard calls preflight_run_cmd "<label>" "$(ga_cmd_pg_service_restart)". We make the
# builder emit a recorder-token FUNCTION name and run it via a thinned preflight_run_cmd, so the
# restart ACTION is recorded without run_step's TUI machinery and without any real brew call.
ga_cmd_pg_service_restart() { printf 'rec_pg_restart\n'; }
rec_pg_restart() {
  _rec 'pg_restart'
  # model whether the restart cleared the broken state.
  [[ "${REC_RESTART_CLEARS}" == "1" ]] && SC_PG_UTC="ok"
  return 0
}
preflight_run_cmd() { # $1=label $2=command-string (a token fn name here)
  local IFS=' '
  _rec "run_cmd:$2"
  # shellcheck disable=SC2086  # deliberate word-split of the harness-built token
  $2
}

# === destructive leaf tools → PURE recorders (NEVER exec the real tool) ================
# kill / rm are builtins-or-coreutils the real code calls directly; a shell function shadows
# them with guaranteed precedence so NOTHING real is signalled or removed.
kill() { # only ever `kill -INT <pid>` from clear_unmanaged_pg_orphan
  _rec "sigint:${2:-}"
  # model the orphan dying → socket freed → next detect reads 'down'.
  if [[ "${GA_ORPHAN_CLEARS}" == "1" ]]; then
    GA_ORPHAN_PIDS=""
    SC_PG_UTC="down"
  fi
  return 0
}
rm() { # only ever `rm -f -- <sock>` from clear_unmanaged_pg_orphan (socket removal)
  _rec "rm_socket:$*"
  return 0 # PURE recorder — the real /tmp/.s.PGSQL.5432 (live pg) is NEVER removed
}
sleep() { return 0; } # collapse the bounded poll interval to instant
lsof() {              # `lsof -t -- <sock>` and `lsof -ti tcp:5432` — report the (fake) owning pid
  # kill_daemon_tmux_sessions now folds a STRICTLY PORT-SCOPED fakechat port-free
  # (`lsof -iTCP:<port>`) after the tmux teardown. That probe is orthogonal to postgres,
  # so return NO owner and do NOT record it — this harness asserts NO pg-socket probing,
  # and the fakechat reap has its own coverage in fakechat-port-cleanup.bats.
  case "${1:-}" in -iTCP:*) return 0 ;; esac
  _rec "lsof:$*"
  [[ -n "${GA_ORPHAN_PIDS}" ]] && printf '%s\n' "${GA_ORPHAN_PIDS}"
  return 0
}
# pgrep: the fakechat port-free's descendant/helper probe — no matches in this harness.
pgrep() { return 1; }
psql() {
  _rec "psql:$*"
  return 0
}
pg_isready() {
  _rec "pg_isready:$*"
  return 0
}
brew() {
  _rec "brew:$*"
  return 0
}
# tmux: has-session reports the session EXISTS (return 0); kill-session records the reap.
tmux() {
  case "${1:-}" in
    has-session) return 0 ;;
    kill-session) _rec "tmux_kill:${3:-}" ;;
    *) : ;;
  esac
  return 0
}
# pkill: reports a match (return 0) + records the pattern reaped.
pkill() {
  _rec "pkill:${2:-}"
  return 0
}

# === TTY / render helpers → no-op recorders (need a real TTY otherwise) ================
log() { printf '%s\n' "$*" >>"${GA_LOG}"; }
preflight_line() {
  _rec "line:$*"
  printf '%s\n' "$*" >>"${GA_LOG}"
}
preflight_release_tty() { _rec 'release_tty'; }
c() { printf '%s' "${2:-}"; }

# reset ambient state to the run_gate_quiet contract (-e off, no ERR trap) before each case.
_reset_case() {
  set +e
  trap - ERR
  _rec_reset
  SC_PG_UTC="ok"
  SC_KEG=""
  GA_SANDBOX="no"
  REC_RESTART_CLEARS="1"
  GA_ORPHAN_PIDS="424242"
  GA_ORPHAN_CLEARS="0"
  DRY_RUN=false
}

echo "============================================================================"
echo "(A) UNINSTALL: stop_detached_daemons leaves a HEALTHY postgres UNTOUCHED"
echo "============================================================================"
_reset_case
# healthy pg, real target, live run: the daemon reaps MUST fire; pg MUST be untouched.
DRY_RUN=false GA_SANDBOX="no"
stop_detached_daemons </dev/null
rc=$?
echo "    observed: $(_rec_dump)"
assert_eq "stop_detached_daemons returns 0" "0" "${rc}"
assert_rec_has "daemon-tmux reap FIRES (claude-wiki-daemon)" "tmux_kill:claude-wiki-daemon"
assert_rec_has "daemon-tmux reap FIRES (claude-autoagent-daemon)" "tmux_kill:claude-autoagent-daemon"
assert_rec_has "fakechat channel reap FIRES" "pkill:claude --channels plugin:fakechat@"
assert_rec_has "fakechat spawn-helper reap FIRES" "pkill:spawn-unix-fd.py"
# ZERO pg-destructive actions.
assert_rec_absent "NO brew-services action" "brew:"
assert_rec_absent "NO SIGINT to any postmaster" "sigint:"
assert_rec_absent "NO socket removal" "rm_socket:"
assert_rec_absent "NO lsof probe of the socket" "lsof:"
assert_rec_absent "NO psql/DB touch" "psql:"

echo ""
echo "  [A-static] run_uninstall wires the pg-safe teardown + contains NO pg destruction"
# Extract run_uninstall's body and assert its call graph (the heavy destructive steps —
# launchctl / node_modules rm / symlink sweep — are NOT executed here; they mutate the real tree).
RU_BODY="$(awk '/^run_uninstall\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${GA_DIR_ROOT}/lib/ga-core.sh")"
if grep -q 'stop_detached_daemons' <<<"${RU_BODY}"; then
  pass "run_uninstall calls stop_detached_daemons (STEP1b)"
else
  fail "run_uninstall does NOT call stop_detached_daemons"
fi
if grep -qE 'clear_unmanaged_pg_orphan|brew services stop|kill -INT' <<<"${RU_BODY}"; then
  fail "run_uninstall body contains a pg-destructive call (should be install-scoped only)"
else
  pass "run_uninstall body contains NO clear_unmanaged_pg_orphan / brew-stop / SIGINT"
fi

# === (B) INSTALL preflight_pg_utc_guard discrimination ================================
echo ""
echo "============================================================================"
echo "(B) INSTALL: preflight_pg_utc_guard state discrimination"
echo "============================================================================"

echo ""
echo "  [B-static] clear_unmanaged_pg_orphan retains the layer-3 stale-socket removal branch"
# Deterministic (host-independent) proof that the socket-rm branch EXISTS in the code — complements
# the guard-conditional runtime checks in B3/B3b (which can only OBSERVE the rm fire when a live
# socket happens to exist). If a regression drops layer-3, this static check fails on every host.
CL_BODY="$(declare -f clear_unmanaged_pg_orphan)"
if [[ "${CL_BODY}" == *'rm -f -- "${sock}"'* ]]; then
  pass "clear_unmanaged_pg_orphan body contains the layer-3 rm -f -- \"\${sock}\" removal"
else
  fail "clear_unmanaged_pg_orphan body is MISSING the layer-3 socket removal"
fi

echo ""
echo "  [B1] healthy 'ok' server → no-op (guard never enters its body)"
_reset_case
SC_PG_UTC="ok"
preflight_pg_utc_guard >/dev/null 2>>"${GA_LOG}"
rc=$?
echo "    observed: $(_rec_dump)"
assert_eq "B1 returns 0" "0" "${rc}"
assert_rec_absent "B1 no warn line emitted (never entered)" "line:"
assert_rec_absent "B1 no restart" "pg_restart"
assert_rec_absent "B1 no SIGINT" "sigint:"
assert_rec_absent "B1 no socket rm" "rm_socket:"

echo ""
echo "  [B2] 'broken' + brew-managed keg → RESTART clears it (no kill, no socket rm)"
_reset_case
SC_PG_UTC="broken"
SC_KEG="18"
REC_RESTART_CLEARS="1"
preflight_pg_utc_guard >/dev/null 2>>"${GA_LOG}"
rc=$?
echo "    observed: $(_rec_dump)"
assert_eq "B2 returns 0 (self-healed)" "0" "${rc}"
assert_rec_has "B2 brew restart FIRES" "pg_restart"
assert_rec_absent "B2 NO SIGINT (never kills a brew server)" "sigint:"
assert_rec_absent "B2 NO socket rm" "rm_socket:"

echo ""
echo "  [B3] 'broken' + NO brew keg → scoped orphan clear FIRES (SIGINT + socket rm) → 0"
_reset_case
SC_PG_UTC="broken"
SC_KEG=""
GA_ORPHAN_CLEARS="1" # SIGINT frees the socket → re-verify reads 'down'
preflight_pg_utc_guard >/dev/null 2>>"${GA_LOG}"
rc=$?
echo "    observed: $(_rec_dump)"
assert_eq "B3 returns 0 (orphan cleared, continue)" "0" "${rc}"
assert_rec_absent "B3 NO brew restart (no keg)" "pg_restart"
assert_rec_has "B3 SIGINT fast-shutdown FIRES" "sigint:424242"
assert_socket_rm_matches_guard "B3 socket removal matches the code's [[ -S ]] guard"

echo ""
echo "  [B3b] 'broken' + keg, restart does NOT clear → scoped clear FIRES (unresolvable-by-restart)"
_reset_case
SC_PG_UTC="broken"
SC_KEG="18"
REC_RESTART_CLEARS="0" # restart runs but leaves it broken
GA_ORPHAN_CLEARS="1"   # the subsequent scoped clear frees it
preflight_pg_utc_guard >/dev/null 2>>"${GA_LOG}"
rc=$?
echo "    observed: $(_rec_dump)"
assert_eq "B3b returns 0 (cleared after restart failed)" "0" "${rc}"
assert_rec_has "B3b brew restart attempted first" "pg_restart"
assert_rec_has "B3b scoped clear SIGINT FIRES after restart" "sigint:424242"
assert_socket_rm_matches_guard "B3b socket removal matches the code's [[ -S ]] guard"

echo ""
echo "  [B4a] DRY_RUN 'broken' unmanaged → clear is a no-op → LOUD-FAIL 1 (no false clear)"
_reset_case
SC_PG_UTC="broken"
SC_KEG=""
DRY_RUN=true
preflight_pg_utc_guard >/dev/null 2>>"${GA_LOG}"
rc=$?
echo "    observed: $(_rec_dump)"
assert_eq "B4a LOUD-FAILS (return 1)" "1" "${rc}"
assert_rec_absent "B4a NO SIGINT under dry-run" "sigint:"
assert_rec_absent "B4a NO socket rm under dry-run" "rm_socket:"
assert_rec_has "B4a release_tty on loud-fail" "release_tty"

echo ""
echo "  [B4b] sandbox 'broken' unmanaged → clear is a no-op → LOUD-FAIL 1 (no false clear)"
_reset_case
SC_PG_UTC="broken"
SC_KEG=""
GA_SANDBOX="yes"
preflight_pg_utc_guard >/dev/null 2>>"${GA_LOG}"
rc=$?
echo "    observed: $(_rec_dump)"
assert_eq "B4b LOUD-FAILS (return 1)" "1" "${rc}"
assert_rec_absent "B4b NO SIGINT under sandbox" "sigint:"
assert_rec_absent "B4b NO socket rm under sandbox" "rm_socket:"

echo ""
echo "============================================================================"
printf 'HARNESS RESULT: %s passed, %s failed\n' "${PASSES}" "${FAILS}"
echo "============================================================================"
# `rm` is shadowed as a pure recorder above; use the real coreutils rm for temp cleanup.
# `command` bypasses the shell-function shadow (unlike a PATH stub), reaching the real rm.
command rm -f "${GA_REC}" "${GA_LOG}"
command rm -rf -- "${GA_PG_SOCK_DIR}"
[[ "${FAILS}" -eq 0 ]]
