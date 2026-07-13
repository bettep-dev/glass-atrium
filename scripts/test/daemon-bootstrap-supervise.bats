#!/usr/bin/env bats
# Supervise-lifecycle regression suite for {wiki,autoagent}-daemon-bootstrap.sh
# + lib/daemon-bootstrap-common.sh — pins the TOCTOU/exit-0 death-family fixes
# (adopt-vs-no-op, duplicate-create race, restart-window lock, transient session
# vanish, monitor exit 3); each contract is detailed at its section below.
# Hermetic: copy the live wrapper + shared libs into a sandbox so SCRIPT_DIR
# resolves the stub inject sibling; stub the PATH binaries (tmux/claude/curl/bun/
# lsof/pgrep); DAEMON_LOCK_DIR points into the sandbox so no production lock is
# touched. The tmux stub keys has-session on a marker file, plus a one-shot
# transient marker (consumed on first probe) simulating a half-created session
# visible for exactly one has-session call; new-session behavior is selected per
# test via TMUX_NEW_SESSION_MODE (ok | raced | atomic).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_WIKI_BOOTSTRAP="${GA}/scripts/wiki-daemon-bootstrap.sh"
REAL_AUTOAGENT_BOOTSTRAP="${GA}/scripts/autoagent-daemon-bootstrap.sh"
REAL_BOOTSTRAP_LIB="${GA}/scripts/lib/daemon-bootstrap-common.sh"
REAL_LOCK_LIB="${GA}/scripts/lib/daemon-lock.sh"
REAL_CONFIG_LIB="${GA}/scripts/lib/atrium-config.sh"
REAL_FAKECHAT_LIB="${GA}/scripts/lib/fakechat-cleanup.sh"
REAL_AUTH_LIB="${GA}/scripts/lib/claude-auth-env.sh"

setup() {
  [[ -f "${REAL_BOOTSTRAP_LIB}" ]] || skip "daemon-bootstrap-common.sh not found"
  TMPROOT="$(mktemp -d -t daemon-supervise-bats.XXXXXX)"
  SANDBOX="${TMPROOT}/scripts"
  STUB_BIN="${TMPROOT}/bin"
  LOCK_DIR="${TMPROOT}/locks"
  SESSION_MARKER="${TMPROOT}/session-exists"
  SESSION_TRANSIENT="${TMPROOT}/session-transient"
  TMUX_CALLS="${TMPROOT}/tmux-calls.log"
  INJECT_CALLS="${TMPROOT}/inject-calls.log"
  CREATE_WINNER="${TMPROOT}/create-winner"
  BOOT_PIDS="${TMPROOT}/boot-pids"
  mkdir -p "${SANDBOX}" "${STUB_BIN}" "${LOCK_DIR}"
  : >"${BOOT_PIDS}"

  cat >"${STUB_BIN}/tmux" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${TMUX_CALLS}"
case "\$1" in
  has-session)
    if [[ -f "${SESSION_TRANSIENT}" ]]; then
      rm -f -- "${SESSION_TRANSIENT}"
      exit 0
    fi
    [[ -f "${SESSION_MARKER}" ]]
    ;;
  new-session)
    case "\${TMUX_NEW_SESSION_MODE:-ok}" in
      ok) : >"${SESSION_MARKER}"; exit 0 ;;
      raced) : >"${SESSION_MARKER}"; exit 1 ;;
      atomic)
        if mkdir "${CREATE_WINNER}" 2>/dev/null; then
          : >"${SESSION_MARKER}"; exit 0
        fi
        exit 1
        ;;
    esac
    ;;
  kill-session) rm -f -- "${SESSION_MARKER}"; exit 0 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${STUB_BIN}/tmux"

  # claude/bun present for `command -v`; curl always 200-OK (instant readiness);
  # lsof prints nothing (no stale listeners); pgrep exit 1 (no helper debris).
  for bin in claude bun curl lsof; do
    printf '#!/usr/bin/env bash\nexit 0\n' >"${STUB_BIN}/${bin}"
    chmod +x "${STUB_BIN}/${bin}"
  done
  printf '#!/usr/bin/env bash\nexit 1\n' >"${STUB_BIN}/pgrep"
  chmod +x "${STUB_BIN}/pgrep"

  cat >"${SANDBOX}/daemon-inject-entry.sh" <<STUB
#!/usr/bin/env bash
printf 'called\n' >>"${INJECT_CALLS}"
exit "\${INJECT_STUB_RC:-0}"
STUB
  chmod +x "${SANDBOX}/daemon-inject-entry.sh"
}

