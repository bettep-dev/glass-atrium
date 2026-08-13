#!/usr/bin/env bash
# Suite-level hermetic environment baseline, shared by every bats corpus setup file.
#
# WHY: a kill switch exported in the ambient shell (an operator disabling a hook while
# debugging, a stale export in a CI runner) turns a suite green without the hook ever
# running — the suite would then prove the shell's state, not the hook's behaviour.
# Each corpus keeps only a thin loader because bats' setup-file lookup is
# DIRECTORY-scoped, not corpus-scoped.

ga_bats_hermetic_env() {
  # Discovery sentinel — a bats version that stops auto-loading the setup file makes the
  # per-corpus sentinel assertion fail loudly instead of silently unpinning this baseline.
  export GA_BATS_SUITE_SETUP=1

  # Hook / gate kill switches + budget overrides: never inherited from the ambient shell.
  unset DOC_ROUTING_LEAK_OFF
  unset SYNTAX_GATE_OFF
  unset SUBAGENT_BUDGET_METER_OFF
  unset SUBAGENT_TOOL_BUDGET_OFF
  unset SUBAGENT_TOOL_BUDGET
  unset SUBAGENT_TOOL_BUDGET_DIR
  unset SUBAGENT_NOPROGRESS_BLOCK
  unset SUBAGENT_NOPROGRESS_BLOCK_LIMIT
  unset SUBAGENT_NOPROGRESS_DISARM
  unset SUBAGENT_NOPROGRESS_LIMIT
}
