#!/usr/bin/env bats
# fakechat-port-cleanup.bats — fakechat_free_port (scripts/lib/fakechat-cleanup.sh): the port-scoped reap
# of a fakechat port's listener owner tree + its port-keyed spawn helper, standalone (section A) and
# through its teardown caller kill_daemon_tmux_sessions (section B); section C covers the fakechat
# step's plugin-detection reads in lib/ga-deps.sh.
#
# Safety property: every fakechat session runs one identical argv (the port rides an env var), so a
# `plugin:fakechat@` cmdline match is port-blind → freeing one port must never signal another port's tree.
#
# Hermetic toward the live machine:
#   * lsof / pgrep / pkill / launchctl / tmux / rm → PATH recorders; kill / sleep → function recorders;
#   * HOME → a scratch dir before ga_init_env; FAKECHAT_PORT_FREE_TIMEOUT_SECS=0 → instant settle-poll.
# Negative checks go through refute_rec: a bare `! grep` is exempt from bats' set -e (SC2314).

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LIB="${GA}/scripts/lib/fakechat-cleanup.sh"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  [[ -f "${LIB}" ]] || skip "fakechat-cleanup.sh not found: ${LIB}"
  SANDBOX="$(mktemp -d -t ga-fakechat-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  mkdir -p "${STUB_BIN}"
  REC="${SANDBOX}/rec"
  : >"${REC}"
  export REC SANDBOX
  # captured before STUB_BIN joins PATH — teardown's removal must bypass the rm recorder.
  REAL_RM="$(command -v rm)"
  # ga_init_env + atrium_config_port read under HOME → a scratch home, never the live one.
  export HOME="${SANDBOX}/home" GA_DATA_ROOT="${SANDBOX}/home/.glass-atrium"
  mkdir -p "${HOME}"
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
  # record-only pkill / launchctl / rm — a broad reap, a launchd call or a removal lands in REC.
  local tool
  for tool in pkill launchctl rm; do
    printf '#!/bin/bash\nprintf "%s %%s\\n" "$*" >>"%s"\nexit 0\n' "${tool}" "${REC}" >"${STUB_BIN}/${tool}"
    chmod +x "${STUB_BIN}/${tool}"
  done
  export PATH="${STUB_BIN}:${PATH}"
  # suspend any inherited ERR trap; the lib is sourceable without strict-mode fallout.
  trap - ERR
  # shellcheck source=/dev/null
  source "${LIB}"
}

teardown() {
  local real_rm="${REAL_RM:-/bin/rm}"
  if ga_guard_path "${SANDBOX:-}"; then "${real_rm}" -rf -- "${SANDBOX:?}"; fi
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
# → GA_PGREP_HELP_<port> (the port is the pattern's 2nd word — port-keyed, so a helper
# on a different port is never returned).
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

# tmux stub — has-session ALWAYS misses so a real tmux session is never touched.
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

# _boot_ga — source lib/ga-core.sh (defines kill_daemon_tmux_sessions +
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
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  grep -qF 'kill -TERM 1111' "${REC}" # owner
  grep -qF 'kill -TERM 3333' "${REC}" # descendant (pgrep -P recursion)
  grep -qF 'kill -TERM 2222' "${REC}" # port-keyed spawn-unix helper
  grep -qF 'lsof -iTCP:8787' "${REC}" # probed the requested port
  # NEVER a broad, port-blind reap; and only the requested port was ever probed.
  refute_rec 'pkill'
  refute_rec 'plugin:fakechat@'
  refute_rec 'lsof -iTCP:8788'
}

@test "A2(port-scoped): freeing 8787 NEVER signals a session, listener or helper on another fakechat port" {
  # another fakechat session (claude 9999) + its bun listener on 8788 (8888) + its helper (7777) are live.
  stub_lsof_byport
  stub_pgrep_byport
  export GA_LSOF_8787="1111" GA_PGREP_HELP_8787="2222"
  export GA_LSOF_8788="8888"       # 8788 listener — must never be queried/killed
  export GA_PGREP_HELP_8788="7777" # 8788 helper
  export GA_PGREP_P_1111=""        # target owner has no children here
  run fakechat_free_port 8787
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  grep -qF 'kill -TERM 1111' "${REC}" # target owner reaped
  grep -qF 'kill -TERM 2222' "${REC}" # target port-keyed helper reaped
  # the 8788 tree fully preserved (each negative has teeth via refute_rec):
  refute_rec '9999'             # 8788 claude never signalled (a plugin:fakechat@ match would hit it)
  refute_rec '8888'             # 8788 listener never signalled
  refute_rec '7777'             # 8788 helper never signalled
  refute_rec 'lsof -iTCP:8788'  # 8788 never even probed
  refute_rec 'plugin:fakechat@' # NO port-blind cmdline match
  refute_rec 'pkill'            # NO broad reap
}

