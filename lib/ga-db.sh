# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (DB_NAME/DB_SETUP_SCRIPT/RECREATE_DB/RECREATE_YES/PG_SOCKET/GA_ROOT/DRY_RUN/LOAD_LAUNCHD/BOOTSTRAP_EXIT_HEALTH/BOOTSTRAP_HEALTH_WINDOW_SECS) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — database provisioning/recreate + drop-with-backup + monitor health gate domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# same-name conflict recreate gate (--recreate-db)
# Backs up + drops + recreates an EXISTING DB. SANDBOX-ONLY by construction:
#   * refuses on the live DB 'glass_atrium' unless GA_DB_NAME points the whole DB path at a
#     throwaway name (DB_NAME != glass_atrium). Mirrors oss-db-setup.sh's recreate_database guard
#     — defense in depth (both layers refuse).
#   * operator-approve: a TTY prompt defaulting to No, or --recreate-yes for non-interactive
#     (CI/sandbox) runs. Never default-yes (irreversible single-sink data loss — Excessive-Agency iron-law).
# The backup-before-drop + connection-drain HOW lives in oss-db-setup.sh (recreate_database),
# invoked here with GA_DB_RECREATE=1.
recreate_db_gate() {
  # SAFETY: never recreate the live single-sink 'glass_atrium' DB from the installer.
  if [[ "${DB_NAME}" == "glass_atrium" ]]; then
    die "--recreate-db refused on the live DB 'glass_atrium' — set GA_DB_NAME to a throwaway name (sandbox/CI only)"
  fi

  log "RECREATE: DB '${DB_NAME}' exists and --recreate-db was requested."
  log "RECREATE: this BACKS UP (pg_dump), DROPS, and RECREATES '${DB_NAME}' — existing data is replaced."

  # operator-approve: explicit --recreate-yes, else a TTY prompt (default No); a non-TTY without it aborts (never default-yes).
  if ! "${RECREATE_YES}"; then
    local reply=""
    if [[ -t 0 ]]; then
      printf 'Back up, drop, and recreate DB "%s"? [y/N]: ' "${DB_NAME}" >&2
      read -r reply || reply=""
    fi
    case "${reply}" in
      y | Y) log "RECREATE: operator approved (TTY)" ;;
      *) die "--recreate-db declined (no approval) — DB '${DB_NAME}' left intact" ;;
    esac
  else
    log "RECREATE: operator approved (--recreate-yes)"
  fi

  # delegate to oss-db-setup.sh with GA_DB_RECREATE=1: it backs up (parameterized
  # pg_dump of DB_NAME, NEVER live glass_atrium), drains connections, drops, then runs
  # the full createdb + .env + migrate-deploy path against the recreated DB.
  [[ -f "${DB_SETUP_SCRIPT}" ]] || die "DB setup script missing: ${DB_SETUP_SCRIPT}"
  # SEAM GUARD (fail-closed): oss-db-setup.sh hardcodes PG_SOCKET=/tmp + ignores GA_PG_SOCKET.
  # A non-/tmp seam socket would delegate against the LIVE /tmp cluster (silent probe/mutate split) → refuse.
  [[ "${PG_SOCKET}" == "/tmp" ]] || die "GA_PG_SOCKET seam active (${PG_SOCKET}) but oss-db-setup.sh is /tmp-only — set GA_SKIP_DB_SETUP=1 (or GA_DB_NAME) for DB isolation"
  log "== DB recreate: oss-db-setup.sh GA_DB_RECREATE=1 (cwd=${GA_ROOT}/monitor) =="
  # preserve the child's named exit code (5/6/7/8) — a CI/dashboard wrapper branches on them (not die's generic 1).
  local db_rc
  # set -E propagates the ERR trap into the subshell → a non-zero would fire a spurious ERROR line
  # before db_rc is captured. Suspend the trap for the bracketed call, restore it after.
  set +e
  trap - ERR
  (cd -- "${GA_ROOT}/monitor" && GA_DB_RECREATE=1 bash "${DB_SETUP_SCRIPT}")
  db_rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  if [[ "${db_rc}" -ne 0 ]]; then
    log "DB recreate failed — oss-db-setup.sh exit codes: 5=createdb 6=prisma 7=override 8=recreate-guard (rc=${db_rc})"
    # force-quit-class guard: CLI keeps the named exit code; TUI run_step RETURNS it → FAIL panel (not a force-quit).
    exit_step "${db_rc}" || return "${db_rc}"
  fi
  log "== DB recreate done =="
}

