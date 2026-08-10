#!/usr/bin/env bash
# SC2154: SESSION/ROLE/FAKECHAT_PORT_DEFAULT/SCRIPT_DIR/WRITE_QUOTA_MARKER are
# wrapper-injected per the Wrapper contract below — a sourced lib cannot see their
# assignment, so the unassigned-reference warning is a structural false positive.
# shellcheck disable=SC2154
#
# daemon-bootstrap-common.sh — shared idempotent tmux-session bootstrap flow for
# the fakechat-channel daemons (wiki + autoagent). Sourced by the thin role
# wrappers {wiki,autoagent}-daemon-bootstrap.sh; not executable on its own.
#
# Architecture (fakechat channel):
#   The session runs `claude --channels plugin:fakechat@claude-plugins-official`
#   directly. claude's MCP host spawns the fakechat plugin as a stdio child
#   (per the plugin .mcp.json `command: bun run ... start`). That bun process
#   is BOTH (a) an MCP server over claude's stdin/stdout pipe and (b) a Bun
#   HTTP server on 127.0.0.1:$FAKECHAT_PORT — config.toml [ports].
#   {autoagent,wiki}_fakechat (defaults 8787 autoagent / 8788 wiki). A
#   POST /upload (multipart form-data: id + text) makes the plugin emit an MCP
#   `notifications/claude/channel` on its stdout → claude (the pipe owner)
#   receives it as a user message. External injects write to that HTTP endpoint.
#
#   No standalone bun pre-spawn: MCP stdio transport is a PRIVATE parent↔child
#   pipe created at spawn — a separately spawned bun cannot deliver notifications
#   to claude (it would bind the HTTP port but its MCP stream goes nowhere).
#   Per-instance port isolation comes from the step-3 `-e FAKECHAT_PORT=<port>`
#   tmux env (server.ts reads process.env), so claude spawns its own correctly-
#   piped, correctly-ported bun child. The stale-port reclaim (step 2.6) clears
#   any prior listener so that child can bind without EADDRINUSE.
#
# Wrapper contract — before sourcing this file the caller MUST define:
#   SESSION                — tmux session name (e.g. claude-wiki-daemon)
#   ROLE                   — wiki | autoagent (inject arg + log tag)
#   FAKECHAT_PORT_DEFAULT  — role's resolved fakechat port (config.toml
#                            [ports].{autoagent,wiki}_fakechat, defaults
#                            8787 autoagent / 8788 wiki)
#   SCRIPT_DIR             — wrapper's own dir (resolves daemon-inject-entry.sh)
#   WRITE_QUOTA_MARKER     — true → a downstream consumer reads the marker
#                            (autoagent: daemon-daily-restart's post-bootstrap
#                            check); false → the marker is diagnostic (wiki).
#                            The marker itself is written for BOTH roles; the
#                            flag selects the consumer wording only.
# Then call: daemon_bootstrap_main "$@"
#
# Exit-code contract (per-script, never a shared table):
#   0 — success / sanctioned no-op (adopted session, supervisor-lock yield)
#   1 — invalid mode, missing binary, unusable config (loud precondition fail)
#   2 — quota wall (return mode): inject rc=2, or a cold-start bind failure with
#       today-dated quota evidence for this role
#   3 — respawn signal (supervise mode): session missing, or the fakechat port
#       unresponsive past DAEMON_MONITOR_FAIL_THRESHOLD consecutive probes
#   4 — cold-start bind failure with NO quota evidence (return mode): the inject
#       is deferred and the caller's transient-retry budget should engage. A
#       clean 0 here would lie to daemon-daily-restart.sh, and under launchd
#       KeepAlive{SuccessfulExit=false} it suppresses the respawn entirely.

# Shared symlink pid-lock helpers (restart-window + supervisor locks). Resolved
# relative to this lib (not SCRIPT_DIR) so the wrapper contract stays unchanged.
DAEMON_BOOTSTRAP_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DAEMON_BOOTSTRAP_LIB_DIR
# shellcheck source=lib/daemon-lock.sh
source "${DAEMON_BOOTSTRAP_LIB_DIR}/daemon-lock.sh"

# fakechat port-cleanup lib — the shared, STRICTLY PORT-SCOPED fakechat_free_port
# helper reaped in the stale-port reclaim (step 2.6). Loud-fail on absence (broken
# install), matching the E5-lib contract in lib/ga-env.sh. log() is not yet defined
# at this module scope, so the loud-fail prints directly to stderr.
if [[ ! -f "${DAEMON_BOOTSTRAP_LIB_DIR}/fakechat-cleanup.sh" ]]; then
  printf 'FATAL: fakechat-cleanup lib missing: %s (broken install — scripts/lib is incomplete)\n' \
    "${DAEMON_BOOTSTRAP_LIB_DIR}/fakechat-cleanup.sh" >&2
  exit 1
