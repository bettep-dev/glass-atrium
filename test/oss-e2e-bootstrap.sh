#!/usr/bin/env bash
# Fresh-machine E2E bootstrap smoke test (roadmap T31) for Glass Atrium OSS.
# Self-contained: clones the repo into a sandbox fake-HOME, runs the FULL
# install path (config render + plist render + symlink farm + wire_hooks + DB
# bootstrap) against the THROWAWAY database claude_oss_e2e, starts the monitor
# directly (no launchd) on a non-default port via the config.toml -> .env
# chain, smoke-checks /api/health within the 30s startup window, asserts
# uninstall parity, then tears everything down (kill monitor, DROP the
# throwaway db, remove the sandbox).
#
# SAFETY CONTRACT:
#   * never touches the real ~/.claude (fake HOME), the real config.toml, or
#     the real `glass_atrium` database — the only db it creates/drops is the
#     fixed-name throwaway claude_oss_e2e, and ONLY when this run created it.
#   * aborts when claude_oss_e2e already exists (refuses to adopt/drop a db
#     this run did not create).
#   * launchd, install side: static-verified only (rendered plists) — this run
#     passes neither --load-launchd nor --repoint-launchd, so INSTALL never
#     invokes launchctl; loading plists stays a manual user step
#     (scripts/daemon-README.md "Loading the launchd Plists").
#   * launchd, uninstall side: `glass-atrium uninstall` DOES invoke `launchctl
#     bootout gui/$UID/com.glass-atrium.*` in real-home runs — and gui-domain
#     labels are per-UID, NOT per-HOME, so a fake-HOME run would still hit the
#     REAL user's live jobs. What protects the authoring machine here is the
#     engine's sandbox guard (lib/ga-core.sh is_sandbox_target → the
#     unload_launchd_jobs "launchd domain untouched" skip), asserted in STEP 5.
#
# Env knobs:
#   GA_E2E_SANDBOX  sandbox root (default: mktemp -d)
#   GA_E2E_PORT     monitor smoke-check port (default 17842, non-default)
#   GA_E2E_KEEP=1   keep the sandbox on exit (debugging; db is still dropped)
# assertion-tally harness idiom: ok/no always return 0 (printf + arithmetic),
# so `assert && ok || no` IS an exact if-then-else (SC2015) and substitutions
# inside their evidence strings are display-only (SC2312); cleanup is invoked
# via trap (SC2329).
# shellcheck disable=SC2015,SC2312,SC2329
set -uo pipefail

GA="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly GA
readonly REAL_HOME="${HOME}"
readonly E2E_DB="claude_oss_e2e"
# oss-db-setup.sh creates BOTH the main throwaway db AND its `_shadow` sibling
# (prisma migrate dev drift-detection safety net) — cleanup + the absence gate
# MUST cover both names or the shadow orphans on every run.
readonly E2E_DB_SHADOW="${E2E_DB}_shadow"
readonly E2E_PORT="${GA_E2E_PORT:-17842}"
readonly PG_SOCKET="/tmp"
readonly STARTUP_WINDOW_SECS=30

SANDBOX="${GA_E2E_SANDBOX:-}"
if [[ -z "${SANDBOX}" ]]; then
  SANDBOX="$(mktemp -d -t ga-e2e.XXXXXX)"
fi
readonly SANDBOX
readonly FAKE_HOME="${SANDBOX}/home"
readonly CLONE="${FAKE_HOME}/.glass-atrium"

PASS=0
FAIL=0
ok() {
  printf '  PASS: %s\n' "$1"
  PASS=$((PASS + 1))
}
no() {
  printf '  FAIL: %s\n' "$1"
  FAIL=$((FAIL + 1))
}
hdr() { printf '\n===== %s =====\n' "$1"; }
die() {
  printf 'ABORT: %s\n' "$*" >&2
  exit 2
}

