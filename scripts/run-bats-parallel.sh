#!/usr/bin/env bash
# run-bats-parallel.sh — run the harness verification suite as three staged runs.
#
# Stage 1 runs all 4 bats roots (test/ hooks/test/ scripts/test/ autoagent/test/)
# under `bats --jobs <N> --no-parallelize-within-files`: files run concurrently while
# tests WITHIN a file stay sequential, preserving setup_file-once and ordered-
# side-effect semantics. The job count derives from the host core count at
# runtime (macOS sysctl first, GNU nproc fallback for Linux).
# Stages 2 and 3 run the TWO unittest roots — hooks/test and autoagent/test — each in
# its OWN sandbox HOME with the data-root env scrubbed alongside it (see the stages
# themselves); stage 4 runs the scripts/test pytest suites under the SAME data-root
# scrub but WITHOUT a sandbox HOME (measured reason at the stage), and only when pytest
# is importable.
#
# TWO unittest roots because `unittest discover` takes a single -s — the same reason the
# CI test-python leg loops over the identical pair. They are separate STAGES rather than
# one looping stage because their environments differ: each runs under its OWN sandbox
# HOME (reason at SANDBOX_ROOT).
#
# EVERY stage, stage 1 included, additionally runs under DAEMON_ENV_SCRUB — the env the
# self-improvement daemon exports on its way here (rationale at the array itself).
#
# Both unittest corpora therefore run TWICE per invocation, deliberately: stage 1's
# <root>/suite-hermeticity.bats drives the same `unittest discover` to probe for sandbox
# escape, and the matching python stage then runs it as that corpus's own verdict. The
# probe asserts a property of the run (nothing escaped, something ran) while the stage
# owns the rc, and neither can stand in for the other. The daemon's one flaky-retry
# doubles the pair again on a red cycle, which the per-stage duration banners expose.
#
# The stages are RUN, not `exec`'d, and the runner exits with the MAXIMUM stage rc
# rather than the last one — a stage-1 failure must not be erased by green python
# stages, and a python failure must not be erased by green bats. The self-improvement
# daemon reaches the suite ONLY through this script and consumes only its exit code
# (autoagent/daemon-apply.sh green-suite gate), so a python-stage failure becomes a
# gate failure with no extra wiring. The ONE rc that is not a stage verdict is
# TOOLCHAIN_PRECONDITION_RC, raised before stage 1 (rationale at the constant).
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
# DAEMON_ENV_SCRUB is a deliberate divergence rather than a mirror gap: .github/workflows/
# ci.yml sets none of those variables, so a fresh runner carries no leak to scrub there.
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
readonly AUTOAGENT_TEST_ROOT=autoagent/test
readonly SCRIPTS_TEST_ROOT=scripts/test

# The exit code RESERVED for a toolchain precondition failure — a tool present but
# UNUSABLE, which is neither an absent binary nor a red suite. Chosen outside every
# rc a stage can fold into WORST_RC (pytest returns 1-5, bats and unittest 1) and
# below the shell's 126+ band, so no suite can produce it. autoagent/daemon-apply.sh
# mirrors the value to pick its abort clause, and scripts/test/run-bats-parallel.bats
# pins it, so a probe later moved into a folding position cannot promote it silently.
readonly TOOLCHAIN_PRECONDITION_RC=17

# The env autoagent/daemon-cycle.sh EXPORTS before daemon-apply.sh shells this runner,
# scrubbed from every stage so the gate verifies each suite against its own fixture rather
# than the daemon's ambient config.
#
# AUTOAGENT_GIT_ROOT is the one member measured to change a verdict: daemon_cycle.
# _resolve_apply_git_scope short-circuits on it by documented design, so a suite pinning
# that resolution against its own work tree instead reads the operator's install. The other
# two git-family names carry no measured delta and ride along for consistency — the three
# are exported in ONE block, and scrubbing a single member leaves a half-seam the next one
# comes through.
#
# The two claude-binary names generalize the scrub stage 3 already carried alone. It is NOT
# a model-seam closure: CLAUDE_BIN defaults to a bare name, so dropping an absolute-path pin
# leaves PATH resolution intact. What closes that seam is a PATH stub, which
# autoagent/test/suite-hermeticity.bats installs and this runner does not.
readonly DAEMON_ENV_SCRUB=(
  -u AUTOAGENT_GIT_ROOT
  -u AUTOAGENT_GIT_PATHSPEC
  -u AUTOAGENT_AGENTS_DIR
  -u AUTOAGENT_CLAUDE_BIN
  -u CLAUDE_BIN
)

