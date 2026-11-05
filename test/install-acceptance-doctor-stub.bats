#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_* come from bats; GA_DOCTOR_DEAD_PORT from the suite setup (test/lib/bats-hermetic-env.bash)
# test/install-acceptance.sh STEP 1 → create_claude_stub + is_stub_reached: the verdict says the
# doctor's metered `claude -p` self-test ran the sandbox stub exactly when the real doctor called it.
# The acceptance script itself is no *.bats file, so the runner never executes it — this suite does.
#
# Run via: bats test/install-acceptance-doctor-stub.bats
# Requires: bats >= 1.5.0, jq, perl (run_with_timeout)

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  load 'lib/bats-db-seal'
  ga_bats_db_seal
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v perl >/dev/null 2>&1 || skip "perl not on PATH (run_with_timeout needs it)"
  SANDBOX="$(mktemp -d -t ga-acceptance-doctor-stub.XXXXXX)"
  mkdir -p "${SANDBOX}/home" "${SANDBOX}/target" "${SANDBOX}/data-root" "${SANDBOX}/empty-reports" \
    "${SANDBOX}/bin"
  local fn
  for fn in create_claude_stub is_stub_reached; do
    awk -v fn="${fn}" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
      "${GA}/test/install-acceptance.sh" >>"${SANDBOX}/oracle.sh"
  done
  # shellcheck source=/dev/null
  source "${SANDBOX}/oracle.sh"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# Run the real doctor with every write and read seam inside the sandbox; $1 is the auth-env lib path.
run_doctor_with_stub() {
  HOME="${SANDBOX}/home" GA_TARGET_HOME="${SANDBOX}/target" GA_DATA_ROOT="${SANDBOX}/data-root" \
    ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/update-state" ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT}" \
    DOCTOR_AUTH_REPORTS_DIR="${SANDBOX}/empty-reports" GA_GENERATE_MANIFEST="${SANDBOX}/no-manifest-gen" \
    GA_AUTH_CLAUDE_BIN="${SANDBOX}/bin/claude" GA_AUTH_ENV_LIB="$1" \
    "${REAL_GA}" doctor >"${SANDBOX}/doctor.log" 2>&1 || true
}

@test "STEP 1 verdict reports the stub reached iff the doctor's self-test called it" {
  declare -f create_claude_stub is_stub_reached >/dev/null

  local row name env_lib expected got calls n=0
  # name | auth-env lib the self-test sources | expected verdict
  local rows=(
    "env lib present, self-test runs the stub|${GA}/scripts/lib/claude-auth-env.sh|reached"
    "env lib absent, self-test skips before the stub|${GA}/scripts/lib/no-such-auth-env.sh|unreached"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name env_lib expected <<<"${row}"
    n=$((n + 1))
    calls="${SANDBOX}/calls.${n}"
    create_claude_stub "${SANDBOX}/bin/claude" "${calls}"
    run_doctor_with_stub "${env_lib}"
    got=unreached
    if is_stub_reached "${calls}"; then got=reached; fi
    [[ "${got}" == "${expected}" ]] || {
      echo "${name}: expected ${expected}, got ${got}"
      cat "${SANDBOX}/doctor.log"
      return 1
    }
  done
}
