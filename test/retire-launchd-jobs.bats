#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2034,SC2154,SC2312,SC2329  # per-@test subshell env + engine globals read by the sourced lib; recorders invoked by it; probe pipe-masking intended
# retire-launchd-jobs.bats — the retirement routine for LAUNCHD_RETIRED_JOBS + GA_DAEMON_SESSIONS and its callers.
# Driven in-process only (port-free pid control): PATH recorders for tmux/pkill/lsof/pgrep/launchctl/rm,
# function recorders for kill/sleep, a 0s fakechat settle ceiling, a scratch HOME (scratch LaunchAgents)
# and the sandbox verdict overridden per test. An lsof/pgrep recorder returns a pid only where kill is a recorder.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

# pid above the macOS pid ceiling (pids wrap below 100000) — can never name a live process.
readonly FAKE_PID=424242

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-retire-launchd-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  REC="${SANDBOX}/rec"
  LOADED="${SANDBOX}/launchctl-loaded"
  TMUX_PRESENT="${SANDBOX}/tmux-present"
  mkdir -p "${STUB_BIN}" "${SANDBOX}/home/Library/LaunchAgents" "${SANDBOX}/rendered" "${SANDBOX}/data"
  : >"${REC}"
  : >"${LOADED}"
  : >"${TMUX_PRESENT}"
  REAL_RM="$(command -v rm)"
  printf '[ports]\nautoagent_fakechat = 18787\nwiki_fakechat = 18788\n' >"${SANDBOX}/config.toml"
  export ATRIUM_CONFIG_TOML="${SANDBOX}/config.toml"
  export HOME="${SANDBOX}/home"
  export GA_PLIST_OUT="${SANDBOX}/rendered"
  export GA_DATA_ROOT="${SANDBOX}/data" AUTOAGENT_REPORTS_DIR="${SANDBOX}/data/reports"
  export GA_PG_SOCKET="${SANDBOX}"
  export FAKECHAT_PORT_FREE_TIMEOUT_SECS=0
  unset GA_TARGET_HOME
  write_stubs
  trap - ERR
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-core.sh"
  ga_init_env "${GA}"
  DRY_RUN=false
  export PATH="${STUB_BIN}:${PATH}"
  kill() { printf 'kill %s\n' "$*" >>"${REC}"; return 0; }
  sleep() { printf 'sleep %s\n' "$*" >>"${REC}"; return 0; }
  is_sandbox_target() { printf 'no\n'; }
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then "${REAL_RM:-/bin/rm}" -rf -- "${SANDBOX:?}"; fi
}

# write_stubs — the PATH recorders; each appends its argv to REC.
#   launchctl: `list` prints the LOADED labels (a label in GA_LAUNCHCTL_STICKY survives bootout;
#   GA_LAUNCHCTL_SETTLE_POLLS keeps a booted-out label listed for that many more list calls).
#   tmux: has-session answers from TMUX_PRESENT; kill-session drops the name from it.
#   rm: records, and removes only paths inside the sandbox.
write_stubs() {
  cat >"${STUB_BIN}/launchctl" <<STUB
#!/bin/bash
printf 'launchctl %s\n' "\$*" >>"${REC}"
case "\$1" in
  list)
    polls="\$(cat "${SANDBOX}/settle-polls" 2>/dev/null || printf '0')"
    [[ "\${polls}" -gt 0 ]] && printf '%s' "\$((polls - 1))" >"${SANDBOX}/settle-polls"
    printf 'PID\tStatus\tLabel\n'
    while IFS= read -r l; do [[ -n "\${l}" ]] && printf -- '-\t0\t%s\n' "\${l}"; done <"${LOADED}"
    if [[ "\${polls}" -gt 0 ]]; then
      while IFS= read -r l; do [[ -n "\${l}" ]] && printf -- '-\t0\t%s\n' "\${l}"; done <"${SANDBOX}/settling"
    fi
    ;;
  bootout)
    label="\${2##*/}"
    for s in \${GA_LAUNCHCTL_STICKY:-}; do [[ "\${s}" == "\${label}" ]] && exit 0; done
    if grep -qxF "\${label}" "${LOADED}"; then
      grep -vxF "\${label}" "${LOADED}" >"${LOADED}.tmp" || true
      mv "${LOADED}.tmp" "${LOADED}"
      if [[ -n "\${GA_LAUNCHCTL_SETTLE_POLLS:-}" ]]; then
        printf '%s\n' "\${label}" >>"${SANDBOX}/settling"
        printf '%s' "\${GA_LAUNCHCTL_SETTLE_POLLS}" >"${SANDBOX}/settle-polls"
      fi
      exit 0
    fi
    exit 3
    ;;
  bootstrap) printf '%s\n' "\$(basename "\$3" .plist)" >>"${LOADED}" ;;
esac
exit 0
STUB
  cat >"${STUB_BIN}/tmux" <<STUB