fi
# shellcheck source=lib/fakechat-cleanup.sh
source "${DAEMON_BOOTSTRAP_LIB_DIR}/fakechat-cleanup.sh"

# Headless claude auth (launchd keychain-bypass): source the 0600 secrets file
# so CLAUDE_CODE_OAUTH_TOKEN is exported into THIS bootstrap shell (used by the
# bootstrap's own probes). The tmux PANE re-sources the same file at startup so
# the exec'd claude inherits the token from its OWN shell env — the value is NEVER
# passed via `tmux -e KEY=VALUE` (that is argv-visible; see step-3 SECURITY note).
# Absent file → loud WARN + keychain fallback (claude_auth_load_env never crashes).
if [[ -f "${DAEMON_BOOTSTRAP_LIB_DIR}/claude-auth-env.sh" ]]; then
  # shellcheck source=lib/claude-auth-env.sh
  source "${DAEMON_BOOTSTRAP_LIB_DIR}/claude-auth-env.sh"
  claude_auth_load_env
fi

# Channels-session model — pin the `claude --channels` REPL to the menu-configured
# daemon LLM tier instead of the settings.json default (Fable 5, whose low usage
# cap the daemon REPL otherwise hits). haiku_model is the SAME SoT the monitor
# "Daemon cycle helper" menu writes (model-config-consts.ts daemonConfigKey
# "haiku_model") and daemon_cycle.py already runs its cycle calls on — reading it
# here keeps ONE model knob for the whole daemon. Resolved via
# atrium_resolve_haiku_model (lib/atrium-config.sh, sourced by the wrapper before
# this lib). DAEMON_CONFIG override hook → canonical default when empty (test seam).
HAIKU_MODEL="$(atrium_resolve_haiku_model "${DAEMON_CONFIG:-}")"
readonly HAIKU_MODEL

# Env-overridable cold-start constants — shared default budget for BOTH roles.
# Cold-start delay: claude CLI takes ~2-3s to render the REPL after exec, but the
# channel plugin needs extra time to load the Bun runtime, init the fakechat MCP
# server, and bind the HTTP socket. Measured ~14-16s steady-state; under macOS
# load the bind can lag past ~16s, so a 30s warmup + the curl retry below absorbs
# slow cycles without meaningfully extending the restart window.
: "${COLD_START_WAIT_SEC:=30}"
readonly COLD_START_WAIT_SEC

# HTTP readiness retry — even after COLD_START_WAIT_SEC the Bun socket bind can
# lag under contended I/O. Probe GET / (chat UI HTML, 200 OK) before delegating
# to daemon-inject-entry.sh (its own probe is single-shot fatal-on-fail), so
# absorbing flaky readiness here prevents a needless inject failure path.
# Budget: 30s warmup + 6×5s + 5×5s sleep ≈ 85s before the WARN/defer path,
# bounded under launchd's 600s hook ceiling and daily-restart's 300s wait.
# 6 attempts covers a socket bind that lags past ~45s under macOS load (a shorter
# budget would miss a full cron cycle). Each knob env-overridable; defaults fixed.
: "${HTTP_READY_MAX_ATTEMPTS:=6}"
: "${HTTP_READY_INTERVAL_SEC:=5}"
: "${HTTP_READY_TIMEOUT_SEC:=5}"
readonly HTTP_READY_MAX_ATTEMPTS
readonly HTTP_READY_INTERVAL_SEC
readonly HTTP_READY_TIMEOUT_SEC

# Self-health monitor tuning (step 6). MONITOR_INTERVAL_SEC = probe cadence;
# DAEMON_MONITOR_FAIL_THRESHOLD = consecutive failed probes required before the
# loop kills the session + exits 3. The threshold prevents a single transient
# probe miss from destroying a still-binding session (the crash-loop amplifier):
# one missed probe during a slow re-bind would else trigger kill-session →
# launchd respawn → another slow bind → another miss, ad infinitum.
: "${MONITOR_INTERVAL_SEC:=60}"
: "${MONITOR_PROBE_TIMEOUT_SEC:=5}"
: "${DAEMON_MONITOR_FAIL_THRESHOLD:=3}"
readonly MONITOR_INTERVAL_SEC
readonly MONITOR_PROBE_TIMEOUT_SEC
readonly DAEMON_MONITOR_FAIL_THRESHOLD

