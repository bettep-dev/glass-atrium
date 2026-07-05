#!/usr/bin/env bats
# oss-db-setup.sh — GA_DB_NAME throwaway-DB override pin: every DB action keys
# on the override name, a preserved .env pointing at a DIFFERENT db loud-fails
# (exit 7) BEFORE any DB action, and a fresh-rendered .env targets the override
# db. Default (GA_DB_NAME unset) stays byte-compatible with the glass_atrium path.
#
# Run via: bats test/oss-db-setup.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy: a fake monitor root (prisma.config.ts + prisma/migrations/
# + .env.example) satisfies the cwd precondition, and PATH-prepended stub CLIs
# (psql -> "db exists", createdb -> abort marker, npm/npx -> no-op) keep every
# test off the machine-global PostgreSQL entirely.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
SETUP_SH="${GA}/monitor/scripts/oss-db-setup.sh"

setup() {
  [[ -f "${SETUP_SH}" ]] || skip "script not found: ${SETUP_SH}"
  SANDBOX="$(mktemp -d -t ga-dbsetup-bats.XXXXXX)"
  FAKE_ROOT="${SANDBOX}/monitor"
  STUB_BIN="${SANDBOX}/bin"
  mkdir -p "${FAKE_ROOT}/prisma/migrations" "${STUB_BIN}"
  touch "${FAKE_ROOT}/prisma.config.ts"
  cp "${GA}/monitor/.env.example" "${FAKE_ROOT}/.env.example"
  # psql existence probe -> "1" (db exists) so the createdb branch is skipped
  printf '#!/bin/bash\necho 1\n' >"${STUB_BIN}/psql"
  # createdb must never be reached here -> abort marker + non-zero exit
  printf '#!/bin/bash\ntouch "%s/createdb-called"\nexit 1\n' "${SANDBOX}" >"${STUB_BIN}/createdb"
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/npm"
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/npx"
  chmod +x "${STUB_BIN}/psql" "${STUB_BIN}/createdb" "${STUB_BIN}/npm" "${STUB_BIN}/npx"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# run the real script from the fake monitor root with stubbed CLIs.
# $1 = GA_DB_NAME value ("" = unset, the default path).
run_setup() {
  local db_override="$1"
  if [[ -n "${db_override}" ]]; then
    run env GA_DB_NAME="${db_override}" PATH="${STUB_BIN}:${PATH}" \
      bash -c "cd \"${FAKE_ROOT}\" && exec bash \"${SETUP_SH}\""
  else
    run env -u GA_DB_NAME PATH="${STUB_BIN}:${PATH}" \
      bash -c "cd \"${FAKE_ROOT}\" && exec bash \"${SETUP_SH}\""
  fi
}

@test "wrong cwd loud-fails with exit 3 (cwd precondition unchanged)" {
  mkdir -p "${SANDBOX}/empty"
  run env PATH="${STUB_BIN}:${PATH}" \
    bash -c "cd \"${SANDBOX}/empty\" && exec bash \"${SETUP_SH}\""
  [[ "${status}" -eq 3 ]]
}

@test "GA_DB_NAME with non-identifier chars loud-fails with exit 7" {
  run_setup "claude-bad;name"
  [[ "${status}" -eq 7 ]]
  [[ ! -e "${SANDBOX}/createdb-called" ]]
}

@test "GA_DB_NAME vs preserved .env mismatch loud-fails (exit 7) before any DB action" {
  printf 'DATABASE_URL=postgresql:///glass_atrium?host=/tmp\n' >"${FAKE_ROOT}/.env"
  local before
  before="$(shasum "${FAKE_ROOT}/.env" | awk '{print $1}')"
  run_setup "claude_oss_e2e"
  [[ "${status}" -eq 7 ]]
  [[ "${output}" == *"다른 DB"* ]]
  # no DB action attempted, .env untouched
  [[ ! -e "${SANDBOX}/createdb-called" ]]
  [[ "$(shasum "${FAKE_ROOT}/.env" | awk '{print $1}')" == "${before}" ]]
}

@test "GA_DB_NAME fresh render targets the override db (main + shadow) with the invoking OS user qualified" {
  run_setup "claude_oss_e2e"
  [[ "${status}" -eq 0 ]]
  # user-qualified URL form — userless socket URLs make prisma migrate deploy
  # connect as a non-peer default user (P1010)
  grep -qF "DATABASE_URL=postgresql://$(id -un)@localhost/claude_oss_e2e?host=/tmp" "${FAKE_ROOT}/.env"
  # shadow tracks the override name — never the real glass_atrium_shadow
  grep -qF "SHADOW_DATABASE_URL=postgresql://$(id -un)@localhost/claude_oss_e2e_shadow?host=/tmp" "${FAKE_ROOT}/.env"
  # rendered .env must end on a line boundary (append-safety for env upserts)
  [[ -z "$(tail -c 1 "${FAKE_ROOT}/.env")" ]]
  # existence probe said "exists" -> createdb never invoked
  [[ ! -e "${SANDBOX}/createdb-called" ]]
}

@test "default (GA_DB_NAME unset) renders all 4 keys, rest of example preserved" {
  run_setup ""
  [[ "${status}" -eq 0 ]]
  grep -qF "DATABASE_URL=postgresql://$(id -un)@localhost/glass_atrium?host=/tmp" "${FAKE_ROOT}/.env"
  grep -qF "SHADOW_DATABASE_URL=postgresql://$(id -un)@localhost/glass_atrium_shadow?host=/tmp" "${FAKE_ROOT}/.env"
  grep -q '^ATRIUM_MONITOR_PORT=7842$' "${FAKE_ROOT}/.env"
  grep -q "^CLAUDED_DOCS_HTML_ROOT=${HOME}/.glass-atrium/monitor/data/documents$" "${FAKE_ROOT}/.env"
  # additive render: exactly the 2 URL + 1 ${HOME} lines differ (3 removed + 3 added)
  [[ "$(diff "${FAKE_ROOT}/.env" "${FAKE_ROOT}/.env.example" | grep -c '^[<>]')" -eq 6 ]]
}

@test "post-deploy step applies the 10-value attribution_source CHECK constraint (incl structuredoutput-derived)" {
  # record every psql invocation's args; still answer existence probes with "1" so the
  # createdb branch is skipped and the run reaches the post-deploy constraint step.
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/psql-args"\necho 1\nexit 0\n' \
    "${SANDBOX}" >"${STUB_BIN}/psql"
  chmod +x "${STUB_BIN}/psql"
  run_setup ""
  [[ "${status}" -eq 0 ]]
  # the idempotent DROP-then-ADD pair on the canonical constraint name was issued
  grep -q 'DROP CONSTRAINT IF EXISTS outcomes_attribution_source_check' "${SANDBOX}/psql-args"
  grep -q 'ADD CONSTRAINT outcomes_attribution_source_check' "${SANDBOX}/psql-args"
  grep -q 'NOT VALID' "${SANDBOX}/psql-args"
  # the 10th canonical value is present alongside all 9 pre-existing ones
  local v
  for v in hook-input cron-derived agent-id-missing subagent-stop-missing \
           completion-missing conversation-only truncated_completion \
           completion-synthesized budget-truncation structuredoutput-derived; do
    grep -qF "${v}" "${SANDBOX}/psql-args" || {
      echo "missing canonical value: ${v}" >&2
      return 1
    }
  done
}

@test "no literal \${HOME} token survives the render" {
  run_setup ""
  [[ "${status}" -eq 0 ]]
  ! grep -qF '${HOME}' "${FAKE_ROOT}/.env"
}

@test "both DBs absent -> createdb invoked for main AND shadow" {
  # probe says "not exists" for every db; createdb records its args and succeeds
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/psql"
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/createdb-args"\nexit 0\n' \
    "${SANDBOX}" >"${STUB_BIN}/createdb"
  run_setup ""
  [[ "${status}" -eq 0 ]]
  grep -q '^-h /tmp glass_atrium$' "${SANDBOX}/createdb-args"
  grep -q '^-h /tmp glass_atrium_shadow$' "${SANDBOX}/createdb-args"
}

@test "main DB exists, shadow absent -> only the shadow DB is created (idempotent guard)" {
  # probe answers per-db: shadow query -> empty (absent), anything else -> exists
  printf '#!/bin/bash\ncase "$*" in *_shadow*) ;; *) echo 1 ;; esac\nexit 0\n' \
    >"${STUB_BIN}/psql"
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/createdb-args"\nexit 0\n' \
    "${SANDBOX}" >"${STUB_BIN}/createdb"
  run_setup ""
  [[ "${status}" -eq 0 ]]
  [[ "$(wc -l <"${SANDBOX}/createdb-args" | tr -d ' ')" -eq 1 ]]
  grep -q '^-h /tmp glass_atrium_shadow$' "${SANDBOX}/createdb-args"
}

@test "GA_DB_NAME with a preserved USER-QUALIFIED .env passes the guard" {
  printf 'DATABASE_URL=postgresql://%s@localhost/claude_oss_e2e?host=/tmp\n' "$(id -un)" \
    >"${FAKE_ROOT}/.env"
  run_setup "claude_oss_e2e"
  [[ "${status}" -eq 0 ]]
}

@test "GA_DB_NAME with a MATCHING preserved .env passes the guard and preserves it" {
  printf 'DATABASE_URL=postgresql:///claude_oss_e2e?host=/tmp\n' >"${FAKE_ROOT}/.env"
  local before
  before="$(shasum "${FAKE_ROOT}/.env" | awk '{print $1}')"
  run_setup "claude_oss_e2e"
  [[ "${status}" -eq 0 ]]
  [[ "$(shasum "${FAKE_ROOT}/.env" | awk '{print $1}')" == "${before}" ]]
}

# --- recreate path (GA_DB_RECREATE) ------------------------------------------
# Hermetic PATH for the recreate tests: STUB_BIN + system coreutils ONLY, with
# the real PostgreSQL bindir (/opt/homebrew/bin) EXCLUDED. The base setup PATH
# (STUB_BIN:${PATH}) would let an UN-stubbed pg_dump/dropdb resolve to the real
# binary and reach the live cluster — defeating the hermetic strategy. Tests
# that want pg_dump/dropdb stub them into STUB_BIN; the "missing CLI" test omits
# them and relies on this PATH to keep the real ones unreachable. Built from
# STUB_BIN at call time (not at parse time) because setup() assigns STUB_BIN.

# run the script with GA_DB_RECREATE=1 (+ GA_DB_NAME override). $1 = GA_DB_NAME.
run_recreate() {
  local db_override="$1"
  local recreate_path="${STUB_BIN}:/usr/bin:/bin"
  run env GA_DB_RECREATE=1 GA_DB_NAME="${db_override}" \
    GA_DB_BACKUP_DIR="${SANDBOX}/backups" PATH="${recreate_path}" \
    bash -c "cd \"${FAKE_ROOT}\" && exec bash \"${SETUP_SH}\""
}

@test "GA_DB_RECREATE refuses the live DB 'glass_atrium' (exit 8, no drop)" {
  # default name = glass_atrium; recreate guard must reject before any DB action.
  # .env matching is not relevant — refusal precedes the override .env guard path.
  printf '#!/bin/bash\ntouch "%s/dropdb-called"\nexit 0\n' "${SANDBOX}" >"${STUB_BIN}/dropdb"
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/pg_dump"
  chmod +x "${STUB_BIN}/dropdb" "${STUB_BIN}/pg_dump"
  # GA_DB_RECREATE set but GA_DB_NAME unset -> DB_NAME defaults to 'glass_atrium'.
  # `env -u` options MUST precede the NAME=value assignments (else env treats
  # `-u` as the command and exits 127).
  local recreate_path="${STUB_BIN}:/usr/bin:/bin"
  run env -u GA_DB_NAME GA_DB_RECREATE=1 \
    GA_DB_BACKUP_DIR="${SANDBOX}/backups" PATH="${recreate_path}" \
    bash -c "cd \"${FAKE_ROOT}\" && exec bash \"${SETUP_SH}\""
  [[ "${status}" -eq 8 ]]
  [[ "${output}" == *"live DB 'glass_atrium'"* ]]
  [[ ! -e "${SANDBOX}/dropdb-called" ]]
}

@test "GA_DB_RECREATE missing pg_dump/dropdb loud-fails (exit 4) before any drop" {
  # recreate requires pg_dump + dropdb; absence is a named CLI failure. Curated PATH
  # of STUB_BIN ONLY (no /usr/bin:/bin) so pg_dump/dropdb are unresolvable on EVERY
  # host — a usrmerged Linux /bin→/usr/bin would otherwise re-expose the real pg_dump
  # and skip the exit-4 branch (the run_recreate helper's STUB_BIN:/usr/bin:/bin PATH
  # only kept them unreachable on macOS, where they live in /opt/homebrew/bin).
  # bash + id must resolve under the curated PATH: bash execs the script, id backs
  # DB_USER="$(id -un)" at script top (before the exit-4 CLI check). The real id
  # yields a username passing the script's user charset guard (^[A-Za-z0-9._-]+$).
  ln -s "$(command -v bash)" "${STUB_BIN}/bash"
  ln -s "$(command -v id)" "${STUB_BIN}/id"
  # remove the dropdb/pg_dump stubs from the stub bin (createdb/psql remain).
  rm -f "${STUB_BIN}/pg_dump" "${STUB_BIN}/dropdb"
  run env GA_DB_RECREATE=1 GA_DB_NAME=claude_oss_e2e \
    GA_DB_BACKUP_DIR="${SANDBOX}/backups" PATH="${STUB_BIN}" \
    bash -c "cd \"${FAKE_ROOT}\" && exec bash \"${SETUP_SH}\""
  [[ "${status}" -eq 4 ]]
  [[ "${output}" == *"recreate 필수 CLI 부재"* ]]
}

@test "GA_DB_RECREATE backs up BEFORE dropping (order proven by call markers)" {
  # State-aware probe: the main target db reports 'exists' UNTIL dropdb clears its
  # sentinel, so recreate engages (exists) and the post-drop create_db_if_absent
  # probe then sees 'absent' and legitimately invokes createdb (the `create`
  # marker). The shadow db is never dropped, so its probe always reports 'exists'
  # (skipped — no shadow create). pg_dump writes a non-empty file + records order;
  # dropdb records order + clears the main sentinel; createdb records the re-create.
  : >"${SANDBOX}/main-present"
  printf '#!/bin/bash\ncase "$*" in\n  *pg_database*_shadow*) echo 1 ;;\n  *pg_database*) [[ -e "%s/main-present" ]] && echo 1 ;;\nesac\nexit 0\n' \
    "${SANDBOX}" >"${STUB_BIN}/psql"
  printf '#!/bin/bash\nprintf "dump\\n" >>"%s/order"\n# emit a non-empty dump at the -f path arg\nout=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-f" ]] && { out="$2"; shift; }; shift; done\nprintf "PGDMP" >"${out}"\nexit 0\n' \
    "${SANDBOX}" >"${STUB_BIN}/pg_dump"
  printf '#!/bin/bash\nprintf "drop\\n" >>"%s/order"\nrm -f "%s/main-present"\nexit 0\n' "${SANDBOX}" "${SANDBOX}" >"${STUB_BIN}/dropdb"
  printf '#!/bin/bash\nprintf "create\\n" >>"%s/order"\nexit 0\n' "${SANDBOX}" >"${STUB_BIN}/createdb"
  chmod +x "${STUB_BIN}/psql" "${STUB_BIN}/pg_dump" "${STUB_BIN}/dropdb" "${STUB_BIN}/createdb"
  run_recreate "claude_oss_e2e"
  [[ "${status}" -eq 0 ]]
  # dump MUST precede drop MUST precede create (backup-before-drop invariant)
  [[ "$(sed -n '1p' "${SANDBOX}/order")" == "dump" ]]
  [[ "$(sed -n '2p' "${SANDBOX}/order")" == "drop" ]]
  [[ "$(grep -c '^create$' "${SANDBOX}/order")" -ge 1 ]]
  # a non-empty backup file landed under the backup dir
  [[ -n "$(find "${SANDBOX}/backups" -name 'claude_oss_e2e-recreate-*.dump' -size +0c 2>/dev/null)" ]]
}

@test "GA_DB_RECREATE aborts (exit 8) when pg_dump yields an empty file (no drop)" {
  printf '#!/bin/bash\necho 1\n' >"${STUB_BIN}/psql"
  # pg_dump creates an EMPTY file at the -f path -> backup verification fails
  printf '#!/bin/bash\nout=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-f" ]] && { out="$2"; shift; }; shift; done\n: >"${out}"\nexit 0\n' \
    >"${STUB_BIN}/pg_dump"
  printf '#!/bin/bash\ntouch "%s/dropdb-called"\nexit 0\n' "${SANDBOX}" >"${STUB_BIN}/dropdb"
  chmod +x "${STUB_BIN}/psql" "${STUB_BIN}/pg_dump" "${STUB_BIN}/dropdb"
  run_recreate "claude_oss_e2e"
  [[ "${status}" -eq 8 ]]
  [[ "${output}" == *"빈 파일"* ]]
  [[ ! -e "${SANDBOX}/dropdb-called" ]]
}

@test "GA_DB_RECREATE with target absent skips recreate (fresh createdb path)" {
  # probe says target db does NOT exist -> recreate_database returns early, no
  # dropdb. The absent-target path then falls through to the fresh createdb, so the
  # setup() abort stub (touch createdb-called; exit 1) MUST be overridden with a
  # passing createdb here — otherwise the legitimate fresh-create dies EXIT_CREATEDB=5.
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/psql"
  printf '#!/bin/bash\ntouch "%s/dropdb-called"\nexit 0\n' "${SANDBOX}" >"${STUB_BIN}/dropdb"
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/pg_dump"
  printf '#!/bin/bash\nexit 0\n' >"${STUB_BIN}/createdb"
  chmod +x "${STUB_BIN}/psql" "${STUB_BIN}/dropdb" "${STUB_BIN}/pg_dump" "${STUB_BIN}/createdb"
  run_recreate "claude_oss_e2e"
  [[ "${status}" -eq 0 ]]
  [[ ! -e "${SANDBOX}/dropdb-called" ]]
}