@test "A3(invalid-port): a non-integer / out-of-range port is a no-op, never signals" {
  stub_lsof_byport
  run fakechat_free_port "not-a-port"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"invalid port"* ]]
  refute_rec 'kill'
  refute_rec 'lsof' # never even probes on a garbage port
  run fakechat_free_port 99999
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"invalid port"* ]]
}

@test "A4(already-free): no listener + no helper → already-free log, no signal" {
  stub_lsof_byport
  stub_pgrep_byport
  # GA_LSOF_8787 / GA_PGREP_HELP_8787 unset → owner + helper both empty.
  run fakechat_free_port 8787
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"already free"* ]]
  refute_rec 'kill'
}

@test "A5(race-closer): a SO_REUSEADDR re-binder still holding the port after settle is SIGKILLed" {
  stub_lsof_byport
  stub_pgrep_byport
  export GA_LSOF_8787="5555" GA_LSOF_STICKY=1 # the port stays held across re-probes
  run fakechat_free_port 8787
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  grep -qF 'kill -TERM 5555' "${REC}" # graceful TERM first
  grep -qF 'kill -KILL 5555' "${REC}" # then force-KILL the survivor (race-closer)
  [[ "${output}" == *"still held after settle"* ]]
}

# ======================================================================================
# Section B — kill_daemon_tmux_sessions integration (teardown caller of fakechat_free_port)
# ======================================================================================

@test "B1(dry-run): DRY_RUN skips the port-free entirely (report-only, no signal)" {
  _boot_ga
  is_sandbox_target() { printf 'no\n'; }
  stub_tmux_absent_sessions
  stub_lsof_byport
  export GA_LSOF_8787="1111" GA_LSOF_8788="2222"
  DRY_RUN=true
  run kill_daemon_tmux_sessions
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
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
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
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
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
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
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  } # NEVER a die on a configured-invalid port
  [[ "${output}" == *"invalid configured [ports].autoagent_fakechat"* ]]
  grep -qF 'lsof -iTCP:8787' "${REC}" # freed the literal fallback, not the invalid 99999
  grep -qF 'lsof -iTCP:8788' "${REC}"
  refute_rec 'lsof -iTCP:99999'
}

# ======================================================================================
# Section C — fakechat plugin detection (lib/ga-deps.sh), the fakechat step's precondition reads
# ======================================================================================

# _extract_deps_fn — source one named function from lib/ga-deps.sh into the test shell.
_extract_deps_fn() {
  local fn_file="${SANDBOX}/$1.sh"
  awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${GA}/lib/ga-deps.sh" >"${fn_file}" || return 1
  [[ -s "${fn_file}" ]] || return 1
  # shellcheck source=/dev/null
  source "${fn_file}"
}

@test "a claude listing past one pipe buffer still reads the plugin and marketplace present" {
  # name|function|first listing line|expected
  local rows=(
    "fakechat plugin|ga_detect_fakechat|fakechat@claude-plugins-official|present"
    "official marketplace|ga_marketplace_present|claude-plugins-official|yes"
  )
  local row name fn first want got
  for row in "${rows[@]}"; do
    IFS='|' read -r name fn first want <<<"${row}"
    _extract_deps_fn "${fn}" || {
      echo "${name}: ${fn} not found"
      return 1
    }
    # the match first, then ~1 MB: an early-exit reader leaves the CLI mid-write
    cat >"${STUB_BIN}/claude" <<STUB
#!/bin/sh
printf '%s\n' '${first}'
awk 'BEGIN { for (i = 0; i < 60000; i++) print "  other-plugin-" i "@some-marketplace" }'
STUB
    chmod +x "${STUB_BIN}/claude"
    # the launcher's pipefail, scoped to a subshell so the test body keeps bats' own
    got="$(set -o pipefail && "${fn}")"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: got '${got}', want '${want}'"
      return 1
    }
  done
}
