#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154,SC2312,SC2329  # stub source text expands in the stub, not here; per-@test subshell env + engine globals read by the sourced lib; recorders invoked by it
# reload-launchd.bats — the `reload-launchd` subcommand: re-render the launchd definitions and reload every
# active job through load_launchd_jobs, never while an update or an autoagent apply holds the shared .apply-lock.
#
# Hermetic: launchctl is a PATH recorder, HOME (so LaunchAgents) and the reports dir are sandbox paths, the
# renderer is a recorder writing one plist per active job, and the daemon retirement is shadowed in-process.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-reload-launchd-bats.XXXXXX)"
  REC="${SANDBOX}/rec"
  mkdir -p "${SANDBOX}/bin" "${SANDBOX}/home" "${SANDBOX}/rendered" "${SANDBOX}/reports"
  : >"${REC}"
  printf '#!/bin/bash\nprintf "launchctl %%s\\n" "$*" >>"%s"\n[[ "$1" != print ]]\n' "${REC}" >"${SANDBOX}/bin/launchctl"
  chmod +x "${SANDBOX}/bin/launchctl"
  export HOME="${SANDBOX}/home" GA_PLIST_OUT="${SANDBOX}/rendered" GA_CONFIG_TOML="${SANDBOX}/config.toml"
  export GA_DATA_ROOT="${SANDBOX}/data" AUTOAGENT_REPORTS_DIR="${SANDBOX}/reports" GA_PG_SOCKET="${SANDBOX}"
  LOCK="${SANDBOX}/reports/.apply-lock"
  trap - ERR
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-core.sh"
  ga_init_env "${GA}"
  DRY_RUN=false
  export PATH="${SANDBOX}/bin:${PATH}"
  render_plists() {
    local job
    printf 'render\n' >>"${REC}"
    for job in "${LAUNCHD_JOBS[@]}"; do : >"${RENDERED_PLIST_DIR}/${LAUNCHD_LABEL_PREFIX}.${job}.plist"; done
  }
  retire_launchd_jobs_or_warn() { :; }
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

@test "reload-launchd re-renders, then bootstraps every active job, and releases the apply lock" {
  run reload_launchd_jobs
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(head -1 "${REC}")" == render ]] || {
    cat "${REC}"
    return 1
  }
  [[ "$(grep -c '^launchctl bootstrap ' "${REC}")" -eq "${#LAUNCHD_JOBS[@]}" ]] || {
    cat "${REC}"
    return 1
  }
  [[ ! -e "${LOCK}" ]] || {
    echo "apply lock left held"
    return 1
  }
}

@test "reload-launchd refuses while a live holder keeps the apply lock, touching nothing" {
  mkdir -p "${LOCK}"
  printf '%s\n' "$$" >"${LOCK}/pid"
  run reload_launchd_jobs
  [[ "${status}" -eq "${RELOAD_EXIT_LOCKED}" ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"update or apply holds"* ]] || {
    echo "${output}"
    return 1
  }
  [[ ! -s "${REC}" ]] || {
    cat "${REC}"
    return 1
  }
  [[ "$(cat "${LOCK}/pid")" == "$$" ]] || {
    echo "holder's lock disturbed"
    return 1
  }
}
