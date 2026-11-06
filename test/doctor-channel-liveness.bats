#!/usr/bin/env bats
# doctor-channel-liveness.bats — pins run_doctor §16 (recording-channel liveness read off the
# monitor's /api/outcomes/channel-liveness route). Each channel the route names alerting is one
# counted channel-silent warning; a route the doctor cannot read is one channel-blind warning,
# never folded into a clean or silent verdict. WARN only: the doctor exit stays 0.
#
# No monitor is touched: curl resolves to a stub ahead of PATH that answers the liveness route
# with the seeded body and refuses every other URL.
#
# Run via: bats test/doctor-channel-liveness.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  load 'lib/bats-db-seal'
  ga_bats_db_seal
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-liveness-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STUB="${SANDBOX}/bin"
  STUB_STATE="${SANDBOX}/stub"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents" "${STUB}" "${STUB_STATE}"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  cat >"${STUB}/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for arg in "$@"; do url="${arg}"; done
case "${url}" in
  */api/outcomes/channel-liveness)
    cat -- "${GA_STUB_STATE}/liveness-body"
    printf '\n200'
    ;;
  *) exit 7 ;;
esac
STUB
  chmod +x "${STUB}/curl"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

run_doctor_sandbox() {
  run env PATH="${STUB}:${PATH}" \
    GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT=16145 \
    GA_DB_NAME="ga_doctor_liveness_sandbox" GA_SKIP_DB_SETUP=1 \
    GA_STUB_STATE="${STUB_STATE}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

# The `<n> <term>` breakdown value of the PASS line, 0 on a bare PASS.
term_of_output() {
  local value
  value="$(printf '%s\n' "${output}" | sed -n "s/.* \([0-9][0-9]*\) ${1} .*/\1/p" | head -n 1)"
  printf '%s' "${value:-0}"
}

@test "each alerting channel is one channel-silent warning; an unreadable detail set is channel-blind" {
  local row name body want silent blind
  local rows=(
    'none alerting|{"alerting":[],"channels":[]}|ok   : no recording channel has gone silent|0|0'
    'one alerting channel with its detail|{"days":7,"thresholds":{"silence_hours":24,"eligibility_daily_floor":3},"alerting":["hook"],"channels":[{"attribution_source":"hook","alerting":true,"peak_daily_count":40,"silent_hours":30.5},{"attribution_source":"manual","alerting":false,"peak_daily_count":9,"silent_hours":1}]}|warn : recording channel silent — hook: peak 40 rows/day over 7d, nothing recorded for 30h|1|0'
    'alerting set with no per-channel detail|{"alerting":["hook"]}|warn : /api/outcomes/channel-liveness names alerting channel(s) (hook) but carries no readable per-channel detail|0|1'
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name body want silent blind <<<"${row}"
    printf '%s' "${body}" >"${STUB_STATE}/liveness-body"
    run_doctor_sandbox
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ "${output}" == *"${want}"* ]] || {
      echo "${name}: missing '${want}'"
      echo "${output}"
      return 1
    }
    [[ "$(term_of_output channel-silent)" == "${silent}" && "$(term_of_output channel-blind)" == "${blind}" ]] \
      || {
        echo "${name}: silent=$(term_of_output channel-silent) blind=$(term_of_output channel-blind)"
        echo "${output}"
        return 1
      }
  done
}
