#!/usr/bin/env bats
# Cold-start bind-failure suite for lib/daemon-bootstrap-common.sh — pins the
# loud-fail conversion of the exit-0 defer (a clean exit under launchd
# KeepAlive{SuccessfulExit=false} means "do not respawn", so one quota window
# became a ~14h outage): supervise falls through into the self-health loop and
# injects late, return exits 2 on today-dated quota evidence and 4 without it,
# and a marker present at the pre-recreate point buys a bounded backoff.
# Harness mirrors daemon-bootstrap-supervise.bats (sandbox copy + PATH stubs +
# background launch), with three deltas that suite must NOT inherit: the curl
# stub fails until a bind-ok marker appears, the tmux stub answers capture-pane
# from a pane fixture, and HTTP_READY_MAX_ATTEMPTS=1 keeps every case fast.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_WIKI_BOOTSTRAP="${GA}/scripts/wiki-daemon-bootstrap.sh"
REAL_AUTOAGENT_BOOTSTRAP="${GA}/scripts/autoagent-daemon-bootstrap.sh"
REAL_BOOTSTRAP_LIB="${GA}/scripts/lib/daemon-bootstrap-common.sh"
REAL_LOCK_LIB="${GA}/scripts/lib/daemon-lock.sh"
REAL_CONFIG_LIB="${GA}/scripts/lib/atrium-config.sh"
REAL_FAKECHAT_LIB="${GA}/scripts/lib/fakechat-cleanup.sh"

setup() {
  [[ -f "${REAL_BOOTSTRAP_LIB}" ]] || skip "daemon-bootstrap-common.sh not found"
  TMPROOT="$(mktemp -d -t daemon-bindfail-bats.XXXXXX)"
  SANDBOX="${TMPROOT}/scripts"
  STUB_BIN="${TMPROOT}/bin"
  LOCK_DIR="${TMPROOT}/locks"
  QUOTA_DIR="${TMPROOT}/quota"
  SESSION_MARKER="${TMPROOT}/session-exists"
  BIND_OK="${TMPROOT}/bind-ok"
  PANE_FIXTURE="${TMPROOT}/pane-fixture"
  INJECT_CALLS="${TMPROOT}/inject-calls.log"
  BOOT_PIDS="${TMPROOT}/boot-pids"
  TODAY="$(date +%Y-%m-%d)"
  mkdir -p "${SANDBOX}" "${STUB_BIN}" "${LOCK_DIR}" "${QUOTA_DIR}"
  : >"${BOOT_PIDS}"

  cat >"${STUB_BIN}/tmux" <<STUB
#!/usr/bin/env bash
case "\$1" in
  has-session) [[ -f "${SESSION_MARKER}" ]] ;;
  new-session) : >"${SESSION_MARKER}"; exit 0 ;;
  kill-session) rm -f -- "${SESSION_MARKER}"; exit 0 ;;
  capture-pane)
    [[ -f "${PANE_FIXTURE}" ]] && cat "${PANE_FIXTURE}"
    exit 0
    ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${STUB_BIN}/tmux"

  # curl: the bind-failure seam — fails until the bind-ok marker appears, so the
  # readiness probe (and the first monitor ticks) see an unbound fakechat port.
  cat >"${STUB_BIN}/curl" <<STUB
#!/usr/bin/env bash
[[ -f "${BIND_OK}" ]] && exit 0
exit 7
STUB
  chmod +x "${STUB_BIN}/curl"

  for bin in claude bun lsof; do
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

# Copies the live wrapper + shared libs into the sandbox so SCRIPT_DIR resolves
# the stub inject sibling. Args: $1=real wrapper path → echoes the sandbox copy.
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

