#!/usr/bin/env bats
# uninstall-detached-daemons.bats — R2 coverage for the uninstall teardown of the orphans
# that survive `launchctl bootout` + `claude plugin uninstall`:
#   (a) the detached daemon tmux sessions (GA_DAEMON_SESSIONS: claude-wiki-daemon /
#       claude-autoagent-daemon) — reparented to PID 1, so bootout does NOT reach them;
#   (b) lingering fakechat channel procs (`claude --channels plugin:fakechat@...` +
#       their `spawn-unix-fd.py` helpers) that outlive the plugin uninstall;
#   (c) an orphaned postmaster still squatting :5432 / the peer-auth socket — SIGINT
#       (fast shutdown), bounded socket-free poll, stale-socket removal.
#
# Run via: bats test/uninstall-detached-daemons.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic + SAFE toward the live machine (the AGENT is read-only toward real state):
#   * tmux / pkill / lsof / brew resolve to PATH-stub RECORDERS (never the real tools);
#   * `kill` (shell builtin) is overridden to a RECORDER (never signals a real pid);
#   * `sleep` is a no-op (collapse the bounded poll);
#   * `rm` is a record-only PATH stub SAFETY BELT — PG_SOCKET is the real "/tmp" (readonly
#     in ga_init_env), so a real postgres socket at /tmp/.s.PGSQL.5432 must NEVER be deleted
#     by a test. The record-only rm makes the socket-removal branch falsifiable without touch;
#   * is_sandbox_target is overridden per-test (the real verdict depends on the host HOME).

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

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

# brew stub: `list --versions` reports installed kegs; `services stop` records.
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
  stub_lsof # empty pids => the pg-orphan branch reports 'no orphan', touches nothing
  GA_TMUX_PRESENT=""
  export GA_TMUX_PRESENT GA_LSOF_PIDS=""
  run stop_detached_daemons
  [[ "${status}" -eq 0 ]]
  grep -qF 'pkill -f claude --channels plugin:fakechat@' "${REC}"
  grep -qF 'pkill -f spawn-unix-fd.py' "${REC}"
}

@test "R2(pg-orphan): an orphaned postmaster on the socket gets SIGINT (fast shutdown)" {
  is_sandbox_target() { printf 'no\n'; }
  stub_lsof
  stub_brew
  # kill (builtin) + sleep overridden to RECORD / no-op (never signal a real pid, never wait).
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { return 0; }
  GA_LSOF_PIDS="424242" # a fake orphaned postmaster pid
  export GA_LSOF_PIDS
  run stop_orphaned_postgres
  [[ "${status}" -eq 0 ]]
  # SIGINT = postgres fast shutdown, sent to the detected pid.
  grep -qF 'kill -INT 424242' "${REC}"
  # brew-managed keg is stopped first (clean path).
  grep -qF 'brew services stop postgresql@18' "${REC}"
}

@test "R2(pg-orphan): no orphaned postmaster => no kill, graceful no-op" {
  is_sandbox_target() { printf 'no\n'; }
  stub_lsof
  stub_brew
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { return 0; }
  GA_LSOF_PIDS="" # nothing owns the socket
  export GA_LSOF_PIDS
  run stop_orphaned_postgres
  [[ "${status}" -eq 0 ]]
  ! grep -qF 'kill -INT' "${REC}"
  [[ "${output}" == *"no orphaned postmaster"* ]]
}

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
  run grep -cF 'kill_daemon_tmux_sessions' "${GA}/lib/ga-core.sh"
  # 1 definition + 2 call-sites (run_install start + stop_detached_daemons).
  [[ "${output}" -ge 3 ]]
}
