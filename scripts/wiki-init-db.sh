#!/usr/bin/env bash
# wiki-init-db.sh — idempotent SQLite FTS5 index initializer.
# Creates ${WIKI_ROOT}/index/wiki.sqlite (if missing) + applies wiki-schema.sql;
# idempotent (schema is CREATE ... IF NOT EXISTS throughout).
#
# Usage:
#   wiki-init-db.sh            # init or migrate in place
#   wiki-init-db.sh --force    # drop existing DB first (DESTRUCTIVE)

set -Eeuo pipefail
IFS=$'\n\t'

# SCRIPT_DIR: resolve the schema relative to this script so a moved/symlinked
# checkout finds its own sibling wiki-schema.sql (same idiom as pii-scan.sh).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
readonly SCRIPT_DIR

# WIKI_ROOT: single source of truth for the wiki data root. Default = the
# glass-atrium store; WIKI_ROOT env overrides for tests / alternate roots.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
readonly WIKI_ROOT
readonly WIKI_BASE="${WIKI_ROOT}"
readonly DB_PATH="${WIKI_ROOT}/index/wiki.sqlite"
# Prefer the sibling schema; fall back to the store copy (scripts/ is consumed
# in place from ~/.glass-atrium — the ~/.claude/scripts farm is gone).
if [[ -f "${SCRIPT_DIR}/wiki-schema.sql" ]]; then
  readonly SCHEMA_PATH="${SCRIPT_DIR}/wiki-schema.sql"
else
  readonly SCHEMA_PATH="${HOME}/.glass-atrium/scripts/wiki-schema.sql"
fi

log() { printf '[wiki-init-db] %s\n' "$*" >&2; }
die() { printf '[wiki-init-db] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "${SCHEMA_PATH}" ]] || die "schema not found: ${SCHEMA_PATH}"
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not in PATH"

mkdir -p "${WIKI_BASE}/index"

if [[ "${1:-}" == "--force" ]]; then
  if [[ -f "${DB_PATH}" ]]; then
    log "force mode: moving existing DB to trash"
    mv -- "${DB_PATH}" "${HOME}/.Trash/wiki.sqlite.$(date +%Y%m%d-%H%M%S)"
  fi
fi

if [[ -f "${DB_PATH}" ]]; then
  log "existing DB detected; applying schema (idempotent)"
else
  log "creating new DB at ${DB_PATH}"
fi

sqlite3 "${DB_PATH}" < "${SCHEMA_PATH}"

# Sanity check: verify required objects exist.
actual="$(sqlite3 "${DB_PATH}" "
  SELECT name FROM sqlite_master
  WHERE name IN ('notes','notes_fts','notes_tri','dirty_flag','notes_ai','notes_ad','notes_au')
  ORDER BY name;
")"
required=$'dirty_flag\nnotes\nnotes_ad\nnotes_ai\nnotes_au\nnotes_fts\nnotes_tri'
if [[ "${actual}" != "${required}" ]]; then
  die "schema sanity check failed; got: ${actual}"
fi

log "ready: ${DB_PATH}"
