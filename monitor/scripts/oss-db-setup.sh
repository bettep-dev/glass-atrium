#!/usr/bin/env bash
# Glass Atrium monitor — OSS fresh-install DB bootstrap.
#
# The engine is symlink-farm only and does no DB work, so this script owns the
# unattended (non-interactive) clean-install path for the `glass_atrium` DB.
#
# Why `migrate deploy` not `migrate dev`: deploy is non-interactive + needs no shadow
# DB (fits unattended install). The shadow DB is created here idempotently anyway so the
# later dev path (drift-detection safety net) works without manual CREATE DATABASE.
#
# Idempotent (createdb skips existing DB · .env preserved · only pending migrations) +
# loud-fail (set -euo pipefail + named exit code + stderr message per precondition).
#
# Run from the monitor/ project root (DATABASE_URL socket assumes host=/tmp):
#   $ bash scripts/oss-db-setup.sh
set -euo pipefail

# Exit-code semantics (for wrapper-script branching + dashboard alerting):
#   3 = wrong cwd (not monitor root)      4 = required CLI missing (psql/createdb/npm)
#   5 = createdb failure (perm/socket)    6 = prisma step failure (generate/deploy)
#   7 = GA_DB_NAME override mismatch (bad name, or disagrees with existing .env)
#   8 = recreate safety-guard violation (live 'glass_atrium' target, or backup/drop fail)
#   9 = retry after P3009 baseline resolve still failed (manual intervention needed)
#  10 = post-deploy value-domain CHECK constraint verification failed (a CHECK is absent)
#  11 = post-deploy core.budget_overages table verification failed (table absent)
#  12 = post-deploy partial-index verification failed (a restored index is absent)
EXIT_BAD_CWD=3
EXIT_MISSING_CLI=4
EXIT_CREATEDB=5
EXIT_PRISMA=6
EXIT_DB_OVERRIDE=7
EXIT_RECREATE=8
EXIT_P3009=9
EXIT_CHECK_VERIFY=10
EXIT_OVERAGE_TABLE=11
EXIT_PARTIAL_IDX=12

# Squash baseline migration name — the P3009 target guard's known-name allowlist
# (only this migration's failure is resolve-eligible). MUST byte-match the actual
# prisma/migrations/ dir name, else deploy_output_is_baseline_p3009's grep -F never
# matches → the P3009 recovery silently no-ops. Never edit the applied baseline SQL:
# changing an applied migration drifts existing-DB checksums.
SQUASH_BASELINE_MIGRATION="20260611000000_init_squashed"

# GA_DB_NAME: sandbox/CI throwaway-DB override (mirrors the engine's GA_* override
# pattern) — unset keeps the default glass_atrium (additive). Every DB op (existence
# probe · createdb · .env render · migrate deploy) is scoped to this one name.
DB_NAME="${GA_DB_NAME:-glass_atrium}"
# Shadow name tracks the override, preventing drift where the created DB and .env's
# SHADOW_DATABASE_URL point at different DBs (sandbox/CI never touches the real shadow).
SHADOW_DB_NAME="${DB_NAME}_shadow"
# .env render names the user explicitly: with an empty URL user, the prisma schema
# engine (migrate deploy) connects as its built-in default user, not the OS peer user,
# and fails P1010 (.env.example's documented form also includes the user).
DB_USER="$(id -un)"
PG_SOCKET="/tmp"

log() { printf '[oss-db-setup] %s\n' "$*"; }
fail() {
  printf '[oss-db-setup] ERROR: %s\n' "$2" >&2
  exit "$1"
}

# createdb only when the DB is absent (idempotent — avoids createdb's "already exists"
# non-zero exit). The peer-auth Unix socket (-h /tmp) matches DATABASE_URL's host=/tmp.
# A down server yields an empty probe → loud-fail in the createdb path. Args: $1 = DB name.
create_db_if_absent() {
  local name="$1"
  if psql -h "${PG_SOCKET}" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${name}'" 2>/dev/null | grep -q 1; then
    log "DB '${name}' already exists → createdb skip"
  else
    log "creating DB '${name}' (createdb -h ${PG_SOCKET})"
    createdb -h "${PG_SOCKET}" "${name}" \
      || fail "${EXIT_CREATEDB}" "createdb '${name}' failed — check PostgreSQL is running + peer auth (current OS user) privileges"
  fi
}

