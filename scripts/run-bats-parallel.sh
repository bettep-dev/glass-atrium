#!/usr/bin/env bash
# run-bats-parallel.sh — run the full Bats suite with file-level parallelism.
#
# Runs all 4 test roots (test/ hooks/test/ scripts/test/ autoagent/test/) under
# `bats --jobs <N> --no-parallelize-within-files`: files run concurrently while
# tests WITHIN a file stay sequential, preserving setup_file-once and ordered-
# side-effect semantics. The job count derives from the host core count at
# runtime (macOS sysctl first, GNU nproc fallback for Linux).
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

main() {
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
  printf 'run-bats-parallel: bats --jobs %s --no-parallelize-within-files over %s\n' \
    "${job_count}" "${TEST_ROOTS[*]}" >&2
  exec bats --jobs "${job_count}" --no-parallelize-within-files --recursive "${TEST_ROOTS[@]}"
}

main "$@"
