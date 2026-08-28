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
@test "no python suite in this root escapes its sandbox state dir, reaches the model seam, or fails" {
  local home="${BATS_TEST_TMPDIR}/home" bin="${BATS_TEST_TMPDIR}/bin"
  local calls="${BATS_TEST_TMPDIR}/model-calls"
  mkdir -p "${home}" "${bin}"
  printf '#!/bin/sh\nprintf x >>"%s"\nexit 1\n' "${calls}" >"${bin}/claude"
  chmod +x "${bin}/claude"

  # The exit code is CAPTURED, not dropped: a dropped code let a red suite read green
  # here, and this probe is reached by the same runner leg that gates the daemon's apply.
  # The trailer assertion stays alongside it — a collection error also exits non-zero, and
  # the trailer is what distinguishes "the suite ran and failed" from "nothing ran". It
  # carries no count literal deliberately: the suite grows, and a pinned total would be a
  # second thing to maintain for no added signal.
  local log="${BATS_TEST_TMPDIR}/discover.log"
  local rc=0
  env -u ATRIUM_UPDATE_STATE_DIR -u AUTOAGENT_CLAUDE_BIN \
    HOME="${home}" PATH="${bin}:${PATH}" \
    python3 -m unittest discover -s "${BATS_TEST_DIRNAME}" -p 'test_*.py' \
    >"${log}" 2>&1 || rc=$?

  # Every assertion below gates on its own status. On bash 3.2 a FAILING bare `[[ ]]` in
  # mid-body does not abort the test (measured: bash 3.2.57 + bats 1.13.0 — the `[ ]`
  # builtin form does abort, the `[[ ]]` keyword form does not), so a mid-body `[[ ]]`
  # would be an assertion that can never fail.
  [[ "${rc}" -eq 0 ]] || {
    printf 'unittest discover exited %s; tail of the run log:\n' "${rc}" >&2
    tail -n 20 "${log}" >&2
    return 1
  }

  grep -qE '^Ran [1-9][0-9]* tests?' "${log}" || {
    printf 'no run trailer in the discover log — nothing ran:\n' >&2
    tail -n 20 "${log}" >&2
    return 1
  }

  # Both tail assertions carry their own diagnostic, matching the hooks twin: the bare
  # `[ ]` form they replace does abort on failure, but it names only a line number, and
  # what this probe is worth on a red run is the path it left behind.
  local escaped
  escaped="$(find "${home}" -type f)"
  [[ -z "${escaped}" ]] || {
    printf 'files written under the sandbox state dir:\n%s\n' "${escaped}" >&2
    return 1
  }

  [[ ! -e "${calls}" ]] || {
    printf 'the model seam was reached %s time(s) despite the PATH stub\n' \
      "$(wc -c <"${calls}" | tr -d ' ')" >&2
    return 1
  }
}
