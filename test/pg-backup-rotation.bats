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
# It also pins the ADR-6 wiring (AC-C3): the script resolves its directory through
# the shared resolver, so a configured relocation must carry BOTH the dump and its
# rotation, and an unreachable resolver library must still produce a dump — the job
# runs unattended from launchd, where dying because a library moved is the worst
# available outcome.
#
# Hermetic strategy: HOME is redirected to a mktemp sandbox (so the script's
# BACKUP_DIR + TRASH_DIR resolve inside it), and a fake pg_dump on PATH writes a
# non-empty payload — the real glass_atrium database and the real ~/.glass-atrium
# backups are never touched (SECURITY: no real pg_dump ever runs).
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict — every
# assertion below `return 1`s with its own message so each fails independently.

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

# seed_nightly_in <dir> <count> — create <count> dated nightly dumps (ascending dates).
seed_nightly_in() {
  local dir="$1" n="$2" i day
  mkdir -p -- "${dir}"
  for ((i = 1; i <= n; i++)); do
    day="$(printf '202601%02d' "${i}")"
    printf 'SEED\n' >"${dir}/glass_atrium-${day}-000000.dump"
  done
}

# seed_nightly <count> — the same, at the default location.
seed_nightly() {
  seed_nightly_in "${BACKUP_DIR}" "$1"
}

# Write one keep-forever pre-uninstall dump (matches lib/ga-db.sh naming).
seed_preuninstall() {
  printf 'KEEP-FOREVER\n' >"${BACKUP_DIR}/glass_atrium-pre-uninstall-20260601-000000.dump"
}

# Count dated nightly dumps present (excludes the pre-uninstall dump, which
# begins with 'p' not a digit).
count_nightly_in() {
  find "$1" -maxdepth 1 -type f -name 'glass_atrium-[0-9]*.dump' | wc -l | tr -d '[:space:]'
}

