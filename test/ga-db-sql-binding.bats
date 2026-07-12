#!/usr/bin/env bats
# ga-db.sh — SQL parameterized-binding (#4) + oss-db-setup /tmp-seam guard (#5).
#
# Two low-severity DB-safety fixes in lib/ga-db.sh:
#   #4  the setup_database + drop_databases existence probes bind DB_NAME / ${db}
#       via a psql VARIABLE (-v dbname) + the :'dbname' quoted-substitution form
#       fed over STDIN — parameterized binding, never string-concatenated into the
#       SQL literal (mirrors ga_detect_postgres_role; core-security.md).
#   #5  run_db_setup + recreate_db_gate refuse to delegate to oss-db-setup.sh when
#       GA_PG_SOCKET points off /tmp: the setup script hardcodes PG_SOCKET=/tmp and
#       ignores the seam, so a non-/tmp socket would mutate the LIVE /tmp cluster.
#       Fail-closed with an actionable die (zero prod change — prod PG_SOCKET=/tmp).
#
# Run via: bats test/ga-db-sql-binding.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic: sources the REAL engine and calls the domain functions directly under
# the entry point's strict mode, with a PATH-prepended stub psql that RECORDS its
# args + stdin (never a real cluster). GA_DB_NAME points every DB action at a
# throwaway name; every test excludes the Homebrew bindir from PATH so even a
# mis-placed guard could only reach oss-db-setup.sh's exit-4 missing-CLI path —
# never the live DB.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-dbbind-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  TARGET="${SANDBOX}/target"
  REC="${SANDBOX}/rec"
  mkdir -p "${STUB_BIN}" "${TARGET}" "${REC}"
  # default psql stub: record args ($*) + the SQL (stdin) for binding assertions,
  # echo nothing (DB 'absent'). Individual tests overwrite psql per scenario.
  cat >"${STUB_BIN}/psql" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>"${GA_REC}/psql-args"
cat >>"${GA_REC}/psql-stdin"
exit 0
STUB
  # dropdb / pg_dump: record-if-invoked so a test can assert they were NOT called.
  cat >"${STUB_BIN}/dropdb" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>"${GA_REC}/dropdb-called"
exit 0
STUB
  cat >"${STUB_BIN}/pg_dump" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>"${GA_REC}/pg_dump-called"
exit 0
STUB
  chmod +x "${STUB_BIN}/psql" "${STUB_BIN}/dropdb" "${STUB_BIN}/pg_dump"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# setup_database presence-probe path — DB 'present' (psql echo 1) so no delegation.
# Curated PATH: STUB_BIN + system coreutils only (real pg bindir excluded).
run_setup_probe() {
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_REC="${REC}" PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      setup_database
    ' _ "${GA}"
}

# drop_databases probe path — both DBs 'absent' (psql empty) so no dump/drop.
run_drop_probe() {
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_DB_BACKUP_DIR="${SANDBOX}/backups" GA_REC="${REC}" \
    PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      drop_databases
    ' _ "${GA}"
}

@test "P1: setup_database probe binds DB_NAME via psql -v (parameterized, not concatenated)" {
  # DB 'present' → the existence probe is exercised, no delegation to oss-db-setup.sh.
  cat >"${STUB_BIN}/psql" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >>"${GA_REC}/psql-args"
cat >>"${GA_REC}/psql-stdin"
echo 1
exit 0
STUB
  chmod +x "${STUB_BIN}/psql"
  run_setup_probe
  [[ "${status}" -eq 0 ]] || return 1
  # DB_NAME bound as a psql variable; the SQL travels over STDIN with a :'dbname' placeholder.
  grep -qF -- '-v dbname=claude_oss_e2e' "${REC}/psql-args" || return 1
  grep -qF -- "datname=:'dbname'" "${REC}/psql-stdin" || return 1
  # the vulnerable concatenated literal must appear in NEITHER the args nor the SQL.
  ! grep -qF -- "datname='claude_oss_e2e'" "${REC}/psql-args" || return 1
  ! grep -qF -- "datname='claude_oss_e2e'" "${REC}/psql-stdin" || return 1
  # the old inline -c form is gone (SQL is fed via stdin now).
  ! grep -qF -- '-tAc' "${REC}/psql-args" || return 1
}

@test "P2: drop_databases probe binds \${db} via psql -v for BOTH DBs, no drop on absent" {
  # default stub echoes nothing → both GA DBs 'absent' → dump+drop skipped, exit 0.
  run_drop_probe
  [[ "${status}" -eq 0 ]] || return 1
  # both GA databases probed with the parameterized -v binding (primary + shadow).
  grep -qF -- '-v dbname=claude_oss_e2e' "${REC}/psql-args" || return 1
  grep -qF -- '-v dbname=claude_oss_e2e_shadow' "${REC}/psql-args" || return 1
  grep -qF -- "datname=:'dbname'" "${REC}/psql-stdin" || return 1
  # no concatenated literal, no -c form.
  ! grep -qF -- "datname='claude_oss_e2e'" "${REC}/psql-args" || return 1
  ! grep -qF -- '-tAc' "${REC}/psql-args" || return 1
  # absent DBs → pg_dump/dropdb never invoked (fail-closed, data-preserving).
  [[ ! -e "${REC}/pg_dump-called" ]] || return 1
  [[ ! -e "${REC}/dropdb-called" ]] || return 1
}

@test "S1: run_db_setup seam guard — GA_PG_SOCKET off /tmp fails closed before delegating" {
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_PG_SOCKET="${SANDBOX}/seam-sock" GA_REC="${REC}" \
    PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      run_db_setup
    ' _ "${GA}"
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${output}" == *"GA_PG_SOCKET seam active"* ]] || return 1
  [[ "${output}" == *"oss-db-setup.sh is /tmp-only"* ]] || return 1
  # the guard fired BEFORE the delegation banner logged → oss-db-setup.sh never ran.
  [[ "${output}" != *"== DB bootstrap: oss-db-setup.sh"* ]] || return 1
}

@test "S2: recreate_db_gate seam guard — GA_PG_SOCKET off /tmp fails closed before delegating" {
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_PG_SOCKET="${SANDBOX}/seam-sock" GA_REC="${REC}" \
    PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      RECREATE_YES=true
      recreate_db_gate
    ' _ "${GA}"
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${output}" == *"GA_PG_SOCKET seam active"* ]] || return 1
  # the guard fired BEFORE the delegation banner logged → oss-db-setup.sh never ran.
  [[ "${output}" != *"== DB recreate: oss-db-setup.sh"* ]] || return 1
}
