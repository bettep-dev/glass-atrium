#!/usr/bin/env bats
# drop_databases — uninstall BACKUP-BEFORE-DROP contract (lib/ga-core.sh).
#
# The uninstall DB teardown takes a pre-drop pg_dump of each EXISTING GA database
# and gates the drop on it, FAIL-CLOSED per database. It MUST:
#   * dump each existing DB (custom -F c) to
#     <backup_dir>/<db>-pre-uninstall-<ts>.dump BEFORE its dropdb (order proven
#     by call markers);
#   * SKIP the drop for a DB whose dump FAILED or is EMPTY (loud log, data
#     preserved) while still dropping a sibling whose dump succeeded;
#   * still return 0 on every skip path (uninstall's never-fatal contract);
#   * skip both dump and drop silently for an ABSENT database (--if-exists
#     semantics preserved);
#   * keep the dropdb-absent advisory skip unchanged (no dump attempted).
#
# Run via: bats test/uninstall-db-backup.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy (mirrors unwire-hooks.bats sourcing + oss-db-setup.bats
# stubbing): the test sources the REAL engine and calls drop_databases directly
# under the entry point's `set -Eeuo pipefail`, with PATH-prepended stub CLIs
# (psql/pg_dump/dropdb) on a CURATED PATH (STUB_BIN + system coreutils, the real
# PostgreSQL bindir excluded) so no test can ever reach the live cluster.
# GA_DB_NAME points every DB action at a throwaway name and GA_DB_BACKUP_DIR
# points the dumps at a throwaway dir — the live ~/.claude is never touched.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-dbbackup-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  BACKUPS="${SANDBOX}/backups"
  TARGET="${SANDBOX}/target"
  mkdir -p "${STUB_BIN}" "${TARGET}"
  # default stubs: probe → both DBs exist; pg_dump → non-empty dump + markers;
  # dropdb → call recorder. Individual tests overwrite per scenario.
  printf '#!/bin/bash\necho 1\nexit 0\n' >"${STUB_BIN}/psql"
  # pg_dump records "$*" + an order marker, then emits a non-empty dump at -f.
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/pg_dump-args"\nprintf "dump\\n" >>"%s/order"\nout=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-f" ]] && { out="$2"; shift; }; shift; done\nprintf "PGDMP" >"${out}"\nexit 0\n' \
    "${SANDBOX}" "${SANDBOX}" >"${STUB_BIN}/pg_dump"
  # dropdb records "$*" + an order marker, then succeeds.
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/dropdb-args"\nprintf "drop\\n" >>"%s/order"\nexit 0\n' \
    "${SANDBOX}" "${SANDBOX}" >"${STUB_BIN}/dropdb"
  chmod +x "${STUB_BIN}/psql" "${STUB_BIN}/pg_dump" "${STUB_BIN}/dropdb"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Drive the REAL drop_databases against the stubs, under the entry point's strict
# mode. Curated PATH: STUB_BIN + system coreutils only (real pg bindir excluded).
run_drop() {
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_DB_BACKUP_DIR="${BACKUPS}" PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      drop_databases
    ' _ "${GA}"
}

@test "T1: dump ok -> BOTH DBs dumped non-empty, BOTH dropped, dump precedes drop per DB" {
  run_drop
  [[ "${status}" -eq 0 ]]
  # a non-empty pre-uninstall dump landed for main AND shadow
  [[ -n "$(find "${BACKUPS}" -name 'claude_oss_e2e-pre-uninstall-*.dump' -size +0c 2>/dev/null)" ]]
  [[ -n "$(find "${BACKUPS}" -name 'claude_oss_e2e_shadow-pre-uninstall-*.dump' -size +0c 2>/dev/null)" ]]
  # dropdb invoked for main AND shadow — exactly the two GA databases
  grep -q -- '--if-exists --force claude_oss_e2e$' "${SANDBOX}/dropdb-args"
  grep -q -- '--if-exists --force claude_oss_e2e_shadow$' "${SANDBOX}/dropdb-args"
  [[ "$(wc -l <"${SANDBOX}/dropdb-args" | tr -d ' ')" -eq 2 ]]
  # backup-before-drop ordering, per DB: dump → drop → dump → drop
  [[ "$(sed -n '1p' "${SANDBOX}/order")" == "dump" ]]
  [[ "$(sed -n '2p' "${SANDBOX}/order")" == "drop" ]]
  [[ "$(sed -n '3p' "${SANDBOX}/order")" == "dump" ]]
  [[ "$(sed -n '4p' "${SANDBOX}/order")" == "drop" ]]
}

