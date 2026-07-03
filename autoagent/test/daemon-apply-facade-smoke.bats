#!/usr/bin/env bats
# daemon FACADE-PATH smoke suite — regression pin for the symlink-facade failure
# CLASS (2026-07-02 incident): launchd invokes the daemon scripts THROUGH the
# ~/.claude per-file symlink facade; bash never dereferences a file-level
# symlink in BASH_SOURCE, so a bare dirname(BASH_SOURCE) resolved sibling
# resources into the FACADE dir, where each sibling exists only if a mirror
# symlink was hand-created. The scripts/lib/apply-lock.sh mirror was never
# created → `[daemon-apply] FATAL: apply-lock lib missing` → exit 5 every
# 04:30 cycle. Fix under pin: realpath(BASH_SOURCE)-based SCRIPT_DIR (file
# first, THEN dirname — the containing facade dir is real, so pwd -P can never
# help), landing every sibling lookup in the REAL tree.
#
# Hermetic replica: NOTHING under the real ~/.claude (or the live repo) is
# touched. The mktemp sandbox holds a COPIED script subset (the "real tree")
# plus a facade dir of per-file symlinks that DELIBERATELY omits the
# scripts/lib/apply-lock.sh mirror — the exact live incident shape. The daemon
# is invoked through the facade with --dry-run, which is DB-free by design
# (backlog_source_available returns false under dry-run → deterministic JSON
# report fallback), skips the real lock acquisition, and logs only to /tmp.
# A fake HOME makes the HOME-anchored pause-flag / auth-env libs miss (loud
# WARN + proceed) so no real user state is ever read.
#
# PRE-FIX behavior (this suite FAILS on it): dirname(BASH_SOURCE) =
# facade/autoagent → APPLY_LOCK_LIB = facade/scripts/lib/apply-lock.sh
# (absent) → exit 5. POST-FIX: realpath lands in the sandbox real tree → the
# lib sources → the empty report drains zero patches → exit 0.
#
# Run via: bats autoagent/test/daemon-apply-facade-smoke.bats
# Requires: bats >= 1.5.0, bash 3.2+, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

