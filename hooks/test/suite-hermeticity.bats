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
# reaches the operator's real runtime state, because ga_paths.get_base_root falls back to
# $HOME/.glass-atrium whenever GA_DATA_ROOT is unset. Redirecting HOME and asserting the
# redirect stayed empty catches that for EVERY module at once, including one added later —
# which is what makes this cheaper than auditing each module's own sandboxing.
#
# The discover exit code is asserted here, as it is in the autoagent twin. These suites
# are the runner's stage 2 and their verdict becomes the runner's rc, so a dropped code
# here would report a red stage as green.
@test "no python suite in this root escapes its sandbox HOME or fails" {
  local home="${BATS_TEST_TMPDIR}/home"
  local log="${BATS_TEST_TMPDIR}/discover.log"
  local rc=0
  mkdir -p "${home}"

  # GA_DATA_ROOT is unset deliberately: with it set, the HOME fallback this probe watches
  # is never taken. PYTHONDONTWRITEBYTECODE keeps a direct `bats hooks/test/...` run from
  # dropping __pycache__ into this tracked corpus; the runner exports it for its own children.
  env -u GA_DATA_ROOT -u ATRIUM_UPDATE_STATE_DIR \
    HOME="${home}" PYTHONDONTWRITEBYTECODE=1 \
    python3 -m unittest discover -s "${BATS_TEST_DIRNAME}" -p 'test_*.py' \
    >"${log}" 2>&1 || rc=$?

  # Every assertion gates on its own status. On bash 3.2 a FAILING bare `[[ ]]` in mid-body
  # does not abort the test (measured: bash 3.2.57 + bats 1.13.0 — the `[ ]` builtin form
  # does abort, the `[[ ]]` keyword form does not), so a mid-body `[[ ]]` would be an
  # assertion that can never fail.
  [[ "${rc}" -eq 0 ]] || {
    printf 'unittest discover exited %s; tail of the run log:\n' "${rc}" >&2
    tail -n 20 "${log}" >&2
    return 1
  }

  # A collection error also exits non-zero, so the trailer is what separates "the suites ran"
  # from "nothing ran". No count literal: the corpus grows, and a pinned total would be a
  # second thing to maintain for no added signal.
  grep -qE '^Ran [1-9][0-9]* tests?' "${log}" || {
    printf 'no run trailer in the discover log — nothing ran:\n' >&2
    tail -n 20 "${log}" >&2
    return 1
  }

  local escaped
  escaped="$(find "${home}" -type f)"
  [[ -z "${escaped}" ]] || {
    printf 'files written under the sandbox HOME:\n%s\n' "${escaped}" >&2
    return 1
  }
}