# PG15 dropped PUBLIC's automatic CREATE on schema public, so the GA DB role (peer OS
# user) needs an explicit GRANT to create tables (a prerequisite for migrate deploy's
# CREATE TABLE). Privilege is DB-scoped → run separate psql per main/shadow. Idempotent:
# a no-op when already held (or for a superuser/owner). peer-auth /tmp socket only.
# SECURITY: DB_USER = id -un passes the charset guard (^[A-Za-z0-9._-]+$ — no quotes)
#   then is double-quoted as a SQL identifier → injection-safe (same as recreate_database).
# Args: $1 = target DB name.
grant_public_create() {
  local name="$1"
  log "GRANT CREATE ON SCHEMA public → \"${DB_USER}\" (DB '${name}', PG15+ handling)"
  psql -h "${PG_SOCKET}" -d "${name}" -v ON_ERROR_STOP=1 -q \
    -c "GRANT CREATE ON SCHEMA public TO \"${DB_USER}\"" \
    || fail "${EXIT_CREATEDB}" "GRANT CREATE ON SCHEMA public (DB '${name}', role '${DB_USER}') failed — check peer auth / privileges"
}

# Parameterized backup — dumps the argument DB (vs pg-backup.sh's hardcoded
# '-d glass_atrium') so recreate's safety invariant ("never touch live glass_atrium")
# holds. Custom format (-F c) for pg_restore compat + non-empty check; EXIT_RECREATE on
# backup failure. Args: $1 = dump DB name, $2 = output file path.
backup_db_to_file() {
  local name="$1" out="$2"
  log "pg_dump '${name}' → ${out} (custom format)"
  pg_dump -h "${PG_SOCKET}" -d "${name}" -F c -f "${out}" \
    || fail "${EXIT_RECREATE}" "pg_dump '${name}' failed — before the drop step, so data is preserved (drop not run)"
  # Empty dump must not proceed to drop — loss is irreversible, so backup completion is
  # a hard precondition of the drop.
  [[ -s "${out}" ]] \
    || fail "${EXIT_RECREATE}" "pg_dump '${name}' produced an empty file (${out}) — drop aborted (data preserved)"
}

# Count active connections (excluding self) — pre-diagnosis for a drop blocked by
# 'being accessed by other users'. Args: $1 = DB name. stdout = integer conn count.
active_conn_count() {
  local name="$1"
  psql -h "${PG_SOCKET}" -d postgres -tAc \
    "SELECT count(*) FROM pg_stat_activity WHERE datname='${name}' AND pid <> pg_backend_pid()" \
    2>/dev/null | tr -d '[:space:]'
}

