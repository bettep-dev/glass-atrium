#!/usr/bin/env bats
# daemon-cycle-dry-run.bats — the cycle driver's --dry-run reaches the cycle module as the module's
# own no-write flag, so the documented dry run never runs the module's writing stages.
#
# Hermetic: a copied driver in a mktemp tree, a fake HOME, and AUTOAGENT_PYTHON_BIN pointed at a bash
# stub that logs each call's argv — no python stage, helper, launcher or database is reached.

bats_require_minimum_version 1.5.0

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME comes from bats
GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_DRIVER="${GA}/autoagent/daemon-cycle.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  [[ -f "${REAL_DRIVER}" ]] || skip "daemon-cycle.sh not found: ${REAL_DRIVER}"
  local tmp
  tmp="$(mktemp -d -t daemon-cycle-dry-run.XXXXXX)"
  WORK="$(cd -- "${tmp}" && pwd -P)"
  FAKE_HOME="${WORK}/home"
  REPORTS="${WORK}/reports"
  CALL_LOG="${WORK}/calls.log"
  OUT_JSON="${WORK}/cycle.json"
  mkdir -p -- "${FAKE_HOME}/.glass-atrium/hooks" "${WORK}/real/autoagent/archive" "${WORK}/bin" "${REPORTS}"
  DRIVER="${WORK}/real/autoagent/daemon-cycle.sh"
  cp -p -- "${REAL_DRIVER}" "${DRIVER}"
  # existence only: the driver checks these files, the python stub never reads them
  : >"${WORK}/real/autoagent/daemon_cycle.py"
  : >"${FAKE_HOME}/.glass-atrium/hooks/learning-aggregator.py"
  # completion record, no re-arm marker → the backfill head stage is not pending and calls nothing
  : >"${REPORTS}/.unadjudicated-backfill-done"
  printf '%s\n' '{"patches": []}' >"${OUT_JSON}"
  make_stubs
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# make_stubs — the python stub logs the cycle module call with its argv; the apply and regression
# scripts and the claude CLI the driver resolves at load time only exit.
make_stubs() {
  cat >"${WORK}/bin/python-stub" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" --limit "*) printf 'cycle %s\n' "$*" >>"${STUB_CALL_LOG}" ;;
  *) printf 'py %s\n' "$*" >>"${STUB_CALL_LOG}" ;;
esac
exit 0
EOF
  printf '#!/usr/bin/env bash\nexit 0\n' >"${WORK}/real/autoagent/daemon-apply.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' \
    >"${WORK}/real/autoagent/archive/daemon-regression-deprecated-2026-05-02.sh"
  printf '#!/usr/bin/env bash\nexit 1\n' >"${WORK}/bin/claude"
  chmod +x "${WORK}/bin/python-stub" "${WORK}/real/autoagent/daemon-apply.sh" \
    "${WORK}/real/autoagent/archive/daemon-regression-deprecated-2026-05-02.sh" "${WORK}/bin/claude"
}

# run_driver — the default dispatch mode, with no DB-target input and no limit from the host.
run_driver() {
  : >"${CALL_LOG}"
  run env -u AUTOAGENT_CLAUDE_BIN -u DATABASE_URL -u ATRIUM_UPDATE_DB_NAME -u GA_SKIP_DB_SETUP \
    -u GA_DB_NAME -u GA_TARGET_HOME -u AUTOAGENT_DAEMON_LIMIT \
    HOME="${FAKE_HOME}" GA_DATA_ROOT="${WORK}/data-root" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_APPLY_LOCK_LIB="${GA}/scripts/lib/apply-lock.sh" \
    AUTOAGENT_PYTHON_BIN="${WORK}/bin/python-stub" STUB_CALL_LOG="${CALL_LOG}" \
    PATH="${WORK}/bin:${PATH}" \
    bash "${DRIVER}" --out "${OUT_JSON}" "$@"
}

# cycle_calls — every cycle module call the last run made, one per line.
cycle_calls() {
  grep '^cycle ' "${CALL_LOG}" || true
}

@test "a dry run adds only the module's own --dry-run to the cycle call a bare run makes" {
  local bare dry
  run_driver
  [[ "${status}" -eq 0 ]] || {
    echo "bare run: ${output}"
    return 1
  }
  bare="$(cycle_calls)"
  run_driver --dry-run
  [[ "${status}" -eq 0 ]] || {
    echo "dry run: ${output}"
    return 1
  }
  dry="$(cycle_calls)"
  [[ "${bare}" == "cycle "* && "${bare}" != *$'\n'* && "${bare}" != *" --dry-run"* &&
    "${bare}" != *" --skip-haiku"* ]] || {
    echo "bare run cycle calls: ${bare}"
    return 1
  }
  [[ "${dry}" == "${bare} --dry-run" ]] || {
    echo "dry run cycle calls: ${dry}"
    echo "bare run cycle calls: ${bare}"
    return 1
  }
}