# --- cleanup (always: kill monitor + drop throwaway db + remove sandbox) -------
MONITOR_PID=""
CREATED_DB="false"
cleanup() {
  local rc=$?
  if [[ -n "${MONITOR_PID}" ]] && kill -0 "${MONITOR_PID}" 2>/dev/null; then
    kill "${MONITOR_PID}" 2>/dev/null
    wait "${MONITOR_PID}" 2>/dev/null
    printf 'cleanup: sandbox monitor (pid %s) stopped\n' "${MONITOR_PID}" >&2
  fi
  # drop ONLY the fixed-name throwaway dbs (main + shadow), ONLY when this run
  # created them — the preflight absence gate makes any post-gate existence ours
  # by construction. Both names are dropped so the shadow never orphans.
  if [[ "${CREATED_DB}" == "true" && "${E2E_DB}" == "claude_oss_e2e" ]]; then
    local db
    for db in "${E2E_DB}" "${E2E_DB_SHADOW}"; do
      if dropdb -h "${PG_SOCKET}" --if-exists "${db}" 2>/dev/null; then
        printf 'cleanup: throwaway db %s dropped\n' "${db}" >&2
      else
        printf 'cleanup: WARNING — dropdb %s failed (drop it manually)\n' "${db}" >&2
      fi
    done
  fi
  if [[ "${GA_E2E_KEEP:-0}" != "1" && -n "${SANDBOX}" && "${SANDBOX}" != "/" && -d "${SANDBOX}" ]]; then
    rm -rf -- "${SANDBOX}"
    printf 'cleanup: sandbox removed (%s)\n' "${SANDBOX}" >&2
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# =============================================================================
hdr "STEP 0 — preflight (tools + PG reachable + throwaway-db absence gate)"
for cli in git jq psql createdb dropdb npm node curl; do
  command -v "${cli}" >/dev/null 2>&1 || die "required CLI missing: ${cli}"
done
psql -h "${PG_SOCKET}" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 \
  || die "PostgreSQL not reachable on socket ${PG_SOCKET} — E2E needs a live local cluster"
# absence gate covers BOTH names — a leftover shadow from an aborted prior run
# would otherwise be silently adopted (oss-db-setup createdb is idempotent) and
# then dropped by cleanup, violating the "never drop a db this run did not
# create" invariant.
for db in "${E2E_DB}" "${E2E_DB_SHADOW}"; do
  DB_PRE="$(psql -h "${PG_SOCKET}" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${db}'" 2>/dev/null || true)"
  [[ "${DB_PRE}" != "1" ]] \
    || die "db ${db} already exists — refusing to adopt/drop a db this run did not create"
done
ok "throwaway dbs ${E2E_DB} + ${E2E_DB_SHADOW} absent (safe to create)"
# port must be free — a stale listener would fake the health check
if lsof -nP -iTCP:"${E2E_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port ${E2E_PORT} already in use — pick another GA_E2E_PORT"
fi
ok "smoke port ${E2E_PORT} free"
# read-only safety baselines: real glass_atrium db migration count + real monitor state
REAL_MIG_BEFORE="$(psql -h "${PG_SOCKET}" -d glass_atrium -tAc \
  'SELECT count(*) FROM _prisma_migrations' 2>/dev/null || printf 'ABSENT')"
REAL_MONITOR_UP="no"
curl -sf -o /dev/null "http://127.0.0.1:16145/api/health" 2>/dev/null && REAL_MONITOR_UP="yes"
printf '  baseline: real glass_atrium migrations=%s, real monitor up=%s\n' \
  "${REAL_MIG_BEFORE}" "${REAL_MONITOR_UP}"
# real-env caches derived BEFORE any HOME override (sandbox npm/playwright reuse)
REAL_NPM_CACHE="$(npm config get cache 2>/dev/null || true)"
REAL_PW_CACHE="${REAL_HOME}/Library/Caches/ms-playwright"

# =============================================================================
hdr "STEP 1 — fresh clone into sandbox fake-HOME (+ working-tree overlay)"
mkdir -p "${FAKE_HOME}"
git clone --quiet --no-hardlinks "${GA}" "${CLONE}" \
  || die "git clone failed: ${GA} -> ${CLONE}"
