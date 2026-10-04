#!/usr/bin/env bats
# daemon-cycle-retire-stage.bats — the cycle driver's retirement stage: the launcher's
# retire-launchd-jobs routine runs ahead of dispatch in every mode except --backfill-only, a launcher
# that cannot run is a named skip, and an uncleared residue degrades the cycle without aborting it.
#
# Hermetic: a copied driver in a mktemp tree, a fake HOME, and an argv-recording launcher stub beside
# it. The real routine never runs, so no launchctl, tmux, port lookup or signal is reached.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_DRIVER="${GA}/autoagent/daemon-cycle.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

RETIRE_CALL="entry retire-launchd-jobs"

setup() {
  [[ -f "${REAL_DRIVER}" ]] || skip "daemon-cycle.sh not found: ${REAL_DRIVER}"
  WORK="$(cd -- "$(mktemp -d -t daemon-cycle-retire-stage.XXXXXX)" && pwd -P)"
  FAKE_HOME="${WORK}/home"
  REPORTS="${WORK}/reports"
  CALL_LOG="${WORK}/calls.log"
  OUT_JSON="${WORK}/cycle.json"
  LAUNCHER="${WORK}/real/glass-atrium"
  mkdir -p -- "${FAKE_HOME}/.glass-atrium/hooks" "${WORK}/real/autoagent/archive" "${WORK}/bin" "${REPORTS}"
  DRIVER="${WORK}/real/autoagent/daemon-cycle.sh"
  cp -p -- "${REAL_DRIVER}" "${DRIVER}"
  # existence only: the driver checks these files, the python stub never reads them
  : >"${WORK}/real/autoagent/daemon_cycle.py"
  : >"${FAKE_HOME}/.glass-atrium/hooks/learning-aggregator.py"
  # completion record, no re-arm marker → the backfill head stage is not pending and calls nothing
  : >"${REPORTS}/.unadjudicated-backfill-done"
  printf '%s\n' '{"patches": []}' >"${OUT_JSON}"
  make_python_stub
  make_stage_stubs
  make_launcher_stub
  EXTRA_ENV=()
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# make_python_stub — every PYTHON_BIN call lands here and logs one line naming what it was.
make_python_stub() {
  cat >"${WORK}/bin/python-stub" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" --backfill-unadjudicated "*) printf 'mode\n' >>"${STUB_CALL_LOG}" ;;
  *" --limit "*) printf 'cycle\n' >>"${STUB_CALL_LOG}" ;;
  *) printf 'py %s\n' "$*" >>"${STUB_CALL_LOG}" ;;
esac
exit 0
EOF
  chmod +x "${WORK}/bin/python-stub"
}

# make_stage_stubs — the apply and regression scripts log their name; the claude CLI the driver
# resolves at load time is never executed by any stage here.
make_stage_stubs() {
  local apply="${WORK}/real/autoagent/daemon-apply.sh"
  local regression="${WORK}/real/autoagent/archive/daemon-regression-deprecated-2026-05-02.sh"
  # shellcheck disable=SC2016  # STUB_CALL_LOG expands when the stub runs, not here
  printf '#!/usr/bin/env bash\nprintf "apply\\n" >>"${STUB_CALL_LOG}"\n' >"${apply}"
  # shellcheck disable=SC2016  # STUB_CALL_LOG expands when the stub runs, not here
  printf '#!/usr/bin/env bash\nprintf "regression\\n" >>"${STUB_CALL_LOG}"\n' >"${regression}"
  printf '#!/usr/bin/env bash\nexit 1\n' >"${WORK}/bin/claude"
  chmod +x "${apply}" "${regression}" "${WORK}/bin/claude"
}

# make_launcher_stub — the harness entry point the driver resolves beside its own root. Records its
# argv; the retirement call exits STUB_RETIRE_RC, every other call exits 0.
make_launcher_stub() {
  cat >"${LAUNCHER}" <<'EOF'
#!/usr/bin/env bash
printf 'entry %s\n' "$*" >>"${STUB_CALL_LOG}"
if [[ "${1:-}" == retire-launchd-jobs ]]; then
  exit "${STUB_RETIRE_RC:-0}"
fi
exit 0
EOF
  chmod +x "${LAUNCHER}"
}

