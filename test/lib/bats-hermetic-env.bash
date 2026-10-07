#!/usr/bin/env bash
# Suite-level hermetic environment baseline, shared by every bats corpus setup file.
#
# WHY: a kill switch exported in the ambient shell (an operator disabling a hook while
# debugging, a stale export in a CI runner) turns a suite green without the hook ever
# running — the suite would then prove the shell's state, not the hook's behaviour.
# Each corpus keeps only a thin loader because bats' setup-file lookup is
# DIRECTORY-scoped, not corpus-scoped.

# One declaration of the switch list: ga_bats_hermetic_env unsets it, ga_bats_assert_hermetic
# pins it — a switch added here is cleared AND asserted by every corpus with no further edit.
GA_BATS_KILLSWITCHES=(
  DOC_ROUTING_LEAK_OFF
  SYNTAX_GATE_OFF
  SUBAGENT_BUDGET_METER_OFF
  SUBAGENT_TOOL_BUDGET_OFF
  SUBAGENT_TOOL_BUDGET
  SUBAGENT_TOOL_BUDGET_DIR
  SUBAGENT_NOPROGRESS_BLOCK
  SUBAGENT_NOPROGRESS_BLOCK_LIMIT
  SUBAGENT_NOPROGRESS_DISARM
  SUBAGENT_NOPROGRESS_LIMIT
  WORKTREE_WRITER_LOCK_OFF
  WORKTREE_LOCK_DIR
  WORKTREE_LOCK_TTL_SECS
)

# libpq names that outrank or reroute PGHOST — cleared so only the dead PGHOST below routes a
# host-less connection. One declaration: test/bats-db-seal.bats asserts each one cleared.
GA_BATS_PG_ROUTING_NAMES=(PGPORT PGHOSTADDR PGSERVICE PGDATABASE PGPASSFILE)

ga_bats_hermetic_env() {
  # Discovery sentinel — a bats version that stops auto-loading the setup file makes the
  # per-corpus sentinel assertion fail loudly instead of silently unpinning this baseline.
  export GA_BATS_SUITE_SETUP=1

  # Port a sandboxed run may curl without reaching anything: privileged, never bound by a
  # user process, so the connect is refused immediately. Suites that shell a port-resolving
  # section pass this as ATRIUM_MONITOR_PORT — pinning the variable HERE instead would break
  # the suites whose subject IS the resolver reading monitor/.env.
  export GA_DOCTOR_DEAD_PORT=1

  local switch
  for switch in "${GA_BATS_KILLSWITCHES[@]}"; do
    unset "${switch}"
  done

  ga_bats_set_scratch_cwd || return 1

  # Dead PGHOST: a host-less libpq connection (psql, a hook's psycopg "dbname=glass_atrium") fails on
  # a socket path that never exists instead of reaching the live server on the default /tmp socket.
  # Set here so every entrypoint inherits it — direct bats, CI per-file jobs, the live-suite runner.
  # An ephemeral-cluster suite exports its own PGHOST over it.
  export PGHOST="${BATS_RUN_TMPDIR}/no-pg-socket"
  local name
  for name in "${GA_BATS_PG_ROUTING_NAMES[@]}"; do
    unset "${name}"
  done

  # Runtime log/data root, same family as the dead PGHOST: shell hooks, python consumers and the
  # launcher resolve logs/ and data/ from GA_DATA_ROOT before $HOME/.glass-atrium, so a hook a test
  # runs with no seam of its own writes here, not into the live logs a daemon ingests.
  # Overridden, never defaulted → an ambient live-root export (a launcher-driven run) cannot leak in.
  # A suite whose subject IS the HOME fallback unsets it on the command it drives.
  export GA_DATA_ROOT="${BATS_RUN_TMPDIR}/ga-data-root"
  # the chunked part-hooks resolve their diag sink from the rules root, not GA_DATA_ROOT
  export GA_CHUNK_SINK="${GA_DATA_ROOT}/logs/inject-scope-chunk.diag.log"
  mkdir -p "${GA_DATA_ROOT}/logs" "${GA_DATA_ROOT}/data" || return 1
}

# Scratch-cwd seat: each test starts in BATS_SUITE_TMPDIR.
# A script a test starts from there → its cwd-relative delete lands in the run's scratch tree.
# Accident safety net, not a boundary → a test body or script that cds on its own leaves the seat.
# Seat not taken → the whole run is refused, not warned.
# The run root resolves BEFORE the cd — a relative --tempdir resolves against the start cwd.
ga_bats_set_scratch_cwd() {
  local run_root
  if ! run_root="$(ga_bats_get_run_root)" || [[ -z "${BATS_SUITE_TMPDIR:-}" ]] \
    || ! cd -- "${BATS_SUITE_TMPDIR}"; then
    printf 'refusing the run: cannot enter BATS_SUITE_TMPDIR (%s) under BATS_RUN_TMPDIR (%s)\n' \
      "${BATS_SUITE_TMPDIR:-unset}" "${BATS_RUN_TMPDIR:-unset}" >&2
    return 1
  fi
  local cwd
  cwd="$(pwd -P)"
  if [[ "${cwd}" != "${run_root}/"* ]]; then
    printf 'refusing the run: cwd %s is not under BATS_RUN_TMPDIR (%s)\n' "${cwd}" "${run_root}" >&2
    return 1
  fi
}

ga_bats_assert_hermetic() {
  local switch
  for switch in "${GA_BATS_KILLSWITCHES[@]}"; do
    if [[ -n "${!switch:-}" ]]; then
      printf 'kill switch inherited from the ambient shell: %s\n' "${switch}" >&2
      return 1
    fi
  done

  local run_root cwd
  cwd="$(pwd -P)"
  if ! run_root="$(ga_bats_get_run_root)" || [[ "${cwd}" != "${run_root}/"* ]]; then
    printf 'test cwd %s is not under BATS_RUN_TMPDIR (%s)\n' "${cwd}" "${BATS_RUN_TMPDIR:-unset}" >&2
    return 1
  fi
}

# Physical path of the bats run's scratch root — `pwd -P` is physical too, and TMPDIR on
# macOS sits behind the /var -> /private/var symlink, so a logical compare never matches.
ga_bats_get_run_root() {
  [[ -n "${BATS_RUN_TMPDIR:-}" ]] || return 1
  (cd -P -- "${BATS_RUN_TMPDIR}" && pwd)
}