ok "clone @HEAD created at ${CLONE}"
# `glass-atrium install` (STEP 2, NOT install.sh) derives GA_ROOT via `pwd -P`
# (symlinks resolved), so every farm symlink it writes targets the PHYSICAL
# clone path. On macOS mktemp returns a
# /var/folders symlink whose realpath is /private/var/folders — the `-lname`
# glob below MUST use the resolved path or it matches zero links (false FAIL).
CLONE_REAL="$(cd -- "${CLONE}" && pwd -P)"
readonly CLONE_REAL
# overlay: uncommitted tracked changes + untracked files, so the E2E exercises
# the CURRENT tree under test (commit is a separate pipeline stage)
git -C "${GA}" diff HEAD --binary >"${SANDBOX}/working-tree.patch"
if [[ -s "${SANDBOX}/working-tree.patch" ]]; then
  git -C "${CLONE}" apply --whitespace=nowarn "${SANDBOX}/working-tree.patch" \
    && ok "working-tree patch applied ($(grep -c '^diff --git' "${SANDBOX}/working-tree.patch") file diffs)" \
    || no "working-tree patch failed to apply"
else
  ok "working tree clean — no patch overlay needed"
fi
git -C "${GA}" ls-files --others --exclude-standard >"${SANDBOX}/untracked.list"
if [[ -s "${SANDBOX}/untracked.list" ]]; then
  if tar -cf - -C "${GA}" -T "${SANDBOX}/untracked.list" | tar -xf - -C "${CLONE}"; then
    ok "untracked files overlaid ($(wc -l <"${SANDBOX}/untracked.list" | tr -d ' ') files)"
  else
    no "untracked-file overlay failed"
  fi
fi

# =============================================================================
hdr "STEP 2 — install.sh full path (config + plists + farm + hooks + THROWAWAY DB)"
# NOTE: STEP 2 exercises `glass-atrium install` (the in-process engine), NOT the
# install.sh bundle bootstrap — install.sh now downloads+extracts a release
# bundle (no .git) and hands off here; this E2E seeds the tree via git clone.
# install.sh's bundle download+extract path is covered hermetically by
# scripts/test/glass-atrium-install.bats (drives the
# GA_INSTALL_SRC_BUNDLE/GA_INSTALL_SRC_MANIFEST seam: fresh install, preserve-set
# merge, idempotency, per-file SHA-256 reject, release-scope exclusion).
# fresh-machine precondition: ~/.claude exists (Claude Code creates it)
mkdir -p "${FAKE_HOME}/.claude"
declare -a SBX_ENV=(
  "HOME=${FAKE_HOME}"
  "GA_DB_NAME=${E2E_DB}"
)
# npm/playwright cache reuse — avoids a cold-cache re-download under the fake
# HOME; content-addressed caches, safe to share read/write
[[ -n "${REAL_NPM_CACHE}" ]] && SBX_ENV+=("npm_config_cache=${REAL_NPM_CACHE}")
[[ -d "${REAL_PW_CACHE}" ]] && SBX_ENV+=("PLAYWRIGHT_BROWSERS_PATH=${REAL_PW_CACHE}")
# preflight absence gate passed → any ${E2E_DB} existing beyond this point was
# created by this run (cleanup may drop it)
CREATED_DB="true"
env -u GA_TARGET_HOME -u GA_CONFIG_TOML -u GA_MANIFEST -u GA_SKIP_DB_SETUP \
  -u GA_PLIST_OUT -u GA_ROOT "${SBX_ENV[@]}" \
  bash "${CLONE}/glass-atrium" install </dev/null >"${SANDBOX}/install.log" 2>&1
INSTALL_RC=$?
if [[ "${INSTALL_RC}" -eq 0 ]]; then
  ok "glass-atrium install rc=0"
else
  no "glass-atrium install rc=${INSTALL_RC}"
  tail -25 "${SANDBOX}/install.log"
fi
grep -q '== DB bootstrap done ==' "${SANDBOX}/install.log" \
  && ok "DB bootstrap path ran to completion (oss-db-setup.sh)" \
  || no "DB bootstrap completion marker missing from install log"
DB_NOW="$(psql -h "${PG_SOCKET}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${E2E_DB}'" 2>/dev/null || true)"
[[ "${DB_NOW}" == "1" ]] \
  && ok "throwaway db ${E2E_DB} created" \
  || no "throwaway db ${E2E_DB} NOT created"
# the shadow sibling is created by the SAME oss-db-setup path — assert it exists
# so its lifecycle (create here, drop in cleanup) is exercised, not just leaked.
SHADOW_NOW="$(psql -h "${PG_SOCKET}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${E2E_DB_SHADOW}'" 2>/dev/null || true)"
[[ "${SHADOW_NOW}" == "1" ]] \
  && ok "throwaway shadow db ${E2E_DB_SHADOW} created (cleanup will drop it)" \
  || no "throwaway shadow db ${E2E_DB_SHADOW} NOT created"
