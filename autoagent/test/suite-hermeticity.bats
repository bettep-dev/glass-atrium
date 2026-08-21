#!/usr/bin/env bats
# Suite-level hermetic baseline pin for this bats directory, plus the write-escape probe
# for the python suites that share it.
#
# Fails when setup_suite.bash is not auto-loaded (a bats action default below 1.7, a moved
# file), so the hermetic baseline can never be silently unpinned by silent discovery.

bats_require_minimum_version 1.5.0

setup() {
  load '../../test/lib/bats-hermetic-env'
}

@test "setup_suite discovery sentinel is exported" {
  [[ "${GA_BATS_SUITE_SETUP:-}" == "1" ]]
}

@test "hook kill switches are cleared from the suite environment" {
  ga_bats_assert_hermetic
}

# The python suites in this directory are driven by `unittest discover`, which offers no
# directory-scoped setup hook: each module pins its own sandbox, and a module that forgets
# reaches the operator's real state root, because editable_merge.state_root falls back to
# $HOME/.claude/data/update whenever ATRIUM_UPDATE_STATE_DIR is unset. Redirecting HOME and
# asserting the redirect stayed empty catches that for EVERY module at once, including one
# added later.
#
# The two escapes are independent and the probe watches both. A decision record is written on
# the arbiter's failure arms too, so a state-dir escape is reachable with the model seam
# already closed; and the seam is reachable without any record landing outside the sandbox,
# because daemon_cycle.CLAUDE_BIN and gap_arbiter.get_decision's keyword default both freeze
# at import, ahead of any per-module hook. The PATH stub therefore both spends no model budget
# and counts what reached it.
@test "no python suite in this root escapes its sandbox state dir or the model seam" {
  local home="${BATS_TEST_TMPDIR}/home" bin="${BATS_TEST_TMPDIR}/bin"
  local calls="${BATS_TEST_TMPDIR}/model-calls"
  mkdir -p "${home}" "${bin}"
  printf '#!/bin/sh\nprintf x >>"%s"\nexit 1\n' "${calls}" >"${bin}/claude"
  chmod +x "${bin}/claude"

  # A failing python suite is the python leg's verdict, not this probe's — the run's exit
  # code is deliberately dropped. The trailer assertion below is what keeps the drop from
  # turning a suite that never ran into a silent pass.
  local log="${BATS_TEST_TMPDIR}/discover.log"
  env -u ATRIUM_UPDATE_STATE_DIR -u AUTOAGENT_CLAUDE_BIN \
    HOME="${home}" PATH="${bin}:${PATH}" \
    python3 -m unittest discover -s "${BATS_TEST_DIRNAME}" -p 'test_*.py' \
    >"${log}" 2>&1 || true

  grep -qE '^Ran [1-9][0-9]* tests?' "${log}"

  run find "${home}" -type f
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]

  [ ! -e "${calls}" ]
}
