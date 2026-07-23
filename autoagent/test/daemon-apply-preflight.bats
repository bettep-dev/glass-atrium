#!/usr/bin/env bats
# daemon-apply test-suite PREFLIGHT suite (T1a root presence + T22 green-suite
# gate). Pins that the daemon loud-fails (exit 16) BEFORE the lock rather than
# mutating a harness it cannot verify: the four test roots must be present, and
# on the batch/cron path the suite prerequisites must be installed and the suite
# must exit 0. Escape hatches (AUTOAGENT_ALLOW_UNVERIFIED / --dry-run / the
# AUTOAGENT_PREFLIGHT_ACTIVE re-entry sentinel) and the single-proposal green-
# suite exemption are pinned too, plus the ONE flaky retry (a first suite
# failure re-runs the FULL suite once behind a loud green_gate_flaky_retry WARN;
# a second failure hits the unchanged preflight_fatal). Every code-behavior row
# FAILS at HEAD (no preflight exists there) and passes after.
#
# Assertion idiom: `[[ ... ]] || return 1`. Bats does NOT catch a bare non-final
# `[[ ]]` failure — the double-bracket keyword is treated as a tested condition,
# so only the LAST command of a body would gate the test — whereas a plain
# command's non-zero return IS caught. Routing every assertion through
# `|| return 1` makes each one actually gate the test (and reports the failing
# line). Single-bracket `[ ]` is caught bare, but `[[ ]]` is needed for the
# `== *glob*` output checks, so the idiom is applied uniformly.
#
# Hermetic: a mktemp "real tree" holds a COPIED daemon + its sourced libs, so
# GA_ROOT (= the realpathed script dir's parent) is the sandbox and the four
# roots are present/absent under test control — nothing under the live tree is
# read or written. A fake HOME makes the HOME-anchored pause-flag lib miss (loud
# WARN + proceed). psql is masked so the deterministic report-fallback path runs
# with no DB. The green-suite runner is stubbed (AUTOAGENT_BATS_RUNNER) so the
# real suite is never shelled recursively.
#
# Run via: bats autoagent/test/daemon-apply-preflight.bats
# Requires: bats >= 1.5.0, bash 3.2+, git, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

# mirror_path — symlink every real-PATH executable into $1 EXCEPT the names in
# $2.. (whole-PATH mirror per build_psql_masked_stub precedent: an allowlist that
# misses one coreutil makes the daemon exit 127 opaquely). Masking psql forces
# the report fallback; masking bats/parallel simulates a missing prerequisite.
mirror_path() {
  local dest="$1"
  shift
  local excl=" $* "
  mkdir -p -- "${dest}"
  local d f name
  local old_ifs="${IFS}"
  IFS=:
  for d in ${PATH}; do
    [[ -d "${d}" ]] || continue
    for f in "${d}"/*; do
      [[ -x "${f}" && ! -d "${f}" ]] || continue
      name="${f##*/}"
      case "${excl}" in
        *" ${name} "*) continue ;;
      esac
      [[ -e "${dest}/${name}" ]] || ln -sf "${f}" "${dest}/${name}"
    done
  done
  IFS="${old_ifs}"
}

# setup_file — build the shared mirror PATHs ONCE (read-only across tests):
# PSQL_MASKED keeps bats/parallel (prereqs present, report fallback); NOPREREQ
# additionally drops bats + parallel (prereq-absent simulation).
setup_file() {
  PSQL_MASKED="${BATS_FILE_TMPDIR}/bin-psqlmasked"
  NOPREREQ="${BATS_FILE_TMPDIR}/bin-noprereq"
  if [[ -f "${REAL_SCRIPT}" ]]; then
    mirror_path "${PSQL_MASKED}" psql
    mirror_path "${NOPREREQ}" psql bats parallel
  fi
  export PSQL_MASKED NOPREREQ
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so realpath-derived GA_ROOT stays canonical.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-preflight-bats.XXXXXX)" && pwd -P)"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  FAKE_HOME="${WORK}/home"
  MARKER="${WORK}/runner.fired"
  RUNNER_LOG="${WORK}/runner.calls"
  mkdir -p -- "${AGENTS}" "${REPORTS}" "${FAKE_HOME}"
  printf '%s\n' '{"patches": []}' >"${WORK}/report.json"
}

