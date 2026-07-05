#!/usr/bin/env bash
# Glass Atrium monitor — OSS fresh-install DB bootstrap.
#
# The engine is symlink-farm only and does no DB work, so this script owns the
# unattended (non-interactive) clean-install path for the `glass_atrium` DB.
#
# Why `migrate deploy` not `migrate dev`: deploy is non-interactive and needs no
# shadow DB (fits unattended install); dev requires interactive prompts. The shadow
# DB is unneeded by deploy but created here idempotently so the later dev path
# (migrate dev's drift-detection safety net) works without manual CREATE DATABASE.
#
# Idempotent: createdb skips an existing main/shadow DB · existing .env is preserved
# · deploy applies only pending migrations. Loud-fail: set -euo pipefail + a named
# exit code + stderr message per precondition.
#
# Run from the monitor/ project root (DATABASE_URL's socket path assumes host=/tmp):
#   $ bash scripts/oss-db-setup.sh
set -euo pipefail

# Exit-code semantics (for wrapper-script branching + dashboard alerting):
#   3 = wrong cwd (not monitor root)      4 = required CLI missing (psql/createdb/npm)
#   5 = createdb failure (perm/socket)    6 = prisma step failure (generate/deploy)
#   7 = GA_DB_NAME override mismatch (bad name, or disagrees with existing .env)
#   8 = recreate safety-guard violation (live 'glass_atrium' target, or backup/drop fail)
#   9 = retry after P3009 baseline resolve still failed (manual intervention needed)
#  10 = post-deploy attribution_source CHECK constraint apply failed
EXIT_BAD_CWD=3
EXIT_MISSING_CLI=4
EXIT_CREATEDB=5
EXIT_PRISMA=6
EXIT_DB_OVERRIDE=7
EXIT_RECREATE=8
EXIT_P3009=9
EXIT_POSTSQL=10

# Squash baseline migration name — the P3009 target guard's known-name allowlist
# (only this migration's failure is resolve-eligible). Never edit the applied
# init_oss_baseline SQL: changing an applied migration drifts existing-DB checksums.
SQUASH_BASELINE_MIGRATION="20260611000000_init_oss_baseline"

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
    log "DB '${name}' 이미 존재 → createdb skip"
  else
    log "DB '${name}' 생성 (createdb -h ${PG_SOCKET})"
    createdb -h "${PG_SOCKET}" "${name}" \
      || fail "${EXIT_CREATEDB}" "createdb '${name}' 실패 — PostgreSQL 가동 + peer auth (현재 OS 유저) 권한 확인"
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
  log "GRANT CREATE ON SCHEMA public → \"${DB_USER}\" (DB '${name}', PG15+ 대응)"
  psql -h "${PG_SOCKET}" -d "${name}" -v ON_ERROR_STOP=1 -q \
    -c "GRANT CREATE ON SCHEMA public TO \"${DB_USER}\"" \
    || fail "${EXIT_CREATEDB}" "GRANT CREATE ON SCHEMA public (DB '${name}', role '${DB_USER}') 실패 — peer auth/권한 확인"
}

