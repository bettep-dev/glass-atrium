#!/usr/bin/env bats
# doctor-backup-dir-relocation.bats — pins run_doctor §24 (backup directory reconciliation surface).
#
# The ADR-6 resolver declines a configured [paths].backup_dir it cannot safely adopt and says so
# ONCE, on stderr, in whichever process resolved it — the nightly launchd job, whose stderr no
# operator reads. §24 is the standing surface for that condition, and for the mirror-image one: a
# resolution outside the default while the default still holds dumps nobody moved.
#
# Each row asserts a property the others cannot produce:
#   AC1  a declared value the resolver declined        -> exactly one row, naming both paths
#   AC2  resolved outside the default, default POPULATED -> exactly one row, naming the census
#   AC3  fresh install (value = the default)           -> ZERO rows
#   AC4  a customization in use, default EMPTY         -> ZERO rows (the knob working as documented)
#   AC4b a value declared EMPTY                        -> exactly one row, total unmoved
#   AC5  the warning total is identical across all three shapes (kind B)
#   AC6  the row's identifier stem is registered kind B in the summary contract
#
# AC4 is the narrowing that keeps this section quiet: a row on every legitimately customized
# install is the alarm fatigue ADR-10 split doctor from the reconciler to avoid, so widening the
# condition back to "resolved != default" alone must go red here.
#
# Hermetic: config, both backup locations and every dump are sandbox files under a throwaway
# GA_ROOT. GA_DB_BACKUP_DIR is stripped from the environment so an operator seam in the caller's
# shell cannot hijack the resolver mid-suite.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict under bash 3.2 — every
# assertion here ends in `return 1` on mismatch, so each fails the test on its own.
#
# Run via: bats test/doctor-backup-dir-relocation.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
CONTRACT="${GA}/test/doctor-summary-contract.bats"

# Every §24 row carries this stem, so a row census is one grep and a healthy run is provably zero.
ROW_MARKER='note : backup dir'

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-doctor-bkpdir-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  # The default location the resolver derives from GA_DATA_ROOT, spelled once here.
  DEFAULT_DIR="${SANDBOX}/data/backups/postgres"
  CUSTOM_DIR="${SANDBOX}/relocated-backups"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# seed_config <backup_dir value|-> — writes the sandbox config.toml; `-` omits the key entirely.
seed_config() {
  local value="$1"
  {
    printf '[paths]\n'
    printf 'target_home = "%s"\n' "${TARGET}"
    [[ "${value}" == "-" ]] || printf 'backup_dir = "%s"\n' "${value}"
  } >"${GA_SANDBOX}/config.toml"
}

# seed_dump <dir> — one *.dump file, which is what the resolver's census counts.
seed_dump() {
  mkdir -p "$1"
  printf 'pg_dump payload\n' >"$1/glass_atrium-20260101-000000.dump"
}

run_doctor_sandbox() {
  run env -u GA_DB_BACKUP_DIR \
    GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
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

# How many §24 rows the last run emitted. `|| true` (never `|| echo 0`: grep -c already prints 0).
section_row_count() {
  local count
  count="$(printf '%s\n' "${output}" | grep -c -F -- "${ROW_MARKER}" || true)"
  [[ -n "${count}" ]] || count=0
  printf '%s' "${count}"
}

assert_row_count() {
  local want="$1" got
  got="$(section_row_count)"
  [[ "${got}" == "${want}" ]] || {
    printf 'expected %s §24 row(s), got %s — output:\n%s\n' "${want}" "${got}" "${output}" >&2
    return 1
  }
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    printf 'doctor output missing %s — output:\n%s\n' "${1}" "${output}" >&2
    return 1
  }
}

# The warning total the PASS summary reports: 0 on a bare PASS, the parenthesised number otherwise.
warn_total_of_output() {
  local line
  line="$(printf '%s\n' "${output}" | grep -F '== doctor: PASS' || true)"
  [[ -n "${line}" ]] || {
    printf 'no PASS summary line — harness defect, not a drift verdict:\n%s\n' "${output}" >&2
    return 1
  }
  case "${line}" in
    *"with "*" warning(s)"*) printf '%s' "${line}" | sed -e 's/.*with \([0-9][0-9]*\) warning(s).*/\1/' ;;
    *) printf '0' ;;
  esac
}

