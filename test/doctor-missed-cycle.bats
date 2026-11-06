#!/usr/bin/env bats
# doctor-missed-cycle.bats — pins run_doctor §29: a UTC report date missing from the autoagent
# daemon-reports dir inside the lookback. Registration kind A on an OPEN gap only; a gap a later
# report supersedes, and every not-applicable state, is a note with no counter.
#
# No real launchd is asked: launchctl resolves to a stub ahead of PATH, HOME is a sandbox (so
# LAUNCH_AGENTS is too), and is_sandbox_target is shadowed inside the doctor shell.
#
# Run via: bats test/doctor-missed-cycle.bats
# Requires: bats >= 1.5.0, bash 3.2+, BSD or GNU date(1)

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"
CYCLE_LABEL="com.glass-atrium.autoagent-cycle"

setup() {
  load 'lib/bats-db-seal'
  ga_bats_db_seal
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  utc_days_ago 1 >/dev/null || skip "neither BSD nor GNU date(1) arithmetic available"

  SANDBOX="$(mktemp -d -t ga-doctor-missed-cycle-bats.XXXXXX)"
  SANDBOX_HOME="${SANDBOX}/home"
  LA="${SANDBOX_HOME}/Library/LaunchAgents"
  REPORTS="${SANDBOX_HOME}/.glass-atrium/data/daemon-reports"
  STUB="${SANDBOX}/bin"
  MANIFEST="${SANDBOX}/manifest.json"
  GEN_STUB="${SANDBOX}/generate-manifest.sh"
  mkdir -p -- "${SANDBOX}/target" "${STUB}"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${GEN_STUB}"
  cat >"${STUB}/launchctl" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == "print" ]] && exit "${GA_TEST_PRINT_RC:-0}"
exit 0
STUB
  chmod +x "${GEN_STUB}" "${STUB}/launchctl"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

utc_days_ago() {
  date -u -v-"$1"d +%Y-%m-%d 2>/dev/null || date -u -d "$1 days ago" +%Y-%m-%d 2>/dev/null
}

# A healthy loaded install: the cycle plist deployed, launchd reporting it loaded, the reports dir
# present and empty. Each row then seeds its own reports.
reset_fixture() {
  if ga_guard_path "${SANDBOX_HOME}"; then rm -rf -- "${SANDBOX_HOME:?}"; fi
  mkdir -p -- "${LA}" "${REPORTS}"
  printf '<plist/>\n' >"${LA}/${CYCLE_LABEL}.plist"
  PRINT_RC=0
  SANDBOX_VERDICT=no
  DOCTOR_PATH="${STUB}:${PATH}"
}

# Seed one cycle report per day offset (0 = today, UTC).
seed_reports() {
  local offset
  for offset in "$@"; do
    printf '{}\n' >"${REPORTS}/autoagent-$(utc_days_ago "${offset}").json"
  done
}

# A PATH holding every tool the current PATH resolves except launchctl.
use_path_without_launchctl() {
  local filtered="${SANDBOX}/no-launchctl-bin" dir tool
  mkdir -p -- "${filtered}"
  local IFS=':'
  for dir in ${PATH}; do
    [[ -d "${dir}" ]] || continue
    for tool in "${dir}"/*; do
      [[ "${tool##*/}" != "launchctl" && -x "${tool}" && ! -e "${filtered}/${tool##*/}" ]] || continue
      ln -s -- "${tool}" "${filtered}/${tool##*/}"
    done
  done
  DOCTOR_PATH="${filtered}"
}

run_doctor_sandbox() {
  run env PATH="${DOCTOR_PATH}" GA_TEST_PRINT_RC="${PRINT_RC}" GA_TEST_SANDBOX_VERDICT="${SANDBOX_VERDICT}" \
    HOME="${SANDBOX_HOME}" GA_DATA_ROOT="${SANDBOX_HOME}/.glass-atrium" GA_TARGET_HOME="${SANDBOX}/target" \
    GA_LIB_DIR="${GA}/scripts/lib" GA_MANIFEST="${MANIFEST}" GA_GENERATE_MANIFEST="${GEN_STUB}" \
    GA_CONFIG_TOML="${SANDBOX}/no-such-config.toml" AUTOAGENT_BACKUP_DIR="${SANDBOX}/agents-bak" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" GA_DB_NAME="ga_doctor_missed_cycle_sandbox" \
    GA_SKIP_DB_SETUP=1 "${@}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      is_sandbox_target() { printf "%s\n" "${GA_TEST_SANDBOX_VERDICT}"; }
      run_doctor
    ' _ "${GA}"
}