# Restart-window honor (supervise mode): poll cadence + bounded patience while
# daemon-daily-restart holds DAEMON_RESTART_LOCK across its kill→recreate. The
# cap keeps a wedged-but-alive restart from starving supervision forever — on
# expiry the bootstrap proceeds to create, and the TOCTOU-tolerant create
# absorbs any residual race. 2700s covers the worst-case restart window (3
# bootstrap attempts × 600s backstop + backoffs + teardown polls) with headroom.
: "${RESTART_LOCK_WAIT_SEC:=2700}"
: "${RESTART_LOCK_POLL_SEC:=5}"
readonly RESTART_LOCK_WAIT_SEC
readonly RESTART_LOCK_POLL_SEC

# Quota-marker directory seam. The writer here and the consumer in
# daemon-daily-restart.sh MUST resolve the same dir — the cross-file invariant is
# documented at that consumer. /tmp is the production value; tests redirect it so
# a fixture can never make the live 05:30 restart record status='quota_exceeded'.
: "${DAEMON_QUOTA_MARKER_DIR:=/tmp}"
readonly DAEMON_QUOTA_MARKER_DIR

# Pre-recreate quota backoff (supervise only). A cold start that cannot bind
# during a Claude session-limit window would otherwise lap every ~5 min
# (30s warmup + ~55s probe budget + 3 monitor intervals + ThrottleInterval),
# i.e. ~150 respawns across a multi-hour wall. One long wait per lap replaces
# that heat without touching the plists' 30s ThrottleInterval, so a genuine
# crash still recovers at full speed.
: "${GA_DAEMON_QUOTA_BACKOFF_SEC:=1800}"
readonly GA_DAEMON_QUOTA_BACKOFF_SEC

log() {
  # ISO 8601 UTC for cross-correlation with launchd / health-check logs.
  # Separate `date` call avoids SC2312 (masked return value in $(...)).
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] [%s-daemon-bootstrap] %s\n' "${ts}" "${ROLE}" "$*"
}

# Steps 1 + 2.5: required binaries on PATH. Loud fail early if any is missing.
daemon_bootstrap_preflight() {
  local bin
  for bin in tmux claude curl bun lsof; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      log "FATAL: ${bin} not found on PATH (PATH=${PATH})"
      exit 1
    fi
  done
}

# Step 2.6: stale-port reclaim. claude's own bun MCP child binds
# 127.0.0.1:$FAKECHAT_PORT in step 3; a stale listener (orphan bun reparented to
# PID 1, manual diagnostic spawn) would make that child hit EADDRINUSE and die →
# REPL has no fakechat link. So clear the port FIRST via the shared, STRICTLY
# PORT-SCOPED fakechat_free_port (fakechat-cleanup.sh): it reaps the port owner + its
# descendant tree + the port-keyed spawn-helper debris, escalating TERM → KILL. It
# NEVER matches on the plugin:fakechat@ cmdline — that would TERM the LIVE HEALTHY
# PEER daemon, whose claude shares an IDENTICAL command line (only the tmux
# `-e FAKECHAT_PORT=` env differs). FAKECHAT_PORT_DEFAULT is this role's own resolved
# port (wrapper-injected via atrium_config_port), so the reap stays peer-safe.
daemon_bootstrap_reclaim_port() {
  fakechat_free_port "${FAKECHAT_PORT_DEFAULT}"
}