count_nightly() {
  count_nightly_in "${BACKUP_DIR}"
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

# --- AC-C3: the ADR-6 resolver decides where the dump lands ------------------
#
# NO LIVE PATH LITERAL: test/db-backup-path-consistency.bats greps every tracked
# file for the stale backup path, so the fixture below uses sandbox paths only.

# run_backup_with <config.toml path> <resolver library path> — drive the script with
# the config seam and the library seam both pinned. A library path that does not
# exist exercises the fallback arm.
run_backup_with() {
  run env -u GA_DATA_ROOT -u GA_ROOT -u GA_DB_BACKUP_DIR \
    HOME="${FAKE_HOME}" PATH="${FAKE_BIN}:${PATH}" \
    ATRIUM_CONFIG_TOML="$1" ATRIUM_CONFIG_LIB="$2" \
    bash "${REAL_SCRIPT}"
}

@test "AC-C3 a configured backup_dir carries BOTH the nightly dump and its rotation" {
  local relocated="${SANDBOX}/relocated" kept
  # Case 2 of the ADR-6 table: the destination EXISTS, so the configured value is
  # adopted and differs from the default location under this sandbox HOME.
  mkdir -p -- "${relocated}"
  printf '[paths]\nbackup_dir = "%s"\n' "${relocated}" >"${SANDBOX}/config.toml"
  # One dump over the retention window, seeded AT the configured location, so the
  # rotation has to run there too.
  seed_nightly_in "${relocated}" "$((RETAIN_COUNT + 1))"

  run_backup_with "${SANDBOX}/config.toml" "${GA}/scripts/lib/atrium-config.sh"
  [[ "${status}" -eq 0 ]] || {
    echo "script exit ${status}: ${output}" >&2
    return 1
  }
  # the rotation ran at the configured location, leaving exactly the window …
  kept="$(count_nightly_in "${relocated}")"
  [[ "${kept}" -eq "${RETAIN_COUNT}" ]] || {
    echo "nightly retained at the configured dir = ${kept}, expected ${RETAIN_COUNT}" >&2
    return 1
  }
  # … today's dump is one of them (the script wrote where it rotated) …
  [[ -n "$(find "${relocated}" -maxdepth 1 -type f -name "glass_atrium-$(date +%Y%m%d)-*.dump")" ]] || {
    echo "today's dump did not land at the configured dir; out=${output}" >&2
    return 1
  }
  # … and the default location was never written to.
  [[ "$(count_nightly_in "${BACKUP_DIR}")" -eq 0 ]] || {
    echo "dumps leaked to the default location while a relocation was configured" >&2
    return 1
  }
}

@test "AC-C3 an unreachable resolver library still dumps, with exactly one WARN" {
  local warns
  # A config that WOULD relocate, paired with a library that cannot be read: the
  # fallback must ignore the unread config and use the default location rather than
  # abort the unattended job.
  mkdir -p -- "${SANDBOX}/relocated"
  printf '[paths]\nbackup_dir = "%s"\n' "${SANDBOX}/relocated" >"${SANDBOX}/config.toml"

  run_backup_with "${SANDBOX}/config.toml" "${SANDBOX}/no-such-library.sh"
  [[ "${status}" -eq 0 ]] || {
    echo "library-absent run exited ${status}: ${output}" >&2
    return 1
  }
  [[ -n "$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "glass_atrium-$(date +%Y%m%d)-*.dump" -size +0c)" ]] || {
    echo "no dump at the default location on the fallback path; out=${output}" >&2
    return 1
  }
  # Exactly one WARN: the fallback is announced once, and nothing else warns on a
  # run this small (the rotation branch is the only other WARN emitter).
  warns="$(printf '%s\n' "${output}" | grep -c 'WARN' || true)"
  [[ -z "${warns}" ]] && warns=0
  [[ "${warns}" -eq 1 ]] || {
    echo "expected exactly 1 WARN line, got ${warns}; out=${output}" >&2
    return 1
  }
}

# --- creation mask (CWE-732) --------------------------------------------------
#
# A dump is the entire database in one file. Under the caller's default mask it
# lands 0644 in a 0755 directory, readable by every local account; the script sets
# a 077 mask around the two creating steps so a directory it creates is 0700 and
# the dump inside it 0600.

# Octal permission bits of $1. BSD and GNU stat spell this differently AND their
# flags collide (`-f` is a format on BSD, --file-system on GNU), so each errors out
# on the other platform and the `||` chain IS the branch.
mode_of() {
  stat -f '%Lp' -- "$1" 2>/dev/null || stat -c '%a' -- "$1" 2>/dev/null
}

@test "AC-C7 a backup dir and dump this script CREATES are owner-only (0700 / 0600)" {
  local fresh="${SANDBOX}/fresh-dumps" dump dir_mode dump_mode default_mode
  # ADR-6 case 3: the destination is absent and creatable and the default location
  # holds no dumps, so the script's own mkdir is what creates it — which is the only
  # shape where a creation mask can be observed at all.
  printf '[paths]\nbackup_dir = "%s"\n' "${fresh}" >"${SANDBOX}/config.toml"

  run_backup_with "${SANDBOX}/config.toml" "${GA}/scripts/lib/atrium-config.sh"
  [[ "${status}" -eq 0 ]] || {
    echo "script exit ${status}: ${output}" >&2
    return 1
  }
  dir_mode="$(mode_of "${fresh}")"
  [[ "${dir_mode}" == "700" ]] || {
    echo "created backup dir mode = ${dir_mode}, expected 700" >&2
    return 1
  }
  dump="$(find "${fresh}" -maxdepth 1 -type f -name 'glass_atrium-*.dump' | head -n 1)"
  [[ -n "${dump}" ]] || {
    echo "no dump landed at ${fresh}; out=${output}" >&2
    return 1
  }
  dump_mode="$(mode_of "${dump}")"
  [[ "${dump_mode}" == "600" ]] || {
    echo "dump mode = ${dump_mode}, expected 600" >&2
    return 1
  }
  # HONEST LIMIT, pinned so no reader mistakes the mask for a chmod: umask governs
  # CREATION only. The default location setup() pre-created keeps its own 0755 — the
  # script does not, and must not, silently re-mode a directory an operator made.
  default_mode="$(mode_of "${BACKUP_DIR}")"
  [[ "${default_mode}" == "755" ]] || {
    echo "the pre-existing dir was re-moded to ${default_mode}; the mask must not chmod" >&2
    return 1
  }
}
