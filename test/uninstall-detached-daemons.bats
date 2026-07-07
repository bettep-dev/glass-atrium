#!/usr/bin/env bats
# uninstall-detached-daemons.bats — coverage for the uninstall teardown of the orphans that
# survive `launchctl bootout` + `claude plugin uninstall`, AND the install-scoped clear of a
# GENUINE broken postgres orphan (moved OUT of uninstall).
#
#   UNINSTALL (stop_detached_daemons):
#     (a) the detached daemon tmux sessions (GA_DAEMON_SESSIONS: claude-wiki-daemon /
#         claude-autoagent-daemon) — reparented to PID 1, so bootout does NOT reach them;
#     (b) lingering fakechat channel procs (`claude --channels plugin:fakechat@...` +
#         their `spawn-unix-fd.py` helpers) that outlive the plugin uninstall.
#     REGRESSION GUARD: uninstall MUST leave the postgres server + its /tmp peer-auth socket
#     UNTOUCHED — no `brew services stop`, no SIGINT, no socket removal. A healthy server is
#     the user's, never GA's to stop on uninstall (the confirmed root-cause bug this suite pins).
#
#   INSTALL (clear_unmanaged_pg_orphan, wired into preflight_pg_utc_guard):
#     a GENUINE unmanaged orphan (answers SELECT 1 but REJECTS SET timezone='UTC', unresolvable
#     by a brew restart) is cleared install-side only — SIGINT (fast shutdown), bounded
#     socket-free poll, stale-socket removal — carrying its OWN DRY_RUN + sandbox guards. A
#     HEALTHY server (ok/down/absent) is never entered. A DRY_RUN / sandbox clear is a no-op, so
#     the guard's post-clear re-verify stays 'broken' and falls through to the loud-fail (never a
#     false 'cleared').
#
# Run via: bats test/uninstall-detached-daemons.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic + SAFE toward the live machine (the AGENT is read-only toward real state):
#   * tmux / pkill / lsof resolve to PATH-stub RECORDERS (never the real tools);
#   * `kill` (shell builtin) is overridden to a RECORDER (never signals a real pid);
#   * `sleep` is a no-op (collapse the bounded poll);
#   * `rm` is a record-only PATH stub SAFETY BELT — PG_SOCKET is the real "/tmp" (readonly
#     in ga_init_env), so a real postgres socket at /tmp/.s.PGSQL.5432 must NEVER be deleted
#     by a test. The record-only rm makes the socket-removal branch falsifiable without touch;
#   * is_sandbox_target is overridden per-test (the real verdict depends on the host HOME).

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-detached-daemons-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  mkdir -p "${STUB_BIN}"
  REC="${SANDBOX}/rec"
  : >"${REC}"
  # suspend any inherited ERR trap; ga-core is sourceable without strict-mode side effects.
  trap - ERR
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-core.sh"
  ga_init_env "${GA}"
  DRY_RUN=false

  # record-only rm SAFETY BELT (never delete anything — protects the real /tmp socket).
  printf '#!/bin/bash\nprintf "rm %%s\\n" "$*" >>"%s"\nexit 0\n' "${REC}" >"${STUB_BIN}/rm"
  chmod +x "${STUB_BIN}/rm"
  export PATH="${STUB_BIN}:${PATH}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# extract_launcher_fn — eval a single named launcher function into the test shell so it can be
# DRIVEN dynamically (its deps stubbed per-test) without booting the TUI. (glass-atrium carries a
# BASH_SOURCE==$0 source-guard, so the functions are callable in isolation.)
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

# --- stub factories ------------------------------------------------------------------

# tmux stub: `has-session` exit-codes per a configured present-set; `kill-session` records.
# GA_TMUX_PRESENT (space-separated session names) = sessions that "exist".
stub_tmux() {
  cat >"${STUB_BIN}/tmux" <<STUB
#!/bin/bash
case "\$1" in
  has-session)
    # \$3 is the session name (has-session -t <name>)
    for s in \${GA_TMUX_PRESENT}; do [[ "\$3" == "\$s" ]] && exit 0; done
    exit 1
    ;;
  kill-session)
    printf 'tmux kill-session %s\n' "\$3" >>"${REC}"
    exit 0
    ;;