# Parameterized backup — dumps the argument DB (vs pg-backup.sh's hardcoded
# '-d glass_atrium') so recreate's safety invariant ("never touch live glass_atrium")
# holds. Custom format (-F c) for pg_restore compat + non-empty check; EXIT_RECREATE on
# backup failure. Args: $1 = dump DB name, $2 = output file path.
backup_db_to_file() {
  local name="$1" out="$2"
  log "pg_dump '${name}' → ${out} (custom format)"
  pg_dump -h "${PG_SOCKET}" -d "${name}" -F c -f "${out}" \
    || fail "${EXIT_RECREATE}" "pg_dump '${name}' 실패 — drop 이전 단계라 데이터 보존됨 (드롭 미실행)"
  # Empty dump must not proceed to drop — loss is irreversible, so backup completion is
  # a hard precondition of the drop.
  [[ -s "${out}" ]] \
    || fail "${EXIT_RECREATE}" "pg_dump '${name}' 가 빈 파일 생성 (${out}) — 드롭 중단 (데이터 보존됨)"
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
      "recreate 거부 — live DB 'glass_atrium' 는 재생성 대상이 될 수 없음 (GA_DB_NAME sandbox override 필요)"
  fi
  # Absent target needs no recreate — the createdb path creates it fresh (caller falls through).
  if ! psql -h "${PG_SOCKET}" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${name}'" 2>/dev/null | grep -q 1; then
    log "recreate: DB '${name}' 부재 → 재생성 불필요 (fresh createdb 진행)"
    return 0
  fi

  # step 1 — backup before drop (parameterized, never touches live glass_atrium); timestamped file.
  local backup_dir backup_file
  backup_dir="${GA_DB_BACKUP_DIR:-${HOME}/.claude/backups/postgres}"
  mkdir -p -- "${backup_dir}"
  backup_file="${backup_dir}/${name}-recreate-$(date +%Y%m%d-%H%M%S).dump"
  backup_db_to_file "${name}" "${backup_file}"
  log "recreate: 백업 완료 ${backup_file}"

  # step 2 — active-connection warning (drop-block pre-diagnosis). Usually 0 for a
  # sandbox DB, but real connections are drained via REVOKE + terminate (reconnect-race guard).
  local conns
  conns="$(active_conn_count "${name}")"
  [[ "${conns}" =~ ^[0-9]+$ ]] || conns=0
  if [[ "${conns}" -gt 0 ]]; then
    log "recreate: WARN — '${name}' 에 활성 연결 ${conns}건 → REVOKE CONNECT + terminate 로 드레인"
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
  log "recreate: dropdb '${name}' (백업 보존: ${backup_file})"
  dropdb -h "${PG_SOCKET}" "${name}" \
    || fail "${EXIT_RECREATE}" "dropdb '${name}' 실패 (활성 연결 잔존?) — 백업 보존됨: ${backup_file}"
  log "recreate: '${name}' 드롭 완료 → createdb 경로로 재생성 진행"
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

# --- precondition: cwd (loud-fail) ---------------------------------------------
# Confirm the monitor root via prisma.config.ts + prisma/migrations/ both present.
[[ -f prisma.config.ts ]] && [[ -d prisma/migrations ]] \
  || fail "${EXIT_BAD_CWD}" "monitor 루트에서 실행 필요 (prisma.config.ts + prisma/migrations/ 부재) — cwd=${PWD}"

# --- precondition: required CLI (loud-fail) ------------------------------------
for cli in createdb psql npm npx; do
  command -v "${cli}" >/dev/null 2>&1 \
    || fail "${EXIT_MISSING_CLI}" "필수 CLI 부재: ${cli} (PostgreSQL client / Node 설치 확인)"
done
# recreate path also requires pg_dump (backup) + dropdb (drop).
if [[ -n "${GA_DB_RECREATE:-}" ]]; then
  for cli in pg_dump dropdb; do
    command -v "${cli}" >/dev/null 2>&1 \
      || fail "${EXIT_MISSING_CLI}" "recreate 필수 CLI 부재: ${cli} (PostgreSQL client 설치 확인)"
  done
fi

# --- precondition: GA_DB_NAME override consistency (loud-fail) ------------------
# Name charset guard — non-identifier chars are dangerous across createdb args / URL / grep.
[[ "${DB_NAME}" =~ ^[a-z_][a-z0-9_]*$ ]] \
  || fail "${EXIT_DB_OVERRIDE}" "GA_DB_NAME='${DB_NAME}' 부적합 — 소문자/숫자/언더스코어만 허용"

# User charset guard — allow only chars safe in both URL userinfo and the sed replacement.
[[ "${DB_USER}" =~ ^[A-Za-z0-9._-]+$ ]] \
  || fail "${EXIT_DB_OVERRIDE}" "OS 사용자명 '${DB_USER}' 부적합 — 영숫자/점/하이픈/언더스코어만 허용"

# If the override is on but the preserved .env points at a different DB (e.g. the real
# glass_atrium), migrate deploy would apply there — block before any DB op begins. The
# authority segment ([^/]*) accepts both an empty value (legacy userless render) and user@localhost.
if [[ -n "${GA_DB_NAME:-}" && -f .env ]] \
  && ! grep -qE "^DATABASE_URL=postgresql://[^/]*/${DB_NAME}\?" .env; then
  fail "${EXIT_DB_OVERRIDE}" \
    "GA_DB_NAME=${DB_NAME} 인데 기존 .env DATABASE_URL 이 다른 DB 를 가리킴 — .env 수정 또는 GA_DB_NAME 해제 필요"
fi

# --- step 0 (opt-in): conflict-recreate (GA_DB_RECREATE) -----------------------
# Same-name conflict path: entered only when forcing a fresh install despite an existing
# DB. Safety invariant — DB_NAME != 'glass_atrium' (recreate_database's inner guard +
# engine guard, doubled). backup (parameterized) → drain → dropdb, then the createdb
# below recreates. Shadow is excluded (not a schema-bearing DB; the createdb idempotent
# path covers it).
if [[ -n "${GA_DB_RECREATE:-}" ]]; then
  recreate_database "${DB_NAME}"
fi

# --- step 1: createdb (idempotent — main + shadow) ------------------------------
create_db_if_absent "${DB_NAME}"
# shadow: migrate dev's drift-detection safety net — unused by deploy, but created here
# so the later dev path works immediately without a manual CREATE DATABASE.
create_db_if_absent "${SHADOW_DB_NAME}"

# --- step 1b: PG15+ schema public CREATE grant (idempotent · DB-scoped) ---------
# PG15 dropped PUBLIC's automatic CREATE on schema public → grant the GA role explicitly.
# Per main/shadow (privilege is DB-scoped) · a safe no-op for a superuser/owner.
grant_public_create "${DB_NAME}"
grant_public_create "${SHADOW_DB_NAME}"

# --- step 2: .env (idempotent — preserve if present) ---------------------------
if [[ -f .env ]]; then
  log ".env 이미 존재 → 보존 (덮어쓰지 않음)"
else
  # DATABASE_URL/SHADOW: name the user + substitute the DB names to match step 1's
  # created targets (missing user → migrate deploy P1010); the ${HOME} literal is expanded
  # once here (dotenv does not expand it) — the same sed convention as the engine's render_config.
  sed -e "s|^DATABASE_URL=postgresql:///[^?]*?|DATABASE_URL=postgresql://${DB_USER}@localhost/${DB_NAME}?|" \
    -e "s|^SHADOW_DATABASE_URL=postgresql:///[^?]*?|SHADOW_DATABASE_URL=postgresql://${DB_USER}@localhost/${SHADOW_DB_NAME}?|" \
    -e "s|\${HOME}|${HOME}|g" \
    .env.example >.env
  log ".env.example → .env 렌더 완료 (DB=${DB_NAME}, user=${DB_USER}) · DATABASE_URL 값 확인/수정 후 진행 권장"
fi

# --- step 3: dependency install (clean, lockfile-pinned) -----------------------
log "npm ci (package-lock.json 고정 설치)"
npm ci

# --- step 4: prisma generate (loud-fail) ---------------------------------------
log "prisma generate (Prisma client)"
npx prisma generate || fail "${EXIT_PRISMA}" "prisma generate 실패"

# --- step 5: prisma migrate deploy (non-interactive · no shadow DB) -------------
# Fresh empty DB: applies only pending migrations then exits clean (deploy_rc=0 → skips
# the P3009 branch). Pre-squash DB (failed baseline record): deploy fails P3009 → the
# narrow targeted recovery below —
#   cond 1: the failure output is the squash baseline's P3009 (other migrations/errors unhandled)
#   cond 2: the baseline DDL objects actually exist (only the record is failed; partial = real fail)
# Only when both hold: checksum-safe 'migrate resolve --applied <baseline>' + one deploy retry.
# Every other failure is loud-fail (EXIT_PRISMA) — no masking. init_oss_baseline SQL unchanged.
log "prisma migrate deploy (미적용 migration 적용)"
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
    fail "${EXIT_PRISMA}" "prisma migrate deploy 실패 — DATABASE_URL / DB 권한 확인"
  fi
  log "P3009 감지 — 실패 마이그레이션이 squash baseline '${SQUASH_BASELINE_MIGRATION}'"
  # SAFETY: resolve only when the baseline DDL was actually applied (partial = real fail → loud-fail).
  baseline_objects="$(squash_baseline_objects_present)"
  if [[ "${baseline_objects}" != "present" ]]; then
    fail "${EXIT_P3009}" \
      "P3009 인데 baseline 객체(core.outcomes / core.TaskType) 부재 — 부분 적용 의심, 자동 resolve 거부 (수동 점검 필요)"
  fi
  log "P3009: baseline 객체 존재 확인 → 'migrate resolve --applied ${SQUASH_BASELINE_MIGRATION}' (checksum-safe, SQL 미변경)"
  npx prisma migrate resolve --applied "${SQUASH_BASELINE_MIGRATION}" \
    || fail "${EXIT_P3009}" "migrate resolve --applied ${SQUASH_BASELINE_MIGRATION} 실패 — 수동 개입 필요"
  log "P3009: resolve 완료 → migrate deploy 재시도"
  npx prisma migrate deploy \
    || fail "${EXIT_P3009}" "resolve 후 migrate deploy 재시도도 실패 — 수동 개입 필요 (DB 상태 점검)"
  log "P3009: resolve + deploy 재시도 성공 — pre-squash baseline 정상 복구"
fi

# --- step 6: attribution_source CHECK constraint (idempotent · post-deploy raw SQL) ---
# init_oss_baseline defines core.outcomes.attribution_source as plain TEXT (no CHECK),
# so the canonical value allowlist is applied out-of-band HERE rather than via a
# migration — editing the applied baseline SQL drifts existing-DB checksums (see the
# SQUASH_BASELINE_MIGRATION note). DROP IF EXISTS + ADD → safe to re-run and to widen
# the set. NOT VALID skips the full-table scan (pre-existing rows trusted); new writes
# are still checked. The 10-value set MUST byte-match the dual-write producers
# (track-outcome.sh / outcomes.ts / daemon_cycle.py / _pg_*_dualwrite.py) — a missing
# value makes a dual-write hit constraint_violation → the row is silently dropped from PG.
# core.outcomes lives only in the main DB (created by migrate deploy) — shadow excluded.
log "attribution_source CHECK 제약 적용 (10종 캐노니컬 · idempotent · NOT VALID)"
psql -h "${PG_SOCKET}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q \
  -c "ALTER TABLE core.outcomes DROP CONSTRAINT IF EXISTS outcomes_attribution_source_check" \
  -c "ALTER TABLE core.outcomes ADD CONSTRAINT outcomes_attribution_source_check CHECK ((attribution_source IS NULL) OR (attribution_source = ANY (ARRAY['hook-input','cron-derived','agent-id-missing','subagent-stop-missing','completion-missing','conversation-only','truncated_completion','completion-synthesized','budget-truncation','structuredoutput-derived']::text[]))) NOT VALID" \
  || fail "${EXIT_POSTSQL}" "attribution_source CHECK 제약 적용 실패 (DB '${DB_NAME}') — core.outcomes 존재 + peer auth 권한 확인"

# --- no seed step --------------------------------------------------------------
# The empty schema is functional on its own (0 required seeds) — stated so the installer
# does not go looking for a seed.
log "seed 불필요 — 빈 스키마가 기능적 (no required seed)"

log "완료 — npm run dev (또는 build + start) 로 기동"
