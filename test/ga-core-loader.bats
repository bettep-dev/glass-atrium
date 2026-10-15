#!/usr/bin/env bats
# lib/ga-core.sh load contract: the thin loader refuses to load without a sibling the engine needs.
#
# Run via: bats test/ga-core-loader.bats
# Requires: bats, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source=scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  SANDBOX="$(mktemp -d -t ga-core-loader-bats.XXXXXX)"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

@test "sourcing the engine from a tree without the shared path guard fails loudly" {
  mkdir -p "${SANDBOX}/lib"
  cp -p -- "${GA}"/lib/ga-*.sh "${SANDBOX}/lib/"
  run bash -c 'source "$1/lib/ga-core.sh" && echo ENGINE_LOADED' _ "${SANDBOX}"
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${output}" == *"FATAL: cannot source the shared path guard"* ]] || return 1
  [[ "${output}" != *ENGINE_LOADED* ]]
}
