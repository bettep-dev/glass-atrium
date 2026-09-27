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

  ga_bats_set_scratch_cwd
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