# Background launch; pid returned via the LAUNCHED_PID global (a
# command-substitution launch would orphan the child into a subshell).
# Args: $1=script $2=logfile $3...=mode args
launch_bootstrap() {
  local script="$1" logf="$2"
  shift 2
  PATH="${STUB_BIN}:${PATH}" \
    DAEMON_LOCK_DIR="${LOCK_DIR}" \
    ATRIUM_CONFIG_TOML="${TMPROOT}/config.toml" \
    DAEMON_CONFIG="${TMPROOT}/daemon-config.json" \
    DAEMON_QUOTA_MARKER_DIR="${QUOTA_DIR}" \
    GA_ROOT="${TMPROOT}" \
    COLD_START_WAIT_SEC=0 \
    HTTP_READY_MAX_ATTEMPTS=1 \
    HTTP_READY_INTERVAL_SEC=0 \
    MONITOR_INTERVAL_SEC=0.5 \
    RESTART_LOCK_POLL_SEC=1 \
    GA_DAEMON_QUOTA_BACKOFF_SEC="${GA_DAEMON_QUOTA_BACKOFF_SEC:-1800}" \
    bash "${script}" "$@" >"${logf}" 2>&1 &
  LAUNCHED_PID=$!
  printf '%s\n' "${LAUNCHED_PID}" >>"${BOOT_PIDS}"
}

# Synchronous return-mode run. Args: $1=script $2...=extra env assignments
run_return() {
  local script="$1"
  shift
  run env PATH="${STUB_BIN}:${PATH}" DAEMON_LOCK_DIR="${LOCK_DIR}" \
    ATRIUM_CONFIG_TOML="${TMPROOT}/config.toml" \
    DAEMON_QUOTA_MARKER_DIR="${QUOTA_DIR}" \
    COLD_START_WAIT_SEC=0 HTTP_READY_MAX_ATTEMPTS=1 HTTP_READY_INTERVAL_SEC=0 \
    "$@" bash "${script}" return
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

# AC-B1 — supervise must never answer a bind failure with a clean exit: launchd
# KeepAlive{SuccessfulExit=false} reads exit 0 as "do not respawn". The process
# stays alive in the self-health loop instead (bootstrap runs as its own bash
# process, so loop entry is asserted through the log line + liveness, the same
# way the adopt case is asserted in daemon-bootstrap-supervise.bats).

@test "supervise + cold-start bind failure: no exit 0, enters the self-health loop" {
  local s pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "never bound within cold-start budget — inject deferred" 10 || return 1
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10 || return 1
  kill -0 "${pid}" || return 1
  run ! grep -qF "recovery via the 05:30 daily-restart" "${TMPROOT}/boot.log" || return 1
  [[ ! -f "${INJECT_CALLS}" ]] || return 1
}

@test "supervise + late bind: the deferred inject runs exactly once in the loop" {
  local s pid
  s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
  launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "entering self-health monitoring loop" 10 || return 1
  [[ ! -f "${INJECT_CALLS}" ]] || return 1
  # the bun binds past the cold-start budget — the loop's probe now succeeds
  : >"${BIND_OK}"
  wait_for_log "${TMPROOT}/boot.log" "running the deferred inject" 10 || return 1
  wait_for_log "${TMPROOT}/boot.log" "entry injection succeeded" 10 || return 1
  sleep 1.5
  [[ "$(wc -l <"${INJECT_CALLS}" | tr -d ' ')" -eq 1 ]] || return 1
  kill -0 "${pid}" || return 1
}

# AC-B2/AC-B3 — return mode reports the failure to daemon-daily-restart instead
# of a lying 0: exit 4 (retryable transient, engages the caller's 3-attempt
# budget) without quota evidence, exit 2 (quota wall, excluded from retries) with
# a today-dated marker. Return mode never sleeps — the caller's 600s
# BOOTSTRAP_TIMEOUT_SEC backstop would SIGTERM it into the rc-124 anomaly path.

@test "return + bind failure, no quota evidence: exit 4, named in the log" {
  local s
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  run_return "${s}"
  [[ "${status}" -eq 4 ]] || return 1
  [[ "${output}" == *"exit 4 (deferred inject, retryable transient)"* ]] || return 1
  [[ ! -f "${INJECT_CALLS}" ]] || return 1
}

@test "return + bind failure with today-dated quota marker: exit 2, no backoff wait" {
  local s
  s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
  : >"${QUOTA_DIR}/autoagent-quota-marker-${TODAY}"
  # a 600s backoff would blow the 600s caller backstop if return mode ever waited
  run_return "${s}" GA_DAEMON_QUOTA_BACKOFF_SEC=600
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"exit 2 (quota wall)"* ]] || return 1
  [[ "${output}" != *"quota-aware backoff"* ]] || return 1
}

