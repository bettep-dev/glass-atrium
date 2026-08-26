#!/usr/bin/env bats
# wire-hooks-restart-notice.bats — pins the hook-rewire restart notice, its marker, and the
# doctor lifecycle that retires the marker.
#
# Claude Code snapshots settings.json hook bindings at SESSION START, so a binding this install
# adds, drops, or retires is inert in every already-running session. Nothing told the user that,
# and nothing recorded that a restart was owed. wire_hooks now announces it and writes a marker;
# doctor reports the marker until its window expires.
#
# WHAT THIS SUITE DOES NOT CLAIM: that a restart HAPPENED. Activation is not observable — the
# binding snapshot is taken inside a process this tree cannot see. So a fired-log artifact newer
# than the marker proves only that SOME hook fired (possibly the OLD binding, inside a session
# that started before the rewire), never that the new binding is live. AC6 pins that refutation as
# a regression test: the marker survives an observation and clears ONLY by window expiry.
#
# The notice condition is `added > 0 OR removed > 0`, not `added > 0`: a changed matcher takes the
# remove+add path, so a matcher-only change wires nothing new yet still needs the same restart.
# AC3 is that row.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate — the keyword is read as a tested
# condition. Every assertion here `return 1`s on mismatch, so each one independently fails.
#
# Nothing outside the sandbox is written: GA_TARGET_HOME redirects settings.json and GA_DATA_ROOT
# redirects the marker + artifact roots, so neither ~/.claude nor ~/.glass-atrium is touched.
#
# Run via: bats test/wire-hooks-restart-notice.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-rewire-notice-bats.XXXXXX)"
  TARGET="${SANDBOX}/target"
  DATA="${SANDBOX}/dataroot"
  GA_SANDBOX="${SANDBOX}/ga"
  MANIFEST="${SANDBOX}/manifest.json"
  SETTINGS="${TARGET}/settings.json"
  MARKER="${DATA}/data/hook-rewire-pending"
  mkdir -p "${TARGET}" "${DATA}/data" "${DATA}/logs" "${GA_SANDBOX}/agents"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

NOTICE="RESTART REQUIRED"

# Drive the REAL wire_hooks against the sandbox under the strict mode the entry point arms.
run_wire() {
  run env GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA}" bash -c '
    set -Eeuo pipefail
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    wire_hooks
  ' _ "${GA}"
}

# Drive the REAL retire_hook_binding for one basename.
run_retire() {
  run env GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA}" bash -c '
    set -Eeuo pipefail
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    retire_hook_binding "$2"
  ' _ "${GA}" "$1"
}

# Run the REAL run_doctor against the sandbox. GA_SKIP_DB_SETUP takes the documented opt-out branch
# so no database is ever contacted, and the monitor port is the discard port.
run_doctor_sandbox() {
  run env GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" GA_DATA_ROOT="${DATA}" \
    ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" ATRIUM_MONITOR_PORT="9" \
    GA_SKIP_DB_SETUP=1 \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

assert_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "output missing '${1}':" >&2
    echo "${output}" >&2
    return 1
  }
}

refute_has() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "output unexpectedly holds '${1}':" >&2
    echo "${output}" >&2
    return 1
  }
}

# Append a hook-group carrying an EXPECTED (event, basename) pair under an UNEXPECTED matcher —
# exactly the residue a matcher change leaves behind. Read off the live file so no hook filename is
# hardcoded here.
add_stale_matcher_row() {
  local tmp="${SANDBOX}/stale.json"
  jq '
    (.hooks | to_entries[0]) as $e
    | ($e.value[0].hooks[0].command) as $cmd
    | .hooks[$e.key] += [ { "matcher": "GA-STALE-PROBE", "hooks": [ { "type": "command", "command": $cmd } ] } ]
  ' "${SETTINGS}" >"${tmp}" || return 1
  mv -f -- "${tmp}" "${SETTINGS}"
}

# Basename of the first wired Atrium command — the retire target, again never hardcoded.
first_wired_basename() {
  jq -r '(.hooks | to_entries[0].value[0].hooks[0].command) | split("/") | last' "${SETTINGS}"
}

# $1 = epoch the marker claims it was written at.
write_marker() {
  printf 'epoch=%s\nadded=1 removed=0 retired=0\n' "$1" >"${MARKER}"
}

# $1 = path, $2 = epoch. `touch -t` reads LOCAL time on both flavors, so the stamp is rendered
# local on both too (a -u stamp fed to a local -t would shift the file by the UTC offset).
set_mtime() {
  local stamp
  stamp="$(date -r "$2" +%Y%m%d%H%M.%S 2>/dev/null)" || stamp="$(date -d "@$2" +%Y%m%d%H%M.%S)"
  touch -t "${stamp}" -- "$1"
}