esac
exit 0
STUB
  chmod +x "${STUB_BIN}/tmux"
}

# pkill stub: record the pattern; exit 0 (matched) / 1 (no match) per GA_PKILL_RC.
stub_pkill() {
  cat >"${STUB_BIN}/pkill" <<STUB
#!/bin/bash
# args: -f <pattern>
printf 'pkill %s\n' "\$*" >>"${REC}"
exit \${GA_PKILL_RC:-0}
STUB
  chmod +x "${STUB_BIN}/pkill"
}

# lsof stub: echo GA_LSOF_PIDS (empty => no owner found).
stub_lsof() {
  cat >"${STUB_BIN}/lsof" <<STUB
#!/bin/bash
printf '%s' "\${GA_LSOF_PIDS:-}"
[[ -n "\${GA_LSOF_PIDS:-}" ]] && printf '\n'
exit 0
STUB
  chmod +x "${STUB_BIN}/lsof"
}

# brew stub: `list --versions` reports installed kegs; `services stop` records (a stop MUST
# NEVER be recorded now — layer-1 was deleted; this stub exists only to falsify a regression).
stub_brew() {
  cat >"${STUB_BIN}/brew" <<STUB
#!/bin/bash
case "\$1" in
  list) printf 'postgresql@18 18.4\nnode@24 24.3.0\n' ;;
  services)
    if [[ "\$2" == "stop" ]]; then printf 'brew services stop %s\n' "\$3" >>"${REC}"; fi
    ;;
esac
exit 0
STUB
  chmod +x "${STUB_BIN}/brew"
}

# ------------------------------------------------------------------------------------

@test "R2(tmux): kill_daemon_tmux_sessions kills BOTH detached sessions when present" {
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux
  GA_TMUX_PRESENT="claude-wiki-daemon claude-autoagent-daemon"
  export GA_TMUX_PRESENT
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  grep -qF 'tmux kill-session claude-wiki-daemon' "${REC}"
  grep -qF 'tmux kill-session claude-autoagent-daemon' "${REC}"
}

@test "R2(tmux): a session that does NOT exist is a loud skip, not a kill" {
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux
  GA_TMUX_PRESENT="claude-wiki-daemon" # only the wiki session is live
  export GA_TMUX_PRESENT
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  grep -qF 'tmux kill-session claude-wiki-daemon' "${REC}"
  ! grep -qF 'tmux kill-session claude-autoagent-daemon' "${REC}"
  [[ "${output}" == *"no detached tmux session 'claude-autoagent-daemon' to kill"* ]]
}

@test "R2(guard): sandbox target skips the WHOLE teardown (no tmux kill)" {
  is_sandbox_target() { printf 'yes\n'; }
  stub_tmux
  GA_TMUX_PRESENT="claude-wiki-daemon claude-autoagent-daemon"
  export GA_TMUX_PRESENT
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"sandbox target"* ]]
  [[ ! -s "${REC}" ]] # nothing recorded — no kill reached the stub
}

@test "R2(guard): DRY_RUN reports without killing" {
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux
  GA_TMUX_PRESENT="claude-wiki-daemon claude-autoagent-daemon"
  export GA_TMUX_PRESENT
  DRY_RUN=true
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"dry-run"* ]]
  [[ ! -s "${REC}" ]]
}

@test "R2(tmux): tmux absent is a loud-log skip (Precondition Loud-Fail, not silent)" {
  is_sandbox_target() { printf 'no\n'; }
  # no tmux stub → command -v tmux misses (STUB_BIN has no tmux; ensure real tmux is hidden)
  command() {
    if [[ "$1" == "-v" && "$2" == "tmux" ]]; then return 1; fi
    builtin command "$@"
  }
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"tmux not found — skipping"* ]]
}