MIG_COUNT="$(psql -h "${PG_SOCKET}" -d "${E2E_DB}" -tAc \
  'SELECT count(*) FROM _prisma_migrations' 2>/dev/null || printf '0')"
[[ "${MIG_COUNT}" -gt 0 ]] \
  && ok "prisma migrations applied to ${E2E_DB} (${MIG_COUNT} rows)" \
  || no "no migrations recorded in ${E2E_DB}"
# authority segment ([^/]*) — render now user-qualifies the URL (peer user)
grep -qE "^DATABASE_URL=postgresql://[^/]*/${E2E_DB}\?host=/tmp$" "${CLONE}/monitor/.env" \
  && ok "rendered monitor/.env targets the throwaway db" \
  || no "monitor/.env DATABASE_URL does not target ${E2E_DB}"
# FTS parity vs live db (authoring machine only): the baseline's raw-SQL
# appendix surface — tsvector generated columns + GIN index set — must match
if [[ "${REAL_MIG_BEFORE}" != "ABSENT" ]]; then
  FTS_Q="SELECT n.nspname||'.'||c.relname||'.'||a.attname FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE a.attgenerated='s' AND n.nspname IN ('core','monitor','wiki') ORDER BY 1"
  GIN_Q="SELECT schemaname||'.'||indexname FROM pg_indexes WHERE indexdef ILIKE '%using gin%' ORDER BY 1"
  if [[ "$(psql -h "${PG_SOCKET}" -d glass_atrium -tAc "${FTS_Q}")" == "$(psql -h "${PG_SOCKET}" -d "${E2E_DB}" -tAc "${FTS_Q}")" &&
  "$(psql -h "${PG_SOCKET}" -d glass_atrium -tAc "${GIN_Q}")" == "$(psql -h "${PG_SOCKET}" -d "${E2E_DB}" -tAc "${GIN_Q}")" ]]; then
    ok "FTS surface parity with live db (tsvector columns + GIN indexes)"
  else
    no "FTS surface differs from live db (raw-SQL appendix incomplete)"
  fi
fi
# config render: zero unexpanded ${HOME} tokens
if [[ -f "${CLONE}/config.toml" ]]; then
  # literal token grep (BRE) — not a shell expansion
  # shellcheck disable=SC2016
  UNEXP="$(grep -c '\${HOME}' "${CLONE}/config.toml" || true)"
  [[ -z "${UNEXP}" ]] && UNEXP=0
  [[ "${UNEXP}" -eq 0 ]] \
    && ok "config.toml rendered (0 unexpanded \${HOME})" \
    || no "config.toml has ${UNEXP} unexpanded \${HOME} lines"
else
  no "config.toml not rendered"
fi
# symlink farm: pristine fake home → links == the FARMED manifest subset, NOT
# the full manifest. The manifest also bundles install-internal entries (lib/,
# monitor/, hooks/, scoped/, config.toml.example, ...) consumed in place from
# ~/.glass-atrium and never symlinked into ~/.claude, so the farm is legitimately
# smaller. Derive the expectation by running every manifest rel through the
# ENGINE'S OWN filter (source the clone's ga-core.sh + is_symlink_excluded in a
# subshell) — an inline mirror of SYMLINK_EXCLUDE_* goes stale as the farm set
# evolves; the engine query cannot. The find glob uses CLONE_REAL (physical
# path) to match the pwd -P targets `glass-atrium install` writes.
FARM_EXPECT="$(
  # subshell: sourcing the engine arms readonly globals — keep them contained
  # shellcheck source=/dev/null
  source "${CLONE}/lib/ga-core.sh" || exit 1
  ga_init_env "${CLONE}" || exit 1
  expect=0
  while IFS= read -r rel; do
    [[ "$(is_symlink_excluded "${rel}")" == "no" ]] && expect=$((expect + 1))
  done < <(jq -r '.files[]' "${CLONE}/manifest.json")
  printf '%s\n' "${expect}"
)"
[[ "${FARM_EXPECT}" =~ ^[0-9]+$ && "${FARM_EXPECT}" -gt 0 ]] \
  && ok "farm expectation derived via engine is_symlink_excluded (${FARM_EXPECT} of $(jq '.files | length' "${CLONE}/manifest.json") manifest entries)" \
  || no "farm expectation derivation failed (got '${FARM_EXPECT}')"
