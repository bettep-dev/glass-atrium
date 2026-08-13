#!/usr/bin/env bats
# Suite-level hermetic baseline pin for this bats directory.
#
# Fails when setup_suite.bash is not auto-loaded (a bats action default below 1.7, a moved
# file), so the hermetic baseline can never be silently unpinned by silent discovery.

@test "setup_suite discovery sentinel is exported" {
  [[ "${GA_BATS_SUITE_SETUP:-}" == "1" ]]
}

@test "hook kill switches are cleared from the suite environment" {
  [[ -z "${DOC_ROUTING_LEAK_OFF:-}" ]] && [[ -z "${SYNTAX_GATE_OFF:-}" ]] &&
    [[ -z "${SUBAGENT_TOOL_BUDGET_OFF:-}" ]] && [[ -z "${SUBAGENT_BUDGET_METER_OFF:-}" ]]
}