# One parent scratch dir; each unittest stage gets its OWN sandbox HOME beneath it, so
# stage 3 never inherits what stage 2's suites left behind. The cleanup trap still tracks
# a single path because removing the parent removes both.
SANDBOX_ROOT=""
# The git probe's throwaway repo, declared here so the EXIT trap below already covers
# it when probe_git_usable creates it.
GIT_PROBE_DIR=""
# The highest exit code any stage has returned so far, folded by run_stage itself. The
# fold lives THERE rather than at each call site: a `run_stage … || rc=$?` site would
# disable set -e for the whole call (SC2310), and the rc is data to be folded, not a
# failure to propagate.
WORST_RC=0

# SC2329: invoked indirectly by the EXIT trap below — not dead code.
# shellcheck disable=SC2329
cleanup() {
  if [[ -n "${SANDBOX_ROOT}" && -d "${SANDBOX_ROOT}" ]]; then
    rm -rf -- "${SANDBOX_ROOT}"
  fi
  if [[ -n "${GIT_PROBE_DIR}" && -d "${GIT_PROBE_DIR}" ]]; then
    rm -rf -- "${GIT_PROBE_DIR}"
  fi
}
trap cleanup EXIT

# run_stage — run one stage, fold its exit code into WORST_RC, and print a
# duration-carrying banner to stderr. Always returns 0.
# Duration comes from SECONDS (integer, bash 3.2-safe) because BSD date has no %N.
# $1 = banner label · $2.. = the command and its arguments
run_stage() {
  local label="${1}"
  shift
  local t0="${SECONDS}"
  local rc=0
  "$@" || rc=$?
  if ((rc > WORST_RC)); then WORST_RC="${rc}"; fi
  printf 'run-bats-parallel: [%s] rc=%s (%ss)\n' \
    "${label}" "${rc}" "$((SECONDS - t0))" >&2
}