@test "R2(fakechat): stop_detached_daemons reaps BOTH fakechat proc patterns" {
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux
  stub_pkill
  GA_TMUX_PRESENT=""
  export GA_TMUX_PRESENT
  run stop_detached_daemons
  [[ "${status}" -eq 0 ]]
  grep -qF 'pkill -f claude --channels plugin:fakechat@' "${REC}"
  grep -qF 'pkill -f spawn-unix-fd.py' "${REC}"
}

# === REGRESSION GUARD — uninstall leaves the postgres server + socket UNTOUCHED ==========

@test "R2(pg-untouched): stop_detached_daemons NEVER stops pg (no brew-stop / no SIGINT / no socket-rm)" {
  # the confirmed-bug pin: even with a live orphan visible on the socket AND a brew keg present,
  # uninstall must NOT touch postgres — only the GA-owned tmux + fakechat orphans are reaped.
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux
  stub_pkill
  stub_lsof
  stub_brew
  # if uninstall STILL signalled/stopped pg, these recorders would capture it.
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { return 0; }
  GA_TMUX_PRESENT="claude-wiki-daemon"
  export GA_TMUX_PRESENT GA_LSOF_PIDS="424242" # a fake orphan is present on the socket
  run stop_detached_daemons
  [[ "${status}" -eq 0 ]]
  # GA-owned orphans ARE reaped.
  grep -qF 'tmux kill-session claude-wiki-daemon' "${REC}"
  grep -qF 'pkill -f claude --channels plugin:fakechat@' "${REC}"
  # postgres is LEFT ALONE — none of the three teardown layers fire on uninstall.
  ! grep -qF 'brew services stop' "${REC}"
  ! grep -qF 'kill -INT' "${REC}"
  ! grep -qF 'rm /tmp/.s.PGSQL.5432' "${REC}"
}

@test "R2(pg-untouched, static): stop_detached_daemons + run_uninstall reference NO pg stop helper" {
  # the moved helper is renamed to clear_unmanaged_pg_orphan and lives ONLY install-side; the old
  # stop_orphaned_postgres name is fully gone, and neither uninstall function calls the new one.
  ! grep -qF 'stop_orphaned_postgres' "${GA}/lib/ga-core.sh"
  local sdd ru
  sdd="$(awk '/^stop_detached_daemons\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${GA}/lib/ga-daemons.sh")"
  ru="$(awk '/^run_uninstall\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${GA}/lib/ga-core.sh")"
  [[ -n "${sdd}" && -n "${ru}" ]]
  [[ "${sdd}" != *'clear_unmanaged_pg_orphan'* ]]
  [[ "${ru}" != *'clear_unmanaged_pg_orphan'* ]]
}

# === INSTALL-SCOPED clear_unmanaged_pg_orphan — the renamed, layer-1-stripped helper ======

@test "clear(fires): a genuine orphan on the socket gets SIGINT (fast shutdown), NO brew stop" {
  is_sandbox_target() { printf 'no\n'; }
  stub_lsof
  stub_brew # present but MUST NOT be called (layer-1 brew-services-stop was deleted)
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { return 0; }
  GA_LSOF_PIDS="424242" # a fake unmanaged-orphan pid
  export GA_LSOF_PIDS
  run clear_unmanaged_pg_orphan
  [[ "${status}" -eq 0 ]]
  # layer-2 fires: SIGINT to the detected pid.
  grep -qF 'kill -INT 424242' "${REC}"
  # layer-1 is GONE: NO brew-managed server is ever stopped by the clear.
  ! grep -qF 'brew services stop' "${REC}"
}

@test "clear(layers): the helper body keeps layer-2 SIGINT + layer-3 socket-rm, drops layer-1 brew stop" {
  local body
  body="$(declare -f clear_unmanaged_pg_orphan)"
  [[ -n "${body}" ]]
  # layer-2 (SIGINT fast shutdown) + layer-3 (stale socket removal) retained.
  [[ "${body}" == *'kill -INT'* ]]
  [[ "${body}" == *'rm -f -- "${sock}"'* ]]
  # layer-1 (brew services stop postgresql@N) fully removed — never stop a brew-managed server.
  [[ "${body}" != *'brew services stop'* ]]
  # carries its OWN guards (no longer behind stop_detached_daemons).
  [[ "${body}" == *'"${DRY_RUN}"'* ]]
  [[ "${body}" == *'is_sandbox_target'* ]]
}

