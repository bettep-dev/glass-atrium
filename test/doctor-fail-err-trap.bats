#!/usr/bin/env bats
# doctor-fail-err-trap.bats — red-team #17 residual item 6.
#
# DEFECT (confirmed by code-trace): the launcher's `doctor` passthrough branch did
# `return "${doctor_rc}"`. Under the launcher's `set -Eeuo pipefail` + the echo-only ERR
# trap (glass-atrium:325 `trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR`),
# a NON-ZERO `return` is a "failed command" that trips the ERR trap, printing a spurious
# `ERROR: line …: return …` on top of a LEGITIMATE doctor FAIL. The sibling `update`
# passthrough branch already solved the identical problem by using `exit "${update_rc}"`
# (documented at glass-atrium:742-743). FIX: mirror it — `exit "${doctor_rc}"` (which never
# trips ERR, and cleanup()'s EXIT trap preserves $? so the returned code is unchanged).
#
# STRATEGY (launcher-as-library, mirrors test/run-step-fail-return.bats): a driver SOURCES
# the real launcher (BASH_SOURCE!=$0 → main is skipped), keeps the REAL ERR + EXIT traps
# ARMED, stubs run_doctor to return non-zero + doctor_headless_auth_advisory to a no-op,
# then calls the REAL `passthrough doctor`. PASS-AFTER: the real launcher MUST NOT emit a
# spurious `ERROR: line` and preserves the exit code; STATIC: the source pins the `exit`-idiom
# on both the doctor and preflight branches (mirroring the `update` branch).
#
# Machine-safe: no real doctor run (run_doctor stubbed), no TTY, no ~/.claude / ~/.glass-atrium
# mutation. bats `run` merges stderr into $output, so the ERR-trap line lands in $output.
#
# Run via: bats test/doctor-fail-err-trap.bats
# Requires: bats 1.5+, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
TUI="${GA}/glass-atrium"

setup() {
  [[ -f "${TUI}" ]] || skip "glass-atrium launcher not found: ${TUI}"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "launcher lib not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-doctor-errtrap.XXXXXX)"
  DRIVER="${SANDBOX}/driver.sh"

  # The driver keeps the REAL ERR+EXIT traps armed (does NOT `trap - ERR`), stubs the two
  # doctor callees, and calls the REAL passthrough branch named by SUB (doctor | preflight —
  # preflight is a doctor alias that shares the ERR-trap defect).
  cat >"${DRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck disable=SC1090,SC2317
source "${GA_LAUNCHER}" >/dev/null 2>&1
run_doctor() { return "${DOCTOR_RC:-3}"; }
doctor_headless_auth_advisory() { :; }
passthrough "${SUB:-doctor}"
DRV
  chmod +x "${DRIVER}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

drive() {
  # $1 = launcher path, $2 = doctor rc (default 3), $3 = passthrough sub (doctor | preflight)
  run env GA_LAUNCHER="$1" DOCTOR_RC="${2:-3}" SUB="${3:-doctor}" bash "${DRIVER}"
}

# === PASS-AFTER — the real (fixed) launcher ==================================================

@test "item6 pass-after: a non-zero doctor FAIL emits NO spurious ERR-trap line" {
  drive "${TUI}" 3
  [[ "${output}" != *"ERROR: line"* ]] || return 1
}

@test "item6 pass-after: the doctor FAIL exit code is preserved unchanged (3)" {
  drive "${TUI}" 3
  [[ "${status}" -eq 3 ]] || return 1
}

@test "item6 pass-after: a different non-zero doctor rc (2) is also clean + preserved" {
  drive "${TUI}" 2
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" != *"ERROR: line"* ]] || return 1
}

@test "item6 pass-after: a PASSING doctor (rc 0) stays clean + exits 0" {
  drive "${TUI}" 0
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"ERROR: line"* ]] || return 1
}

# === PREFLIGHT ALIAS — the sibling branch shares (and now is freed of) the same defect =======

@test "preflight pass-after: a non-zero doctor FAIL via 'preflight' emits NO spurious ERR-trap line" {
  drive "${TUI}" 3 preflight
  [[ "${output}" != *"ERROR: line"* ]] || return 1
}

@test "preflight pass-after: the preflight FAIL exit code is preserved unchanged (3)" {
  drive "${TUI}" 3 preflight
  [[ "${status}" -eq 3 ]] || return 1
}

@test "preflight pass-after: a PASSING preflight (rc 0) stays clean + exits 0" {
  drive "${TUI}" 0 preflight
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"ERROR: line"* ]] || return 1
}

# === STATIC — the doctor + preflight branches mirror the `update` branch's exit idiom ========

@test "item6 static: the doctor passthrough branch uses 'exit \${doctor_rc}', not 'return \${doctor_rc}'" {
  local branch
  branch="$(awk '/^    doctor\)/{f=1} f{print} f&&/^      ;;/{exit}' "${TUI}")"
  [[ -n "${branch}" ]] || return 1
  [[ "${branch}" == *'exit "${doctor_rc}"'* ]] || return 1
  [[ "${branch}" != *'return "${doctor_rc}"'* ]] || return 1
}

@test "preflight static: the preflight branch 'exit \${pf_rc}'s the captured rc (no bare terminal run_doctor)" {
  local branch
  branch="$(awk '/^    preflight\)/{f=1} f{print} f&&/^      ;;/{exit}' "${TUI}")"
  [[ -n "${branch}" ]] || return 1
  [[ "${branch}" == *'run_doctor || pf_rc=$?'* ]] || return 1
  [[ "${branch}" == *'exit "${pf_rc}"'* ]] || return 1
  # the defect form (run_doctor as the terminal case action) is gone.
  [[ "${branch}" != *'preflight) run_doctor ;;'* ]] || return 1
  # preflight must NOT run the auth advisory (doctor-only).
  [[ "${branch}" != *'doctor_headless_auth_advisory'* ]] || return 1
}
