#!/usr/bin/env bats
# pg-backup.sh rotation — keep-forever pre-uninstall dumps must NOT consume slots
# in the 14-dump rolling-backup window. The rotation candidate set is the dated
# nightly form only (glass_atrium-<digits>-...), so a kept-forever pre-uninstall
# dump (glass_atrium-pre-uninstall-..., written by lib/ga-db.sh drop_databases)
# never shrinks the rolling depth.
#
# Run via: bats test/pg-backup-rotation.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy: HOME is redirected to a mktemp sandbox (so the script's
# BACKUP_DIR + TRASH_DIR resolve inside it), and a fake pg_dump on PATH writes a
# non-empty payload — the real glass_atrium database and the real ~/.glass-atrium
# backups are never touched (SECURITY: no real pg_dump ever runs).

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_SCRIPT="${GA}/scripts/pg-backup.sh"
RETAIN_COUNT=14

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "script not found: ${REAL_SCRIPT}"
  SANDBOX="$(mktemp -d -t ga-pgbackup-bats.XXXXXX)"
  FAKE_HOME="${SANDBOX}/home"
  BACKUP_DIR="${FAKE_HOME}/.glass-atrium/backups/postgres"
  TRASH_DIR="${FAKE_HOME}/.Trash"
  # The script assumes ~/.Trash exists (a real user always has it); create it so
  # rotation mv targets resolve instead of silently WARN-skipping.
  mkdir -p -- "${BACKUP_DIR}" "${TRASH_DIR}"
  FAKE_BIN="${SANDBOX}/bin"
  mkdir -p -- "${FAKE_BIN}"
  # Stub pg_dump: write a small non-empty payload to the -f target so the
  # script's non-empty gate passes without ever contacting a real database.
  cat >"${FAKE_BIN}/pg_dump" <<'STUB'
#!/usr/bin/env bash
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "${out}" ]] && printf 'FAKE-DUMP-PAYLOAD\n' >"${out}"
exit 0
STUB
  chmod +x "${FAKE_BIN}/pg_dump"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# seed_nightly <count> — create <count> dated nightly dumps (ascending dates).
seed_nightly() {
  local n="$1" i day
  for ((i = 1; i <= n; i++)); do
    day="$(printf '202601%02d' "${i}")"
    printf 'SEED\n' >"${BACKUP_DIR}/glass_atrium-${day}-000000.dump"
  done
}

# Write one keep-forever pre-uninstall dump (matches lib/ga-db.sh naming).
seed_preuninstall() {
  printf 'KEEP-FOREVER\n' >"${BACKUP_DIR}/glass_atrium-pre-uninstall-20260601-000000.dump"
}

# Count dated nightly dumps present (excludes the pre-uninstall dump, which
# begins with 'p' not a digit).
count_nightly() {
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'glass_atrium-[0-9]*.dump' | wc -l | tr -d '[:space:]'
}

run_backup() {
  # Unset GA_DATA_ROOT/GA_ROOT so the default-path seam resolves under FAKE_HOME
  # (a leaked env var would otherwise redirect BACKUP_DIR off the sandbox).
  run env -u GA_DATA_ROOT -u GA_ROOT HOME="${FAKE_HOME}" PATH="${FAKE_BIN}:${PATH}" bash "${REAL_SCRIPT}"
}

@test "rotation retains 14 nightly dumps despite a keep-forever pre-uninstall dump" {
  seed_nightly "${RETAIN_COUNT}" # 14 dated nightly dumps
  seed_preuninstall              # 1 keep-forever pre-uninstall dump
  run_backup                     # adds a 15th (today) nightly dump
  [[ "${status}" -eq 0 ]] || {
    echo "script exit ${status}: ${output}"
    return 1
  }
  # Pre-uninstall dump is excluded from the rotation budget, so the full 14-slot
  # window is retained for nightly dumps (pre-fix this collapsed to 13).
  local kept
  kept="$(count_nightly)"
  [[ "${kept}" -eq "${RETAIN_COUNT}" ]] || {
    echo "nightly retained = ${kept}, expected ${RETAIN_COUNT}"
    return 1
  }
}

@test "keep-forever pre-uninstall dump is never rotated to trash" {
  seed_nightly "${RETAIN_COUNT}"
  seed_preuninstall
  run_backup
  [[ "${status}" -eq 0 ]] || {
    echo "script exit ${status}: ${output}"
    return 1
  }
  [[ -f "${BACKUP_DIR}/glass_atrium-pre-uninstall-20260601-000000.dump" ]] || {
    echo "pre-uninstall dump was rotated to trash (keep-forever violated)"
    return 1
  }
}