teardown() {
  if [[ -f "${BOOT_PIDS}" ]]; then
    while read -r pid; do
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    done <"${BOOT_PIDS}"
  fi
  [[ -n "${TMPROOT:-}" && -d "${TMPROOT}" ]] && rm -rf -- "${TMPROOT}" || true
}

# Copy the live wrapper + both shared libs into the sandbox so the wrapper's
# SCRIPT_DIR resolves the stub sibling AND the libs under the same lib/ layout.
# Args: $1=real wrapper path → echoes the sandboxed copy path.
sandbox_copy() {
  local real="$1" base
  base="$(basename "${real}")"
  cp "${real}" "${SANDBOX}/${base}"
  chmod +x "${SANDBOX}/${base}"
  mkdir -p "${SANDBOX}/lib"
  cp "${REAL_BOOTSTRAP_LIB}" "${SANDBOX}/lib/daemon-bootstrap-common.sh"
  cp "${REAL_LOCK_LIB}" "${SANDBOX}/lib/daemon-lock.sh"
  cp "${REAL_CONFIG_LIB}" "${SANDBOX}/lib/atrium-config.sh"
  cp "${REAL_FAKECHAT_LIB}" "${SANDBOX}/lib/fakechat-cleanup.sh"
  printf '%s\n' "${SANDBOX}/${base}"
}

# Launch a sandboxed bootstrap in the background with hermetic env; the pid is
# returned via the LAUNCHED_PID global (NOT echoed — a command-substitution
# launch would orphan the child into a subshell, breaking `wait` in tests).
# Real sleep is kept (no stub) — the time knobs are shrunk instead, so the
# monitor/wait loops stay lively without hot-spinning.
# Args: $1=script $2=logfile $3...=mode args
launch_bootstrap() {
  local script="$1" logf="$2"
  shift 2
  PATH="${STUB_BIN}:${PATH}" \
    DAEMON_LOCK_DIR="${LOCK_DIR}" \
    ATRIUM_CONFIG_TOML="${TMPROOT}/config.toml" \
    DAEMON_CONFIG="${TMPROOT}/daemon-config.json" \
    GA_ROOT="${TMPROOT}" \
    COLD_START_WAIT_SEC=0 \
    HTTP_READY_INTERVAL_SEC=0 \
    MONITOR_INTERVAL_SEC=1 \
    RESTART_LOCK_POLL_SEC=1 \
    TMUX_NEW_SESSION_MODE="${TMUX_NEW_SESSION_MODE:-ok}" \
    bash "${script}" "$@" >"${logf}" 2>&1 &
  LAUNCHED_PID=$!
  printf '%s\n' "${LAUNCHED_PID}" >>"${BOOT_PIDS}"
}

# Polls a log file for a fixed string. Args: $1=file $2=needle $3=timeout_sec
wait_for_log() {
  local file="$1" needle="$2" timeout="$3" elapsed=0
  while ((elapsed < timeout * 10)); do
    if [[ -f "${file}" ]] && grep -qF "${needle}" "${file}"; then
      return 0
    fi
    sleep 0.1
    elapsed=$((elapsed + 1))
  done
  echo "timed out waiting for log line: ${needle}" >&2
  [[ -f "${file}" ]] && cat "${file}" >&2
  return 1
}

# Adopt-and-supervise: pre-existing session must never produce a clean exit 0
# in supervise mode (the unsupervised-session death under SuccessfulExit=false).

@test "supervise + pre-existing session: adopts (monitor loop), no recreate, no no-op exit" {
  : >"${SESSION_MARKER}"
  local s pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "already exists — adopting for supervision" 10
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10
  kill -0 "${pid}"
  run ! grep -qF -- "no-op" "${TMPROOT}/boot.log"
  run ! grep -q '^new-session' "${TMUX_CALLS}"
  # adopter holds the supervisor lock (link target = its pid)
  [[ "$(readlink "${LOCK_DIR}/daemon-supervisor-wiki.lock")" == "${pid}" ]]
}

@test "return + pre-existing session: keeps the no-op exit 0" {
  : >"${SESSION_MARKER}"
  local s
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  run env PATH="${STUB_BIN}:${PATH}" DAEMON_LOCK_DIR="${LOCK_DIR}" \
    ATRIUM_CONFIG_TOML="${TMPROOT}/config.toml" \
    COLD_START_WAIT_SEC=0 bash "${s}" return
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"already exists — no-op (return mode)"* ]]
  [[ "${output}" != *"entering self-health monitoring loop"* ]]
}

# Duplicate-create TOCTOU: the loser treats the racer's session as success,
# never injects (the winner owns it), and still supervises in supervise mode.