# probe_git_usable — exit TOOLCHAIN_PRECONDITION_RC unless git can INITIALIZE a
# repository, not merely answer --version. An unaccepted Xcode licence leaves the
# latter working while every `git init` fails, which reds hundreds of suite rows at
# once and reads downstream as a failing harness rather than a broken toolchain.
# Called from main's preflight block ahead of stage 1, so the verdict never enters
# run_stage's WORST_RC fold and a deterministic failure costs milliseconds.
probe_git_usable() {
  local err=""
  GIT_PROBE_DIR="$(mktemp -d -t run-bats-parallel-gitprobe.XXXXXX)"
  if err="$(git -C "${GIT_PROBE_DIR}" init -q 2>&1)"; then
    return 0
  fi
  printf 'run-bats-parallel: toolchain precondition FAILED (rc %s) — git cannot initialize a repository, so the suite never ran; this is NOT a red suite: %s\n' \
    "${TOOLCHAIN_PRECONDITION_RC}" "${err}" >&2
  exit "${TOOLCHAIN_PRECONDITION_RC}"
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
  # python3 carries stages 2, 3 and 4. Absent, all three would contribute rc 0 and the
  # green gate would pass on a suite half of which never ran — loud-fail instead.
  command -v python3 >/dev/null 2>&1 || {
    printf 'run-bats-parallel: python3 not found — required by the %s and %s unittest stages\n' \
      "${HOOKS_TEST_ROOT}" "${AUTOAGENT_TEST_ROOT}" >&2
    exit 1
  }
  # Presence is not usability, and the three checks above only answer presence. Probed
  # in the same block so a toolchain verdict is reached before any stage costs time.
  probe_git_usable

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

  printf 'run-bats-parallel: bats --jobs %s --no-parallelize-within-files over %s\n' \
    "${job_count}" "${TEST_ROOTS[*]}" >&2

  run_stage 'stage 1/4 bats' \
    env "${DAEMON_ENV_SCRUB[@]}" \
    bats --jobs "${job_count}" --no-parallelize-within-files --recursive "${TEST_ROOTS[@]}"

  # The unittest suites are hermetic under a sandbox HOME (they write nothing below it)
  # ONLY once GA_DATA_ROOT is scrubbed with it: ga_paths.get_base_root PREFERS
  # GA_DATA_ROOT and falls back to $HOME/.glass-atrium, so redirecting HOME alone leaves
  # an ambient GA_DATA_ROOT (a sandbox install, an outer test harness) pointing a module
  # that forgets its own sandbox at the live data root — silently, since the redirected
  # HOME then reads clean. ATRIUM_UPDATE_STATE_DIR is the update-side twin of that seam.
  # This is the same scrub hooks/test/suite-hermeticity.bats applies to the identical
  # discover run; the two are kept identical on purpose, so the probe cannot read green
  # under conditions this stage does not share.
  SANDBOX_ROOT="$(mktemp -d -t run-bats-parallel-home.XXXXXX)"
  mkdir -p "${SANDBOX_ROOT}/hooks" "${SANDBOX_ROOT}/autoagent"

  run_stage "stage 2/4 ${HOOKS_TEST_ROOT} unittest" \
    env "${DAEMON_ENV_SCRUB[@]}" -u GA_DATA_ROOT -u ATRIUM_UPDATE_STATE_DIR \
    "HOME=${SANDBOX_ROOT}/hooks" \
    python3 -m unittest discover -s "${HOOKS_TEST_ROOT}" -p 'test_*.py'

  # Stage 3 is the autoagent twin of stage 2 and is NOT conditional: autoagent/test is a
  # manifest member (its *.py suites ship to every live install), and daemon-apply.sh's
  # own T1a precondition already refuses to run when the root is absent. So absence here
  # means a broken install, not a thin environment — and `unittest discover` against a
  # missing -s exits non-zero on its own, which is the loud outcome that case deserves.
  # Guarding it the way stage 4 guards pytest would convert a broken install into a
  # silent pass, which is the failure this stage exists to close.
  #
  # Its env differs from stage 2's in the sandbox HOME alone — every scrubbed name,
  # AUTOAGENT_CLAUDE_BIN included, sits in DAEMON_ENV_SCRUB and reaches all four stages.
  # autoagent/test/suite-hermeticity.bats scrubs the same set on the identical discover
  # run, so the probe cannot read green under conditions this stage does not share.
  run_stage "stage 3/4 ${AUTOAGENT_TEST_ROOT} unittest" \
    env "${DAEMON_ENV_SCRUB[@]}" -u GA_DATA_ROOT -u ATRIUM_UPDATE_STATE_DIR \
    "HOME=${SANDBOX_ROOT}/autoagent" \
    python3 -m unittest discover -s "${AUTOAGENT_TEST_ROOT}" -p 'test_*.py'

  # Stage 4 is conditional: the live install has no pytest, and the honest outcome
  # there is a LOUD skip (one stderr line naming the interpreter) rather than a silent
  # pass. The probe's own stderr is suppressed because the skip line below is the
  # message the operator should read — the ModuleNotFoundError traceback is noise.
  #
  # The data-root scrub is the SAME as stage 2's and for the same reason. The sandbox
  # HOME deliberately is NOT: psycopg is reachable only through the user site-packages
  # dir, which lives UNDER $HOME, so a redirect drops it from the probed interpreter's
  # sys.path and test_pg_dual_write_exit_contract.py silently degrades from 5 pinned
  # exit branches to 2 (measured 2026-09-01: 205 passed with the real HOME, 202 passed
  # + 3 skipped with a sandbox one; the scrub alone changes nothing either way). Trading
  # a real assertion for a silent skip is the wrong side of that bargain. RESIDUAL, so
  # nobody reads the omission as "stage 3 is hermetic": it is not. The one escape this
  # left — an agent_lifecycle delete moving its fixture into $HOME/.Trash — is closed
  # test-side (scripts/test/test_inject_sync.py redirects HOME for those two tests and
  # asserts the move landed), and a whole-suite probe under a sandbox HOME now writes
  # nothing. What is still absent is the STRUCTURAL guarantee: nothing stops a module
  # added later from writing under HOME, which is exactly what the sandbox would buy.
  if python3 -c 'import pytest' >/dev/null 2>&1; then
    run_stage "stage 4/4 ${SCRIPTS_TEST_ROOT} pytest" \
      env "${DAEMON_ENV_SCRUB[@]}" -u GA_DATA_ROOT -u ATRIUM_UPDATE_STATE_DIR \
      python3 -m pytest "${SCRIPTS_TEST_ROOT}/" --color=no
  else
    local python3_path
    python3_path="$(command -v python3)"
    printf 'run-bats-parallel: [stage 4/4 %s pytest] SKIPPED — pytest is not importable by %s (0s)\n' \
      "${SCRIPTS_TEST_ROOT}" "${python3_path}" >&2
  fi

  printf 'run-bats-parallel: stages complete rc=%s (total %ss)\n' \
    "${WORST_RC}" "$((SECONDS - total_t0))" >&2
  exit "${WORST_RC}"
}

main "$@"