#!/bin/bash
printf 'tmux %s\n' "\$*" >>"${REC}"
case "\$1" in
  has-session) grep -qxF "\$3" "${TMUX_PRESENT}" ;;
  kill-session)
    grep -vxF "\$3" "${TMUX_PRESENT}" >"${TMUX_PRESENT}.tmp" || true
    mv "${TMUX_PRESENT}.tmp" "${TMUX_PRESENT}"
    ;;
esac
STUB
  cat >"${STUB_BIN}/rm" <<STUB
#!/bin/bash
printf 'rm %s\n' "\$*" >>"${REC}"
for a in "\$@"; do
  case "\${a}" in -*) ;; "${SANDBOX}"/*) ;; *) exit 0 ;; esac
done
exec "${REAL_RM}" "\$@"
STUB
  cat >"${STUB_BIN}/lsof" <<STUB
#!/bin/bash
printf 'lsof %s\n' "\$*" >>"${REC}"
[[ -n "\${GA_LSOF_PIDS:-}" ]] && printf '%s\n' "\${GA_LSOF_PIDS}"
exit 0
STUB
  cat >"${STUB_BIN}/pgrep" <<STUB
#!/bin/bash
printf 'pgrep %s\n' "\$*" >>"${REC}"
[[ "\$1" == "-f" && -n "\${GA_PGREP_PIDS:-}" ]] && printf '%s\n' "\${GA_PGREP_PIDS}"
exit 0
STUB
  cat >"${STUB_BIN}/pkill" <<STUB
#!/bin/bash
printf 'pkill %s\n' "\$*" >>"${REC}"
exit 0
STUB
  chmod +x "${STUB_BIN}"/*
}

# plant_residue — every retired label loaded with its plist deployed, both retired sessions present.
plant_residue() {
  local job label
  for job in "${LAUNCHD_RETIRED_JOBS[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${job}"
    printf '%s\n' "${label}" >>"${LOADED}"
    : >"${LAUNCH_AGENTS}/${label}.plist"
  done
  printf '%s\n' "${GA_DAEMON_SESSIONS[@]}" >"${TMUX_PRESENT}"
}

# get_mutation_lines — recorded calls beyond a read-only probe (launchctl allowlisted to list|print, others denylisted).
get_mutation_lines() {
  grep -E '^(launchctl |rm |tmux kill-session|kill |pkill |lsof |pgrep )' "${REC}" \
    | grep -vE '^launchctl (list|print)( |$)' || true
}

@test "residue present: each retired label is booted out and its plist removed, sessions killed, configured ports freed" {
  plant_residue
  printf '%s\n' "${LAUNCHD_LABEL_PREFIX}.${LAUNCHD_JOBS[0]}" >>"${LOADED}"
  export GA_LSOF_PIDS="${FAKE_PID}"
  run retire_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; cat "${REC}"; return 1; }
  local job label sess
  for job in "${LAUNCHD_RETIRED_JOBS[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${job}"
    grep -qxF "launchctl bootout gui/${UID}/${label}" "${REC}" || { echo "no bootout: ${label}"; return 1; }
    [[ ! -e "${LAUNCH_AGENTS}/${label}.plist" ]] || { echo "plist left: ${label}"; return 1; }
  done
  for sess in "${GA_DAEMON_SESSIONS[@]}"; do
    grep -qxF "tmux kill-session -t ${sess}" "${REC}" || { echo "session not killed: ${sess}"; return 1; }
  done
  grep -qF 'lsof -iTCP:18787 ' "${REC}" || { cat "${REC}"; return 1; }
  grep -qF 'lsof -iTCP:18788 ' "${REC}" || { cat "${REC}"; return 1; }
  grep -qxF "kill -TERM ${FAKE_PID}" "${REC}" || { cat "${REC}"; return 1; }
  for job in "${LAUNCHD_JOBS[@]}"; do
    ! grep -qF "${LAUNCHD_LABEL_PREFIX}.${job}" <(grep -v '^launchctl list' "${REC}") \
      || { echo "active label touched: ${job}"; return 1; }
  done
  ! grep -q '^pkill ' "${REC}" || { cat "${REC}"; return 1; }
}

@test "no residue: only read-only launchctl probes run — no bootout, rm, session kill, port lookup or signal" {
  export GA_LSOF_PIDS="${FAKE_PID}" GA_PGREP_PIDS="${FAKE_PID}"
  printf '%s\n' "${LAUNCHD_LABEL_PREFIX}.${LAUNCHD_JOBS[0]}" >"${LOADED}"
  run retire_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"no retired residue"* ]] || { echo "${output}"; return 1; }
  [[ -z "$(get_mutation_lines)" ]] || { get_mutation_lines; return 1; }
  grep -q '^launchctl list' "${REC}" || { cat "${REC}"; return 1; }
}

@test "a second run after a clearing run finds no residue and records no action" {
  plant_residue
  run retire_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  : >"${REC}"
  run retire_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"no retired residue"* ]] || { echo "${output}"; return 1; }
  [[ -z "$(get_mutation_lines)" ]] || { get_mutation_lines; return 1; }
}

@test "dry-run and a sandbox verdict each record no call at all" {
  local row
  for row in dry-run sandbox; do
    plant_residue
    : >"${REC}"
    if [[ "${row}" == "dry-run" ]]; then DRY_RUN=true; else DRY_RUN=false; is_sandbox_target() { printf 'yes\n'; }; fi
    run retire_launchd_jobs
    [[ "${status}" -eq 0 ]] || { echo "${row}: ${output}"; return 1; }
    [[ ! -s "${REC}" ]] || { echo "${row}"; cat "${REC}"; return 1; }
  done
}

@test "residue the routine cannot clear makes it return non-zero and name what remains" {
  plant_residue
  export GA_LAUNCHCTL_STICKY="${LAUNCHD_LABEL_PREFIX}.${LAUNCHD_RETIRED_JOBS[0]}"
  export GA_LAUNCHD_SETTLE_TIMEOUT_SECS=0
  run retire_launchd_jobs
  [[ "${status}" -ne 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"${GA_LAUNCHCTL_STICKY}"* ]] || { echo "${output}"; return 1; }
}

@test "a bootout that settles after several polls is waited out and returns 0" {
  plant_residue
  export GA_LAUNCHCTL_SETTLE_POLLS=4
  run retire_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; cat "${REC}"; return 1; }
}

@test "the caller form logs a named warning and returns 0 on residue left in place" {
  retire_launchd_jobs() { return 1; }
  run retire_launchd_jobs_or_warn
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"WARNING: retired launchd residue"* ]] || { echo "${output}"; return 1; }
}

# load_ready — render every active-roster plist into the scratch render dir and arm --load-launchd.
load_ready() {
  local job
  for job in "${LAUNCHD_JOBS[@]}"; do
    : >"${RENDERED_PLIST_DIR}/${LAUNCHD_LABEL_PREFIX}.${job}.plist"
  done
  LOAD_LAUNCHD=true
}

@test "--load-launchd retires the retired labels before the active roster loads" {
  plant_residue
  load_ready
  run load_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; cat "${REC}"; return 1; }
  local last_retire first_load
  last_retire="$(grep -n "^launchctl bootout gui/${UID}/${LAUNCHD_LABEL_PREFIX}.${LAUNCHD_RETIRED_JOBS[2]}$" "${REC}" | cut -d: -f1)"
  first_load="$(grep -n '^launchctl bootstrap ' "${REC}" | head -1 | cut -d: -f1)"
  [[ -n "${last_retire}" && -n "${first_load}" && "${last_retire}" -lt "${first_load}" ]] \
    || { cat "${REC}"; return 1; }
}

@test "--load-launchd on a residue-free tree sends no signal and runs no port lookup" {
  export GA_LSOF_PIDS="${FAKE_PID}" GA_PGREP_PIDS="${FAKE_PID}"
  load_ready
  run load_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  ! grep -qE '^(kill |pkill |lsof |pgrep |tmux kill-session)' "${REC}" || { cat "${REC}"; return 1; }
  [[ "$(grep -c '^launchctl bootstrap ' "${REC}")" -eq "${#LAUNCHD_JOBS[@]}" ]] || { cat "${REC}"; return 1; }
}

@test "--load-launchd still loads the active roster when the retirement leaves residue" {
  retire_launchd_jobs() { return 1; }
  load_ready
  run load_launchd_jobs
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"WARNING: retired launchd residue"* ]] || { echo "${output}"; return 1; }
  [[ "$(grep -c '^launchctl bootstrap ' "${REC}")" -eq "${#LAUNCHD_JOBS[@]}" ]] || { cat "${REC}"; return 1; }
}

@test "the retire-launchd-jobs passthrough runs the routine with the parsed flags and exits its rc" {
  local driver="${SANDBOX}/driver.sh" rc
  cat >"${driver}" <<'DRV'
#!/usr/bin/env bash
# shellcheck disable=SC1090
source "${GA_LAUNCHER}" >/dev/null 2>&1
retire_launchd_jobs() { printf 'routine dry_run=%s\n' "${DRY_RUN}"; return "${ROUTINE_RC}"; }
passthrough retire-launchd-jobs "$@"
DRV
  for rc in 0 1; do
    run env GA_LAUNCHER="${LAUNCHER}" ROUTINE_RC="${rc}" bash "${driver}" --dry-run
    [[ "${status}" -eq "${rc}" ]] || { echo "rc ${rc}: ${output}"; return 1; }
    [[ "${output}" == *"routine dry_run=true"* ]] || { echo "rc ${rc}: ${output}"; return 1; }
  done
}