# Step 3 + 4: create the detached tmux session running claude with the fakechat
# channel plugin, then confirm. FAKECHAT_PORT is set in the tmux session env so
# the spawned claude inherits it and passes it to the bun MCP child it spawns;
# the plugin's Bun HTTP server binds 127.0.0.1:$FAKECHAT_PORT (server.ts reads
# process.env.FAKECHAT_PORT). `-e VAR=value` propagates the env var into the new
# session without polluting the launchd context. Pane leaf: [tmux] → claude → bun
# (claude's MCP stdio child holds the pipe that carries POST /upload back).
create_raced=false
daemon_bootstrap_create_session() {
  log "creating session '${SESSION}' with fakechat channel plugin (port=${FAKECHAT_PORT_DEFAULT})"
  log "channels REPL model=${HAIKU_MODEL} (daemon-config.json haiku_model, fallback claude-haiku-4-5)"
  # FAKECHAT_PORT is a NON-secret tmux set-env (server.ts reads process.env) — kept
  # on `-e`. The spawned claude inherits it and passes it to the bun MCP child.
  local tmux_env_args=("-e" "FAKECHAT_PORT=${FAKECHAT_PORT_DEFAULT}")
  # SECURITY (core-security.md Secret Management / OWASP A04): the headless OAuth
  # token MUST NOT be passed via `tmux -e KEY=VALUE` — `-e value` lands in the tmux
  # CLIENT process argv, which `ps -wwxo args` exposes to every local user (macOS
  # has no default hidepid). Instead the PANE command sources the 0600 secrets file
  # itself (claude_auth_load_env), so the exec'd claude inherits the token from its
  # OWN shell env and the value never touches any argv. Absent secrets file →
  # claude_auth_load_env warns + returns 0 (never aborts) → claude falls back to the
  # keychain (unchanged behavior). The lib path is single-quoted inside the bash -c
  # program — no token is ever interpolated; only the harness-controlled install path
  # is embedded. `bash -c` (NOT -lc): a login shell would re-source profiles and could
  # mutate PATH/env, so a plain non-login shell preserves the tmux-session env the
  # pane inherits (FAKECHAT_PORT et al.).
  local auth_lib="${DAEMON_BOOTSTRAP_LIB_DIR}/claude-auth-env.sh"
  local pane_cmd
  # --model pins the channels REPL to the resolved daemon LLM tier (HAIKU_MODEL,
  # module-level). SECURITY: single-quoted inside the `bash -c` program (same idiom
  # as source '<auth_lib>' below) so the id stays one literal token; HAIKU_MODEL is
  # read from the local monitor-validated daemon-config.json, never external input.
  # --model is additive — the OAuth-token source + fakechat channel stay intact.
  if [[ -f "${auth_lib}" ]]; then
    pane_cmd="source '${auth_lib}'; claude_auth_load_env; exec claude --channels plugin:fakechat@claude-plugins-official --model '${HAIKU_MODEL}'"
  else
    # no auth lib on disk (deploy gap) — start claude directly; it uses the keychain.
    pane_cmd="exec claude --channels plugin:fakechat@claude-plugins-official --model '${HAIKU_MODEL}'"
  fi
  if ! tmux new-session -d -s "${SESSION}" -c "${HOME}" \
    "${tmux_env_args[@]}" \
    "exec bash -c \"${pane_cmd}\""; then
    # Duplicate-session TOCTOU: a concurrent bootstrap can win the create
    # between the idempotency guard and this call — the racer's session is the
    # live one, so treat as success but flag it; main then skips the duplicate
    # inject (the winner owns it) and heads straight to its mode gate.
    if tmux has-session -t "${SESSION}" 2>/dev/null; then # GA-ABSORB[benign]: rc is the probe answer; stderr is noise
      create_raced=true
      log "WARN: session create raced a concurrent bootstrap — '${SESSION}' already exists, adopting the winner's session"
      return 0
    fi
    log "FATAL: session '${SESSION}' creation failed"
    exit 1
  fi

  if ! tmux has-session -t "${SESSION}" 2>/dev/null; then # GA-ABSORB[benign]: rc is the probe answer; stderr is noise
    log "FATAL: session '${SESSION}' creation failed"
    exit 1
  fi
  log "session '${SESSION}' created successfully"
}

# HTTP readiness probe loop (step 5 prelude). Probes GET / up to
# HTTP_READY_MAX_ATTEMPTS times; sets the module global http_ready true/false so
# the caller branches (defer path). A global, not a stdout echo, because log()
# writes to stdout — a command-substitution capture would swallow the log lines.
# -fsS = fail on HTTP >= 400 + silent + still show errors. Mirrors the
# daemon-inject-entry.sh liveness contract.
http_ready=false
daemon_bootstrap_wait_http_ready() {
  local probe_url="http://127.0.0.1:${FAKECHAT_PORT_DEFAULT}/"
  local attempt
  http_ready=false
  for ((attempt = 1; attempt <= HTTP_READY_MAX_ATTEMPTS; attempt++)); do
    # GA-ABSORB[benign]: rc is the probe answer; -fsS already reports real errors
    if curl -fsS -m "${HTTP_READY_TIMEOUT_SEC}" -o /dev/null "${probe_url}" 2>/dev/null; then
      log "fakechat HTTP server ready on attempt ${attempt}/${HTTP_READY_MAX_ATTEMPTS} (${probe_url})"
      http_ready=true
      return 0
    fi
    if ((attempt < HTTP_READY_MAX_ATTEMPTS)); then
      log "fakechat HTTP probe attempt ${attempt}/${HTTP_READY_MAX_ATTEMPTS} failed — sleeping ${HTTP_READY_INTERVAL_SEC}s before retry"
      sleep "${HTTP_READY_INTERVAL_SEC}"
    fi
  done
}

# Today-dated quota-marker path for THIS role, published as a global (a
# command-substitution capture would swallow log lines, same reason as http_ready).
# Local date (not UTC) matches the daily-restart launchd schedule and its consumer.
quota_marker_path=""
daemon_bootstrap_set_quota_marker_path() {
  local today
  today="$(date +%Y-%m-%d)"
  quota_marker_path="${DAEMON_QUOTA_MARKER_DIR}/${ROLE}-quota-marker-${today}"
}