# full DB path, regardless of DB presence — safe to repeat (oss-db-setup.sh is
# idempotent: createdb skip / .env preserve / migrate deploy applies pending only).
run_db_setup() {
  [[ -f "${DB_SETUP_SCRIPT}" ]] || die "DB setup script missing: ${DB_SETUP_SCRIPT}"
  # SEAM GUARD (fail-closed): oss-db-setup.sh hardcodes PG_SOCKET=/tmp + ignores GA_PG_SOCKET.
  # A non-/tmp seam socket would delegate against the LIVE /tmp cluster (silent probe/mutate split) → refuse.
  [[ "${PG_SOCKET}" == "/tmp" ]] || die "GA_PG_SOCKET seam active (${PG_SOCKET}) but oss-db-setup.sh is /tmp-only — set GA_SKIP_DB_SETUP=1 (or GA_DB_NAME) for DB isolation"
  log "== DB bootstrap: oss-db-setup.sh (cwd=${GA_ROOT}/monitor) =="
  # cwd precondition of the script: monitor project root (prisma.config.ts)
  # preserve the child's named exit code (3/4/5/6) — a CI/dashboard wrapper branches on them.
  local db_rc
  # set -E propagates the ERR trap into the subshell → a non-zero would fire a spurious ERROR line
  # before db_rc is captured. Suspend the trap for the bracketed call, restore it after.
  set +e
  trap - ERR
  (cd -- "${GA_ROOT}/monitor" && bash "${DB_SETUP_SCRIPT}")
  db_rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  if [[ "${db_rc}" -ne 0 ]]; then
    log "DB bootstrap failed — oss-db-setup.sh exit codes: 3=cwd 4=missing-cli 5=createdb 6=prisma (rc=${db_rc})"
    # force-quit-class guard (step-8 npm-ci/createdb/prisma): CLI keeps the named exit code; TUI run_step RETURNS it → FAIL panel, never a masked quit.
    exit_step "${db_rc}" || return "${db_rc}"
  fi
  log "== DB bootstrap done =="
}

# DB bootstrap (fresh-machine gate — delegates to oss-db-setup.sh)
# glass-atrium owns the WHEN (fresh machine = 'glass_atrium' DB absent), oss-db-setup.sh owns the
# HOW. Existing-DB machines skip here so a re-run is zero-diff (never re-enters the heavy npm-ci
# path); applying PENDING migrations on an existing DB is an explicit operator action
# (`glass-atrium db-setup` runs the full path regardless of DB presence). GA_SKIP_DB_SETUP opts
# out entirely — sandbox/CI runs must never touch the machine-global PostgreSQL (mirrors the
# GA_TARGET_HOME override pattern).
setup_database() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping DB bootstrap (mutation-free staging)"
    return 0
  fi
  if [[ -n "${GA_SKIP_DB_SETUP:-}" ]]; then
    log "DB bootstrap skipped (GA_SKIP_DB_SETUP set) — run '${0##*/} db-setup' later"
    return 0
  fi
  command -v psql >/dev/null 2>&1 \
    || die_step 1 "psql not found — install PostgreSQL, or set GA_SKIP_DB_SETUP=1 and run '${0##*/} db-setup' later" \
    || return 1
  # presence probe only — a server-down/unreachable socket falls through to the full setup path (createdb loud-fails with a named code).
  local db_exists
  # SECURITY: parameterized bind — DB_NAME via psql -v + :'dbname' over STDIN, never SQL-string concat.
  # STDIN not -c: psql expands :'var' only for stdin/-f (mirrors ga_detect_postgres_role; core-security.md).
  db_exists="$(
    psql -h "${PG_SOCKET}" -d postgres -v dbname="${DB_NAME}" -tA 2>/dev/null <<'SQL' || true