@test "clear(dry-run): DRY_RUN is a no-op — NO SIGINT, NO socket-rm (never a false clear)" {
  is_sandbox_target() { printf 'no\n'; }
  stub_lsof
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { return 0; }
  DRY_RUN=true
  GA_LSOF_PIDS="424242"
  export GA_LSOF_PIDS
  run clear_unmanaged_pg_orphan
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"dry-run"* ]]
  ! grep -qF 'kill -INT' "${REC}"
  ! grep -qF 'rm /tmp/.s.PGSQL.5432' "${REC}"
}

@test "clear(sandbox): a sandbox target is a no-op — NO SIGINT, NO socket-rm" {
  is_sandbox_target() { printf 'yes\n'; }
  stub_lsof
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { return 0; }
  GA_LSOF_PIDS="424242"
  export GA_LSOF_PIDS
  run clear_unmanaged_pg_orphan
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"sandbox target"* ]]
  ! grep -qF 'kill -INT' "${REC}"
  ! grep -qF 'rm /tmp/.s.PGSQL.5432' "${REC}"
}

# === preflight_pg_utc_guard WIRING — healthy no-op / cleared-continue / loud-fail ==========

@test "guard(healthy): an ok server is a no-op — clear is NEVER called, returns 0" {
  extract_launcher_fn preflight_pg_utc_guard
  preflight_line() { :; }
  c() { :; }
  preflight_release_tty() { :; }
  # a HEALTHY server: the very first detect is 'ok' → the guard early-returns, nothing entered.
  ga_detect_postgres_utc() { printf 'ok\n'; }
  clear_unmanaged_pg_orphan() { printf 'CLEAR-CALLED\n' >>"${REC}"; }
  run preflight_pg_utc_guard
  [[ "${status}" -eq 0 ]]
  ! grep -qF 'CLEAR-CALLED' "${REC}" # the clear path was never entered for a healthy server
}

@test "guard(cleared): a broken unmanaged orphan is cleared, re-verify != broken → continue (0)" {
  extract_launcher_fn preflight_pg_utc_guard
  preflight_line() { :; }
  c() { :; }
  preflight_release_tty() { :; }
  ga_pg_keg_major() { printf ''; } # UNMANAGED orphan (no brew keg) → skip the restart branch
  # file-backed counter: call#1 = broken (enter), call#2 (post-clear) = down (a freshly-cleared
  # socket reads 'down', NOT 'ok') — the guard's `!= broken` check must accept it.
  UTC_CALLS="${SANDBOX}/utc-calls"; printf '0' >"${UTC_CALLS}"
  ga_detect_postgres_utc() {
    local n; n="$(cat "${UTC_CALLS}")"; n=$((n + 1)); printf '%s' "${n}" >"${UTC_CALLS}"
    if [[ "${n}" -eq 1 ]]; then printf 'broken\n'; else printf 'down\n'; fi
  }
  clear_unmanaged_pg_orphan() { printf 'CLEAR-CALLED\n' >>"${REC}"; }
  run preflight_pg_utc_guard
  [[ "${status}" -eq 0 ]]           # cleared → continue (install proceeds fresh)
  grep -qF 'CLEAR-CALLED' "${REC}"  # the scoped clear fired
}

@test "guard(unfreeable): a clear that does NOT free the socket falls to the loud-fail (return 1)" {
  extract_launcher_fn preflight_pg_utc_guard
  preflight_line() { :; }
  c() { :; }
  preflight_release_tty() { :; }
  ga_pg_keg_major() { printf ''; }
  ga_detect_postgres_utc() { printf 'broken\n'; } # STILL broken after the clear
  clear_unmanaged_pg_orphan() { printf 'CLEAR-CALLED\n' >>"${REC}"; } # a no-op clear
  run preflight_pg_utc_guard
  [[ "${status}" -eq 1 ]]           # never a false 'cleared' → loud-fail bail
  grep -qF 'CLEAR-CALLED' "${REC}"
}

