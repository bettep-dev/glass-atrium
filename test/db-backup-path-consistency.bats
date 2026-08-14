#!/usr/bin/env bats
# DB backup path consistency — every user-facing string naming the pg_dump
# backup dir must match the real default (lib/ga-db.sh, scripts/pg-backup.sh:
# ${GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres). One of those strings
# is the DROP typed-confirm pre-gate, so a stale path is read exactly when the
# user is deciding whether data is recoverable.
#
# Run via: bats test/db-backup-path-consistency.bats
# Requires: bats (brew install bats-core), git, bash 3.2+
#
# TRACKED-CONTENT SCAN: this file ships to the live install, where the scan root
# is not a git checkout but does hold user-owned config and monitor documents
# that legitimately quote the legacy path. A filesystem-wide scan there fails for
# the wrong reason and reds the apply gate, so the guard scopes itself to
# git-tracked files and goes inert off a checkout root.
#
# SELF-TRIP HAZARD: this file is inside the scanned tree, so the stale needle is
# assembled at runtime from two fragments and never appears literally here.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# The 3 legacy-path strings in test/oss-db-setup.bats are NEGATIVE assertions
# (the legacy dir must NOT be created) — correcting them would invert the test.
NEGATIVE_ASSERTION_FILE="test/oss-db-setup.bats"

# `-ef` (same inode) rather than string equality: a symlinked checkout resolves
# to a different spelling of the same root.
is_repo_root() {
  local top
  top="$(git -C "${GA}" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ -n "${top}" ]] || return 1
  [[ "${top}" -ef "${GA}" ]]
}

@test "no stale legacy backup path remains in tracked files" {
  local needle hits
  is_repo_root || skip "scan root is not a git checkout root: ${GA}"
  needle=".claude/backups/""postgres"
  hits="$(git -C "${GA}" grep -nIF --full-name -e "${needle}" \
    -- '.' ":(exclude)${NEGATIVE_ASSERTION_FILE}" || true)"
  [[ -z "${hits}" ]] || { printf 'stale backup path sites:\n%s\n' "${hits}" >&2; return 1; }
}

@test "the real default still resolves under the GA data root" {
  grep -q 'backups/postgres' "${GA}/lib/ga-db.sh"
  grep -q 'GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres' "${GA}/scripts/pg-backup.sh"
}
