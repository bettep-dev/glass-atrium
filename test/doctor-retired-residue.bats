#!/usr/bin/env bats
# doctor-retired-residue.bats — pins run_doctor's retired-residue section.
#
# WHY THIS SECTION EXISTS: the retirement sweep moves a vendor-dropped file to Trash, and a move it
# cannot make is deliberately a WARN rather than an exit — aborting there would cost the run its
# mode enforcement, farm refresh and hook wiring for one immovable file. That WARN scrolls past with
# the rest of the deploy, so the sweep records each un-moved path and this section reads it back.
#
# GRAMMAR: the record is one manifest-relative path per line, written by
# update_sweep_removed_files at the path spine_retired_unmoved_path() resolves — the SAME helper the
# doctor calls, so the producer and the reader cannot drift onto two locations.
#
# ACs pinned here:
#   AC1  a recorded path whose file is still present is a WARN naming it, never a FAIL.
#   AC2  a recorded path whose file is gone is dropped from the record, and the surviving line stays.
#   AC3  a record whose every line is resolved is REMOVED and the clearing is reported.
#   AC4  no record at all is silent — the normal install says nothing.
#
# Run via: bats test/doctor-retired-residue.bats
# Requires: bats, bash 3.2+
#
# Hermetic: GA_TARGET_HOME, GA_DATA_ROOT and ATRIUM_UPDATE_STATE_DIR point at throwaway temp dirs, a
# nonexistent manifest-gen skips the §8 hashing and an echo-OK claude stub neutralises the auth
# advisory's live probe. No ~/.claude or ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"

# A path that exists under GA_ROOT for every checkout, so the still-present arm needs no fixture of
# its own — the doctor resolves the record's lines against the install root, not against a sandbox.
PRESENT_PATH="scripts/update.sh"
GONE_PATH="scripts/lib/no-such-retired-file.sh"

setup() {
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  [[ -f "${GA}/${PRESENT_PATH}" ]] || skip "fixture path absent: ${PRESENT_PATH}"
  [[ ! -e "${GA}/${GONE_PATH}" ]] || skip "fixture path unexpectedly present: ${GONE_PATH}"
  TARGET="$(mktemp -d -t ga-doctor-residue-target.XXXXXX)"
  DATA_ROOT="$(mktemp -d -t ga-doctor-residue-data.XXXXXX)"
  STATE="$(mktemp -d -t ga-doctor-residue-state.XXXXXX)"
  mkdir -p "${TARGET}/bin"
  cat >"${TARGET}/bin/claude" <<'SH'
#!/bin/bash
echo OK
exit 0
SH
  chmod +x "${TARGET}/bin/claude"
  export GA_GENERATE_MANIFEST="${TARGET}/no-such-manifest-gen" # nonexistent → §8 SHA hashing skipped
  export GA_AUTH_CLAUDE_BIN="${TARGET}/bin/claude"            # echo-OK stub → no live claude -p probe
  RECORD="${STATE}/retired-unmoved.txt"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
  [[ -n "${DATA_ROOT:-}" && -d "${DATA_ROOT}" ]] && rm -rf -- "${DATA_ROOT}" || true
  [[ -n "${STATE:-}" && -d "${STATE}" ]] && rm -rf -- "${STATE}" || true
}

# Drive the REAL doctor with the target, runtime-data and updater-state seams at the sandbox. A
# sandboxed tree fails other sections, so every assertion is on this section's own verdict LINES
# rather than on $status.
run_doctor_seam() {
  GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}" \
    ATRIUM_MONITOR_PORT="1" \
    run "${REAL_GA}" doctor
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC1 — a still-present recorded path WARNs ──────────────────────────────────────────────────

@test "AC1: a recorded retired path whose file is still present is a WARN, never a FAIL" {
  printf '%s\n' "${PRESENT_PATH}" >"${RECORD}"
  run_doctor_seam
  assert_output_has "warn : retired file still in place — ${PRESENT_PATH}" || return 1
  assert_output_lacks "FAIL : retired file still in place" || return 1
  assert_output_has "retired-residue" || return 1
}

# ── AC2 — a resolved line is dropped, a live one survives ─────────────────────────────────────

@test "AC2: a recorded path whose file is gone is dropped and the live line is kept" {
  printf '%s\n%s\n' "${GONE_PATH}" "${PRESENT_PATH}" >"${RECORD}"
  run_doctor_seam
  assert_output_lacks "${GONE_PATH}" || return 1
  assert_output_has "warn : retired file still in place — ${PRESENT_PATH}" || return 1
  [[ "$(cat "${RECORD}")" == "${PRESENT_PATH}" ]] || return 1
}

# ── AC3 — an entirely resolved record is removed ──────────────────────────────────────────────

@test "AC3: a record whose every line is resolved is removed and the clearing is reported" {
  printf '%s\n' "${GONE_PATH}" >"${RECORD}"
  run_doctor_seam
  assert_output_has "recorded retired residue is gone" || return 1
  [[ ! -e "${RECORD}" ]] || return 1
}

# ── AC4 — no record is silent ─────────────────────────────────────────────────────────────────

@test "AC4: no record at all leaves the section silent" {
  [[ ! -e "${RECORD}" ]] || return 1
  run_doctor_seam
  assert_output_lacks "retired file still in place" || return 1
  assert_output_lacks "recorded retired residue is gone" || return 1
}