# Both roles write the marker now: a wiki-side session-limit window suppresses the
# fakechat child exactly as an autoagent one does, and the pre-recreate backoff
# reads the marker of whichever role it runs as. WRITE_QUOTA_MARKER selects the
# wording only — autoagent's marker additionally feeds daemon-daily-restart's
# status='quota_exceeded' UPSERT (alert suppression).
daemon_bootstrap_write_quota_marker() {
  daemon_bootstrap_set_quota_marker_path
  if [[ "${WRITE_QUOTA_MARKER}" == "true" ]]; then
    log "writing quota marker ${quota_marker_path} (consumed by daemon-daily-restart)"
  else
    log "writing quota marker ${quota_marker_path} (diagnostic + backoff input)"
  fi
  : >"${quota_marker_path}" || log "WARN: failed to create quota marker ${quota_marker_path} (non-fatal)"
}

# Quota detection straight from the REPL pane. The inject-rc signal does not exist
# on the cold-start bind-failure path (the inject has not run yet), so the pane
# scrollback is the only evidence available there. Alternation mirrors
# detect_quota_in_pane in daemon-daily-restart.sh; the reset-time alternative is
# TZ-agnostic here because this lib carries no atrium_load_timezone dependency.
daemon_bootstrap_detect_pane_quota() {
  local quota_re='Limit reached|Usage ⚠ Limit|Exceeded USD budget|out of extra usage|/rate-limit-options|resets [^)]*\('
  local pane_dump
  # GA-ABSORB[handled@grep-on-empty-pane_dump]: a missing session degrades to an empty dump, reported as no-quota by the grep below
  pane_dump="$(tmux capture-pane -t "${SESSION}" -p -S -100 2>/dev/null || true)"
  grep -qE "${quota_re}" <<<"${pane_dump}"
}

# Pre-recreate quota backoff (supervise only, at most once per process). Returns 0
# when it waited — the caller MUST then re-enter the adopt / restart-lock check,
# since the 05:30 daily-restart can create a session during the wait and reclaiming
# its port would kill that fresh bun. Returns 1 when no wait applied. Return mode
# never waits: daemon-daily-restart's 600s BOOTSTRAP_TIMEOUT_SEC backstop would
# SIGTERM it into the rc-124 anomaly path.
# Set by the cold-start bind-failure fall-through; consumed once by the monitor
# loop's probe-success arm (the port bound late → run the skipped inject).
inject_deferred=false
quota_backoff_done=false
daemon_bootstrap_quota_backoff() {
  if [[ "${quota_backoff_done}" == "true" ]]; then
    return 1
  fi
  daemon_bootstrap_set_quota_marker_path
  if [[ ! -f "${quota_marker_path}" ]]; then
    return 1
  fi
  if [[ ! "${GA_DAEMON_QUOTA_BACKOFF_SEC}" =~ ^[0-9]+$ ]]; then
    log "FATAL: GA_DAEMON_QUOTA_BACKOFF_SEC must be a non-negative integer (got '${GA_DAEMON_QUOTA_BACKOFF_SEC}')"
    exit 1
  fi
  quota_backoff_done=true
  # Logged BEFORE the sleep so the wait is observable without paying it.
  log "quota marker ${quota_marker_path} present — waiting ${GA_DAEMON_QUOTA_BACKOFF_SEC}s before recreate (quota-aware backoff)"
  sleep "${GA_DAEMON_QUOTA_BACKOFF_SEC}"
  log "quota backoff elapsed — re-checking the restart window before recreate"
  return 0
}

# Step 5: invoke the entry injection and classify its rc. Captures the inject exit
# code (0=ok / 2=quota wall / other=fail) into the global inject_exit so the step-6
# mode gate forwards it as the bootstrap rc in return mode. set -e is suppressed
# inside `if`, but we want the raw code, so use a plain invocation + $?. On rc=2 the
# quota marker is written only when WRITE_QUOTA_MARKER=true (autoagent consumes it;
# wiki is decoupled, writes none, rc=2 stays diagnostic).
daemon_bootstrap_inject() {
  local inject_script="${SCRIPT_DIR}/daemon-inject-entry.sh"
  log "invoking entry injection: ${inject_script} ${ROLE}"
  set +e
  "${inject_script}" "${ROLE}"
  inject_exit=$?
  set -e
  case "${inject_exit}" in
    0)
      log "entry injection succeeded"
      ;;
    2)
      log "WARN: inject failed due to quota wall (exit 2); session is alive, /loop will retry next tick"
      daemon_bootstrap_write_quota_marker
      ;;
    *)
      log "WARN: entry injection failed (exit ${inject_exit}); session is alive, manual re-inject possible"
      ;;
  esac
}