@test "guard(dry-run integration): DRY_RUN → REAL clear no-ops → guard loud-fails (1), no SIGINT" {
  # end-to-end: the extracted guard + the REAL clear_unmanaged_pg_orphan (sourced ga-core). Under
  # DRY_RUN the helper is a no-op, so the orphan stays 'broken' and the guard correctly bails —
  # a DRY_RUN install NEVER reports a false 'orphan cleared' and NEVER signals a pid.
  extract_launcher_fn preflight_pg_utc_guard
  preflight_line() { :; }
  c() { :; }
  preflight_release_tty() { :; }
  is_sandbox_target() { printf 'no\n'; }
  ga_pg_keg_major() { printf ''; }
  ga_detect_postgres_utc() { printf 'broken\n'; } # the orphan is never cleared under dry-run
  stub_lsof
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { return 0; }
  DRY_RUN=true
  GA_LSOF_PIDS="424242"
  export GA_LSOF_PIDS
  run preflight_pg_utc_guard
  [[ "${status}" -eq 1 ]]
  ! grep -qF 'kill -INT' "${REC}" # the real clear no-oped under DRY_RUN (never signalled the pid)
}

# === static wiring — the guard drives the clear with a `!= broken` re-verify ===============

@test "guard(static): preflight_pg_utc_guard wires clear_unmanaged_pg_orphan with a != broken re-verify" {
  local body
  body="$(awk '/^preflight_pg_utc_guard\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${body}" ]]
  # the renamed install-scoped clear is invoked from the unmanaged-orphan branch.
  [[ "${body}" == *'clear_unmanaged_pg_orphan'* ]]
  # post-clear success check mirrors the brew-restart re-verify: != broken (a cleared socket is
  # 'down', not 'ok'), NEVER a == ok check that would drop a genuinely-cleared orphan to the bail.
  [[ "${body}" == *'ga_detect_postgres_utc)" != "broken"'* ]]
  [[ "${body}" != *'ga_detect_postgres_utc)" == "ok"'* ]]
  # the :5432 healthy-server early-return is preserved byte-for-byte (ok/down/absent never enter).
  [[ "${body}" == *'[[ "$(ga_detect_postgres_utc)" == "broken" ]] || return 0'* ]]
}

# === wiring — run_uninstall ordering + install-start tmux clear (unchanged) ================

@test "R2(wiring): run_uninstall calls stop_detached_daemons BETWEEN launchd teardown and DB drop" {
  # static ordering proof against the engine source (no destructive run).
  run awk '
    /unload_launchd_jobs/ { u = NR }
    /stop_detached_daemons/ && !/^#/ { s = NR }
    /drop_databases/ && !/^#/ { d = NR }
    END { print u, s, d }
  ' "${GA}/lib/ga-core.sh"
  # unload(<)stop(<)drop — the call-site line numbers must be strictly increasing.
  set -- ${output}
  # last occurrences win in awk above; assert all three found + ordered.
  [[ -n "$1" && -n "$2" && -n "$3" ]]
  [[ "$1" -lt "$2" ]]
  [[ "$2" -lt "$3" ]]
}

@test "R2(wiring): run_install clears stale daemon tmux sessions at install start" {
  # after the ga-core split: the definition + the stop_detached_daemons call-site moved into
  # ga-daemons.sh; only run_install's install-start call remains in ga-core.sh. Sum both files.
  core_n="$(grep -cF 'kill_daemon_tmux_sessions' "${GA}/lib/ga-core.sh" || true)"
  daemons_n="$(grep -cF 'kill_daemon_tmux_sessions' "${GA}/lib/ga-daemons.sh" || true)"
  [[ -z "${core_n}" ]] && core_n=0
  [[ -z "${daemons_n}" ]] && daemons_n=0
  # 1 definition + 2 call-sites (run_install start in ga-core.sh + def & stop_detached_daemons call in ga-daemons.sh).
  [[ "$(( core_n + daemons_n ))" -ge 3 ]]
}
