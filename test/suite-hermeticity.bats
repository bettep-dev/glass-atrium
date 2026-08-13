#!/usr/bin/env bats
# Suite-level hermetic baseline pin for this bats directory.
#
# Fails when setup_suite.bash is not auto-loaded (a bats action default below 1.7, a moved
# file), so the hermetic baseline can never be silently unpinned by silent discovery.

setup() {
  load 'lib/bats-hermetic-env'
}

@test "setup_suite discovery sentinel is exported" {
  [[ "${GA_BATS_SUITE_SETUP:-}" == "1" ]]
}

@test "hook kill switches are cleared from the suite environment" {
  ga_bats_assert_hermetic
}