# The `<n> missed-cycle` term of the PASS breakdown; 0 on a bare PASS, empty when the run did not PASS.
missed_cycle_term() {
  if [[ "${output}" == *"== doctor: PASS =="* ]]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "${output}" | sed -n 's/.* \([0-9][0-9]*\) missed-cycle .*/\1/p' | head -n 1
}

# Row: name | report day offsets (0 = today) | expected missed-cycle term | text the output must carry.
@test "each lookback state yields its row and counts only an open gap" {
  local d1 d2 d3
  d1="$(utc_days_ago 1)"
  d2="$(utc_days_ago 2)"
  d3="$(utc_days_ago 3)"
  local rows=(
    "open gap|4 3 2|1|warn : autoagent cycle has written no report since ${d2} — missing UTC report date(s): ${d1}"
    "open run of gaps|4 3|1|missing UTC report date(s): ${d2} ${d1}"
    "manual cycle supersedes the open gap|4 3 2 0|0|note : autoagent cycle missed UTC report date(s) ${d1}"
    "gap a later report superseded|4 2 1|0|note : autoagent cycle missed UTC report date(s) ${d3}"
    "only today missing|3 2 1|0|ok   : autoagent cycle wrote a report for every UTC date in the last 7d"
    "fresh install|1|0|ok   : autoagent cycle wrote a report for every UTC date in the last 7d"
    "no report yet||0|note : missed-cycle check skipped — no autoagent cycle report yet"
  )
  local row name offsets expect text term
  local -a days
  for row in "${rows[@]}"; do
    IFS='|' read -r name offsets expect text <<<"${row}"
    reset_fixture
    days=()
    IFS=' ' read -ra days <<<"${offsets}" || true
    seed_reports ${days[@]+"${days[@]}"}
    run_doctor_sandbox
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ "${output}" == *"${text}"* ]] || {
      echo "${name}: missing '${text}'"
      echo "${output}"
      return 1
    }
    term="$(missed_cycle_term)"
    [[ "${term}" == "${expect}" ]] || {
      echo "${name}: missed-cycle term '${term}' != ${expect}"
      echo "${output}"
      return 1
    }
    if [[ "${expect}" == "0" ]]; then
      [[ "${output}" != *"warn : autoagent cycle"* ]] || {
        echo "${name}: unexpected warn"
        echo "${output}"
        return 1
      }
    fi
  done
}

@test "a gap older than the lookback ages out of the report" {
  reset_fixture
  seed_reports 4 1
  run_doctor_sandbox MISSED_CYCLE_WINDOW_DAYS=2
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"note : autoagent cycle missed UTC report date(s) $(utc_days_ago 2) "* ]] \
    || {
      echo "${output}"
      return 1
    }
  [[ "${output}" != *"$(utc_days_ago 3)"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(missed_cycle_term)" == "0" ]] || {
    echo "${output}"
    return 1
  }
}

as_sandbox_target() { SANDBOX_VERDICT=yes; }
as_unloaded() { PRINT_RC=113; }
undeploy_cycle() {
  local plist="${LA}/${CYCLE_LABEL}.plist"
  if ga_guard_path "${plist}"; then rm -f -- "${plist:?}"; fi
}
drop_reports_dir() {
  if ga_guard_path "${REPORTS}"; then rm -rf -- "${REPORTS:?}"; fi
}

# Row: name | fixture command | note the output must carry. Every row first seeds an open gap, so a
# detector that ignored the state would count it.
@test "a not-applicable state is a note with no count, even over an open gap" {
  local rows=(
    "sandbox target|as_sandbox_target|note : missed-cycle check skipped — sandbox target"
    "no launchctl|use_path_without_launchctl|note : missed-cycle check skipped — launchctl not found"
    "job not deployed|undeploy_cycle|note : missed-cycle check skipped — ${CYCLE_LABEL} not deployed"
    "job not loaded|as_unloaded|note : missed-cycle check skipped — ${CYCLE_LABEL} not loaded"
    "no reports dir|drop_reports_dir|note : missed-cycle check skipped — no autoagent daemon-reports dir"
  )
  local row name fixture text
  for row in "${rows[@]}"; do
    IFS='|' read -r name fixture text <<<"${row}"
    reset_fixture
    seed_reports 4 3
    "${fixture}"
    run_doctor_sandbox
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ "${output}" == *"${text}"* ]] || {
      echo "${name}: missing '${text}'"
      echo "${output}"
      return 1
    }
    [[ "$(missed_cycle_term)" == "0" ]] || {
      echo "${name}: counted"
      echo "${output}"
      return 1
    }
    [[ "${output}" != *"warn : autoagent cycle"* ]] || {
      echo "${name}: unexpected warn"
      echo "${output}"
      return 1
    }
  done
}
