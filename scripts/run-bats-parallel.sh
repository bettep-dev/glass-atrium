#!/usr/bin/env bash
# run-bats-parallel.sh — run the harness verification suite as three staged runs.
#
# Stage 1 runs all 4 bats roots (test/ hooks/test/ scripts/test/ autoagent/test/)
# under `bats --jobs <N> --no-parallelize-within-files`: files run concurrently while
# tests WITHIN a file stay sequential, preserving setup_file-once and ordered-
# side-effect semantics. The job count derives from the host core count at
# runtime (macOS sysctl first, GNU nproc fallback for Linux).
# Stage 2 runs the hooks/test unittest suites in a sandbox HOME; stage 3 runs the
# scripts/test pytest suites, but only when pytest is importable.
#
# The stages are RUN, not `exec`'d, and the runner exits with the MAXIMUM stage rc
# rather than the last one — a stage-1 failure must not be erased by green python
# stages, and a python failure must not be erased by green bats. The self-improvement
# daemon reaches the suite ONLY through this script and consumes only its exit code
# (autoagent/daemon-apply.sh green-suite gate), so a python-stage failure becomes a
# gate failure with no extra wiring.
#
# Every stage prints a banner carrying its DURATION, because that gate re-runs the
# WHOLE runner once on a first failure (daemon-apply.sh green_gate_flaky_retry): the
# cost of the python stages is paid TWICE on a red cycle, and the banner is what
# makes that cost visible in the daemon log.
#
# CI does NOT come through here — it runs each .bats file as its own parallel job and
# installs its own python deps — so the commands below MIRROR the CI legs (test-python,
# test-python-pytest) rather than sharing code with them. The one deliberate deviation
# is verbosity: CI passes -v because it post-processes the log into a job summary, while
# this runner's consumer is an unattended daemon log.
#
# Sequential fallback (to isolate a parallel-only flake):
#   bats --recursive test/ hooks/test/ scripts/test/ autoagent/test/
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly TEST_ROOTS=(test hooks/test scripts/test autoagent/test)
readonly HOOKS_TEST_ROOT=hooks/test
readonly SCRIPTS_TEST_ROOT=scripts/test

SANDBOX_HOME=""
# Out-parameter of run_stage. A stage's rc is reported HERE rather than as run_stage's
# own return value: a `run_stage … || rc=$?` call site would disable set -e for the
# whole call (SC2310), and the rc is data to be folded, not a failure to propagate.
STAGE_RC=0

# SC2329: invoked indirectly by the EXIT trap below — not dead code.
# shellcheck disable=SC2329
cleanup() {
  if [[ -n "${SANDBOX_HOME}" && -d "${SANDBOX_HOME}" ]]; then
    rm -rf -- "${SANDBOX_HOME}"
  fi
}
trap cleanup EXIT

# run_stage — run one stage, publish its exit code in STAGE_RC, and print a
# duration-carrying banner to stderr. Always returns 0: the caller folds STAGE_RC.
# Duration comes from SECONDS (integer, bash 3.2-safe) because BSD date has no %N.
# $1 = banner label · $2.. = the command and its arguments
run_stage() {
  local label="${1}"
  shift
  local t0="${SECONDS}"
  STAGE_RC=0
  "$@" || STAGE_RC=$?
  printf 'run-bats-parallel: [%s] rc=%s (%ss)\n' \
    "${label}" "${STAGE_RC}" "$((SECONDS - t0))" >&2
}

main() {
  # Exported at main entry so EVERY child — bats, unittest, pytest and anything they
  # spawn — inherits it. Without it a child that imports a module drops __pycache__
  # into a corpus directory, which the live recovery-repo snapshot screen refuses as
  # untracked (scripts/snapshot-live-repos.sh). Daemon, operator and manual runs all
  # pass through this one entry point.
  export PYTHONDONTWRITEBYTECODE=1

  command -v bats >/dev/null 2>&1 || {
    printf 'run-bats-parallel: bats not found (brew install bats-core)\n' >&2
    exit 1
  }
  # GNU parallel is a HARD dependency of `bats --jobs` — without it bats silently
  # falls back to serial, so loud-fail here rather than run an unintended sequential pass.
  command -v parallel >/dev/null 2>&1 || {
    printf 'run-bats-parallel: GNU parallel not found — required by bats --jobs (brew install parallel)\n' >&2
    exit 1
  }
  # python3 carries stages 2 and 3. Absent, both would contribute rc 0 and the green
  # gate would pass on a suite half of which never ran — loud-fail instead.
  command -v python3 >/dev/null 2>&1 || {
    printf 'run-bats-parallel: python3 not found — required by the %s unittest stage\n' \
      "${HOOKS_TEST_ROOT}" >&2
    exit 1
  }

  # macOS ships no nproc (GNU coreutils only); sysctl hw.ncpu is the BSD core source.
  local job_count=""
  if command -v sysctl >/dev/null 2>&1; then
    job_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [[ -z "${job_count}" ]] && command -v nproc >/dev/null 2>&1; then
    job_count="$(nproc)"
  fi
  [[ -n "${job_count}" ]] || job_count=4

  cd -- "${REPO_ROOT}"

  local total_t0="${SECONDS}"
  local worst=0

  printf 'run-bats-parallel: bats --jobs %s --no-parallelize-within-files over %s\n' \
    "${job_count}" "${TEST_ROOTS[*]}" >&2

  run_stage 'stage 1/3 bats' \
    bats --jobs "${job_count}" --no-parallelize-within-files --recursive "${TEST_ROOTS[@]}"
  if ((STAGE_RC > worst)); then worst="${STAGE_RC}"; fi

  # The unittest suites are hermetic under a sandbox HOME (they write nothing below
  # it), so the stage cannot mutate the operator's real home on a daemon-driven run.
  SANDBOX_HOME="$(mktemp -d -t run-bats-parallel-home.XXXXXX)"
  run_stage "stage 2/3 ${HOOKS_TEST_ROOT} unittest" \
    env "HOME=${SANDBOX_HOME}" python3 -m unittest discover -s "${HOOKS_TEST_ROOT}" -p 'test_*.py'
  if ((STAGE_RC > worst)); then worst="${STAGE_RC}"; fi

  # Stage 3 is conditional: the live install has no pytest, and the honest outcome
  # there is a LOUD skip (one stderr line naming the interpreter) rather than a silent
  # pass. The probe's own stderr is suppressed because the skip line below is the
  # message the operator should read — the ModuleNotFoundError traceback is noise.
  if python3 -c 'import pytest' >/dev/null 2>&1; then
    run_stage "stage 3/3 ${SCRIPTS_TEST_ROOT} pytest" \
      python3 -m pytest "${SCRIPTS_TEST_ROOT}/" --color=no
    if ((STAGE_RC > worst)); then worst="${STAGE_RC}"; fi
  else
    local python3_path
    python3_path="$(command -v python3)"
    printf 'run-bats-parallel: [stage 3/3 %s pytest] SKIPPED — pytest is not importable by %s (0s)\n' \
      "${SCRIPTS_TEST_ROOT}" "${python3_path}" >&2
  fi

  printf 'run-bats-parallel: stages complete rc=%s (total %ss)\n' \
    "${worst}" "$((SECONDS - total_t0))" >&2
  exit "${worst}"
}

main "$@"