FARM_LINKS="$(find "${FAKE_HOME}/.claude" -type l -lname "${CLONE_REAL}/*" 2>/dev/null | wc -l | tr -d ' ')"
[[ "${FARM_LINKS}" -eq "${FARM_EXPECT}" ]] \
  && ok "symlink farm complete — farmed subset (${FARM_LINKS}/${FARM_EXPECT})" \
  || no "symlink farm ${FARM_LINKS} != farmed manifest subset ${FARM_EXPECT}"

# =============================================================================
hdr "STEP 3 — T20 config chain: non-default port -> render-monitor-env -> .env"
# runbook step: the operator sets [ports].monitor in the rendered config
# portable in-place edit: BSD `sed -i ''` (2-arg) and GNU `sed -i` (1-arg) are
# mutually incompatible, so use the temp-file + mv idiom that works on both.
sed -e "s/^monitor = 16145\$/monitor = ${E2E_PORT}/" "${CLONE}/config.toml" \
  >"${CLONE}/config.toml.tmp" && mv "${CLONE}/config.toml.tmp" "${CLONE}/config.toml"
grep -q "^monitor = ${E2E_PORT}\$" "${CLONE}/config.toml" \
  && ok "[ports].monitor set to ${E2E_PORT} in sandbox config.toml" \
  || no "failed to set [ports].monitor in sandbox config.toml"
# runbook step: docs html root must exist before render-monitor-env validation
mkdir -p "${CLONE}/monitor/data/documents"
env "${SBX_ENV[@]}" GA_ROOT="${CLONE}" bash "${CLONE}/scripts/render-monitor-env.sh" \
  >"${SANDBOX}/render-env.log" 2>&1
RENDER_RC=$?
[[ "${RENDER_RC}" -eq 0 ]] \
  && ok "render-monitor-env.sh rc=0" \
  || {
    no "render-monitor-env.sh rc=${RENDER_RC}"
    tail -5 "${SANDBOX}/render-env.log"
  }
grep -q "^ATRIUM_MONITOR_PORT=${E2E_PORT}\$" "${CLONE}/monitor/.env" \
  && ok "monitor/.env carries ATRIUM_MONITOR_PORT=${E2E_PORT} (config-driven)" \
  || no "ATRIUM_MONITOR_PORT=${E2E_PORT} missing from monitor/.env"

# =============================================================================
hdr "STEP 4 — monitor build + DIRECT start (no launchd) + /api/health smoke"
(cd "${CLONE}/monitor" && env "${SBX_ENV[@]}" npm run build) \
  >"${SANDBOX}/build.log" 2>&1
BUILD_RC=$?
[[ "${BUILD_RC}" -eq 0 ]] \
  && ok "monitor build rc=0" \
  || {
    no "monitor build rc=${BUILD_RC}"
    tail -15 "${SANDBOX}/build.log"
  }
(
  cd "${CLONE}/monitor" || exit 1
  exec env "${SBX_ENV[@]}" node dist/server/main.js
) >"${SANDBOX}/monitor.log" 2>&1 &
MONITOR_PID=$!
HTTP_CODE=""
ELAPSED=0
while [[ "${ELAPSED}" -lt "${STARTUP_WINDOW_SECS}" ]]; do
  HTTP_CODE="$(curl -s -o "${SANDBOX}/health.json" -w '%{http_code}' \
    "http://127.0.0.1:${E2E_PORT}/api/health" 2>/dev/null || true)"
  [[ "${HTTP_CODE}" == "200" ]] && break
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
if [[ "${HTTP_CODE}" == "200" ]]; then
  ok "/api/health HTTP 200 within ${ELAPSED}s (window ${STARTUP_WINDOW_SECS}s, port ${E2E_PORT})"
  printf '  health body: %s\n' "$(head -c 300 "${SANDBOX}/health.json")"
else
  no "/api/health did not return 200 within ${STARTUP_WINDOW_SECS}s (last=${HTTP_CODE:-none})"
  tail -15 "${SANDBOX}/monitor.log"
fi
# non-interference: the real monitor (if it was up) must still answer
if [[ "${REAL_MONITOR_UP}" == "yes" ]]; then
  curl -sf -o /dev/null "http://127.0.0.1:16145/api/health" \
    && ok "real monitor on 16145 unaffected" \
    || no "real monitor on 16145 stopped answering during E2E"
fi
# stop the sandbox monitor before parity checks
kill "${MONITOR_PID}" 2>/dev/null
wait "${MONITOR_PID}" 2>/dev/null
MONITOR_PID=""
ok "sandbox monitor stopped"

# =============================================================================
hdr "STEP 4b — --recreate-db against the THROWAWAY db (backup→drop→recreate)"
# the throwaway db now exists WITH migrations and has no open sandbox connections
# (monitor stopped above). --recreate-db must back it up, drop it, and recreate
# it — all keyed on GA_DB_NAME so the live `glass_atrium` is NEVER a target. Backups go
# to a sandbox dir (GA_DB_BACKUP_DIR) so the real ~/.claude/backups is untouched.
RECREATE_BACKUP_DIR="${SANDBOX}/db-backups"
MIG_BEFORE_RECREATE="$(psql -h "${PG_SOCKET}" -d "${E2E_DB}" -tAc \
  'SELECT count(*) FROM _prisma_migrations' 2>/dev/null || printf '0')"
env -u GA_TARGET_HOME -u GA_CONFIG_TOML -u GA_MANIFEST -u GA_SKIP_DB_SETUP \
  -u GA_PLIST_OUT -u GA_ROOT "${SBX_ENV[@]}" \
  GA_DB_BACKUP_DIR="${RECREATE_BACKUP_DIR}" \
  bash "${CLONE}/glass-atrium" install --recreate-db --recreate-yes \
  </dev/null >"${SANDBOX}/recreate.log" 2>&1
RECREATE_RC=$?
[[ "${RECREATE_RC}" -eq 0 ]] \
  && ok "glass-atrium --recreate-db --recreate-yes rc=0" \
  || {
    no "glass-atrium --recreate-db rc=${RECREATE_RC}"
    tail -20 "${SANDBOX}/recreate.log"
  }
# a non-empty timestamped backup of the THROWAWAY db landed in the sandbox dir
RECREATE_BACKUP="$(find "${RECREATE_BACKUP_DIR}" -name "${E2E_DB}-recreate-*.dump" -size +0c 2>/dev/null | head -1)"
[[ -n "${RECREATE_BACKUP}" ]] \
  && ok "recreate backed up before drop ($(basename "${RECREATE_BACKUP}"), non-empty)" \
  || no "no non-empty recreate backup found under ${RECREATE_BACKUP_DIR}"
# the throwaway db exists again and migrations re-applied (drop+recreate happened)
DB_AFTER_RECREATE="$(psql -h "${PG_SOCKET}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${E2E_DB}'" 2>/dev/null || true)"
[[ "${DB_AFTER_RECREATE}" == "1" ]] \
  && ok "throwaway db ${E2E_DB} recreated (exists post-recreate)" \
  || no "throwaway db ${E2E_DB} missing after recreate"
MIG_AFTER_RECREATE="$(psql -h "${PG_SOCKET}" -d "${E2E_DB}" -tAc \
  'SELECT count(*) FROM _prisma_migrations' 2>/dev/null || printf '0')"
[[ "${MIG_AFTER_RECREATE}" -gt 0 && "${MIG_AFTER_RECREATE}" == "${MIG_BEFORE_RECREATE}" ]] \
  && ok "migrations re-applied to recreated db (${MIG_AFTER_RECREATE}, == pre-recreate)" \
  || no "recreated db migration count ${MIG_AFTER_RECREATE} != pre-recreate ${MIG_BEFORE_RECREATE}"
# NEGATIVE: --recreate-db on the live name 'glass_atrium' MUST be refused before any
# DB action. Run with GA_DB_NAME forced to 'glass_atrium' (overriding SBX_ENV's
# throwaway) — the recreate gate dies before delegating to the DB.
REAL_MIG_PRE_REFUSAL="$(psql -h "${PG_SOCKET}" -d glass_atrium -tAc \
  'SELECT count(*) FROM _prisma_migrations' 2>/dev/null || printf 'ABSENT')"
env -u GA_TARGET_HOME -u GA_CONFIG_TOML -u GA_MANIFEST -u GA_SKIP_DB_SETUP \
  -u GA_PLIST_OUT -u GA_ROOT "${SBX_ENV[@]}" GA_DB_NAME="glass_atrium" \
  GA_DB_BACKUP_DIR="${RECREATE_BACKUP_DIR}" \
  bash "${CLONE}/glass-atrium" install --recreate-db --recreate-yes \
  </dev/null >"${SANDBOX}/recreate-refusal.log" 2>&1
REFUSAL_RC=$?
[[ "${REFUSAL_RC}" -ne 0 ]] \
  && grep -q "live DB 'glass_atrium'" "${SANDBOX}/recreate-refusal.log" \
  && ok "--recreate-db on live 'glass_atrium' refused (rc=${REFUSAL_RC}, named guard)" \
  || {
    no "--recreate-db on live 'glass_atrium' was NOT refused (rc=${REFUSAL_RC})"
    tail -10 "${SANDBOX}/recreate-refusal.log"
  }
REAL_MIG_POST_REFUSAL="$(psql -h "${PG_SOCKET}" -d glass_atrium -tAc \
  'SELECT count(*) FROM _prisma_migrations' 2>/dev/null || printf 'ABSENT')"
[[ "${REAL_MIG_POST_REFUSAL}" == "${REAL_MIG_PRE_REFUSAL}" ]] \
  && ok "live glass_atrium db untouched by the refused recreate (${REAL_MIG_PRE_REFUSAL})" \
  || no "live glass_atrium db changed during refusal: ${REAL_MIG_PRE_REFUSAL} -> ${REAL_MIG_POST_REFUSAL}"

# =============================================================================
hdr "STEP 5 — uninstall parity (symlinks/bindings gone, throwaway db dropped)"
# --yes: the launcher requires explicit consent for the destructive headless
# uninstall (glass-atrium consent gate dies rc=1 before run_uninstall without it),
# mirroring STEP 4b's --recreate-yes precedent. Do NOT weaken that gate.
env -u GA_TARGET_HOME -u GA_CONFIG_TOML -u GA_MANIFEST "${SBX_ENV[@]}" \
  bash "${CLONE}/glass-atrium" uninstall --yes >"${SANDBOX}/uninstall.log" 2>&1
UNINST_RC=$?
[[ "${UNINST_RC}" -eq 0 ]] \
  && ok "glass-atrium uninstall rc=0" \
  || {
    no "glass-atrium uninstall rc=${UNINST_RC}"
    tail -15 "${SANDBOX}/uninstall.log"
  }
# SAFETY CONTRACT enforcement: this run's HOME is the fake sandbox, so the
# engine's sandbox guard MUST have skipped the launchd teardown — otherwise the
# uninstall just booted out the REAL user's live com.glass-atrium.* jobs
# (gui-domain labels are per-UID, not per-HOME).
grep -q 'sandbox target — launchd domain untouched' "${SANDBOX}/uninstall.log" \
  && ok "sandbox guard fired — launchd domain untouched (real jobs protected)" \
  || no "sandbox guard did NOT fire — uninstall may have hit the real gui/\$UID launchd domain"
# CLONE_REAL (physical path) so the "zero remain" check is meaningful, not a
# vacuous match against the never-targeted /var/folders prefix.
LEFT="$(find "${FAKE_HOME}/.claude" -type l -lname "${CLONE_REAL}/*" 2>/dev/null | wc -l | tr -d ' ')"
[[ "${LEFT}" -eq 0 ]] \
  && ok "zero GA symlinks remain under fake ~/.claude" \
  || no "${LEFT} GA symlinks remain after uninstall"
env -u GA_TARGET_HOME -u GA_CONFIG_TOML -u GA_MANIFEST "${SBX_ENV[@]}" \
  bash "${CLONE}/glass-atrium" uninstall --verify-clean >"${SANDBOX}/verify-clean.log" 2>&1
VC_RC=$?
[[ "${VC_RC}" -eq 0 ]] \
  && ok "uninstall --verify-clean PASS" \
  || {
    no "uninstall --verify-clean rc=${VC_RC}"
    tail -8 "${SANDBOX}/verify-clean.log"
  }
# uninstall's run_uninstall STEP2 drop_databases intentionally DROPS the throwaway
# db + its shadow (no keep-db mode; only --dry-run skips the drop). Expect the
# throwaway db GONE post-uninstall, matching the engine's designed teardown.
DB_AFTER_UNINST="$(psql -h "${PG_SOCKET}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${E2E_DB}'" 2>/dev/null || true)"
[[ "${DB_AFTER_UNINST}" != "1" ]] \
  && ok "throwaway db ${E2E_DB} dropped by uninstall as designed (drop_databases teardown)" \
  || no "throwaway db ${E2E_DB} still present after uninstall (drop_databases should have dropped it)"

# =============================================================================
hdr "STEP 6 — launchd STATIC verify (rendered plists only — launchctl never run)"
PLIST_DIR="${CLONE}/rendered/launchd"
PLIST_COUNT="$(find "${PLIST_DIR}" -name 'com.glass-atrium.*.plist' 2>/dev/null | wc -l | tr -d ' ')"
[[ "${PLIST_COUNT}" -eq 8 ]] \
  && ok "8 plists rendered by install (file-write only)" \
  || no "expected 8 rendered plists, found ${PLIST_COUNT}"
# plist validation must STILL validate on the Linux CI runner, where plutil
# (macOS-only) is absent. Preference order, first available wins:
#   1. xmllint --noout   — XML well-formedness (libxml2; present on most CI)
#   2. python3 plistlib  — full plist parse, stdlib-only (strictest portable)
#   3. plutil -lint -s   — macOS fallback when neither of the above exists
# A no-validator SKIP is the last resort (returns 0) so a missing toolchain does
# not spuriously fail the run; real validation is preferred whenever possible.
plist_validate() {
  local pf="$1"
  if command -v xmllint >/dev/null 2>&1; then
    xmllint --noout "${pf}" >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "${pf}" >/dev/null 2>&1
  elif command -v plutil >/dev/null 2>&1; then
    plutil -lint -s "${pf}" >/dev/null 2>&1
  else
    return 0
  fi
}
LINT_FAIL=0
for f in "${PLIST_DIR}"/com.glass-atrium.*.plist; do
  [[ -e "${f}" ]] || continue
  plist_validate "${f}" || LINT_FAIL=$((LINT_FAIL + 1))
done
[[ "${LINT_FAIL}" -eq 0 ]] \
  && ok "all rendered plists pass plist validation (xmllint/plistlib/plutil)" \
  || no "${LINT_FAIL} plists fail plist validation"
# leak scan: no real-GA-root or real-target-home literals in rendered plists
# (trailing slash on the .claude literal keeps ~/.claude-work from matching)
if grep -RFq -e "${GA}" -e "${REAL_HOME}/.claude/" "${PLIST_DIR}" 2>/dev/null; then
  no "rendered plists leak authoring-machine paths"
else
  ok "0 authoring-machine path hits in rendered plists (sandbox paths only)"
fi
printf '  NOTE: loading plists (launchctl bootstrap) is a MANUAL user step —\n'
printf '        see scripts/daemon-README.md "Loading the launchd Plists".\n'

# =============================================================================
hdr "STEP 7 — SAFETY GUARD: real glass_atrium db + real monitor untouched"
REAL_MIG_AFTER="$(psql -h "${PG_SOCKET}" -d glass_atrium -tAc \
  'SELECT count(*) FROM _prisma_migrations' 2>/dev/null || printf 'ABSENT')"
[[ "${REAL_MIG_AFTER}" == "${REAL_MIG_BEFORE}" ]] \
  && ok "real glass_atrium db migration count unchanged (${REAL_MIG_BEFORE})" \
  || no "real glass_atrium db migrations changed: ${REAL_MIG_BEFORE} -> ${REAL_MIG_AFTER}"
if [[ "${REAL_MONITOR_UP}" == "yes" ]]; then
  curl -sf -o /dev/null "http://127.0.0.1:16145/api/health" \
    && ok "real monitor still healthy post-run" \
    || no "real monitor unhealthy post-run"
fi

hdr "RESULT"
printf 'PASS=%s  FAIL=%s\n' "${PASS}" "${FAIL}"
[[ "${FAIL}" -eq 0 ]] && printf 'T31 E2E BOOTSTRAP GREEN\n' || printf 'T31 E2E HAS FAILURES\n'
exit "${FAIL}"
