#!/usr/bin/env bats
# daemon-cycle-backfill-stage.bats — the cycle driver's unadjudicated-backfill head stage: when it
# invokes the backfill mode, what it skips by name, how it holds and releases .apply-lock, and how the
# mode rc folds into the cycle exit.
#
# Hermetic: a copied driver in a mktemp tree, a fake HOME, AUTOAGENT_REPORTS_DIR inside the work dir,
# and AUTOAGENT_PYTHON_BIN pointed at a bash stub that logs one line per call — no python stage, no
# helper and no database is reached. Only the lock lib is real (ATRIUM_APPLY_LOCK_LIB).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_DRIVER="${GA}/autoagent/daemon-cycle.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

RECORD=".unadjudicated-backfill-done"
MARKER=".unadjudicated-backfill-pending"

setup() {
  [[ -f "${REAL_DRIVER}" ]] || skip "daemon-cycle.sh not found: ${REAL_DRIVER}"
  WORK="$(cd -- "$(mktemp -d -t daemon-cycle-backfill-stage.XXXXXX)" && pwd -P)"
  FAKE_HOME="${WORK}/home"
  mkdir -p -- "${FAKE_HOME}/.glass-atrium/hooks" "${WORK}/real/autoagent/archive" "${WORK}/bin"
  DRIVER="${WORK}/real/autoagent/daemon-cycle.sh"
  cp -p -- "${REAL_DRIVER}" "${DRIVER}"
  # existence only: the driver checks the module file, the python stub never reads it
  : >"${WORK}/real/autoagent/daemon_cycle.py"
  : >"${FAKE_HOME}/.glass-atrium/hooks/learning-aggregator.py"
  make_python_stub
  make_stage_stubs
  EXTRA_ENV=()
  use_row default
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# use_row — per-row reports dir, call log and report, so no row sees another row's state.
use_row() {
  ROW_DIR="${WORK}/rows/$1"
  REPORTS="${ROW_DIR}/reports"
  CALL_LOG="${ROW_DIR}/calls.log"
  OUT_JSON="${ROW_DIR}/cycle.json"
  mkdir -p -- "${REPORTS}"
  printf '%s\n' '{"patches": []}' >"${OUT_JSON}"
}

# make_python_stub — every PYTHON_BIN call lands here. The backfill mode call logs its argv plus the
# pid file of the lock under its --reports-dir (the lock the stage holds while the mode runs), then
# exits STUB_MODE_RC; STUB_MODE_TERM sends TERM to the driver first. The cycle call can plant an
# acquirer's pid-less lock dir (STUB_CYCLE_PLANT_LOCK).
make_python_stub() {
  cat >"${WORK}/bin/python-stub" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" --backfill-unadjudicated "*)
    dir="" prev=""
    for arg in "$@"; do
      if [[ "${prev}" == "--reports-dir" ]]; then dir="${arg}"; fi
      prev="${arg}"
    done
    printf 'mode %s lockpid=%s\n' "$*" "$(cat -- "${dir}/.apply-lock/pid" 2>/dev/null)" >>"${STUB_CALL_LOG}"
    if [[ -n "${STUB_MODE_TERM:-}" ]]; then kill -TERM "${PPID}"; fi
    exit "${STUB_MODE_RC:-0}"
    ;;
  *" --limit "*)
    printf 'cycle %s\n' "$*" >>"${STUB_CALL_LOG}"
    if [[ -n "${STUB_CYCLE_PLANT_LOCK:-}" ]]; then
      mkdir -p -- "${STUB_CYCLE_PLANT_LOCK}" && : >"${STUB_CYCLE_PLANT_LOCK}/pid"
    fi
    ;;
  *) printf 'py %s\n' "$*" >>"${STUB_CALL_LOG}" ;;
esac
exit 0
EOF
  chmod +x "${WORK}/bin/python-stub"
}

# make_stage_stubs — the non-python stages, each logging its own name, the launcher (its retirement
# call logs `retire`, any other call `doctor`), plus the claude CLI the driver resolves at load time
# (never executed by any stage here).
make_stage_stubs() {
  local name path
  for name in apply regression; do
    case "${name}" in
      apply) path="${WORK}/real/autoagent/daemon-apply.sh" ;;
      regression) path="${WORK}/real/autoagent/archive/daemon-regression-deprecated-2026-05-02.sh" ;;
      *) return 1 ;;
    esac
    # shellcheck disable=SC2016  # STUB_CALL_LOG expands when the stub runs, not here
    printf '#!/usr/bin/env bash\nprintf "%s\\n" >>"${STUB_CALL_LOG}"\n' "${name}" >"${path}"
    chmod +x "${path}"
  done
  cat >"${WORK}/real/glass-atrium" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == retire-launchd-jobs ]]; then
  printf 'retire\n' >>"${STUB_CALL_LOG}"
