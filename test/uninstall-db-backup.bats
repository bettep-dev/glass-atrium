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

# --- creation mask (CWE-732) --------------------------------------------------

# mode_of — SHARED, because that `||` chain between the two stat SPELLINGS was never a
# platform branch: on GNU it read a statfs block as a mode and reddened this assertion
# and its two siblings together. See test/lib/stat-mode.bash.
load 'lib/stat-mode'

@test "AC-C7 pre-drop dumps and the dir created for them are owner-only (0700 / 0600)" {
  local dump dir_mode dump_mode
  # These dumps are the ONLY copy of a database this function then drops, so a
  # world-readable dump is the whole database readable by every local account.
  # ${BACKUPS} is not pre-created by setup(), so drop_databases' own mkdir makes it.
  run_drop
  [[ "${status}" -eq 0 ]] || {
    echo "drop_databases exit ${status}: ${output}" >&2
    return 1
  }
  dir_mode="$(mode_of "${BACKUPS}")"
  [[ "${dir_mode}" == "700" ]] || {
    echo "created backup dir mode = ${dir_mode}, expected 700" >&2
    return 1
  }
  dump="$(find "${BACKUPS}" -maxdepth 1 -type f -name '*-pre-uninstall-*.dump' | head -n 1)"
  [[ -n "${dump}" ]] || {
    echo "no pre-uninstall dump landed; out=${output}" >&2
    return 1
  }
  dump_mode="$(mode_of "${dump}")"
  [[ "${dump_mode}" == "600" ]] || {
    echo "dump mode = ${dump_mode}, expected 600" >&2
    return 1
  }
}

@test "AC-C7 the creation mask is RESTORED when drop_databases returns" {
  local probe="${SANDBOX}/post-drop-probe" mode
  # The 077 scope is process-global, and drop_databases is called from the uninstall
  # engine mid-run: a leaked mask silently makes every file the REST of the uninstall
  # creates owner-only. Deleting the restore line keeps every other assertion green, so
  # the probe is a file created after the call in the SAME shell — the only thing that
  # can tell the two states apart.
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_DB_BACKUP_DIR="${BACKUPS}" PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      umask 022
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      drop_databases
      : >"$2"
    ' _ "${GA}" "${probe}"
  [[ "${status}" -eq 0 ]] || {
    echo "drop_databases exit ${status}: ${output}" >&2
    return 1
  }
  [[ -f "${probe}" ]] || {
    echo "the post-call probe was never created; out=${output}" >&2
    return 1
  }
  mode="$(mode_of "${probe}")"
  [[ "${mode}" == "644" ]] || {
    echo "post-call creation mode = ${mode}, expected 644 (the caller's 022 mask)" >&2
    return 1
  }
}

@test "AC-C7b the creation mask is RESTORED when the backup dir cannot be created" {
  local blocker="${SANDBOX}/not-a-dir" probe="${SANDBOX}/mkdir-fail-probe" mode
  # The mkdir-failure arm returns EARLY, ahead of the restore that closes the function,
  # so it carries a restore of its own — and AC-C7 cannot speak for it: that probe only
  # ever walks the success path, so deleting this arm's restore leaves every other
  # assertion in this file green. A regular file standing in for the parent makes
  # `mkdir -p` fail on both platforms (ENOTDIR), which is the one way to reach the early
  # return with the 077 mask already set.
  : >"${blocker}"
  run env GA_TARGET_HOME="${TARGET}" GA_DB_NAME=claude_oss_e2e \
    GA_DB_BACKUP_DIR="${blocker}/backups" PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      umask 022
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      drop_databases
      : >"$2"
    ' _ "${GA}" "${probe}"
  [[ "${status}" -eq 0 ]] || {
    echo "drop_databases exit ${status}: ${output}" >&2
    return 1
  }
  # the arm under test is the one that fired, and it preserved the data
  [[ "${output}" == *"cannot create backup dir"* ]] || {
    echo "the mkdir-failure arm never fired; out=${output}" >&2
    return 1
  }
  [[ ! -f "${SANDBOX}/dropdb-args" ]] || {
    echo "a database was dropped with no backup dir: $(cat "${SANDBOX}/dropdb-args")" >&2
    return 1
  }
  [[ -f "${probe}" ]] || {
    echo "the post-call probe was never created; out=${output}" >&2
    return 1
  }
  mode="$(mode_of "${probe}")"
  [[ "${mode}" == "644" ]] || {
    echo "post-call creation mode = ${mode}, expected 644 (the caller's 022 mask)" >&2
    return 1
  }
}
