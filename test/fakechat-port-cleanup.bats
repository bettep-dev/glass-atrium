#!/usr/bin/env bats
# fakechat-port-cleanup.bats — coverage for the STRICTLY PORT-SCOPED fakechat port
# reap (scripts/lib/fakechat-cleanup.sh) folded into the daemon bootstrap stale-port
# reclaim AND the ga install/uninstall teardown (kill_daemon_tmux_sessions).
#
# The confirmed bug: rapidly restarting a daemon leaves an orphan bun MCP child
# reparented to PID 1 still holding 127.0.0.1:<fakechat-port> — the next
# `claude --channels plugin:fakechat` session's bun then never binds (EADDRINUSE).
#
# THE CRITICAL SAFETY PROPERTY (verify-stage MUST-FIX): the fakechat port is passed
# to bun via the tmux `-e FAKECHAT_PORT=` ENV, NOT argv — both daemons' command lines
# are IDENTICAL (`claude --channels plugin:fakechat@claude-plugins-official`). So a
# `pgrep -f 'plugin:fakechat@'` match is PORT-BLIND and would TERM the LIVE HEALTHY
# PEER daemon on every restart. This suite pins that fakechat_free_port reaches the
# owner DIRECTLY by port and NEVER kills a peer.
#
# NEGATIVE-ASSERTION TEETH: bats runs each test body under set -e, but a bare `! cmd`
# is EXEMPT from set -e mid-test (SC2314) — a toothless `! grep` would pass even if
# the peer WERE killed. Every "must NOT appear" check therefore goes through
# refute_rec (a plain-function non-zero return DOES trip set -e).
#
# Hermetic + SAFE toward the live machine (the AGENT never touches a real proc):
#   * lsof / pgrep resolve to PATH-stub RECORDERS keyed on the queried port;
#   * kill / sleep are RECORDER / no-op function overrides (never a real signal);
#   * tmux is a PATH stub (has-session always MISS) so a real daemon session is never
#     touched by the ga-domain integration tests;
#   * FAKECHAT_PORT_FREE_TIMEOUT_SECS=0 collapses the settle-poll to instant.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LIB="${GA}/scripts/lib/fakechat-cleanup.sh"

setup() {
  [[ -f "${LIB}" ]] || skip "fakechat-cleanup.sh not found: ${LIB}"
  SANDBOX="$(mktemp -d -t ga-fakechat-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  mkdir -p "${STUB_BIN}"
  REC="${SANDBOX}/rec"
  : >"${REC}"
  export REC SANDBOX
  # settle-poll → instant (a real ceiling would busy-spin against the no-op sleep).
  export FAKECHAT_PORT_FREE_TIMEOUT_SECS=0
  # kill / sleep RECORDERS — nested function defs are global in bash, so these shadow
  # the builtins for EVERY command the reap runs (nothing real is ever signalled).
  kill() {
    printf 'kill %s\n' "$*" >>"${REC}"
    return 0
  }
  sleep() { return 0; }
  # default no-owner lsof + no-child pgrep (a per-test factory overrides where needed).
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/lsof"
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/pgrep"
  chmod +x "${STUB_BIN}/lsof" "${STUB_BIN}/pgrep"
  export PATH="${STUB_BIN}:${PATH}"
  # suspend any inherited ERR trap; the lib is sourceable without strict-mode fallout.
  trap - ERR
  # shellcheck source=/dev/null
  source "${LIB}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# refute_rec NEEDLE — FAIL the test if NEEDLE (fixed string) is present in the
# recorder. A plain function returning non-zero DOES trip bats' set -e mid-test,
# unlike a bare `! grep` (SC2314), so this negative assertion has teeth.
refute_rec() {
  if grep -qF "$1" "${REC}"; then
    printf 'refute_rec: UNEXPECTED %s in recorder:\n' "$1" >&2
    cat "${REC}" >&2
    return 1
  fi
  return 0
}

# --- stub factories ------------------------------------------------------------------

# lsof RECORDER keyed on the queried port: `-iTCP:<port>` → GA_LSOF_<port> owner pid.
# Frees after the FIRST call (the settle-poll / race-closer re-probe reads empty) unless
# GA_LSOF_STICKY=1 (a stubborn re-binder the KILL race-closer must catch).
stub_lsof_byport() {
  cat >"${STUB_BIN}/lsof" <<STUB
#!/bin/bash
printf 'lsof %s\n' "\$*" >>"${REC}"
port=""
for a in "\$@"; do case "\$a" in -iTCP:*) port="\${a#-iTCP:}" ;; esac; done
cf="${SANDBOX}/lsof-\${port}.cnt"
n=0; [[ -f "\${cf}" ]] && n="\$(cat "\${cf}")"; n=\$((n + 1)); printf '%s' "\${n}" >"\${cf}"
var="GA_LSOF_\${port}"; val="\${!var:-}"
[[ -n "\${val}" && ( "\${GA_LSOF_STICKY:-0}" == "1" || "\${n}" -eq 1 ) ]] && printf '%s\n' "\${val}"
exit 0
STUB
  chmod +x "${STUB_BIN}/lsof"
}