setup() {
  [[ -f "${GA}/autoagent/daemon-apply.sh" ]] || skip "daemon-apply.sh not found: ${GA}/autoagent/daemon-apply.sh"
  [[ -f "${GA}/scripts/lib/apply-lock.sh" ]] || skip "apply-lock.sh not found: ${GA}/scripts/lib/apply-lock.sh"
  # pwd -P resolves /var -> /private/var so realpath comparisons stay canonical.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-facade-bats.XXXXXX)" && pwd -P)"

  # Sandbox REAL tree — copies (not symlinks) of the live repo subset, so the
  # realpath of a facade symlink terminates INSIDE the sandbox and the run can
  # never reach the live repo's siblings.
  REAL="${WORK}/real"
  mkdir -p "${REAL}/autoagent/lib" "${REAL}/scripts/lib"
  cp -p "${GA}/autoagent/daemon-apply.sh" "${REAL}/autoagent/daemon-apply.sh"
  cp -p "${GA}/autoagent/daemon-cycle.sh" "${REAL}/autoagent/daemon-cycle.sh"
  cp -p "${GA}/autoagent/daemon_cycle.py" "${REAL}/autoagent/daemon_cycle.py"
  cp -p "${GA}/autoagent/lib/git-txn.sh" "${REAL}/autoagent/lib/git-txn.sh"
  cp -p "${GA}/scripts/lib/apply-lock.sh" "${REAL}/scripts/lib/apply-lock.sh"

  # FACADE — per-file symlinks mirroring the ~/.claude layout. The mirrors that
  # existed at incident time (daemon scripts + the manually-added git-txn.sh)
  # are present; scripts/lib/apply-lock.sh is DELIBERATELY absent (the
  # class-defining missing mirror). daemon_cycle.py is likewise absent on the
  # daemon-cycle facade (a sibling born after the migration — same class).
  FACADE="${WORK}/facade"
  mkdir -p "${FACADE}/autoagent/lib" "${FACADE}/scripts/lib"
  ln -s "${REAL}/autoagent/daemon-apply.sh" "${FACADE}/autoagent/daemon-apply.sh"
  ln -s "${REAL}/autoagent/daemon-cycle.sh" "${FACADE}/autoagent/daemon-cycle.sh"
  ln -s "${REAL}/autoagent/lib/git-txn.sh" "${FACADE}/autoagent/lib/git-txn.sh"
  # NO ${FACADE}/scripts/lib/apply-lock.sh — the incident's missing mirror.
  # NO ${FACADE}/autoagent/daemon_cycle.py — missing-mirror class, cycle side.

  # Mutable sandbox state + fake HOME (HOME-anchored libs must MISS, not read
  # real user state; missing libs are a loud WARN + proceed by design).
  REPORTS="${WORK}/reports"
  AGENTS="${WORK}/agents"
  FAKE_HOME="${WORK}/home"
  mkdir -p "${REPORTS}" "${AGENTS}" "${FAKE_HOME}"
  printf '%s\n' '{"patches": []}' >"${WORK}/report.json"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# ---------------------------------------------------------------------------
# (a) daemon-apply.sh via facade → apply-lock lib resolves to the REAL tree
# ---------------------------------------------------------------------------

@test "facade-invoked daemon-apply resolves the apply-lock lib (no exit-5 FATAL)" {
  run env HOME="${FAKE_HOME}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    bash "${FACADE}/autoagent/daemon-apply.sh" --dry-run \
    --report "${WORK}/report.json" --agents-dir "${AGENTS}"

  # Class pin: the lib default must never resolve into the facade.
  [[ "${output}" != *"FATAL: apply-lock lib missing"* ]]
  [[ "${status}" -ne 5 ]]
  # End-to-end: the lib sourced, the empty report drained zero patches, clean 0.
  [[ "${output}" == *"0 body-auto patches"* ]]
  [[ "${status}" -eq 0 ]]
}

# ---------------------------------------------------------------------------
# (b) daemon-apply.sh via facade honors the ATRIUM_APPLY_LOCK_LIB env override
# ---------------------------------------------------------------------------

@test "facade-invoked daemon-apply keeps the ATRIUM_APPLY_LOCK_LIB override intact" {
  # Point the override at a bogus path: the realpath default MUST NOT shadow the
  # documented env contract, so the run has to FATAL exit 5 on the bogus lib.
  run env HOME="${FAKE_HOME}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_APPLY_LOCK_LIB="${WORK}/nonexistent-apply-lock.sh" \
    bash "${FACADE}/autoagent/daemon-apply.sh" --dry-run \
    --report "${WORK}/report.json" --agents-dir "${AGENTS}"

  [[ "${status}" -eq 5 ]]
  [[ "${output}" == *"FATAL: apply-lock lib missing"* ]]
  [[ "${output}" == *"${WORK}/nonexistent-apply-lock.sh"* ]]
}

# ---------------------------------------------------------------------------
# (c) daemon-cycle.sh via facade → sibling daemon_cycle.py resolves to the
#     REAL tree even though the facade has NO daemon_cycle.py mirror
# ---------------------------------------------------------------------------

@test "facade-invoked daemon-cycle resolves daemon_cycle.py (no missing-module FATAL)" {
  # --help is the earliest clean bail AFTER the PY_MODULE existence check:
  # pre-fix the facade SCRIPT_DIR made that check FATAL (exit 2, "missing");
  # post-fix the module resolves into the real tree and --help exits 0.
  # AUTOAGENT_CLAUDE_BIN skips the claude-binary detection (hermetic).
  run env HOME="${FAKE_HOME}" AUTOAGENT_CLAUDE_BIN=/usr/bin/true \
    bash "${FACADE}/autoagent/daemon-cycle.sh" --help

  [[ "${output}" != *"FATAL: missing"* ]]
  [[ "${status}" -eq 0 ]]
}