# Conflict-recreate: backup → drain connections (REVOKE CONNECT + terminate, a
# reconnect-race guard) → dropdb → fall through to the caller's createdb path. Safety
# invariants (Excessive-Agency iron-law):
#   1) never live 'glass_atrium' — only runs under a GA_DB_NAME override (DB_NAME != it).
#   2) backup completes + is verified non-empty before the drop (backup_db_to_file).
# Args: $1 = recreate target DB name.
recreate_database() {
  local name="$1"
  # SAFETY: literal 'glass_atrium' (the live single-sink) is never recreatable by any
  # path — only enter under an active sandbox override (GA_DB_NAME). The engine applies
  # the same guard redundantly.
  if [[ "${name}" == "glass_atrium" ]]; then
    fail "${EXIT_RECREATE}" \
      "recreate refused — live DB 'glass_atrium' cannot be a recreate target (GA_DB_NAME sandbox override required)"
  fi
  # Absent target needs no recreate — the createdb path creates it fresh (caller falls through).
  if ! psql -h "${PG_SOCKET}" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${name}'" 2>/dev/null | grep -q 1; then
    log "recreate: DB '${name}' absent → recreate unnecessary (proceeding with fresh createdb)"
    return 0
  fi

  # step 1 — backup before drop (parameterized, never touches live glass_atrium); timestamped file.
  local backup_dir backup_file
  backup_dir="${GA_DB_BACKUP_DIR:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres}"
  mkdir -p -- "${backup_dir}"
  backup_file="${backup_dir}/${name}-recreate-$(date +%Y%m%d-%H%M%S).dump"
  backup_db_to_file "${name}" "${backup_file}"
  log "recreate: backup complete ${backup_file}"

  # step 2 — active-connection warning (drop-block pre-diagnosis). Usually 0 for a
  # sandbox DB, but real connections are drained via REVOKE + terminate (reconnect-race guard).
  local conns
  conns="$(active_conn_count "${name}")"
  [[ "${conns}" =~ ^[0-9]+$ ]] || conns=0
  if [[ "${conns}" -gt 0 ]]; then
    log "recreate: WARN — '${name}' has ${conns} active connection(s) → draining via REVOKE CONNECT + terminate"
  fi
  # Block new connections (reconnect-race guard), then terminate existing backends. Both
  # failing is safe to mask (|| true only bypasses set -e) since dropdb still loud-fails.
  psql -h "${PG_SOCKET}" -d postgres -tAc \
    "REVOKE CONNECT ON DATABASE \"${name}\" FROM PUBLIC" >/dev/null 2>&1 || true
  psql -h "${PG_SOCKET}" -d postgres -tAc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${name}' AND pid <> pg_backend_pid()" \
    >/dev/null 2>&1 || true

  # step 3 — dropdb. Loud-fails here on remaining connections ('being accessed by other
  # users') — data is preserved in backup_file since the backup ran first.
  log "recreate: dropdb '${name}' (backup preserved: ${backup_file})"
  dropdb -h "${PG_SOCKET}" "${name}" \
    || fail "${EXIT_RECREATE}" "dropdb '${name}' failed (active connections remaining?) — backup preserved: ${backup_file}"
  log "recreate: '${name}' drop complete → recreating via the createdb path"
}

