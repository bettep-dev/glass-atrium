#!/usr/bin/env bats
# doctor-config-key-drift.bats — pins run_doctor §22 (config.toml key drift vs the template).
#
# render_config returns early once config.toml holds no unexpanded ${HOME} token, so a key added to
# or removed from the shipped template never reaches an existing install and nothing compares the
# two key sets. This section is that comparison and changes nothing: it reads both files, reports
# template keys the live file lacks, and never moves the counter or the exit code (kind B).
#
# Each row asserts a property the others cannot produce:
#   AC1  an unmarked template key absent from the live file -> a note row naming it
#   AC2  a `# ga:optional` key absent from the live file    -> never reported
#   AC3  values differ, key sets identical                  -> no row (names only, never values)
#   AC4  no live config.toml                                -> one note, comparison announced skipped
#   AC5  warning total                                      -> identical with and without a gap (kind B)
#
# Hermetic: template and live config are sandbox files under a throwaway GA_ROOT; the manifest
# generator path does not exist and the monitor port is dead, so no live install state is read.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict — every assertion here
# `return 1`s on mismatch so each fails the test independently.
#
# Run via: bats test/doctor-config-key-drift.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-doctor-cfgkey-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  seed_template
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Sandbox template: one plain key, one `# ga:optional` key, one dotted section. Synthetic content —
# pinning the real template here would couple this suite to an unrelated file.
seed_template() {
  cat >"${GA_SANDBOX}/config.toml.example" <<'TOML'
[meta]
timezone = "auto"
[ports]
monitor = 16145
# ga:optional
wiki_fakechat = 8788
[daemon.pg-backup]
time = "02:30"
TOML
}

# Live config.toml under test — the caller passes the whole body.
seed_live() {
  cat >"${GA_SANDBOX}/config.toml"
}

run_doctor_sandbox() {
  run env GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
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

# The warning total the PASS summary reports: 0 on a bare PASS, the parenthesised number otherwise.
warn_total_of_output() {
  local line
  line="$(printf '%s\n' "${output}" | grep -F '== doctor: PASS' || true)"
  [[ -n "${line}" ]] || {
    echo "no PASS summary line — harness defect, not a drift verdict:" >&2
    echo "${output}" >&2
    return 1
  }
  case "${line}" in
    *"with "*" warning(s)"*)
      printf '%s' "${line}" | sed -e 's/.*with \([0-9][0-9]*\) warning(s).*/\1/'
      ;;
    *) printf '0' ;;
  esac
}

@test "AC1 unmarked template key absent from the live config is reported by name" {
  # [ports].wiki_fakechat carries the marker, so the only reportable absence is [meta].timezone —
  # dropped from the live body to keep the expected set to one key.
  seed_live <<'TOML'
[ports]
monitor = 16145
[daemon.pg-backup]
time = "02:30"
TOML
  run_doctor_sandbox
  assert_output_has "config key drift"
  assert_output_has "[meta].timezone"
}

@test "AC2 a '# ga:optional' key absent from the live config is never reported" {
  seed_live <<'TOML'
[meta]
timezone = "auto"
[ports]
monitor = 16145
[daemon.pg-backup]
time = "02:30"
TOML
  run_doctor_sandbox
  assert_output_lacks "[ports].wiki_fakechat"
}

@test "AC3 differing values with identical key sets produce no drift row" {
  seed_live <<'TOML'
[meta]
timezone = "America/New_York"
[ports]
monitor = 17000
wiki_fakechat = 19999
[daemon.pg-backup]
time = "23:59"
TOML
  run_doctor_sandbox
  assert_output_has "config.toml carries every template key"
  assert_output_lacks "template key(s) absent"
}

@test "AC4 a missing live config.toml is announced, never silently skipped" {
  run_doctor_sandbox
  assert_output_has "no rendered config.toml"
  assert_output_lacks "template key(s) absent"
}

@test "AC5 the warning total is identical with and without a reported gap (kind B)" {
  seed_live <<'TOML'
[meta]
timezone = "auto"
[ports]
monitor = 16145
wiki_fakechat = 8788
[daemon.pg-backup]
time = "02:30"
TOML
  run_doctor_sandbox
  local clean
  clean="$(warn_total_of_output)"
  seed_live <<'TOML'
[ports]
monitor = 16145
TOML
  run_doctor_sandbox
  local drifted
  drifted="$(warn_total_of_output)"
  assert_output_has "template key(s) absent"
  [[ "${clean}" == "${drifted}" ]] || {
    echo "kind-B violation: warning total moved ${clean} -> ${drifted}" >&2
    return 1
  }
}
