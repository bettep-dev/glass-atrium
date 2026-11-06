#!/usr/bin/env bash
# Suite-level hermetic baseline for the hooks/test root. bats runs ONE setup_suite.bash per
# call — the first argument's directory's — so this file governs hooks/test only when hooks/test
# leads the call; every harness shape keeps it there (CI per file, scripts/run-bats-parallel.sh per root).

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
# Kept out of the shared test/lib/bats-hermetic-env.bash → the autoagent corpus is unaffected.
ga_bats_isolate_pg() {
  export PGHOST="${BATS_RUN_TMPDIR}/no-pg-socket"
  unset PGHOSTADDR PGSERVICE
}