teardown() {
  # BSD chmod rejects `--` with a symbolic mode (treats it as a filename), so the
  # perm-restore uses no `--`; WORK is a controlled mktemp path (no leading dash).
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX "${WORK}" 2>/dev/null || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# make_sandbox — copy the daemon + its load-time libs into ${WORK}/real so the
# copied script's GA_ROOT is the sandbox. $1="roots" creates all four test roots;
# "noroots" omits them. Sets REAL + SANDBOX_SCRIPT.
make_sandbox() {
  local want_roots="$1"
  REAL="${WORK}/real"
  mkdir -p -- "${REAL}/autoagent/lib" "${REAL}/scripts/lib"
  cp -p -- "${REAL_SCRIPT}" "${REAL}/autoagent/daemon-apply.sh"
  cp -p -- "${GA}/autoagent/lib/git-txn.sh" "${REAL}/autoagent/lib/git-txn.sh"
  cp -p -- "${GA}/autoagent/daemon_cycle.py" "${REAL}/autoagent/daemon_cycle.py"
  cp -p -- "${GA}/scripts/lib/apply-lock.sh" "${REAL}/scripts/lib/apply-lock.sh"
  SANDBOX_SCRIPT="${REAL}/autoagent/daemon-apply.sh"
  if [[ "${want_roots}" == "roots" ]]; then
    mkdir -p -- "${REAL}/test" "${REAL}/hooks/test" \
      "${REAL}/scripts/test" "${REAL}/autoagent/test"
  fi
}

# make_runner — write an executable green-suite runner STUB that records it fired
# (touches ${MARKER}) then exits $2. Lets a test prove the gate ran (or, by the
# marker's ABSENCE, that it was skipped/exempt) without shelling the real suite.
make_runner() {
  local dest="$1" code="$2"
  cat >"${dest}" <<EOF
#!/usr/bin/env bash
: >"${MARKER}"
exit ${code}
EOF
  chmod +x "${dest}"
}

# make_counting_runner — runner STUB that appends one line per invocation (with
# the sentinel value it saw) to ${RUNNER_LOG}, exiting 1 for the first $2 calls
# and 0 after. red_calls=1 simulates a transient flake (red once, green on the
# retry); a large red_calls simulates a deterministic red; 0 is always green.
make_counting_runner() {
  local dest="$1" red_calls="$2"
  cat >"${dest}" <<EOF
#!/usr/bin/env bash
printf 'call sentinel=%s\n' "\${AUTOAGENT_PREFLIGHT_ACTIVE:-unset}" >>"${RUNNER_LOG}"
[[ "\$(wc -l <"${RUNNER_LOG}")" -gt ${red_calls} ]] || exit 1
exit 0
EOF
  chmod +x "${dest}"
}

# run_batch / run_single — invoke the sandbox daemon with a clean, controlled env
# (ambient escape-hatch vars UNSET so the suite is hermetic even when itself run
# under the green-suite). Extra env assignments are forwarded via $@.
run_batch() {
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    HOME="${FAKE_HOME}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    "$@" \
    bash "${SANDBOX_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
}

run_single() {
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    HOME="${FAKE_HOME}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    "$@" \
    bash "${SANDBOX_SCRIPT}" --proposal-id 999 --agents-dir "${AGENTS}"
}

# ---------------------------------------------------------------------------
# 1. --help stays 0 (preflight is AFTER arg-parse, so --help never reaches it)
# ---------------------------------------------------------------------------

@test "--help exits 0 (preflight runs after arg-parse)" {
  make_sandbox noroots
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    HOME="${FAKE_HOME}" bash "${SANDBOX_SCRIPT}" --help
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"test root absent"* ]] || return 1
}

# ---------------------------------------------------------------------------
# 2. missing root → exit 16 naming the SPECIFIC absent root (batch); no lock
# ---------------------------------------------------------------------------

@test "batch: absent test root aborts exit 16 naming the missing root" {
  make_sandbox roots
  rmdir "${REAL}/hooks/test" # leave the other three; only hooks/test is absent
  run_batch PATH="${PSQL_MASKED}"
  [[ "${status}" -eq 16 ]] || return 1
  [[ "${output}" == *"test root absent"* ]] || return 1
  [[ "${output}" == *"hooks/test"* ]] || return 1
  # No lock was acquired (abort is before the lock dir is created).
  [[ ! -d "${REPORTS}/.apply-lock" ]] || return 1
}

# ---------------------------------------------------------------------------
# 3. root presence runs on the SINGLE-proposal path too (map, not exempt) —
#    the single path can therefore surface exit 16 (classified, not unknown)
# ---------------------------------------------------------------------------

@test "single: absent test root aborts exit 16 (root presence runs on the single path)" {
  make_sandbox noroots
  run_single PATH="${PSQL_MASKED}"
  [[ "${status}" -eq 16 ]] || return 1
  [[ "${output}" == *"test root absent"* ]] || return 1
}

# ---------------------------------------------------------------------------
# 4. AUTOAGENT_ALLOW_UNVERIFIED=1 override → proceed + log unverified
# ---------------------------------------------------------------------------