else
  printf 'doctor\n' >>"${STUB_CALL_LOG}"
fi
EOF
  chmod +x "${WORK}/real/glass-atrium"
  printf '#!/usr/bin/env bash\nexit 1\n' >"${WORK}/bin/claude"
  chmod +x "${WORK}/bin/claude"
}

# run_driver — every row runs with no DB-target input from the host; EXTRA_ENV entries come last, so a
# row overrides a default by naming it there.
run_driver() {
  run env -u AUTOAGENT_CLAUDE_BIN -u DATABASE_URL -u ATRIUM_UPDATE_DB_NAME -u GA_SKIP_DB_SETUP \
    -u GA_DB_NAME \
    HOME="${FAKE_HOME}" GA_DATA_ROOT="${WORK}/data-root" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_APPLY_LOCK_LIB="${GA}/scripts/lib/apply-lock.sh" \
    AUTOAGENT_PYTHON_BIN="${WORK}/bin/python-stub" STUB_CALL_LOG="${CALL_LOG}" \
    PATH="${WORK}/bin:${PATH}" ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    bash "${DRIVER}" --out "${OUT_JSON}" "$@"
}

mode_calls() {
  grep -c '^mode ' "${CALL_LOG}" 2>/dev/null || true
}

listing() {
  (cd -- "$1" && ls -A | tr '\n' ' ')
}

