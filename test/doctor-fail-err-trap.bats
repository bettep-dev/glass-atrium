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
# then calls the REAL `passthrough doctor`. FAIL-BEFORE: a sed copy reverting the fix
# (exit → return) is driven identically and MUST emit `ERROR: line` (proving the assertion
# discriminates); PASS-AFTER: the real launcher MUST NOT, and the exit code stays intact.
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
  PREFIX="${SANDBOX}/glass-atrium-prefix"

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

  # Pre-fix launcher = the committed HEAD (the only working-tree edits to glass-atrium are the
  # doctor + preflight branch fixes), so HEAD carries BOTH faithful pre-fix forms: doctor's
  # `return "${doctor_rc}"` AND `preflight) run_doctor ;;`. Both lib trees are symlinked so the
  # copy at ${SANDBOX} resolves its launcher-libs (${GA_ROOT}/lib) AND script-libs
  # (${GA_ROOT}/scripts/lib, e.g. atrium-config.sh) natively. git-absent → empty PREFIX +
  # fail-before tests skip.
  ln -s "${GA}/lib" "${SANDBOX}/lib"
  mkdir -p "${SANDBOX}/scripts"
  ln -s "${GA}/scripts/lib" "${SANDBOX}/scripts/lib"
  git -C "${GA}" show HEAD:glass-atrium >"${PREFIX}" 2>/dev/null || : >"${PREFIX}"
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

# === FAIL-BEFORE — the pre-fix (HEAD) launcher DID trip the ERR trap =========================

@test "item6 fail-before: the pre-fix doctor branch ('return \${doctor_rc}') emits the spurious ERR-trap line" {
  [[ -s "${PREFIX}" ]] || skip "git-absent — HEAD pre-fix launcher unavailable"
  drive "${PREFIX}" 3 doctor
  # the guard's discriminating signal: pre-fix, the non-zero return trips the echo-only ERR trap.
  [[ "${output}" == *"ERROR: line"* ]] || return 1
}

@test "item6 fail-before: even the pre-fix doctor branch still returns the doctor rc (3)" {
  [[ -s "${PREFIX}" ]] || skip "git-absent — HEAD pre-fix launcher unavailable"
  # the spurious message is ON TOP of a correct exit code — the fix removes only the noise.
  drive "${PREFIX}" 3 doctor
  [[ "${status}" -eq 3 ]] || return 1
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

@test "preflight fail-before: the pre-fix 'preflight) run_doctor ;;' emits the spurious ERR-trap line" {
  [[ -s "${PREFIX}" ]] || skip "git-absent — HEAD pre-fix launcher unavailable"
  drive "${PREFIX}" 3 preflight
  [[ "${output}" == *"ERROR: line"* ]] || return 1
}

@test "preflight fail-before: the pre-fix preflight branch still propagates the doctor rc (3)" {
  [[ -s "${PREFIX}" ]] || skip "git-absent — HEAD pre-fix launcher unavailable"
  drive "${PREFIX}" 3 preflight
  [[ "${status}" -eq 3 ]] || return 1
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