@test "override: AUTOAGENT_ALLOW_UNVERIFIED=1 proceeds past absent roots + logs UNVERIFIED" {
  make_sandbox noroots
  run env -u AUTOAGENT_PREFLIGHT_ACTIVE \
    HOME="${FAKE_HOME}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    PATH="${PSQL_MASKED}" AUTOAGENT_ALLOW_UNVERIFIED=1 \
    bash "${SANDBOX_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
  [[ "${status}" -ne 16 ]] || return 1
  [[ "${output}" == *"UNVERIFIED"* ]] || return 1
}

# ---------------------------------------------------------------------------
# 5. --dry-run exempts the preflight — contrasted with the batch abort so the
#    row still fails at HEAD (batch→16 does not hold there)
# ---------------------------------------------------------------------------

@test "dry-run: preflight is exempt (batch aborts, dry-run does not)" {
  make_sandbox noroots
  # Batch with the same absent roots DOES abort (fails at HEAD: no preflight → 0).
  run_batch PATH="${PSQL_MASKED}"
  [[ "${status}" -eq 16 ]] || return 1
  # Dry-run over the same absent roots does NOT abort.
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    HOME="${FAKE_HOME}" \
    bash "${SANDBOX_SCRIPT}" --dry-run --report "${WORK}/report.json" --agents-dir "${AGENTS}"
  [[ "${status}" -ne 16 ]] || return 1
  [[ "${output}" != *"test root absent"* ]] || return 1
}

# ---------------------------------------------------------------------------
# 6. re-entry sentinel → the whole gate is skipped (contrasted with batch abort)
# ---------------------------------------------------------------------------

@test "sentinel: AUTOAGENT_PREFLIGHT_ACTIVE=1 skips the gate despite absent roots" {
  make_sandbox noroots
  # Without the sentinel the same absent roots abort (fails at HEAD).
  run_batch PATH="${PSQL_MASKED}"
  [[ "${status}" -eq 16 ]] || return 1
  # With the sentinel the gate is skipped.
  run env -u AUTOAGENT_ALLOW_UNVERIFIED \
    HOME="${FAKE_HOME}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    PATH="${PSQL_MASKED}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    bash "${SANDBOX_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
  [[ "${status}" -ne 16 ]] || return 1
  [[ "${output}" != *"test root absent"* ]] || return 1
}

# ---------------------------------------------------------------------------
# 7. no target file is modified when the preflight aborts (checksum before/after)
# ---------------------------------------------------------------------------

@test "abort leaves every target file byte-identical (checksum unchanged)" {
  make_sandbox noroots
  printf '%s\n' '# Probe Agent' 'protected line' >"${AGENTS}/probe.md"
  local before after
  before="$(shasum "${AGENTS}/probe.md")"
  run_batch PATH="${PSQL_MASKED}"
  [[ "${status}" -eq 16 ]] || return 1
  after="$(shasum "${AGENTS}/probe.md")"
  [[ "${before}" == "${after}" ]] || return 1
}

# ---------------------------------------------------------------------------
# 8. missing prerequisite: bats absent → exit 16 naming the prerequisite
# ---------------------------------------------------------------------------

@test "batch: absent bats prerequisite aborts exit 16 naming bats" {
  make_sandbox roots
  run_batch PATH="${NOPREREQ}"
  [[ "${status}" -eq 16 ]] || return 1
  [[ "${output}" == *"prerequisite absent"* ]] || return 1
  [[ "${output}" == *"bats"* ]] || return 1
}

# ---------------------------------------------------------------------------
# 9. missing prerequisite: parallel absent (bats present) → names parallel
# ---------------------------------------------------------------------------

@test "batch: absent GNU parallel prerequisite aborts exit 16 naming parallel" {
  make_sandbox roots
  local noparallel="${WORK}/bin-noparallel"
  mirror_path "${noparallel}" psql parallel
  run_batch PATH="${noparallel}"
  [[ "${status}" -eq 16 ]] || return 1
  [[ "${output}" == *"prerequisite absent"* ]] || return 1
  [[ "${output}" == *"parallel"* ]] || return 1
}

# ---------------------------------------------------------------------------
# 10. red suite → exit 16 naming suite FAILURE, distinct from absence
# ---------------------------------------------------------------------------

@test "batch: a red suite aborts exit 16 (suite FAILED, distinct from absence)" {
  make_sandbox roots
  make_runner "${WORK}/runner-red.sh" 1
  run_batch PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner-red.sh"
  [[ "${status}" -eq 16 ]] || return 1
  [[ "${output}" == *"test suite FAILED"* ]] || return 1
  # Distinct from absence — the abort is NOT a root/prereq message.
  [[ "${output}" != *"test root absent"* ]] || return 1
  [[ "${output}" != *"prerequisite absent"* ]] || return 1
  # The gate DID reach the suite run (proof it is failure, not absence).
  [[ -f "${MARKER}" ]] || return 1
}

# ---------------------------------------------------------------------------
# 11. green suite → the daemon proceeds past the gate (fired on the batch path)
# ---------------------------------------------------------------------------

@test "batch: a green suite lets the daemon proceed (gate fired, no abort)" {
  make_sandbox roots
  make_runner "${WORK}/runner-green.sh" 0
  run_batch PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner-green.sh"
  [[ "${status}" -ne 16 ]] || return 1
  [[ "${output}" != *"test suite FAILED"* ]] || return 1
  # Proof the green-suite ran on the batch path.
  [[ -f "${MARKER}" ]] || return 1
}

# ---------------------------------------------------------------------------
# 12. batch FIRES the green-suite; the single-proposal path EXEMPTS it
# ---------------------------------------------------------------------------

@test "green-suite fires on batch but is exempt on the single-proposal path" {
  make_sandbox roots
  make_runner "${WORK}/runner.sh" 0

  # Batch path: the gate fires → marker written (fails at HEAD: no preflight).
  run_batch PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner.sh"
  [[ -f "${MARKER}" ]] || return 1

  # Single-proposal path: the heavy gate is exempt → marker NOT written.
  rm -f -- "${MARKER}"
  run_single PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner.sh"
  [[ "${status}" -ne 16 ]] || return 1
  [[ ! -f "${MARKER}" ]] || return 1
}

# ---------------------------------------------------------------------------
# 13. the re-entry sentinel keeps the runner from being shelled (no recursion) —
#     contrasted with the unsentineled batch run that DOES shell it
# ---------------------------------------------------------------------------

@test "sentinel: the green-suite runner is never shelled (bounded, no recurse)" {
  make_sandbox roots
  make_runner "${WORK}/runner.sh" 0

  # Unsentineled batch DOES shell the runner (fails at HEAD: no preflight).
  run_batch PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner.sh"
  [[ -f "${MARKER}" ]] || return 1

  # Sentineled batch skips the whole gate → the runner is never shelled.
  rm -f -- "${MARKER}"
  run env -u AUTOAGENT_ALLOW_UNVERIFIED \
    HOME="${FAKE_HOME}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    PATH="${PSQL_MASKED}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    AUTOAGENT_BATS_RUNNER="${WORK}/runner.sh" \
    bash "${SANDBOX_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
  [[ "${status}" -ne 16 ]] || return 1
  [[ ! -f "${MARKER}" ]] || return 1
}

# ---------------------------------------------------------------------------
# 14. flaky suite (red once, green on the retry) → ONE full-suite re-run behind
#     the loud named WARN, the daemon proceeds
# ---------------------------------------------------------------------------

@test "flaky: a red-then-green suite proceeds after ONE green_gate_flaky_retry re-run" {
  make_sandbox roots
  make_counting_runner "${WORK}/runner-flaky.sh" 1
  run_batch PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner-flaky.sh"
  [[ "${status}" -ne 16 ]] || return 1
  [[ "${output}" == *"green_gate_flaky_retry"* ]] || return 1
  [[ "${output}" != *"test suite FAILED"* ]] || return 1
  # exactly TWO runner invocations (the red first run + the single retry),
  # BOTH carrying the re-entry sentinel export
  [[ "$(wc -l <"${RUNNER_LOG}")" -eq 2 ]] || return 1
  [[ "$(grep -c 'sentinel=1' "${RUNNER_LOG}")" -eq 2 ]] || return 1
}

# ---------------------------------------------------------------------------
# 15. deterministic red → fails BOTH runs → the SAME preflight_fatal, exactly
#     one retry (never N)
# ---------------------------------------------------------------------------

@test "flaky: a deterministic red suite fails both runs → preflight_fatal after one retry" {
  make_sandbox roots
  make_counting_runner "${WORK}/runner-red2.sh" 99
  run_batch PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner-red2.sh"
  [[ "${status}" -eq 16 ]] || return 1
  [[ "${output}" == *"green_gate_flaky_retry"* ]] || return 1
  [[ "${output}" == *"test suite FAILED"* ]] || return 1
  # exactly TWO invocations: first run + ONE retry — the retry is bounded
  [[ "$(wc -l <"${RUNNER_LOG}")" -eq 2 ]] || return 1
}

# ---------------------------------------------------------------------------
# 16. green first run → exactly ONE invocation, no spurious retry, no WARN
# ---------------------------------------------------------------------------

@test "flaky: a green first run fires the runner exactly once (no spurious retry)" {
  make_sandbox roots
  make_counting_runner "${WORK}/runner-green1.sh" 0
  run_batch PATH="${PSQL_MASKED}" AUTOAGENT_BATS_RUNNER="${WORK}/runner-green1.sh"
  [[ "${status}" -ne 16 ]] || return 1
  [[ "${output}" != *"green_gate_flaky_retry"* ]] || return 1
  [[ "$(wc -l <"${RUNNER_LOG}")" -eq 1 ]] || return 1
}