SELECT 1 FROM pg_database WHERE datname=:'dbname'
SQL
  )"
  if [[ "${db_exists}" == "1" ]]; then
    # SAME-NAME CONFLICT: --recreate-db requested AND the DB exists. Default (no flag) = bare skip (idempotent re-run).
    if "${RECREATE_DB}"; then
      recreate_db_gate
      return 0
    fi
    log "DB '${DB_NAME}' present — skipping bootstrap (pending migrations: '${0##*/} db-setup')"
    return 0
  fi
  run_db_setup
}

# drop_databases — uninstall teardown: pre-drop BACKUP, then DROP, of the GA PostgreSQL databases
# (primary ${DB_NAME} + its shadow ${DB_NAME}_shadow) so a reinstall recreates a fresh, consistent
# DB while the dropped data stays RECOVERABLE. The fresh-DB intent stands (dev-agent roster +
# schema drift across installs → no auto-restore), but the drop is gated on a verified backup:
# BACKUP-BEFORE-DROP, FAIL-CLOSED per database. Each EXISTING database is pg_dump'ed (custom -F c,
# pg_restore-compatible) to ${HOME}/.claude/backups/postgres/<db>-pre-uninstall-<ts>.dump
# (pg-backup.sh's dir + timestamp convention; GA_DB_BACKUP_DIR sandbox override, mirroring
# oss-db-setup.sh). A dump that FAILS or is EMPTY (non-empty gate = oss-db-setup.sh
# backup_db_to_file precedent) SKIPS the drop for THAT database — loud log, data preserved,
# uninstall continues; applied uniformly (the shadow may dump near-empty, same gate governs).
# Pre-uninstall dumps are KEEP-FOREVER: no rotation here, and pg-backup.sh's 14-dump keep-window
# never trashes them ('pre-' sorts above every dated glass_atrium-* name in its DESCENDING
# keep-window — load-bearing ordering, do not rename without re-checking that glob). An absent
# database skips both dump and drop silently (--if-exists semantics).
# SECURITY: peer-auth Unix socket ONLY (-h ${PG_SOCKET}), never a host/port + credentials, never reads/echoes a secret.
# IDEMPOTENT (absent DB → clean no-op). GRACEFUL: a missing binary or unreachable server logs a
# warning and returns 0 — never fatal, and EVERY failure path lands on the data-PRESERVING side
# (skip the drop, keep the DB). This is a DELIBERATE, user-requested path that drops the LIVE DB,
# DISTINCT from recreate_db_gate (which refuses the live DB from the installer's --recreate-db
# path); that guard is intentionally NOT reused or weakened here.
drop_databases() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping DB backup + drop (${DB_NAME}, ${DB_NAME}_shadow)"
    return 0
  fi
  if ! command -v dropdb >/dev/null 2>&1; then
    log "uninstall: dropdb not found — skipping DB drop (advisory; reinstall recreates the DB)"
    return 0
  fi
  # BACKUP-BEFORE-DROP hard precondition: no pg_dump → nothing can be backed up → nothing dropped (fail-closed, data preserved, exit 0).
  if ! command -v pg_dump >/dev/null 2>&1; then
    log "uninstall: pg_dump not found — SKIPPING DB drop entirely (backup-before-drop is mandatory; data preserved)"
    return 0
  fi
  local backup_dir="${GA_DB_BACKUP_DIR:-${HOME}/.claude/backups/postgres}"
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  if ! mkdir -p -- "${backup_dir}"; then
    log "uninstall: cannot create backup dir ${backup_dir} — SKIPPING DB drop entirely (data preserved)"
    return 0
  fi
  local db probe dump dropped=0
  log "uninstall: backing up + dropping GA databases via peer-auth socket (${PG_SOCKET})"
  # Scope is EXACTLY the two GA databases — never a wildcard, never "drop all".
  for db in "${DB_NAME}" "${DB_NAME}_shadow"; do
    # Absent DB or a FAILED probe (server unreachable) → skip dump AND drop, data-preserving (loud warn).
    # SECURITY: parameterized bind — ${db} via psql -v + :'dbname' over STDIN, never SQL-string concat.
    # NO `|| true`: a failed psql (server unreachable) keeps its non-zero exit → fail-closed skip-drop below.
    if ! probe="$(
      psql -h "${PG_SOCKET}" -d postgres -v dbname="${db}" -tA 2>/dev/null <<'SQL'