# Bounded wait while daemon-daily-restart's kill→recreate window is open (live
# holder on DAEMON_RESTART_LOCK). Returns when the lock is free/stale, the session
# appears (caller re-checks + adopts), or the patience cap expires.
# restart_lock_outcome (free | session | expired) tells the caller WHY: a "session"
# return can be transient — the retry loop kills a half-created session before each
# retry — so the caller must re-enter rather than reclaim+create against the live
# window. The wait budget is module-global so re-entries share ONE
# RESTART_LOCK_WAIT_SEC cap (bounds the whole bootstrap — no unbounded spin).
restart_lock_outcome=""
restart_lock_waited=0
daemon_bootstrap_wait_restart_lock() {
  while :; do
    daemon_lock_read_holder "${DAEMON_RESTART_LOCK}"
    # GA-ABSORB[benign]: kill -0 rc is the liveness answer; a dead pid's stderr is noise
    if [[ -z "${daemon_lock_holder}" ]] || ! kill -0 "${daemon_lock_holder}" 2>/dev/null; then
      restart_lock_outcome="free"
      return 0
    fi
    if tmux has-session -t "${SESSION}" 2>/dev/null; then # GA-ABSORB[benign]: rc is the probe answer; stderr is noise
      restart_lock_outcome="session"
      return 0
    fi
    if ((restart_lock_waited >= RESTART_LOCK_WAIT_SEC)); then
      log "WARN: restart lock ${DAEMON_RESTART_LOCK} (pid ${daemon_lock_holder}) still held after ${restart_lock_waited}s — proceeding to create"
      restart_lock_outcome="expired"
      return 0
    fi
    if ((restart_lock_waited == 0)); then
      log "restart lock ${DAEMON_RESTART_LOCK} held by pid ${daemon_lock_holder} — waiting for the restart window to close"
    fi
    sleep "${RESTART_LOCK_POLL_SEC}"
    restart_lock_waited=$((restart_lock_waited + RESTART_LOCK_POLL_SEC))
  done
}

# Exactly-one-supervisor invariant: concurrent supervise instances (launchd vs
# manual run, or a duplicate-create race) must never run two monitor loops —
# both would kill-session on the same probe failure. The loser yields with exit
# 0 (safe: a live supervisor exists, and ITS exit-3 path keeps the launchd
# respawn chain intact). A SIGKILLed holder leaves a stale link that the next
# acquire reclaims via the dead-holder probe.
daemon_bootstrap_acquire_supervisor_lock() {
  daemon_lock_acquire "${DAEMON_SUPERVISOR_LOCK}" "$$"
  if [[ "${daemon_lock_acquired}" != "true" ]]; then
    log "supervisor lock ${DAEMON_SUPERVISOR_LOCK} held by live pid ${daemon_lock_holder} — yielding (exactly one supervisor)"
    exit 0
  fi
  trap 'daemon_lock_release "${DAEMON_SUPERVISOR_LOCK}" "$$"' EXIT
}

# Step 6: self-health monitoring (foreground loop, supervise mode).
#   Why foreground: launchd `KeepAlive { SuccessfulExit=false }` restarts the
#   whole daemon on a non-zero bootstrap exit. The restarted bootstrap's step-3
#   `claude --channels` re-spawns the fakechat bun as an MCP stdio child →
#   restores the normal pipe.
#   HTTP probe: GET / → 200 OK (same liveness contract as step 5). bun is
#   claude's MCP child, so its lifecycle is bound to the REPL — no separate bun
#   kill needed: tmux kill-session → claude exits → that bun exits with it →
#   port released → exit 3 → launchd restart → fresh piped bun.
#   Consecutive-fail threshold: a single transient probe miss during a slow
#   re-bind must NOT destroy a still-binding session. Require
#   DAEMON_MONITOR_FAIL_THRESHOLD consecutive failures; reset on any success;
#   emit a loud under-threshold WARN.
daemon_bootstrap_monitor_loop() {
  daemon_bootstrap_acquire_supervisor_lock
  local probe_url="http://127.0.0.1:${FAKECHAT_PORT_DEFAULT}/"
  local fail_count=0
  log "entering self-health monitoring loop (interval=${MONITOR_INTERVAL_SEC}s, port=${FAKECHAT_PORT_DEFAULT}, fail_threshold=${DAEMON_MONITOR_FAIL_THRESHOLD})"

  while true; do
    sleep "${MONITOR_INTERVAL_SEC}"

    # tmux session gone → exit immediately → whole daemon restarts (manual kill).
    # A missing session is unambiguous (not a transient probe miss), so the
    # consecutive-fail threshold does NOT apply here.
    if ! tmux has-session -t "${SESSION}" 2>/dev/null; then # GA-ABSORB[benign]: rc is the probe answer; stderr noise
      log "FATAL: tmux session '${SESSION}' missing — exit 3 (launchd respawn)"
      exit 3
    fi

    # fakechat HTTP probe — a dead bun releases the socket bind → curl fails.
    # GA-ABSORB[benign]: rc is the probe answer; -fsS already reports real errors
    if curl -fsS -m "${MONITOR_PROBE_TIMEOUT_SEC}" -o /dev/null "${probe_url}" 2>/dev/null; then
      fail_count=0
      # Deferred inject (cold-start bind-failure fall-through): the port bound
      # late, so run the skipped inject ONCE here. Without it the session stays
      # alive-but-uninjected — a silent no-work daemon until the 05:30 restart.
      if [[ "${inject_deferred}" == "true" ]]; then
        inject_deferred=false
        log "fakechat port ${FAKECHAT_PORT_DEFAULT} answered after the cold-start defer — running the deferred inject"
        daemon_bootstrap_inject
      fi
      continue
    fi

    fail_count=$((fail_count + 1))
    if ((fail_count < DAEMON_MONITOR_FAIL_THRESHOLD)); then
      log "WARN: monitor probe failed ${fail_count}/${DAEMON_MONITOR_FAIL_THRESHOLD} — session may still be binding, deferring kill"
      continue
    fi

    log "FATAL: fakechat port ${FAKECHAT_PORT_DEFAULT} unresponsive ${fail_count}/${DAEMON_MONITOR_FAIL_THRESHOLD} consecutive probes — kill tmux + exit 3 (launchd respawn)"
    # GA-ABSORB[handled@exit-3-next-line]: already-gone session is the goal state; exit 3 -> launchd respawn
    tmux kill-session -t "${SESSION}" 2>/dev/null || true
    exit 3
  done
}

