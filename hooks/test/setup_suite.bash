#!/usr/bin/env bash
# Suite-level hermetic baseline for this bats directory. bats resolves setup_suite.bash
# per test-file DIRECTORY, so each directory holding suites carries its own loader.

setup_suite() {
  # shellcheck source-path=SCRIPTDIR source=../../test/lib/bats-hermetic-env.bash
  source "${BASH_SOURCE%/*}/../../test/lib/bats-hermetic-env.bash"
  ga_bats_hermetic_env
  ga_bats_isolate_pg
}

# Hooks connect host-less (psycopg.connect("dbname=glass_atrium")), so libpq's default socket — the
# operator's live database on a developer machine — receives any write a suite does not redirect.
# Default → a socket dir that never exists: a suite needing a database names its own ephemeral
# cluster (lib/ephemeral-pg.bash), and a forgotten redirect fails closed.
# The invoking shell's target is kept for leak gates (eph_pg_query_caller_target).
# Kept out of the shared test/lib/bats-hermetic-env.bash → the autoagent corpus is unaffected.
ga_bats_isolate_pg() {
  export GA_BATS_CALLER_PGHOST="${PGHOST:-}" GA_BATS_CALLER_PGPORT="${PGPORT:-}"
  export PGHOST="${BATS_RUN_TMPDIR}/no-pg-socket"
  unset PGHOSTADDR PGSERVICE
}