@test "duplicate-create race (supervise loser): adopts winner's session, skips inject" {
  local s pid
  s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
  TMUX_NEW_SESSION_MODE=raced
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "raced a concurrent bootstrap" 10
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10
  kill -0 "${pid}"
  [[ ! -f "${INJECT_CALLS}" ]]
}

@test "duplicate-create race (return loser): rc=0, no inject, no monitor loop" {
  local s
  s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
  run env PATH="${STUB_BIN}:${PATH}" DAEMON_LOCK_DIR="${LOCK_DIR}" \
    ATRIUM_CONFIG_TOML="${TMPROOT}/config.toml" \
    COLD_START_WAIT_SEC=0 TMUX_NEW_SESSION_MODE=raced bash "${s}" return
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"duplicate-create race resolved by the winner"* ]]
  [[ "${output}" != *"entering self-health monitoring loop"* ]]
  [[ ! -f "${INJECT_CALLS}" ]]
}

@test "duplicate-session race: exactly one live supervisor (symlink lock)" {
  local s pid_a pid_b alive=2 waited=0
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  TMUX_NEW_SESSION_MODE=atomic
  launch_bootstrap "${s}" "${TMPROOT}/boot-a.log"
  pid_a="${LAUNCHED_PID}"
  launch_bootstrap "${s}" "${TMPROOT}/boot-b.log"
  pid_b="${LAUNCHED_PID}"
  # settle: the lock loser yields with exit 0, the winner keeps supervising
  while ((waited < 100)); do
    alive=0
    if kill -0 "${pid_a}" 2>/dev/null; then alive=$((alive + 1)); fi
    if kill -0 "${pid_b}" 2>/dev/null; then alive=$((alive + 1)); fi
    if ((alive == 1)); then break; fi
    sleep 0.1
    waited=$((waited + 1))
  done
  sleep 1
  alive=0
  if kill -0 "${pid_a}" 2>/dev/null; then alive=$((alive + 1)); fi
  if kill -0 "${pid_b}" 2>/dev/null; then alive=$((alive + 1)); fi
  [[ "${alive}" -eq 1 ]]
  local entering yielding
  entering="$(cat "${TMPROOT}/boot-a.log" "${TMPROOT}/boot-b.log" | grep -cF 'entering self-health monitoring loop' || true)"
  [[ "${entering}" -eq 1 ]]
  yielding="$(cat "${TMPROOT}/boot-a.log" "${TMPROOT}/boot-b.log" | grep -cF 'yielding (exactly one supervisor)' || true)"
  [[ "${yielding}" -eq 1 ]]
  # exactly one inject — the create winner owns it
  [[ "$(wc -l <"${INJECT_CALLS}" | tr -d ' ')" -eq 1 ]]
}

# Restart-window lock honor (supervise) — wait while held by a live holder,
# adopt once the session reappears; ignore a stale (dead-holder) lock.

@test "restart-window lock: supervise waits, then adopts the recreated session" {
  local s pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  # live holder = this bats process
  ln -s "$$" "${LOCK_DIR}/daemon-restart-wiki.lock"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "waiting for the restart window to close" 10
  run ! grep -q '^new-session' "${TMUX_CALLS}"
  # the daily-restart finishes recreating the session
  : >"${SESSION_MARKER}"
  wait_for_log "${TMPROOT}/boot.log" "appeared during restart-window wait — adopting" 10
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10
  kill -0 "${pid}"
  run ! grep -q '^new-session' "${TMUX_CALLS}"
}

@test "stale restart lock (dead holder): proceeds straight to create" {
  local s pid dead_pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  true &
  dead_pid=$!
  wait "${dead_pid}" || true
  ln -s "${dead_pid}" "${LOCK_DIR}/daemon-restart-wiki.lock"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10
  kill -0 "${pid}"
  run ! grep -qF "waiting for the restart window" "${TMPROOT}/boot.log"
}

@test "transient session vanish (live holder): re-enters wait, no create until lock release" {
  local s pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  ln -s "$$" "${LOCK_DIR}/daemon-restart-wiki.lock"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "waiting for the restart window to close" 10
  # daily-restart's retry loop kills its half-created session: visible for
  # exactly one has-session probe (the wait's), gone by the adopt re-check
  : >"${SESSION_TRANSIENT}"
  wait_for_log "${TMPROOT}/boot.log" "vanished while the restart lock is held — re-entering restart-window wait" 10
  kill -0 "${pid}"
  run ! grep -q '^new-session' "${TMUX_CALLS}"
  run ! grep -qF "adopting for supervision" "${TMPROOT}/boot.log"
  # holder closes the restart window — only now may the bootstrap create
  rm -f -- "${LOCK_DIR}/daemon-restart-wiki.lock"
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10
  kill -0 "${pid}"
}