# pgrep RECORDER: `-P <pid>` → GA_PGREP_P_<pid> children; `-f "spawn-unix-fd.py <port> "`
# → GA_PGREP_HELP_<port> (the port is the pattern's 2nd word — port-keyed, so a peer
# daemon's helper on a different port is never returned).
stub_pgrep_byport() {
  cat >"${STUB_BIN}/pgrep" <<STUB
#!/bin/bash
printf 'pgrep %s\n' "\$*" >>"${REC}"
if [[ "\$1" == "-P" ]]; then
  var="GA_PGREP_P_\$2"; val="\${!var:-}"
  [[ -n "\${val}" ]] && printf '%s\n' "\${val}"
  exit 0
fi
if [[ "\$1" == "-f" ]]; then
  set -- \$2
  var="GA_PGREP_HELP_\$2"; val="\${!var:-}"
  [[ -n "\${val}" ]] && printf '%s\n' "\${val}"
  exit 0
fi
exit 0
STUB
  chmod +x "${STUB_BIN}/pgrep"
}

# tmux stub — has-session ALWAYS misses so a real daemon session is never touched.
stub_tmux_absent_sessions() {
  cat >"${STUB_BIN}/tmux" <<STUB
#!/bin/bash
case "\$1" in
  has-session) exit 1 ;;
  kill-session) printf 'tmux kill-session %s\n' "\$3" >>"${REC}" ;;
esac
exit 0
STUB
  chmod +x "${STUB_BIN}/tmux"
}

# _boot_ga — source the ga install/uninstall domain (defines kill_daemon_tmux_sessions +
# atrium_config_port + fakechat_free_port via ga_init_env) for the integration tests.
_boot_ga() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  trap - ERR
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-core.sh"
  ga_init_env "${GA}"
  DRY_RUN=false
}

# ======================================================================================
# Section A — fakechat_free_port unit (lib sourced standalone)
# ======================================================================================

@test "A1(reap): frees the lsof port owner + its descendants + the port-keyed helper, NO broad kill" {
  stub_lsof_byport
  stub_pgrep_byport
  export GA_LSOF_8787="1111" GA_PGREP_P_1111="3333" GA_PGREP_HELP_8787="2222"
  run fakechat_free_port 8787
  [[ "${status}" -eq 0 ]]
  grep -qF 'kill -TERM 1111' "${REC}" # owner
  grep -qF 'kill -TERM 3333' "${REC}" # descendant (pgrep -P recursion)
  grep -qF 'kill -TERM 2222' "${REC}" # port-keyed spawn-unix helper
  grep -qF 'lsof -iTCP:8787' "${REC}" # probed the requested port
  # NEVER a broad, port-blind reap; and only the requested port was ever probed.
  refute_rec 'pkill'
  refute_rec 'plugin:fakechat@'
  refute_rec 'lsof -iTCP:8788'
}

@test "A2(peer-preserved): freeing 8787 NEVER signals the live peer daemon (8788) — the MUST-FIX" {
  # target 8787 owner tree; the PEER role's claude (9999) + its bun on 8788 (8888) are LIVE.
  # fakechat_free_port 8787 must reach ONLY the 8787 owner tree — never the peer, never 8788.
  stub_lsof_byport
  stub_pgrep_byport
  export GA_LSOF_8787="1111" GA_PGREP_HELP_8787="2222"
  export GA_LSOF_8788="8888"      # peer bun — must never be queried/killed
  export GA_PGREP_HELP_8788="7777" # peer helper
  export GA_PGREP_P_1111=""        # target owner has no children here
  run fakechat_free_port 8787
  [[ "${status}" -eq 0 ]]
  grep -qF 'kill -TERM 1111' "${REC}" # target owner reaped
  grep -qF 'kill -TERM 2222' "${REC}" # target port-keyed helper reaped
  # PEER daemon fully preserved (each negative has teeth via refute_rec):
  refute_rec '9999'              # peer claude never signalled (a plugin:fakechat@ match would hit it)
  refute_rec '8888'              # peer bun never signalled
  refute_rec '7777'              # peer helper never signalled
  refute_rec 'lsof -iTCP:8788'   # peer port never even probed
  refute_rec 'plugin:fakechat@'  # NO port-blind cmdline match
  refute_rec 'pkill'             # NO broad reap
}

@test "A3(invalid-port): a non-integer / out-of-range port is a no-op, never signals" {
  stub_lsof_byport
  run fakechat_free_port "not-a-port"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"invalid port"* ]]
  refute_rec 'kill'
  refute_rec 'lsof' # never even probes on a garbage port
  run fakechat_free_port 99999
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"invalid port"* ]]
}

@test "A4(already-free): no listener + no helper → already-free log, no signal" {
  stub_lsof_byport
  stub_pgrep_byport
  # GA_LSOF_8787 / GA_PGREP_HELP_8787 unset → owner + helper both empty.
  run fakechat_free_port 8787
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"already free"* ]]
  refute_rec 'kill'
}