@test "AC1 a declared value the resolver declined is reported once, naming both paths" {
  # The live shape: the configured directory does not exist and its parent is missing, while the
  # default location already holds dumps — ADR-6 case 4, adoption declined.
  seed_config "${SANDBOX}/absent-parent/backups"
  seed_dump "${DEFAULT_DIR}"
  run_doctor_sandbox
  assert_row_count 1
  assert_output_has "backup dir unreconciled"
  assert_output_has "${SANDBOX}/absent-parent/backups"
  assert_output_has "${DEFAULT_DIR}"
}

@test "AC2 resolution outside a still-populated default is reported once, with the census" {
  seed_config "${CUSTOM_DIR}"
  mkdir -p "${CUSTOM_DIR}" # exists -> adopted (ADR-6 case 2)
  seed_dump "${DEFAULT_DIR}"
  run_doctor_sandbox
  assert_row_count 1
  assert_output_has "backup dir relocated"
  assert_output_has "1 dump(s)"
  assert_output_has "${CUSTOM_DIR}"
}

@test "AC3 a fresh install declaring the default emits no row" {
  seed_config "${DEFAULT_DIR}"
  run_doctor_sandbox
  assert_row_count 0
}

@test "AC4 a customization in use with an empty default emits no row" {
  # The knob working exactly as documented: an adopted value, nothing stranded behind it. A row
  # here would fire on every customized install for as long as it stayed customized.
  seed_config "${CUSTOM_DIR}"
  mkdir -p "${CUSTOM_DIR}"
  seed_dump "${CUSTOM_DIR}"
  run_doctor_sandbox
  assert_row_count 0
}

@test "AC4b a value declared with an empty string is reported once, total unmoved" {
  # ADR-6 case 5. The resolver declines it and WARNs into the nightly job's unread stderr,
  # which is the exact condition this section exists to make standing — gating the row on a
  # non-empty configured value hides the one shape the operator cannot see anywhere else.
  local healthy empty
  seed_config "${DEFAULT_DIR}"
  run_doctor_sandbox
  healthy="$(warn_total_of_output)"

  seed_config ""
  run_doctor_sandbox
  assert_row_count 1
  assert_output_has "backup dir unreconciled"
  assert_output_has "empty value"
  empty="$(warn_total_of_output)"
  [[ "${healthy}" == "${empty}" ]] || {
    printf 'kind-B violation: warning total moved healthy=%s empty=%s\n' "${healthy}" "${empty}" >&2
    return 1
  }
}

@test "AC5 the warning total is identical across healthy, declined and relocated (kind B)" {
  local healthy declined relocated
  seed_config "${DEFAULT_DIR}"
  run_doctor_sandbox
  healthy="$(warn_total_of_output)"

  seed_config "${SANDBOX}/absent-parent/backups"
  seed_dump "${DEFAULT_DIR}"
  run_doctor_sandbox
  declined="$(warn_total_of_output)"
  assert_output_has "backup dir unreconciled"

  seed_config "${CUSTOM_DIR}"
  mkdir -p "${CUSTOM_DIR}"
  run_doctor_sandbox
  relocated="$(warn_total_of_output)"
  assert_output_has "backup dir relocated"

  [[ "${healthy}" == "${declined}" && "${healthy}" == "${relocated}" ]] || {
    printf 'kind-B violation: warning total moved healthy=%s declined=%s relocated=%s\n' \
      "${healthy}" "${declined}" "${relocated}" >&2
    return 1
  }
}

@test "AC6 the §24 identifier stem is registered kind B in the summary contract" {
  # Registration is what makes the promotion guard bind: an unregistered stem means the contract
  # suite would let a future edit fold this row into the warning total unnoticed.
  [[ -f "${CONTRACT}" ]] || {
    printf 'summary contract suite missing: %s\n' "${CONTRACT}" >&2
    return 1
  }
  # The last stem on the list carries the closing quote, so the anchor tolerates it.
  grep -qE "^bkpdir'?\$" "${CONTRACT}" || {
    printf 'stem `bkpdir` is not registered in KIND_B_STEMS of %s\n' "${CONTRACT}" >&2
    return 1
  }
  grep -q 'bkpdir' "${GA}/lib/ga-doctor.sh" || {
    printf 'stem `bkpdir` names no identifier in lib/ga-doctor.sh\n' >&2
    return 1
  }
}