@test "T2: main-DB dump fails -> main NOT dropped (preserved), shadow dumped + dropped, exit 0" {
  # pg_dump: shadow → non-empty dump ok; main → hard fail, no file written
  cat >"${STUB_BIN}/pg_dump" <<'STUB'
#!/bin/bash
case "$*" in
  *claude_oss_e2e_shadow*)
    out=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-f" ]] && { out="$2"; shift; }; shift; done
    printf 'PGDMP' >"${out}"
    exit 0
    ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "${STUB_BIN}/pg_dump"
  run_drop
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SKIP-DROP: pre-drop backup of 'claude_oss_e2e' failed or empty"* ]]
  # dropdb was invoked ONLY for the shadow DB (main preserved)
  grep -q -- 'claude_oss_e2e_shadow$' "${SANDBOX}/dropdb-args"
  ! grep -q -- 'claude_oss_e2e$' "${SANDBOX}/dropdb-args"
  [[ "$(wc -l <"${SANDBOX}/dropdb-args" | tr -d ' ')" -eq 1 ]]
  # the shadow dump still landed non-empty
  [[ -n "$(find "${BACKUPS}" -name 'claude_oss_e2e_shadow-pre-uninstall-*.dump' -size +0c 2>/dev/null)" ]]
}

@test "T3: dump yields an EMPTY file -> drop skipped for that DB (both preserved), exit 0" {
  # pg_dump exits 0 but leaves an EMPTY file at -f → the non-empty gate must trip
  cat >"${STUB_BIN}/pg_dump" <<'STUB'
#!/bin/bash
out=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-f" ]] && { out="$2"; shift; }; shift; done
: >"${out}"
exit 0
STUB
  chmod +x "${STUB_BIN}/pg_dump"
  run_drop
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"pre-drop backup of 'claude_oss_e2e' failed or empty"* ]]
  [[ "${output}" == *"pre-drop backup of 'claude_oss_e2e_shadow' failed or empty"* ]]
  [[ "${output}" == *"NOT dropped (data preserved)"* ]]
  # no dropdb call at all — both DBs preserved
  [[ ! -e "${SANDBOX}/dropdb-args" ]]
}

@test "T4: dropdb absent -> advisory skip unchanged, no dump attempted, exit 0" {
  # curated PATH of STUB_BIN ONLY so dropdb is unresolvable on EVERY host (a
  # usrmerged Linux /bin→/usr/bin would otherwise re-expose a real dropdb —
  # oss-db-setup.bats precedent). bash must resolve for env's exec; the
  # advisory-skip path itself runs on builtins alone (command -v / printf).
  ln -s "$(command -v bash)" "${STUB_BIN}/bash"
  rm -f "${STUB_BIN}/dropdb"
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_DB_BACKUP_DIR="${BACKUPS}" PATH="${STUB_BIN}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      drop_databases
    ' _ "${GA}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"dropdb not found"* ]]
  # data-preserving outcome: nothing dumped (the dropdb gate precedes the backup
  # machinery), nothing dropped
  [[ ! -e "${SANDBOX}/pg_dump-args" ]]
  [[ ! -e "${SANDBOX}/dropdb-args" ]]
  [[ -z "$(find "${BACKUPS}" -name '*.dump' 2>/dev/null)" ]]
}

@test "T5: absent DB -> skips both dump and drop silently (--if-exists semantics preserved)" {
  # existence probe: shadow exists, main absent
  cat >"${STUB_BIN}/psql" <<'STUB'
#!/bin/bash
case "$*" in *claude_oss_e2e_shadow*) echo 1 ;; esac
exit 0
STUB
  chmod +x "${STUB_BIN}/psql"
  run_drop
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"skip: claude_oss_e2e absent"* ]]
  # main: no dump file, no dropdb call; shadow proceeds normally
  [[ -z "$(find "${BACKUPS}" -name 'claude_oss_e2e-pre-uninstall-*.dump' 2>/dev/null)" ]]
  grep -q -- 'claude_oss_e2e_shadow$' "${SANDBOX}/dropdb-args"
  [[ "$(wc -l <"${SANDBOX}/dropdb-args" | tr -d ' ')" -eq 1 ]]
}