# Warning count off the doctor PASS breakdown; empty when the run did not reach a PASS line.
summary_warns() {
  printf '%s\n' "${output}" | sed -n 's/.*doctor: PASS (with \([0-9][0-9]*\) warning.*/\1/p' | head -n 1
}

@test "AC1: a run that adds bindings announces the restart and writes the marker" {
  run_wire
  [[ "${status}" -eq 0 ]] || return 1
  assert_has "${NOTICE}" || return 1
  [[ -f "${MARKER}" ]] || return 1
  grep -q '^epoch=[0-9][0-9]*$' "${MARKER}" || return 1
  grep -q 'added=[1-9]' "${MARKER}" || return 1
}

@test "AC2: a zero-mutation re-run announces nothing and writes no marker" {
  run_wire
  [[ "${status}" -eq 0 ]] || return 1
  rm -f -- "${MARKER}"

  run_wire
  [[ "${status}" -eq 0 ]] || return 1
  assert_has "0 binding(s) added" || return 1
  refute_has "${NOTICE}" || return 1
  [[ ! -e "${MARKER}" ]] || return 1
}

@test "AC3: added=0 with a stale matcher dropped still announces and marks" {
  run_wire
  [[ "${status}" -eq 0 ]] || return 1
  rm -f -- "${MARKER}"
  add_stale_matcher_row || return 1

  run_wire
  [[ "${status}" -eq 0 ]] || return 1
  assert_has "0 binding(s) added" || return 1
  assert_has "1 stale hook command(s) dropped" || return 1
  assert_has "${NOTICE}" || return 1
  [[ -f "${MARKER}" ]] || return 1
  grep -q 'removed=1' "${MARKER}" || return 1
}

@test "AC4: retire_hook_binding announces and marks at its own summary" {
  run_wire
  [[ "${status}" -eq 0 ]] || return 1
  rm -f -- "${MARKER}"
  local hook
  hook="$(first_wired_basename)"
  [[ -n "${hook}" ]] || return 1

  run_retire "${hook}"
  [[ "${status}" -eq 0 ]] || return 1
  assert_has "${NOTICE}" || return 1
  [[ -f "${MARKER}" ]] || return 1
  grep -q 'retired=[1-9]' "${MARKER}" || return 1
}

# Make-it-red recipe for AC5: INVERT the activity comparison in _doctor_report_rewire_marker
# (`-gt` -> `-le`), which reddens AC5 and AC6 together because they are the two sides of that one
# comparison. Reverting the artifact glob to a fixed filename reddens AC6 ALONE — an unseen
# artifact is exactly what AC5 already expects, so that recipe never falsifies this test.
@test "AC5: an artifact OLDER than the marker reports no activity and keeps the marker" {
  local now
  now="$(date +%s)"
  write_marker "${now}"
  : >"${DATA}/data/zz-arbitrary-probe-fired.log"
  set_mtime "${DATA}/data/zz-arbitrary-probe-fired.log" "$((now - 60))"

  run_doctor_sandbox
  assert_has "NO hook activity observed since the rewire" || return 1
  [[ -f "${MARKER}" ]] || return 1
}

@test "AC6: an artifact NEWER than the marker reports activity yet the marker is RETAINED" {
  local now
  now="$(date +%s)"
  write_marker "${now}"
  : >"${DATA}/data/zz-arbitrary-probe-fired.log"
  set_mtime "${DATA}/data/zz-arbitrary-probe-fired.log" "$((now + 60))"

  run_doctor_sandbox
  assert_has "hook activity observed since the rewire" || return 1
  refute_has "NO hook activity observed since the rewire" || return 1
  assert_has "does NOT prove the new binding is live" || return 1
  # The refuted premise, pinned: an observation never resolves the marker.
  [[ -f "${MARKER}" ]] || return 1
}

@test "AC7: a marker past the window is cleaned up with no report row" {
  local now
  now="$(date +%s)"
  write_marker "$((now - 8 * 86400))"

  run_doctor_sandbox
  refute_has "hook activity observed since the rewire" || return 1
  refute_has "hook rewire pending" || return 1
  [[ ! -e "${MARKER}" ]] || return 1
}

@test "AC8: the marker changes neither the warning count nor the exit code" {
  run_doctor_sandbox
  local base_status="${status}" base_warns
  base_warns="$(summary_warns)"

  # No artifact seeding: neither report branch touches a counter, and the asserted substring is
  # common to both wordings — the branch AC8 does not distinguish is fixture it does not need.
  local now
  now="$(date +%s)"
  write_marker "${now}"

  run_doctor_sandbox
  assert_has "hook activity observed since the rewire" || return 1
  [[ "${status}" -eq "${base_status}" ]] || return 1
  [[ "$(summary_warns)" == "${base_warns}" ]] || return 1
}