# run_driver — no DB-target input and no target home from the host; EXTRA_ENV entries come last, so
# a row overrides a default by naming it there.
run_driver() {
  : >"${CALL_LOG}"
  run env -u AUTOAGENT_CLAUDE_BIN -u DATABASE_URL -u ATRIUM_UPDATE_DB_NAME -u GA_SKIP_DB_SETUP \
    -u GA_DB_NAME -u GA_TARGET_HOME \
    HOME="${FAKE_HOME}" GA_DATA_ROOT="${WORK}/data-root" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_APPLY_LOCK_LIB="${GA}/scripts/lib/apply-lock.sh" \
    AUTOAGENT_PYTHON_BIN="${WORK}/bin/python-stub" STUB_CALL_LOG="${CALL_LOG}" \
    PATH="${WORK}/bin:${PATH}" ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    bash "${DRIVER}" --out "${OUT_JSON}" "$@"
}

retire_calls() {
  grep -c "^${RETIRE_CALL}" "${CALL_LOG}" || true
}

@test "the retirement call precedes the first stage of every dispatch mode" {
  local row name args first
  local -a argv
  local rows=(
    "no argument||cycle"
    "full-cycle|--full-cycle|cycle"
    "cycle-only|--cycle-only|cycle"
    "apply-only|--apply-only|py *--regenerate-stale*"
    "regression-only|--regression-only|regression"
    "aggregate-only|--aggregate-only|py *learning-aggregator.py*"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name args first <<<"${row}"
    argv=()
    if [[ -n "${args}" ]]; then argv=("${args}"); fi
    run_driver ${argv[@]+"${argv[@]}"}
    # shellcheck disable=SC2053  # the expected first stage is a glob pattern
    [[ "$(sed -n 1p "${CALL_LOG}")" == "${RETIRE_CALL}" && "$(sed -n 2p "${CALL_LOG}")" == ${first} ]] || {
      echo "${name}: call order: $(cat "${CALL_LOG}")"
      echo "${output}"
      return 1
    }
  done
}

@test "backfill-only runs the backfill mode and never the retirement routine" {
  run_driver --backfill-only
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(cat "${CALL_LOG}")" == "mode" ]] || {
    echo "calls: $(cat "${CALL_LOG}")"
    echo "${output}"
    return 1
  }
}

@test "dry-run reaches the routine as its --dry-run flag and a live cycle passes none" {
  local row name args expected
  local -a argv
  local rows=(
    "dry run|--cycle-only --dry-run|${RETIRE_CALL} --dry-run"
    "live run|--cycle-only|${RETIRE_CALL}"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name args expected <<<"${row}"
    IFS=' ' read -r -a argv <<<"${args}"
    run_driver "${argv[@]}"
    [[ "$(grep "^${RETIRE_CALL}" "${CALL_LOG}" || true)" == "${expected}" ]] || {
      echo "${name}: calls: $(cat "${CALL_LOG}")"
      echo "${output}"
      return 1
    }
  done
}

@test "an absent or non-executable launcher skips the stage by name and keeps the cycle clean" {
  local row name reason line
  for row in "absent launcher|absent" "mode-644 launcher|not executable"; do
    IFS='|' read -r name reason <<<"${row}"
    make_launcher_stub
    if [[ "${reason}" == absent ]]; then
      if ga_guard_path "${LAUNCHER}"; then rm -f -- "${LAUNCHER:?}"; fi
    else
      chmod 644 "${LAUNCHER}"
    fi
    run_driver --cycle-only
    line="$(grep -F 'stage=retire SKIP' <<<"${output}" || true)"
    [[ "${line}" == *"${LAUNCHER} ${reason} "* ]] || {
      echo "${name}: retire skip line: ${line}"
      echo "${output}"
      return 1
    }
    [[ "${status}" -eq 0 && "$(cat "${CALL_LOG}")" == "cycle"* ]] || {
      echo "${name}: status ${status}, calls: $(cat "${CALL_LOG}")"
      echo "${output}"
      return 1
    }
  done
}

@test "a non-zero routine rc degrades the cycle while every later stage still runs" {
  local row name retire_rc expected
  for row in "residue cleared|0|0" "residue left in place|1|1" "launcher failure|3|1"; do
    IFS='|' read -r name retire_rc expected <<<"${row}"
    EXTRA_ENV=(STUB_RETIRE_RC="${retire_rc}")
    run_driver --full-cycle
    [[ "${status}" -eq "${expected}" ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ "${output}" == *"stage=retire rc=${retire_rc}"* ]] || {
      echo "${name}: ${output}"
      return 1
    }
    {
      grep -q '^cycle$' "${CALL_LOG}" && grep -q '^apply$' "${CALL_LOG}" \
        && grep -q '^entry doctor$' "${CALL_LOG}"
    } || {
      echo "${name}: a later stage did not run — calls: $(cat "${CALL_LOG}")"
      return 1
    }
  done
}
