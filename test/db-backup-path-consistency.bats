#!/usr/bin/env bats
# DB backup path consistency — every user-facing string naming the pg_dump
# backup dir must match the real default (lib/ga-db.sh, scripts/pg-backup.sh:
# ${GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres). One of those strings
# is the DROP typed-confirm pre-gate, so a stale path is read exactly when the
# user is deciding whether data is recoverable.
#
# Run via: bats test/db-backup-path-consistency.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# SELF-TRIP HAZARD: this file is inside the scanned tree, so the stale needle is
# assembled at runtime from two fragments and never appears literally here.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# The 3 legacy-path strings in test/oss-db-setup.bats are NEGATIVE assertions
# (the legacy dir must NOT be created) — correcting them would invert the test.
# The `./` prefix is optional because some grep builds strip it from -r output.
NEGATIVE_ASSERTION_FILE="^\(\./\)\?test/oss-db-setup\.bats:"

@test "no stale legacy backup path remains outside the negative assertions" {
  local needle hits
  needle=".claude/backups/""postgres"
  cd -- "${GA}"
  hits="$(grep -rn -- "${needle}" . \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=worktrees \
    | grep -v "${NEGATIVE_ASSERTION_FILE}" || true)"
  [[ -z "${hits}" ]] || { printf 'stale backup path sites:\n%s\n' "${hits}" >&2; return 1; }
}

@test "the real default still resolves under the GA data root" {
  grep -q 'backups/postgres' "${GA}/lib/ga-db.sh"
  grep -q 'GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres' "${GA}/scripts/pg-backup.sh"
}