@test "A5(race-closer): a SO_REUSEADDR re-binder still holding the port after settle is SIGKILLed" {
  stub_lsof_byport
  stub_pgrep_byport
  export GA_LSOF_8787="5555" GA_LSOF_STICKY=1 # the port stays held across re-probes
  run fakechat_free_port 8787
  [[ "${status}" -eq 0 ]]
  grep -qF 'kill -TERM 5555' "${REC}" # graceful TERM first
  grep -qF 'kill -KILL 5555' "${REC}" # then force-KILL the survivor (race-closer)
  [[ "${output}" == *"still held after settle"* ]]
}

# ======================================================================================
# Section B — kill_daemon_tmux_sessions integration (ga install/uninstall domain)
# ======================================================================================

@test "B1(dry-run): DRY_RUN skips the port-free entirely (report-only, no signal)" {
  _boot_ga
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux_absent_sessions
  stub_lsof_byport
  export GA_LSOF_8787="1111" GA_LSOF_8788="2222"
  DRY_RUN=true
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"dry-run"* ]]
  refute_rec 'kill'
  refute_rec 'lsof' # the whole teardown short-circuits before any probe
}

@test "B2(sandbox): a sandbox target skips the port-free (ports are per-host, not per-HOME)" {
  _boot_ga
  is_sandbox_target() { printf 'yes\n'; }
  stub_tmux_absent_sessions
  stub_lsof_byport
  export GA_LSOF_8787="1111" GA_LSOF_8788="2222"
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"sandbox target"* ]]
  refute_rec 'kill'
  refute_rec 'lsof'
}

@test "B3(both-ports): frees BOTH the autoagent (8787) and wiki (8788) fakechat ports" {
  _boot_ga
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux_absent_sessions
  stub_lsof_byport
  stub_pgrep_byport
  # no config.toml → atrium_config_port returns the literal defaults 8787 / 8788.
  export ATRIUM_CONFIG_TOML="${SANDBOX}/absent-config.toml"
  export GA_LSOF_8787="7001" GA_LSOF_8788="8001"
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]]
  grep -qF 'lsof -iTCP:8787' "${REC}" # autoagent port freed
  grep -qF 'lsof -iTCP:8788' "${REC}" # wiki port freed
  grep -qF 'kill -TERM 7001' "${REC}"
  grep -qF 'kill -TERM 8001' "${REC}"
}

@test "B4(config-invalid): a CONFIGURED-invalid port falls back to the literal default, NEVER dies" {
  _boot_ga
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux_absent_sessions
  stub_lsof_byport
  # an out-of-range autoagent_fakechat → atrium_config_port rc 1; the teardown MUST loud-log +
  # free the literal 8787, never abort. wiki_fakechat absent → default 8788.
  printf '[ports]\nautoagent_fakechat = 99999\n' >"${SANDBOX}/bad-config.toml"
  export ATRIUM_CONFIG_TOML="${SANDBOX}/bad-config.toml"
  export GA_LSOF_8787="7001" GA_LSOF_8788="8001"
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]] # NEVER a die on a configured-invalid port
  [[ "${output}" == *"invalid configured [ports].autoagent_fakechat"* ]]
  grep -qF 'lsof -iTCP:8787' "${REC}" # freed the literal fallback, not the invalid 99999
  grep -qF 'lsof -iTCP:8788' "${REC}"
  refute_rec 'lsof -iTCP:99999'
}

# ======================================================================================
# Section C — static wiring (source-level proofs)
# ======================================================================================

@test "C1(bootstrap-wiring): daemon_bootstrap_reclaim_port calls fakechat_free_port, NO port-blind match" {
  local body
  body="$(awk '/^daemon_bootstrap_reclaim_port\(\) \{/{f=1} f{print} f&&/^}/{exit}' \
    "${GA}/scripts/lib/daemon-bootstrap-common.sh")"
  [[ -n "${body}" ]]
  # the reclaim delegates to the shared, port-scoped helper with its OWN resolved port.
  [[ "${body}" == *'fakechat_free_port "${FAKECHAT_PORT_DEFAULT}"'* ]]
  # and NEVER re-introduces a port-blind cmdline match (the peer-kill bug).
  [[ "${body}" != *'plugin:fakechat@'* ]]
  [[ "${body}" != *'pkill'* ]]
}

@test "C2(teardown-wiring): kill_daemon_tmux_sessions folds the port-free for BOTH ports, no-die fallback" {
  local body
  body="$(awk '/^kill_daemon_tmux_sessions\(\) \{/{f=1} f{print} f&&/^}/{exit}' \
    "${GA}/lib/ga-daemons.sh")"
  [[ -n "${body}" ]]
  [[ "${body}" == *'fakechat_free_port'* ]]
  # both daemon fakechat port keys resolved from config with a literal fallback.
  [[ "${body}" == *'autoagent_fakechat'* ]]
  [[ "${body}" == *'wiki_fakechat'* ]]
  # a configured-invalid port must fall back, never `die` a teardown.
  [[ "${body}" != *'die '* ]]
}
