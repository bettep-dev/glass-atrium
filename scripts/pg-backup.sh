#!/usr/bin/env bash
# pg-backup.sh — nightly pg_dump of the `glass_atrium` database, with 14-dump rotation.
# Runs from launchd at 02:30 daily
# (com.glass-atrium.pg-backup). Idempotent and safe to invoke manually any time.
#
# Storage:   <atrium_backup_dir>/glass_atrium-YYYYMMDD-HHMMSS.dump (custom -F c) — the
#            directory is resolved by the shared ADR-6 resolver, never derived here.
# Retention: keep 14 newest dumps; older ones moved to ~/.Trash/ (NEVER rm —
#            per feedback_delete_to_trash.md and global file-deletion policy).
# Auth:      peer authentication via Unix socket (/tmp). Socket-only absolute —
#            NEVER use -h, -p, or any TCP form. listen_addresses='' by design.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly TRASH_DIR="${HOME}/.Trash"
readonly RETAIN_COUNT=14
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
readonly TIMESTAMP
readonly FILENAME="glass_atrium-${TIMESTAMP}.dump"

log() {
  printf '[pg-backup] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

trap 'die "line ${LINENO}: ${BASH_COMMAND}"' ERR

# Resolve the backup directory through the shared ADR-6 resolver, which is the ONE
# place that decides whether [paths].backup_dir is adopted. This script no longer
# derives the path itself, so an operator relocation reaches the nightly job.
#
# LIBRARY-ABSENT FALLBACK. This runs unattended from launchd, so a library that
# moved must not stop the dump: the default location is spelled here as the
# last-resort constant and the run continues after ONE loud WARN. That literal is
# pinned byte-equal to the resolver's own default by
# test/db-backup-path-consistency.bats — the duplication is deliberate (the SoT is
# unreachable in exactly the branch that needs it) and mechanically held equal.
#
# SEAM: ATRIUM_CONFIG_LIB is a TEST-ONLY override of the library PATH — the sandbox
# seam the bats suites pin, never an operator knob. Production always resolves the
# sibling path spelled below, the same way ATRIUM_CONFIG_TOML and GA_DB_BACKUP_DIR
# are labelled test/sandbox overrides in atrium-config.sh.
resolve_backup_dir() {
  local lib="${ATRIUM_CONFIG_LIB:-${SCRIPT_DIR}/lib/atrium-config.sh}"
  # An && chain, not `|| true`: every step's failure lands on the one fallback arm
  # below, so no status is discarded and set -e stays armed for the rest of the run.
  # shellcheck source-path=SCRIPTDIR source=lib/atrium-config.sh
  if [[ -r "${lib}" ]] && . "${lib}" && declare -F atrium_backup_dir >/dev/null; then
    atrium_backup_dir
    return 0
  fi
  log "WARN: backup-dir resolver unavailable (${lib}) — using the default location"
  printf '%s\n' "${GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres"
}

BACKUP_DIR="$(resolve_backup_dir)"
readonly BACKUP_DIR
readonly DUMP_PATH="${BACKUP_DIR}/${FILENAME}"

# 1. Ensure backup directory exists. mkdir -p is idempotent.
#
#    CREATION MASK (CWE-732). A dump is the entire database in one file, so it must
#    not land 0644 under the caller's default mask: 077 makes a directory this step
#    creates 0700 and the dump written at step 3 0600. The same user runs pg_restore,
#    so owner-only loses nothing.
#
#    SCOPED, not global — restored at step 4, before the rotation moves anything into
#    ~/.Trash, so the rest of the run keeps whatever mask the operator's environment
#    set. A `die` between here and there exits the process, which restores it too.
#
#    HONEST LIMIT: umask governs CREATION only. An already-existing backup directory
#    keeps the mode it has, and this step does not tighten it — that is the
#    reconciler's surface, not the nightly job's.
PRIOR_UMASK="$(umask)"
readonly PRIOR_UMASK
umask 077
mkdir -p "${BACKUP_DIR}"

# 2. Verify pg_dump is on PATH. Under launchd the EnvironmentVariables PATH
#    must include /opt/homebrew/bin (Apple-Silicon Homebrew) — fail loud if
#    not found rather than silently producing zero-byte dumps.
if ! command -v pg_dump >/dev/null 2>&1; then
  die "pg_dump not on PATH (PATH=${PATH})"
fi

# 3. Run the dump. Custom format (-F c) is compressed and supports parallel
#    pg_restore + selective TOC restore. Peer auth via Unix socket — no -h.
#    Dump file MUST exist with size > 0 after this step.
log "starting pg_dump → ${DUMP_PATH}"
if ! pg_dump -d glass_atrium -F c -f "${DUMP_PATH}"; then
  die "pg_dump failed (db=glass_atrium, target=${DUMP_PATH})"
fi

if [[ ! -s "${DUMP_PATH}" ]]; then
  die "pg_dump produced empty file: ${DUMP_PATH}"
fi

# Creation-mask scope ends here — everything below only MOVES files that already
# exist, so it runs under the operator's own mask.
umask "${PRIOR_UMASK}"

# POSIX byte count (identical on BSD+GNU) — NOT `stat -f`/`stat -c` (BSD/GNU-divergent:
# GNU `-f` means --file-system, so '%z' becomes a bad file operand and the ERR trap dies).
dump_bytes="$(wc -c <"${DUMP_PATH}" | tr -d '[:space:]')"
log "dump complete: ${DUMP_PATH} (${dump_bytes} bytes)"

# 4. Rotation: keep ${RETAIN_COUNT} newest dumps; move the rest to ~/.Trash/.
#    Ordering is by filename (timestamp embedded), which equals mtime order
#    by construction. macOS-safe: sort -r + awk 'NR>RETAIN' (no GNU head -n -N).
#    Candidate glob is the DATED nightly form `glass_atrium-[0-9]*.dump` ONLY:
#    keep-forever pre-uninstall dumps (`glass_atrium-pre-uninstall-*.dump`, set
#    by lib/ga-db.sh drop_databases) begin with `p`, so they are excluded and
#    never consume a rotation slot — else each would permanently shrink the
#    nightly retention depth below ${RETAIN_COUNT}.
#    Process-substitution avoids subshell variable scoping.
shopt -s nullglob
all_dumps=()
for dump_file in "${BACKUP_DIR}"/glass_atrium-[0-9]*.dump; do
  all_dumps+=("${dump_file}")
done
shopt -u nullglob

dump_total="${#all_dumps[@]}"
log "found ${dump_total} dump(s) in ${BACKUP_DIR}"

if ((dump_total > RETAIN_COUNT)); then
  # sort filenames descending (newest first), then drop the first RETAIN_COUNT.
  # SC2312 acceptance: pipeline failure here is non-fatal — empty output simply
  # leaves rotation_targets empty (no rotation), which the for-loop handles.
  rotation_targets=()
  while IFS= read -r old_path; do
    [[ -z "${old_path}" ]] && continue
    rotation_targets+=("${old_path}")
  done < <(# GA-ABSORB[benign]: pipeline failure yields an empty rotation set — a no-op, not a lost deliverable
    printf '%s\n' "${all_dumps[@]}" \
      | sort -r 2>/dev/null \
      | awk -v keep="${RETAIN_COUNT}" 'NR>keep' \
      || true # GA-ABSORB[benign]: same pipeline guard under pipefail — an empty rotation set is a valid no-op
  )

  for old_path in "${rotation_targets[@]}"; do
    base="$(basename "${old_path}")"
    # Avoid Trash-name collision by appending a millisecond-resolution suffix.
    trash_target="${TRASH_DIR}/${base}.$(date +%s)"
    if mv "${old_path}" "${trash_target}"; then
      log "rotated to trash: ${base} → ${trash_target}"
    else
      log "WARN: failed to rotate ${old_path} (continuing)"
    fi
  done
else
  log "rotation skipped: ${dump_total} ≤ ${RETAIN_COUNT}"
fi

log "done"
exit 0