# Main entrypoint — the wrapper calls this with "$@" so $1 carries the lifecycle
# mode. inject_exit is a module global (set by daemon_bootstrap_inject, read by
# the return-mode gate).
inject_exit=0
daemon_bootstrap_main() {
  # Lifecycle mode:
  #   supervise (DEFAULT) — long-lived process for launchd KeepAlive: run steps
  #     1-5 then enter the step-6 self-health loop and never return.
  #   return — one-shot for daemon-daily-restart.sh: run steps 1-5 then RETURN the
  #     entry-injection result as the exit code, skipping the step-6 loop so the
  #     caller can proceed to its post-bootstrap healthcheck.
  # DEFAULT MUST be supervise: the launchd plist invokes the wrapper with no arg,
  # so an unset $1 → supervise keeps the KeepAlive path byte-for-byte unchanged
  # (non-regression invariant). $1 is the only positional arg accepted.
  local bootstrap_mode="${1:-supervise}"
  case "${bootstrap_mode}" in
    supervise | return) ;;
    *)
      printf 'FATAL: invalid mode "%s" (expected: supervise|return)\n' "${bootstrap_mode}" >&2
      exit 1
      ;;
  esac

  trap 'log "ERROR: line ${LINENO}: ${BASH_COMMAND}"' ERR

  daemon_bootstrap_preflight

  # Idempotency guard, mode-split. return: an existing session means nothing to
  # recreate — keep the no-op exit for the caller's post-bootstrap flow.
  # supervise: exiting 0 here is the unsupervised-session death — launchd
  # KeepAlive{SuccessfulExit=false} never respawns after a clean exit, so the
  # pre-existing session would run unmonitored until next login. ADOPT it
  # instead: straight to the step-6 loop, no reclaim/create/inject (the live
  # session owns its port and REPL).
  if tmux has-session -t "${SESSION}" 2>/dev/null; then # GA-ABSORB[benign]: rc is the probe answer; stderr is noise
    if [[ "${bootstrap_mode}" == "return" ]]; then
      log "session '${SESSION}' already exists — no-op (return mode)"
      exit 0
    fi
    log "session '${SESSION}' already exists — adopting for supervision"
    daemon_bootstrap_monitor_loop
  fi

  # Supervise honors the restart-window lock BEFORE respawn-create: while
  # daemon-daily-restart holds it the kill→recreate is in flight, and creating
  # here would duplicate-race its return-mode bootstrap (the supervisor lands
  # here when its monitor tick exits 3 on the just-killed session). Return mode
  # never waits — its own invoker IS the lock holder. A "session" wait outcome
  # can be transient (the retry loop killed a half-created session between the
  # wait's probe and the adopt re-check): re-enter the wait instead of falling
  # through — reclaim+create here would kill the next attempt's bun listener
  # mid-warmup. "free"/"expired" outcomes break to create as before; re-entries
  # share the wait's single budget, so the loop stays bounded.
  if [[ "${bootstrap_mode}" == "supervise" ]]; then
    while :; do
      daemon_bootstrap_wait_restart_lock
      if tmux has-session -t "${SESSION}" 2>/dev/null; then # GA-ABSORB[benign]: rc is the probe answer; stderr noise
        log "session '${SESSION}' appeared during restart-window wait — adopting for supervision"
        daemon_bootstrap_monitor_loop
      fi
      if [[ "${restart_lock_outcome}" != "session" ]]; then
        # Quota-aware backoff sits AFTER the restart-lock wait and re-enters it on
        # wake: sleeping before the wait would open a 30-min TOCTOU across the
        # adopt check, and falling straight through on wake would reclaim the port
        # of a session the 05:30 daily-restart created during the sleep.
        if daemon_bootstrap_quota_backoff; then
          continue
        fi
        break
      fi
      log "session '${SESSION}' vanished while the restart lock is held — re-entering restart-window wait"
    done
  fi

  daemon_bootstrap_reclaim_port
  daemon_bootstrap_create_session

  # Duplicate-create race loser: the winner owns inject (a second inject would
  # double-submit /loop). Supervise still proceeds to the monitor loop — the
  # supervisor lock dedupes when the winner also supervises.
  if [[ "${create_raced}" == "true" ]]; then
    if [[ "${bootstrap_mode}" == "return" ]]; then
      log "return mode — duplicate-create race resolved by the winner, returning rc=0"
      exit 0
    fi
    daemon_bootstrap_monitor_loop
  fi

  # Inject entry prompt (only on fresh creation — idempotent re-runs above exit
  # 0 or adopt before reaching here). Bootstrap MUST exit 0 for launchd's
  # SuccessfulExit=false contract on the non-fatal paths.
  local inject_script="${SCRIPT_DIR}/daemon-inject-entry.sh"
  if [[ ! -x "${inject_script}" ]]; then
    log "WARN: inject script missing or not executable (${inject_script}) — skipping entry injection"
    exit 0
  fi

  log "waiting ${COLD_START_WAIT_SEC}s for claude REPL + fakechat HTTP server to initialize"
  sleep "${COLD_START_WAIT_SEC}"

  # Cold-start bind failure. The inject is still SKIPPED (calling it on a known-
  # unready port is a guaranteed FATAL — its first action re-probes that port),
  # but the failure is no longer absorbed into exit 0: under
  # KeepAlive{SuccessfulExit=false} a clean exit means "do not respawn", which
  # turned one transient session-limit window into a ~14h outage with the 05:30
  # daily-restart as the only recovery. Mode split instead —
  #   supervise: fall through to the self-health loop (session alive, inject
  #     deferred until the port answers; else the loop's 3-fail kill + exit 3
  #     yields the proven bounded launchd respawn, no new exit semantics)
  #   return: report a named non-zero rc so the daily-restart caller sees it
  daemon_bootstrap_wait_http_ready
  if [[ "${http_ready}" != "true" ]]; then
    # GA-CONVERTED: the silent exit-0 defer is now a mode split (supervise falls through, return exits 2/4)
    log "WARN: fakechat never bound within cold-start budget — inject deferred"
    # Quota evidence must come from the pane here: the inject never ran, so its
    # rc-2 signal (the only other quota source) does not exist on this path.
    if daemon_bootstrap_detect_pane_quota; then
      log "WARN: quota signature present in the '${SESSION}' pane — session-limit window, not a crash"
      daemon_bootstrap_write_quota_marker
    fi
    if [[ "${bootstrap_mode}" == "return" ]]; then
      daemon_bootstrap_set_quota_marker_path
      if [[ -f "${quota_marker_path}" ]]; then
        log "return mode — cold-start bind failure with today-dated quota evidence (${quota_marker_path}) — exit 2 (quota wall)"
        exit 2
      fi
      log "FATAL: return mode — cold-start bind failure with no quota evidence — exit 4 (deferred inject, retryable transient)"
      exit 4
    fi
    inject_deferred=true
    log "supervise mode — entering the self-health loop with the inject deferred (no exit 0: launchd would never respawn)"
    daemon_bootstrap_monitor_loop
  fi

  daemon_bootstrap_inject

  # BOOTSTRAP-2MODE-GATE-BEGIN
  # Lifecycle decision point. return mode (daemon-daily-restart one-shot): skip
  # the step-6 self-health loop and RETURN the entry-injection result so the
  # caller proceeds to its post-bootstrap healthcheck. inject_exit (0=ok / 2=
  # quota wall / other=fail) is the per-rc contract; on quota the marker file
  # (autoagent only, via WRITE_QUOTA_MARKER) stays the SoT — rc=2 is diagnostic.
  # inject_exit defaults to 0 when an early exit path skipped the inject.
  if [[ "${bootstrap_mode}" == "return" ]]; then
    log "return mode — bootstrap complete, returning rc=${inject_exit:-0} (skipping self-health loop)"
    exit "${inject_exit:-0}"
  fi

  daemon_bootstrap_monitor_loop
  # BOOTSTRAP-2MODE-GATE-END
}