# Monitor tick: missing session still exits 3 (launchd respawn) AND the EXIT
# trap releases the supervisor lock so the respawned instance can acquire it.

@test "monitor loop: missing session → exit 3, supervisor lock released" {
  : >"${SESSION_MARKER}"
  local s pid rc=0
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10
  rm -f -- "${SESSION_MARKER}"
  wait "${pid}" || rc=$?
  [[ "${rc}" -eq 3 ]]
  [[ ! -L "${LOCK_DIR}/daemon-supervisor-wiki.lock" ]]
  grep -qF "missing — exit 3 (launchd respawn)" "${TMPROOT}/boot.log"
}

# Config externalization (T21): [ports].wiki_fakechat overrides the bind port
# end-to-end (create log + tmux session env); an invalid configured port
# loud-fails before any session work.

@test "config override: [ports].wiki_fakechat honored through create + tmux env" {
  local s pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  printf '[ports]\nwiki_fakechat = 18788\n' >"${TMPROOT}/config.toml"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10
  grep -qF "(port=18788)" "${TMPROOT}/boot.log"
  grep -qF -- "-e FAKECHAT_PORT=18788" "${TMUX_CALLS}"
  kill -0 "${pid}"
}

@test "config override: invalid wiki_fakechat loud-fails before any tmux call" {
  local s
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  printf '[ports]\nwiki_fakechat = "not-a-port"\n' >"${TMPROOT}/config.toml"
  run env PATH="${STUB_BIN}:${PATH}" DAEMON_LOCK_DIR="${LOCK_DIR}" \
    ATRIUM_CONFIG_TOML="${TMPROOT}/config.toml" \
    COLD_START_WAIT_SEC=0 bash "${s}" return
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"atrium-config: invalid [ports].wiki_fakechat"* ]]
  [[ ! -f "${TMUX_CALLS}" ]]
}

# --channels REPL model injection (create path). The daemon REPL must run on the
# menu-configured daemon LLM tier (daemon-config.json haiku_model) instead of the
# settings.json default (Fable 5, whose usage cap the autoagent daemon hits). BOTH
# pane_cmd branches (auth-load + plain) MUST carry --model; the value is the
# resolved haiku_model, or the claude-haiku-4-5 fallback when the key/file/jq is
# absent. The tmux stub records $* to TMUX_CALLS, so the new-session pane_cmd is
# asserted directly. launch_bootstrap points DAEMON_CONFIG at the sandbox (hermetic).

@test "model injection (plain branch, key absent): autoagent --channels carries --model fallback" {
  local s pid
  s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
  # no daemon-config.json fixture written → jq/file absent → literal fallback
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10
  grep -qF -- "--channels plugin:fakechat@claude-plugins-official --model 'claude-haiku-4-5'" "${TMUX_CALLS}" || return 1
  # plain branch: no auth-lib source prefix (sandbox has no claude-auth-env.sh)
  ! grep -qF -- "claude-auth-env.sh'; claude_auth_load_env" "${TMUX_CALLS}" || return 1
  kill -0 "${pid}"
}

@test "model injection (plain branch, key present): --model carries the configured haiku_model" {
  local s pid
  s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
  printf '{"haiku_model":"claude-sonnet-4-5"}\n' >"${TMPROOT}/daemon-config.json"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10
  grep -qF -- "--model 'claude-sonnet-4-5'" "${TMUX_CALLS}" || return 1
  # the configured value overrides the fallback literal
  ! grep -qF -- "--model 'claude-haiku-4-5'" "${TMUX_CALLS}" || return 1
  kill -0 "${pid}"
}

@test "model injection (auth-load branch, key absent): source+auth prefix AND --model fallback" {
  local s pid
  s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
  # stage the auth lib so the auth-load pane_cmd branch is taken; GA_ROOT (set by
  # launch_bootstrap) points the secrets lookup at the sandbox, so claude_auth_load_env
  # warns + returns 0 — no real token is ever read.
  cp "${REAL_AUTH_LIB}" "${SANDBOX}/lib/claude-auth-env.sh"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10
  grep -qF -- "claude-auth-env.sh'; claude_auth_load_env; exec claude --channels plugin:fakechat@claude-plugins-official --model 'claude-haiku-4-5'" "${TMUX_CALLS}" || return 1
  kill -0 "${pid}"
}

@test "model injection (shared fix): wiki --channels also carries --model fallback" {
  local s pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10
  grep -qF -- "--model 'claude-haiku-4-5'" "${TMUX_CALLS}" || return 1
  kill -0 "${pid}"
}
