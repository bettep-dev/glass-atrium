#!/usr/bin/env bash
# pg-backup.sh — nightly pg_dump of the `glass_atrium` database, with 14-dump rotation.
# Runs from launchd at 02:30 daily
# (com.glass-atrium.pg-backup). Idempotent and safe to invoke manually any time.
#
# Storage:   ~/.claude/backups/postgres/glass_atrium-YYYYMMDD-HHMMSS.dump (custom -F c)
# Retention: keep 14 newest dumps; older ones moved to ~/.Trash/ (NEVER rm —
#            per feedback_delete_to_trash.md and global file-deletion policy).
# Auth:      peer authentication via Unix socket (/tmp). Socket-only absolute —
#            NEVER use -h, -p, or any TCP form. listen_addresses='' by design.
set -Eeuo pipefail
IFS=$'\n\t'

readonly BACKUP_DIR="${HOME}/.claude/backups/postgres"
readonly TRASH_DIR="${HOME}/.Trash"
readonly RETAIN_COUNT=14
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
readonly TIMESTAMP
readonly FILENAME="glass_atrium-${TIMESTAMP}.dump"
readonly DUMP_PATH="${BACKUP_DIR}/${FILENAME}"

log() {
  printf '[pg-backup] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

trap 'die "line ${LINENO}: ${BASH_COMMAND}"' ERR

# 1. Ensure backup directory exists. mkdir -p is idempotent.
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

dump_bytes="$(stat -f '%z' "${DUMP_PATH}")"
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
  done < <(
    printf '%s\n' "${all_dumps[@]}" \
      | sort -r 2>/dev/null \
      | awk -v keep="${RETAIN_COUNT}" 'NR>keep' \
      || true
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