SELECT 1 FROM pg_database WHERE datname=:'dbname'
SQL
    )"; then
      log "  warn: existence probe for '${db}' failed (server unreachable?) — drop skipped (data preserved)"
      continue
    fi
    if [[ "${probe}" != "1" ]]; then
      log "  skip: ${db} absent — nothing to back up or drop"
      continue
    fi
    # FAIL-CLOSED dump gate: dump must complete AND be non-empty, else THIS database's drop is skipped (pg_dump stderr flows through).
    dump="${backup_dir}/${db}-pre-uninstall-${ts}.dump"
    if ! pg_dump -h "${PG_SOCKET}" -d "${db}" -F c -f "${dump}" || [[ ! -s "${dump}" ]]; then
      log "  SKIP-DROP: pre-drop backup of '${db}' failed or empty (${dump}) — '${db}' NOT dropped (data preserved)"
      continue
    fi
    log "  backup: ${db} → ${dump}"
    # --if-exists: drop-race tolerance. --force (PG 13+): terminate residual connections (defensive; daemons already booted out).
    if dropdb -h "${PG_SOCKET}" --if-exists --force "${db}" >/dev/null 2>&1; then
      dropped=$((dropped + 1))
      log "  drop: ${db} dropped (backup: ${dump})"
    else
      log "  warn: dropdb '${db}' failed (server unreachable?) — skipped (advisory)"
    fi
  done
  log "uninstall: DB drop done (${dropped}/2 dropped — skipped DBs preserved)"
  return 0
}