@test "the trigger files decide whether the cycle invokes the backfill mode" {
  local row name marker record args expected calls
  local -a argv
  local rows=(
    "record absent, no marker|0|0|--cycle-only|1"
    "marker present, record present|1|1|--cycle-only|1"
    "record present, no marker|0|1|--cycle-only|0"
    "dry-run, record absent|0|0|--cycle-only --dry-run|0"
    "backfill-only, record present, no marker|0|1|--backfill-only|1"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name marker record args expected <<<"${row}"
    use_row "${name// /-}"
    if [[ "${marker}" == 1 ]]; then : >"${REPORTS}/${MARKER}"; fi
    if [[ "${record}" == 1 ]]; then : >"${REPORTS}/${RECORD}"; fi
    IFS=' ' read -r -a argv <<<"${args}"
    run_driver "${argv[@]}"
    calls="$(mode_calls)"
    [[ "${calls:-0}" -eq "${expected}" ]] || {
      echo "${name}: mode calls ${calls:-0}, expected ${expected}"
      echo "${output}"
      return 1
    }
  done
}

@test "a not-pending cycle names why it did not invoke the mode" {
  : >"${REPORTS}/${RECORD}"
  run_driver --cycle-only
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"stage=backfill"*"not pending"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "backfill-only runs the head stage alone and exits with its folded rc" {
  local row name mode_rc expected before
  for row in "mode rc 0|0|0" "mode rc 7|7|1"; do
    IFS='|' read -r name mode_rc expected <<<"${row}"
    use_row "${name// /-}"
    before="$(cksum <"${OUT_JSON}")"
    EXTRA_ENV=(STUB_MODE_RC="${mode_rc}")
    run_driver --backfill-only
    [[ "${status}" -eq "${expected}" ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ "$(wc -l <"${CALL_LOG}" | tr -d ' ')" == 1 && "$(cat "${CALL_LOG}")" == mode* ]] || {
      echo "${name}: calls after the mode: $(cat "${CALL_LOG}")"
      return 1
    }
    [[ "${output}" != *"PG_PUSH"* && "${output}" != *"LOOP_PUSH"* ]] || {
      echo "${name}: ${output}"
      return 1
    }
    [[ "$(cksum <"${OUT_JSON}")" == "${before}" ]] || {
      echo "${name}: --out path changed"
      return 1
    }
  done
}

@test "backfill-only with dry-run names the skip, invokes nothing and exits 0" {
  run_driver --backfill-only --dry-run
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ ! -s "${CALL_LOG}" ]] || {
    echo "calls: $(cat "${CALL_LOG}")"
    return 1
  }
  [[ "${output}" == *"stage=backfill SKIP: dry-run"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "GA_SKIP_DB_SETUP skips the stage by name and leaves the trigger files as found" {
  : >"${REPORTS}/${MARKER}"
  : >"${REPORTS}/${RECORD}"
  local before
  before="$(listing "${REPORTS}")"
  EXTRA_ENV=(GA_SKIP_DB_SETUP=1)
  run_driver --cycle-only
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(mode_calls)" -eq 0 ]] || {
    echo "calls: $(cat "${CALL_LOG}")"
    return 1
  }
  [[ "${output}" == *"stage=backfill SKIP: GA_SKIP_DB_SETUP set"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(listing "${REPORTS}")" == "${before}" ]] || {
    echo "reports dir: $(listing "${REPORTS}")"
    return 1
  }
}

@test "the stage needs neither bats nor GNU parallel on PATH" {
  local tool sysbin="${WORK}/sysbin"
  mkdir -p -- "${sysbin}"
  for tool in bash cat date dirname mkdir mv ps readlink rm rmdir sed; do
    ln -s -- "$(command -v "${tool}")" "${sysbin}/${tool}"
  done
  if (PATH="${WORK}/bin:${sysbin}" && command -v bats || command -v parallel) >/dev/null; then
    echo "bats or parallel still resolvable on the curated PATH"
    return 1
  fi
  EXTRA_ENV=(PATH="${WORK}/bin:${sysbin}")
  run_driver --cycle-only
  [[ "$(mode_calls)" -eq 1 ]] || {
    echo "${output}"
    return 1
  }
}

@test "the mode runs ahead of the first stage of every dispatch mode" {
  local row name args first order
  local -a argv
  local rows=(
    "no argument||cycle *"
    "full-cycle|--full-cycle|cycle *"
    "cycle-only|--cycle-only|cycle *"
    "apply-only|--apply-only|py *--regenerate-stale*"
    "regression-only|--regression-only|regression"
    "aggregate-only|--aggregate-only|py *learning-aggregator.py*"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name args first <<<"${row}"
    use_row "${name// /-}"
    argv=()
    if [[ -n "${args}" ]]; then argv=("${args}"); fi
    run_driver ${argv[@]+"${argv[@]}"}
    # the retirement stage's own position is pinned in daemon-cycle-retire-stage.bats
    order="$(grep -v '^retire$' "${CALL_LOG}" || true)"
    # shellcheck disable=SC2053  # the expected first stage is a glob pattern
    [[ "$(sed -n 1p <<<"${order}")" == mode* && "$(sed -n 2p <<<"${order}")" == ${first} ]] || {
      echo "${name}: call order: $(cat "${CALL_LOG}")"
      echo "${output}"
      return 1
    }
  done
}

@test "a lock held by another live process skips the mode and leaves the cycle rc unchanged" {
  mkdir -p -- "${REPORTS}/.apply-lock"
  printf '%s\n' "$$" >"${REPORTS}/.apply-lock/pid"
  local before
  before="$(listing "${REPORTS}") $(cat "${REPORTS}/.apply-lock/pid")"
  run_driver --cycle-only
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(mode_calls)" -eq 0 ]] || {
    echo "calls: $(cat "${CALL_LOG}")"
    return 1
  }
  [[ "${output}" == *"stage=backfill SKIP"*".apply-lock"*"held"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(listing "${REPORTS}") $(cat "${REPORTS}/.apply-lock/pid")" == "${before}" ]] || {
    echo "reports dir changed: $(listing "${REPORTS}")"
    return 1
  }
}

@test "an absent reports dir is created and the lock taken there" {
  EXTRA_ENV=(AUTOAGENT_REPORTS_DIR="${ROW_DIR}/absent/reports")
  run_driver --cycle-only
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  grep -q '^mode .* lockpid=[0-9][0-9]*$' "${CALL_LOG}" || {
    echo "calls: $(cat "${CALL_LOG}" 2>&1)"
    echo "${output}"
    return 1
  }
  [[ ! -e "${ROW_DIR}/absent/reports/.apply-lock" ]] || {
    echo "lock left behind"
    return 1
  }
}

@test "a reports dir that cannot be created degrades the cycle by name" {
  : >"${ROW_DIR}/a-file"
  EXTRA_ENV=(AUTOAGENT_REPORTS_DIR="${ROW_DIR}/a-file/reports")
  run_driver --cycle-only
  [[ "${status}" -eq 1 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(mode_calls)" -eq 0 ]] || {
    echo "calls: $(cat "${CALL_LOG}")"
    return 1
  }
  [[ "${output}" == *"stage=backfill FAILED"*"a-file/reports"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "an unusable lock lib degrades the cycle by name without invoking the mode" {
  local row name lib reason
  printf 'return 1\n' >"${WORK}/broken-lib.sh"
  for row in "lib absent|${WORK}/no-such-lib.sh|missing" "lib fails to load|${WORK}/broken-lib.sh|failed to load"; do
    IFS='|' read -r name lib reason <<<"${row}"
    use_row "${name// /-}"
    EXTRA_ENV=(ATRIUM_APPLY_LOCK_LIB="${lib}")
    run_driver --cycle-only
    [[ "${status}" -eq 1 ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ "$(mode_calls)" -eq 0 ]] || {
      echo "${name}: calls: $(cat "${CALL_LOG}")"
      return 1
    }
    [[ "${output}" == *"stage=backfill FAILED: apply-lock lib ${reason}"* ]] || {
      echo "${name}: ${output}"
      return 1
    }
  done
}

@test "TERM during the mode releases the lock and exits 143" {
  EXTRA_ENV=(STUB_MODE_TERM=1)
  run_driver --cycle-only
  [[ "${status}" -eq 143 ]] || {
    echo "${output}"
    return 1
  }
  [[ ! -e "${REPORTS}/.apply-lock" ]] || {
    echo "lock left behind"
    return 1
  }
  ! grep -q '^cycle ' "${CALL_LOG}" || {
    echo "the cycle stage ran after TERM"
    return 1
  }
}

@test "the lock traps are cleared at release, so a later acquirer's pid-less lock survives the cycle" {
  EXTRA_ENV=(STUB_CYCLE_PLANT_LOCK="${REPORTS}/.apply-lock")
  run_driver --cycle-only
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(mode_calls)" -eq 1 ]] || {
    echo "calls: $(cat "${CALL_LOG}")"
    return 1
  }
  [[ -d "${REPORTS}/.apply-lock" ]] || {
    echo "the planted lock was released at cycle end"
    return 1
  }
}

@test "AUTOAGENT_REPORTS_DIR wins over GA_DATA_ROOT for the trigger, the lock and the mode" {
  local data_reports="${WORK}/data-root/data/daemon-reports" before
  mkdir -p -- "${data_reports}"
  : >"${data_reports}/${RECORD}"
  before="$(listing "${data_reports}")"
  run_driver --cycle-only
  grep -q "^mode .*--reports-dir ${REPORTS} lockpid=[0-9][0-9]*$" "${CALL_LOG}" || {
    echo "calls: $(cat "${CALL_LOG}" 2>&1)"
    echo "${output}"
    return 1
  }
  [[ "$(listing "${data_reports}")" == "${before}" ]] || {
    echo "data root: $(listing "${data_reports}")"
    return 1
  }
}

@test "an empty AUTOAGENT_REPORTS_DIR falls back to the GA_DATA_ROOT reports dir" {
  local data_reports="${WORK}/data-root/data/daemon-reports" before
  : >"${REPORTS}/${MARKER}"
  before="$(listing "${REPORTS}")"
  EXTRA_ENV=(AUTOAGENT_REPORTS_DIR=)
  run_driver --cycle-only
  grep -q "^mode .*--reports-dir ${data_reports} lockpid=[0-9][0-9]*$" "${CALL_LOG}" || {
    echo "calls: $(cat "${CALL_LOG}" 2>&1)"
    echo "${output}"
    return 1
  }
  [[ "$(listing "${REPORTS}")" == "${before}" ]] || {
    echo "reports: $(listing "${REPORTS}")"
    return 1
  }
}

@test "the mode rc folds into the cycle exit: 0 and 10 keep it, any other degrades it" {
  local row name mode_rc expected line
  local rows=(
    "committed|0|0|stage=backfill rc=0"
    "deferred by a gate|10|0|stage=backfill rc=10 DEFERRED"
    "PG fault|7|1|stage=backfill rc=7 FAILED"
    "lock not held|11|1|stage=backfill rc=11 FAILED"
    "record write failed|13|1|stage=backfill rc=13 FAILED"
    "argparse failure|2|1|stage=backfill rc=2 FAILED"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name mode_rc expected line <<<"${row}"
    use_row "${name// /-}"
    EXTRA_ENV=(STUB_MODE_RC="${mode_rc}")
    run_driver --cycle-only
    [[ "${status}" -eq "${expected}" ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ "${output}" == *"${line}"* ]] || {
      echo "${name}: ${output}"
      return 1
    }
  done
}

@test "--help lists the backfill-only arm and the whole Usage block" {
  run_driver --help
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"--backfill-only"* && "${output}" == *"--out PATH"*"daemon-reports/<date>.json"* ]] || {
    echo "${output}"
    return 1
  }
}
