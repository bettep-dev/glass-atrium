#!/usr/bin/env bats
# recovery-repos.sh roster SoT tests: the shared seven-entry recovery-repo roster
# (scripts/lib/recovery-repos.sh) and BOTH consumers resolving it self-relatively —
# the write side (scripts/snapshot-live-repos.sh) and the read side
# (lib/ga-doctor.sh snapshot_staleness_scan).
#
# The roster was formerly duplicated as two hardcoded literals synced by comment;
# a drift between them makes the doctor scan blind to a repo the snapshot writes
# (or the reverse). The literal-absence rows are the drift guard, and the two
# functional rows prove the consumers READ the lib rather than merely mentioning
# it: a probe entry injected into a COPY of the lib must change each consumer's
# observable behaviour.
#
# Self-relative resolution is load-bearing, not stylistic: the CI gate-doctor leg
# runs doctor against a bare mktemp GA target, where any target-relative path
# resolves to nothing.
#
# EVERY assertion carries `|| return 1`: a bare `[[ ... ]]` that fails mid-body
# does NOT fail the test on bats 1.13 (only the final command's status is
# consulted), so an unguarded mid-body assertion is silently vacuous.
#
# Run via: bats scripts/test/recovery-repos.bats
# Requires: bats >= 1.5.0, bash 3.2+, git

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
ROSTER_LIB="${GA}/scripts/lib/recovery-repos.sh"
SNAPSHOT="${GA}/scripts/snapshot-live-repos.sh"
DOCTOR="${GA}/lib/ga-doctor.sh"
PROBE='ga-probe-repo'

setup() {
  WORK="$(mktemp -d -t recovery-repos-bats.XXXXXX)"
  GA_SBX="${WORK}/ga"
  mkdir -p "${GA_SBX}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# A copy of the real lib carrying one EXTRA roster entry, written to $1. Injected by
# line insertion into the real file so the copy keeps the real shape (guard, readonly).
make_probe_lib() {
  local dest="$1"
  awk -v probe="${PROBE}" '
    { print }
    /^    autoagent$/ { print "    " probe }
  ' "${ROSTER_LIB}" >"${dest}"
}

# The seven live recovery repos, one per line, in roster order.
expected_roster() {
  printf '%s\n' autoagent agents monitor scripts/test rules test hooks/test
}

# === 1. the lib itself =======================================================

@test "roster lib defines exactly the seven recovery repos in order" {
  [[ -f "${ROSTER_LIB}" ]] || return 1
  run env bash -c 'set -Eeuo pipefail; source "$1"; printf "%s\n" "${RECOVERY_REPOS[@]}"' _ "${ROSTER_LIB}"

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "$(expected_roster)" ]] || return 1
}

@test "roster lib re-source is a clean no-op under strict mode" {
  run env bash -c 'set -Eeuo pipefail; source "$1"; source "$1"; printf "%s\n" "${#RECOVERY_REPOS[@]}"' _ "${ROSTER_LIB}"

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "7" ]] || return 1
}

# === 2. consumer literal absence (drift guard) ===============================

@test "snapshot-live-repos.sh sources the roster lib and carries no local literal" {
  run grep -c 'lib/recovery-repos.sh' "${SNAPSHOT}"
  [[ "${status}" -eq 0 ]] || return 1

  run grep -n "^readonly LIVE_REPOS=(" "${SNAPSHOT}"
  [[ "${status}" -ne 0 ]] || return 1
}

@test "ga-doctor.sh sources the roster lib and carries no local literal" {
  run grep -c 'scripts/lib/recovery-repos.sh' "${DOCTOR}"
  [[ "${status}" -eq 0 ]] || return 1

  run grep -n "local repos=(autoagent" "${DOCTOR}"
  [[ "${status}" -ne 0 ]] || return 1
}

# === 3. functional: each consumer READS the lib ==============================

@test "snapshot write side resolves the roster from the lib copy beside it" {
  command -v git >/dev/null 2>&1 || skip "git required"
  local tree="${WORK}/tree"
  mkdir -p "${tree}/lib"
  cp "${SNAPSHOT}" "${tree}/snapshot-live-repos.sh"
  cp "${GA}/scripts/lib/apply-lock.sh" "${tree}/lib/apply-lock.sh"
  make_probe_lib "${tree}/lib/recovery-repos.sh"
  chmod +x "${tree}/snapshot-live-repos.sh"

  local rel
  for rel in $(expected_roster); do mkdir -p "${GA_SBX}/${rel}"; done

  run env GA_ROOT="${GA_SBX}" AUTOAGENT_REPORTS_DIR="${WORK}/reports" \
    "${tree}/snapshot-live-repos.sh" --dry-run

  # The probe entry has no directory, so the pre-mutation validation loud-fails on it.
  [[ "${output}" == *"repo dir missing: ${GA_SBX}/${PROBE}"* ]] || return 1
  [[ "${status}" -eq 3 ]] || return 1
}

@test "doctor read side resolves the roster from the lib copy beside it" {
  local tree="${WORK}/engine"
  mkdir -p "${tree}/lib" "${tree}/scripts/lib"
  cp "${GA}/lib/"ga-*.sh "${tree}/lib/"
  cp "${GA}/scripts/lib/"*.sh "${tree}/scripts/lib/"
  make_probe_lib "${tree}/scripts/lib/recovery-repos.sh"

  run env bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      snapshot_staleness_scan "$2"
    ' _ "${tree}" "${GA_SBX}"

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"${PROBE} — no such directory (recovery snapshot n/a)"* ]] || return 1
}

# === 4. missing lib is a loud, named precondition failure ====================

@test "snapshot loud-fails on a missing roster lib with its own exit code" {
  command -v git >/dev/null 2>&1 || skip "git required"
  local tree="${WORK}/bare"
  mkdir -p "${tree}"
  cp "${SNAPSHOT}" "${tree}/snapshot-live-repos.sh"
  chmod +x "${tree}/snapshot-live-repos.sh"

  local rel
  for rel in $(expected_roster); do mkdir -p "${GA_SBX}/${rel}"; done

  # The apply-lock lib is supplied explicitly so its own exit 5 cannot mask the
  # roster-lib gate; GA_ROOT holds no scripts/lib mirror for the facade fallback.
  run env GA_ROOT="${GA_SBX}" AUTOAGENT_REPORTS_DIR="${WORK}/reports" \
    ATRIUM_APPLY_LOCK_LIB="${GA}/scripts/lib/apply-lock.sh" \
    "${tree}/snapshot-live-repos.sh" --dry-run

  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"recovery-repo roster lib missing"* ]] || return 1
}