# Verify the pre-squash baseline DDL was actually applied (resolve's safety precondition):
# only when init_oss_baseline's representative objects (core.outcomes table + core.TaskType
# enum) both exist do we judge "baseline effectively applied, only the _prisma_migrations
# record is failed". If either is absent it's a real (partial-apply) failure → no resolve.
# stdout = 'present' (both exist) / 'absent' (either missing) — caller compares the string
# (calling a function in a condition triggers set -e suppression SC2310 → use command-sub).
squash_baseline_objects_present() {
  local table_present type_present
  # to_regclass: NULL (empty output) when the object does not exist.
  table_present="$(psql -h "${PG_SOCKET}" -d "${DB_NAME}" -tAc \
    "SELECT to_regclass('core.outcomes')" 2>/dev/null | tr -d '[:space:]')"
  type_present="$(psql -h "${PG_SOCKET}" -d "${DB_NAME}" -tAc \
    "SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname='core' AND t.typname='TaskType'" \
    2>/dev/null | tr -d '[:space:]')"
  if [[ "${table_present}" == "core.outcomes" && "${type_present}" == "1" ]]; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

# Judge whether the last deploy output is "the squash baseline's P3009 failure" (pure
# predicate, no side effects). stdout = 'baseline_p3009' (it is) / 'other' (anything else,
# unhandled). Args: $1 = the captured last-deploy output.
deploy_output_is_baseline_p3009() {
  local deploy_output="$1"
  if grep -q 'P3009' <<<"${deploy_output}" \
    && grep -qF "${SQUASH_BASELINE_MIGRATION}" <<<"${deploy_output}"; then
    printf 'baseline_p3009\n'
  else
    printf 'other\n'
  fi
}

# precondition: cwd (loud-fail)
# Confirm the monitor root via prisma.config.ts + prisma/migrations/ both present.
[[ -f prisma.config.ts ]] && [[ -d prisma/migrations ]] \
  || fail "${EXIT_BAD_CWD}" "must run from the monitor root (prisma.config.ts + prisma/migrations/ missing) — cwd=${PWD}"

# precondition: required CLI (loud-fail)
for cli in createdb psql npm npx; do
  command -v "${cli}" >/dev/null 2>&1 \
    || fail "${EXIT_MISSING_CLI}" "missing required CLI: ${cli} (check PostgreSQL client / Node install)"
done
# recreate path also requires pg_dump (backup) + dropdb (drop).
if [[ -n "${GA_DB_RECREATE:-}" ]]; then
  for cli in pg_dump dropdb; do
    command -v "${cli}" >/dev/null 2>&1 \
      || fail "${EXIT_MISSING_CLI}" "missing required CLI for recreate: ${cli} (check PostgreSQL client install)"
  done
fi

# precondition: GA_DB_NAME override consistency (loud-fail)
# Name charset guard — non-identifier chars are dangerous across createdb args / URL / grep.
[[ "${DB_NAME}" =~ ^[a-z_][a-z0-9_]*$ ]] \
  || fail "${EXIT_DB_OVERRIDE}" "GA_DB_NAME='${DB_NAME}' invalid — only lowercase letters / digits / underscore allowed"

# User charset guard — allow only chars safe in both URL userinfo and the sed replacement.
[[ "${DB_USER}" =~ ^[A-Za-z0-9._-]+$ ]] \
  || fail "${EXIT_DB_OVERRIDE}" "OS username '${DB_USER}' invalid — only alphanumerics / dot / hyphen / underscore allowed"

# If the override is on but the preserved .env points at a different DB (e.g. the real
# glass_atrium), migrate deploy would apply there — block before any DB op begins. The
# authority segment ([^/]*) accepts both an empty value (legacy userless render) and user@localhost.
if [[ -n "${GA_DB_NAME:-}" && -f .env ]] \
  && ! grep -qE "^DATABASE_URL=postgresql://[^/]*/${DB_NAME}\?" .env; then
  fail "${EXIT_DB_OVERRIDE}" \
    "GA_DB_NAME=${DB_NAME} but the existing .env DATABASE_URL points at a different DB — fix .env or unset GA_DB_NAME"
fi

# step 0 (opt-in): conflict-recreate (GA_DB_RECREATE)
# Same-name conflict path: entered only when forcing a fresh install despite an existing
# DB. Safety invariant — DB_NAME != 'glass_atrium' (recreate_database's inner guard +
# engine guard, doubled). Shadow excluded (createdb idempotent path covers it).
if [[ -n "${GA_DB_RECREATE:-}" ]]; then
  recreate_database "${DB_NAME}"
fi

# step 1: createdb (idempotent — main + shadow)
create_db_if_absent "${DB_NAME}"
# shadow: migrate dev's drift-detection safety net — unused by deploy, but created here
# so the later dev path works immediately without a manual CREATE DATABASE.
create_db_if_absent "${SHADOW_DB_NAME}"

# step 1b: PG15+ schema public CREATE grant (idempotent · DB-scoped)
# PG15 dropped PUBLIC's CREATE on schema public → grant the GA role explicitly (per
# main/shadow; safe no-op when already held).
grant_public_create "${DB_NAME}"
grant_public_create "${SHADOW_DB_NAME}"

# step 2: .env (idempotent — preserve if present)
if [[ -f .env ]]; then
  log ".env already exists → preserving (not overwriting)"
else
  # DATABASE_URL/SHADOW: name the user + substitute the DB names to match step 1's
  # created targets (missing user → migrate deploy P1010); the ${HOME} literal is expanded
  # once here (dotenv does not expand it) — the same sed convention as the engine's render_config.
  sed -e "s|^DATABASE_URL=postgresql:///[^?]*?|DATABASE_URL=postgresql://${DB_USER}@localhost/${DB_NAME}?|" \
    -e "s|^SHADOW_DATABASE_URL=postgresql:///[^?]*?|SHADOW_DATABASE_URL=postgresql://${DB_USER}@localhost/${SHADOW_DB_NAME}?|" \
    -e "s|\${HOME}|${HOME}|g" \
    .env.example >.env
  log ".env.example → .env render complete (DB=${DB_NAME}, user=${DB_USER}) · review/edit the DATABASE_URL value before proceeding"
fi

# step 3: dependency install (clean, lockfile-pinned)
log "npm ci (lockfile-pinned install from package-lock.json)"
npm ci

# step 4: prisma generate (loud-fail)
log "prisma generate (Prisma client)"
npx prisma generate || fail "${EXIT_PRISMA}" "prisma generate failed"

# step 5: prisma migrate deploy (non-interactive · no shadow DB)
# Fresh empty DB: applies only pending migrations then exits clean (deploy_rc=0 → skips
# the P3009 branch). Pre-squash DB (failed baseline record): deploy fails P3009 → the
# narrow targeted recovery below —
#   cond 1: the failure output is the squash baseline's P3009 (other migrations/errors unhandled)
#   cond 2: the baseline DDL objects actually exist (only the record is failed; partial = real fail)
# Only when both hold: checksum-safe 'migrate resolve --applied <baseline>' + one deploy retry.
# Every other failure is loud-fail (EXIT_PRISMA) — no masking. init_oss_baseline SQL unchanged.
log "prisma migrate deploy (applying pending migrations)"
deploy_out=""
deploy_rc=0
deploy_out="$(npx prisma migrate deploy 2>&1)" || deploy_rc=$?
printf '%s\n' "${deploy_out}"
if [[ "${deploy_rc}" -ne 0 ]]; then
  # Predicate is pure — capture into a variable on its own line, then compare it (calling
  # a function inside a condition triggers SC2310/SC2312). Side effects (fail()/npx) must
  # run at top level so the exit code propagates to the parent shell (an exit inside a
  # command-sub only ends the subshell → masking risk).
  p3009_kind="$(deploy_output_is_baseline_p3009 "${deploy_out}")"
  if [[ "${p3009_kind}" != "baseline_p3009" ]]; then
    fail "${EXIT_PRISMA}" "prisma migrate deploy failed — check DATABASE_URL / DB privileges"
  fi
  log "P3009 detected — the failed migration is the squash baseline '${SQUASH_BASELINE_MIGRATION}'"
  # SAFETY: resolve only when the baseline DDL was actually applied (partial = real fail → loud-fail).
  baseline_objects="$(squash_baseline_objects_present)"
  if [[ "${baseline_objects}" != "present" ]]; then
    fail "${EXIT_P3009}" \
      "P3009 but baseline objects (core.outcomes / core.TaskType) missing — partial apply suspected, auto resolve refused (manual inspection required)"
  fi
  log "P3009: baseline objects confirmed present → 'migrate resolve --applied ${SQUASH_BASELINE_MIGRATION}' (checksum-safe, SQL unchanged)"
  npx prisma migrate resolve --applied "${SQUASH_BASELINE_MIGRATION}" \
    || fail "${EXIT_P3009}" "migrate resolve --applied ${SQUASH_BASELINE_MIGRATION} failed — manual intervention required"
  log "P3009: resolve complete → retrying migrate deploy"
  npx prisma migrate deploy \
    || fail "${EXIT_P3009}" "migrate deploy retry after resolve also failed — manual intervention required (check DB state)"
  log "P3009: resolve + deploy retry succeeded — pre-squash baseline recovered cleanly"
fi

# step 6: value-domain CHECK verification (post-deploy · pg_constraint · SELECT-only · loud-fail)
# The 5 value-domain CHECKs (attribution_source + evaluative_signal + revision_count +
# metric_type on core.outcomes, task_type on core.correction_signals) and core.budget_overages
# are now created by 20260718000001_db_hygiene_promote_ddl — migrate deploy applies them. A
# silent apply miss would let out-of-domain writes through (e.g. an unknown attribution_source
# no longer rejected), so confirm the CHECKs landed and loud-fail otherwise. Names MUST
# byte-match the migration DDL. SELECT-only, no mutation.
log "verifying 5 value-domain CHECK constraints exist (pg_constraint · SELECT-only)"
check_present="$(psql -h "${PG_SOCKET}" -d "${DB_NAME}" -tAc \
  "SELECT count(*) FROM pg_constraint WHERE contype='c' AND conname IN ('outcomes_attribution_source_check','outcomes_evaluative_signal_check','outcomes_revision_count_check','outcomes_metric_type_check','correction_signals_task_type_check')")" \
  || fail "${EXIT_CHECK_VERIFY}" "pg_constraint verification query failed (DB '${DB_NAME}') — check core.outcomes / core.correction_signals exist + peer auth privileges"
if [[ "${check_present}" != "5" ]]; then
  fail "${EXIT_CHECK_VERIFY}" "expected 5 value-domain CHECK constraints, found ${check_present} — 20260718000001_db_hygiene_promote_ddl did not fully apply"
fi

# core.budget_overages presence verification. The table + its surrogate PK are created by
# 20260718000001_db_hygiene_promote_ddl (previously an out-of-band CREATE here that lacked a
# PK). to_regclass → NULL when the object is absent. SELECT-only, no mutation.
log "verifying core.budget_overages table exists (to_regclass · SELECT-only)"
overage_present="$(psql -h "${PG_SOCKET}" -d "${DB_NAME}" -tAc \
  "SELECT to_regclass('core.budget_overages')" | tr -d '[:space:]')" \
  || fail "${EXIT_OVERAGE_TABLE}" "core.budget_overages verification query failed (DB '${DB_NAME}') — check core schema exists + peer auth privileges"
if [[ "${overage_present}" != "core.budget_overages" ]]; then
  fail "${EXIT_OVERAGE_TABLE}" "core.budget_overages absent (DB '${DB_NAME}') — 20260718000001_db_hygiene_promote_ddl did not apply"
fi

# step 7: partial-index presence verification (post-deploy · pg_indexes · SELECT-only · loud-fail)
# The 5 partial indexes restored by 20260718000000_restore_squash_lost_partial_indexes are raw-SQL
# (Prisma DSL cannot express a WHERE predicate). migrate deploy applies them, but a silent create
# miss would degrade to seq-scans (clauded-docs folder cascade + improvement style_ref/tier window)
# with NO error — so confirm all 5 landed and loud-fail otherwise (aligns with the loud-fail
# precondition principle; SELECT-only, no mutation). Names MUST byte-match the migration DDL.
log "verifying 5 restored partial indexes exist (pg_indexes · SELECT-only)"
idx_present="$(psql -h "${PG_SOCKET}" -d "${DB_NAME}" -tAc \
  "SELECT count(*) FROM pg_indexes WHERE indexname IN ('outcomes_style_ref_agent_ts_idx','outcomes_baseline_pre_3tier_idx','autoagent_proposals_confidence_idx','monitor_documents_folder_id_idx','monitor_documents_folder_created_idx')")" \
  || fail "${EXIT_PARTIAL_IDX}" "pg_indexes verification query failed (DB '${DB_NAME}') — check core/monitor schemas + peer auth privileges"
if [[ "${idx_present}" != "5" ]]; then
  fail "${EXIT_PARTIAL_IDX}" "expected 5 restored partial indexes, found ${idx_present} — 20260718000000_restore_squash_lost_partial_indexes did not fully apply"
fi

# no seed step
# The empty schema is functional on its own (0 required seeds) — stated so the installer
# does not go looking for a seed.
log "no seed needed — the empty schema is functional (no required seed)"

log "done — start via npm run dev (or build + start)"