# AC-B4 — the bind-failure path predates the inject, so its only quota evidence
# is the REPL pane; both roles write the marker on detection.

@test "bind failure with a quota pane: marker written for BOTH roles, rc 2" {
  local role s
  printf 'Limit reached · resets 3pm (Asia/Seoul)\n' >"${PANE_FIXTURE}"
  for role in wiki autoagent; do
    rm -f -- "${SESSION_MARKER}"
    if [[ "${role}" == "wiki" ]]; then
      s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
    else
      s="$(sandbox_copy "${REAL_AUTOAGENT_BOOTSTRAP}")"
    fi
    run_return "${s}"
    [[ "${status}" -eq 2 ]] || return 1
    [[ "${output}" == *"quota signature present"* ]] || return 1
    [[ -f "${QUOTA_DIR}/${role}-quota-marker-${TODAY}" ]] || return 1
  done
}

# AC-B5 — with a marker at the pre-recreate point the supervise lap waits before
# recreating (the wait line is logged BEFORE sleeping, so it is observable
# without paying it), then re-enters the restart-window check rather than
# reclaiming the port of a session the 05:30 restart may have created meanwhile.

@test "supervise + quota marker: logs and takes the backoff before recreate" {
  local s pid
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  : >"${QUOTA_DIR}/wiki-quota-marker-${TODAY}"
  GA_DAEMON_QUOTA_BACKOFF_SEC=1 launch_bootstrap "${s}" "${TMPROOT}/boot.log"
  pid="${LAUNCHED_PID}"
  wait_for_log "${TMPROOT}/boot.log" "waiting 1s before recreate (quota-aware backoff)" 10 || return 1
  wait_for_log "${TMPROOT}/boot.log" "quota backoff elapsed — re-checking the restart window" 10 || return 1
  wait_for_log "${TMPROOT}/boot.log" "created successfully" 10 || return 1
  # one wait per process — the recreate lap is not re-delayed
  [[ "$(grep -cF 'quota-aware backoff' "${TMPROOT}/boot.log")" -eq 1 ]] || return 1
  kill -0 "${pid}" || return 1
}

@test "supervise + quota marker + non-integer backoff: loud fail before recreate" {
  local s
  : >"${QUOTA_DIR}/wiki-quota-marker-${TODAY}"
  s="$(sandbox_copy "${REAL_WIKI_BOOTSTRAP}")"
  run env PATH="${STUB_BIN}:${PATH}" DAEMON_LOCK_DIR="${LOCK_DIR}" \
    ATRIUM_CONFIG_TOML="${TMPROOT}/config.toml" \
    DAEMON_QUOTA_MARKER_DIR="${QUOTA_DIR}" \
    COLD_START_WAIT_SEC=0 HTTP_READY_MAX_ATTEMPTS=1 HTTP_READY_INTERVAL_SEC=0 \
    GA_DAEMON_QUOTA_BACKOFF_SEC="half an hour" bash "${s}" supervise
  [[ "${status}" -eq 1 ]] || return 1
  [[ "${output}" == *"GA_DAEMON_QUOTA_BACKOFF_SEC must be a non-negative integer"* ]] || return 1
  [[ ! -f "${SESSION_MARKER}" ]] || return 1
}
