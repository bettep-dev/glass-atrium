#!/usr/bin/env bash
# Suite-level hermetic baseline for this bats directory. bats resolves setup_suite.bash
# per test-file DIRECTORY, so each directory holding suites carries its own loader.

setup_suite() {
  # shellcheck source-path=SCRIPTDIR source=../../test/lib/bats-hermetic-env.bash
  source "${BASH_SOURCE%/*}/../../test/lib/bats-hermetic-env.bash"
  ga_bats_hermetic_env
}