# Start the built monitor directly, poll /api/health until 200 or the window expires, then stop
# it. Port via the shared atrium_monitor_port resolver (env → monitor/.env → config.toml
# [ports].monitor → 16145 — the single shell SoT). The monitor PID is stopped via kill (NEVER launchctl).
# force-quit-guard RESIDUAL RISK (deliberate): the four ROUTINE-failure `exit "${BOOTSTRAP_EXIT_HEALTH}"`
# paths below (build/exec-fail, db-not-open, wrong-listener, no-200-timeout) become exit_step so the
# TUI renders a FAIL panel. The remaining `die`s here (curl-absent, port-unresolvable,
# port-already-serving, lsof-absent) + recreate_db_gate/run_db_setup's script-missing dies stay
# whole-process exits: genuinely-unrecoverable environment/config PRECONDITIONS (missing stock-macOS
# tools, broken port config, an already-running monitor) whose `die` carries actionable remediation
# and are unlikely on a real install. The step-8 (db-setup) + step-13 (gate) force-quit paths are all
# covered above; this is the conscious scope boundary.
bootstrap_health_gate() {
  log "== bootstrap [3/3]: monitor health gate (/api/health, ${BOOTSTRAP_HEALTH_WINDOW_SECS}s window) =="
  command -v curl >/dev/null 2>&1 \
    || die "curl not found — required for the monitor health gate"

  # Single shell SoT (ADR-1): ATRIUM_MONITOR_PORT → rendered monitor/.env → config.toml
  # [ports].monitor → terminal default 16145. A CONFIGURED invalid value loud-fails in the resolver
  # (stderr + rc 1); surface it as a die (CLI-fallback contract: loud, never a silent wrong-port default).
  local port
  port="$(atrium_monitor_port)" \
    || die "monitor port resolution failed — check config.toml [ports].monitor / monitor/.env ATRIUM_MONITOR_PORT"

  # precondition (loud-fail): a pre-existing listener on the gate's own port (e.g. an already-loaded
  # launchd monitor) would answer curl 200 from the STALE instance, masking the freshly-built dist/ — refuse.
  if curl -s -o /dev/null --fail --connect-timeout 2 --max-time 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
    die "port ${port} already serving /api/health (launchd monitor up?) — stop it (launchctl bootout gui/${UID}/com.glass-atrium.monitor) before the bootstrap gate, else the gate validates the stale instance, not the rebuilt dist/"
  fi

  # start the built server in the background; capture its PID for a clean stop. Redirect output to
  # a trap-tracked log (not the gate's stderr) so monitor noise never interleaves — tailed only on fail.
  GATE_LOG="${TMPDIR:-/tmp}/ga-bootstrap-gate.$$.log"
  local mon_pid=""
  (cd -- "${GA_ROOT}/monitor" && exec node dist/server/main.js) >"${GATE_LOG}" 2>&1 &
  mon_pid=$!

  # F10 — early-liveness probe: a backgrounded subshell whose cd/exec fails (wrong cwd,
  # missing/non-exec dist/server/main.js) dies immediately, invisible to set -e. Short-circuit the
  # poll window and point at a build/exec problem rather than burning it on a generic "no 200".
  sleep 1
  if ! kill -0 "${mon_pid}" 2>/dev/null; then
    printf 'FATAL: monitor process exited immediately (build/cwd/exec failure) — see %s\n' "${GATE_LOG}" >&2
    tail -n 20 -- "${GATE_LOG}" >&2 || true
    exit_step "${BOOTSTRAP_EXIT_HEALTH}" || return "${BOOTSTRAP_EXIT_HEALTH}"
  fi

  # poll loop — break on the first HTTP 200 (set -e safe: curl in a condition). The response BODY is
  # captured too (not -o /dev/null): /api/health ALWAYS returns 200 (degraded → db:"closed"), so the
  # db-field gate below needs the body. `-w '\n%{http_code}'` appends the code on its own trailing
  # line (health JSON is single-line), so last line = status, rest = body. --connect-timeout/--max-time
  # bound each probe so a still-booting monitor cannot wedge the poll.
  local http_code="" body="" resp="" elapsed=0
  while [[ "${elapsed}" -lt "${BOOTSTRAP_HEALTH_WINDOW_SECS}" ]]; do
    resp="$(curl -s --connect-timeout 2 --max-time 5 -w '\n%{http_code}' \
      "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
    http_code="$(printf '%s\n' "${resp}" | tail -n1)"
    body="$(printf '%s\n' "${resp}" | sed '$d')"
    [[ "${http_code}" == "200" ]] && break
    sleep 1
    elapsed=$((elapsed + 1))
  done

  # db-field gate: an http-code-only PASS would FALSE-PASS a DB-down monitor (health is 200 even
  # when degraded). Require the body's db field to be "open" (tolerate an optional space after ':').
  local db_open="no"
  case "${body}" in
    *'"db":"open"'* | *'"db": "open"'*) db_open="yes" ;;
    *) db_open="no" ;;
  esac

  # bind the verdict to the freshly-built child: capture WHILE the port is still bound (before the
  # kill block frees it). lsof -ti tcp:<port> lists the listener PID(s); require mon_pid among them
  # so a stale launchd instance answering 200 isn't mistaken for the new build. lsof is
  # BSD/macOS-available — loud-fail if absent (Precondition Loud-Fail), not silent-skip.
  local listener_ok="no"
  if [[ "${http_code}" == "200" ]]; then
    command -v lsof >/dev/null 2>&1 \
      || die "lsof not found — cannot verify the gate's own build is the :${port} listener (install lsof or stop any stale monitor and re-run)"
    local listener_pids
    listener_pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if printf '%s\n' "${listener_pids}" | grep -Fxq -- "${mon_pid}"; then
      listener_ok="yes"
    fi
  fi

  # stop the gate's monitor instance (kill, never launchctl). TERM→KILL escalation: a
  # SIGTERM-ignoring monitor would hang the wait, so re-check kill -0 after a short grace and
  # SIGKILL if still alive. Masked: a missing/already-exited PID must not abort the verdict.
  if [[ -n "${mon_pid}" ]] && kill -0 "${mon_pid}" 2>/dev/null; then
    kill "${mon_pid}" 2>/dev/null || true
    local grace=0
    while [[ "${grace}" -lt 5 ]] && kill -0 "${mon_pid}" 2>/dev/null; do
      sleep 1
      grace=$((grace + 1))
    done
    kill -0 "${mon_pid}" 2>/dev/null && kill -KILL "${mon_pid}" 2>/dev/null || true
    wait "${mon_pid}" 2>/dev/null || true
  fi

  if [[ "${http_code}" == "200" && "${listener_ok}" == "yes" && "${db_open}" == "yes" ]]; then
    log "== bootstrap: monitor health gate PASS (/api/health 200 + db:open in ${elapsed}s, port ${port}, listener=pid ${mon_pid}) =="
    if "${LOAD_LAUNCHD}"; then
      log "== bootstrap: health gate passed — proceeding to --load-launchd (loading the 8 launchd jobs) =="
    else
      log "== bootstrap COMPLETE — load launchd jobs manually (review-first): docs/INSTALL.md §7, or re-run with --load-launchd =="
    fi
    return 0
  fi
  # 200 from OUR freshly-built listener but the DB is unavailable (db:"closed" / degraded) — a
  # DISTINCT loud-fail (not the generic no-200 tail): the monitor is up, PostgreSQL is not.
  if [[ "${http_code}" == "200" && "${listener_ok}" == "yes" && "${db_open}" != "yes" ]]; then
    printf 'FATAL: monitor health gate FAILED — /api/health 200 on port %s but db is not "open" (monitor up, DB unavailable) — start/repair PostgreSQL, then re-run\n' \
      "${port}" >&2
    log "  monitor output (last 20 lines of ${GATE_LOG}):"
    tail -n 20 -- "${GATE_LOG}" >&2 || true
    exit_step "${BOOTSTRAP_EXIT_HEALTH}" || return "${BOOTSTRAP_EXIT_HEALTH}"
  fi
  if [[ "${http_code}" == "200" && "${listener_ok}" != "yes" ]]; then
    printf 'FATAL: /api/health returned 200 on port %s but the gate child (pid %s) was NOT the listener — a stale monitor (launchd?) answered, the freshly-built dist/ is unverified\n' \
      "${port}" "${mon_pid}" >&2
    log "  monitor output (last 20 lines of ${GATE_LOG}):"
    tail -n 20 -- "${GATE_LOG}" >&2 || true
    exit_step "${BOOTSTRAP_EXIT_HEALTH}" || return "${BOOTSTRAP_EXIT_HEALTH}"
  fi
  # surface the captured monitor log on failure — the only diagnostic for WHY the
  # gate never saw a 200 (e.g. a bind error / crash in the redirected output).
  printf 'FATAL: monitor health gate FAILED — no /api/health 200 within %ss (port %s, last=%s)\n' \
    "${BOOTSTRAP_HEALTH_WINDOW_SECS}" "${port}" "${http_code:-none}" >&2
  log "  monitor output (last 20 lines of ${GATE_LOG}):"
  tail -n 20 -- "${GATE_LOG}" >&2 || true
  exit_step "${BOOTSTRAP_EXIT_HEALTH}" || return "${BOOTSTRAP_EXIT_HEALTH}"
}
