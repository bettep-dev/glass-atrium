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

  local switch
  for switch in "${GA_BATS_KILLSWITCHES[@]}"; do
    unset "${switch}"
  done
}

ga_bats_assert_hermetic() {
  local switch
  for switch in "${GA_BATS_KILLSWITCHES[@]}"; do
    if [[ -n "${!switch:-}" ]]; then
      printf 'kill switch inherited from the ambient shell: %s\n' "${switch}" >&2
      return 1
    fi
  done
}
