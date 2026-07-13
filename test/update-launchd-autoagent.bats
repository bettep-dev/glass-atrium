#!/usr/bin/env bats
# update.sh -> update_refresh_resident_launchd, exercised through the
# com.glass-atrium.autoagent-cycle resident job. autoagent-cycle's ProgramArguments were
# repointed to the store-path daemon-cycle.sh, so a bare kickstart would re-run the STALE
# loaded definition — the new path takes effect ONLY by re-copying the freshly rendered
# plist over the LaunchAgents copy then bootout+bootstrap. The dedicated autoagent-cycle
# reload was GENERALIZED into update_refresh_resident_launchd (every resident already-loaded
# com.glass-atrium.* job whose deployed plist drifted); this suite pins the autoagent-cycle
# path's edge cases (loaded reload, not-loaded skip, launchctl-unresolvable graceful, rendered
# missing skip). The full incident matrix (the 6 other jobs, drift gate, wiring) lives in
# scripts/test/update-resident-launchd-redeploy.bats.
#
# Run via: bats test/update-launchd-autoagent.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy: update.sh is SOURCED inside a `run bash -c` subshell so its
# `set -Eeuo pipefail` + ERR trap stay contained (never leak into the bats shell),
# and the file's BASH_SOURCE==$0 guard keeps update_main from executing. launchctl
# is a recording stub selected via the ATRIUM_UPDATE_LAUNCHCTL seam; the rendered /
# deployed plist dirs are mktemp paths via the ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR /
# ATRIUM_UPDATE_LAUNCH_AGENTS_DIR seams. Nothing touches the real ~/Library/LaunchAgents
# or the live daemon.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_UPDATE="${GA}/scripts/update.sh"

setup() {
  [[ -f "${REAL_UPDATE}" ]] || skip "updater not found: ${REAL_UPDATE}"
  SANDBOX="$(mktemp -d -t ga-update-launchd.XXXXXX)"
  STUB_LOG="${SANDBOX}/launchctl-calls.log"
  RENDERED="${SANDBOX}/rendered"
  AGENTS="${SANDBOX}/LaunchAgents"
  SRC="${RENDERED}/com.glass-atrium.autoagent-cycle.plist"
  DST="${AGENTS}/com.glass-atrium.autoagent-cycle.plist"
  mkdir -p "${RENDERED}" "${AGENTS}"
  # a rendered-parity SoT the reload must re-copy (store-path ProgramArguments)
  printf 'RENDERED-STORE-PATH-PLIST\n' >"${SRC}"

  # recording launchctl stub — logs its subcommand, drives the `print` (loaded)
  # probe via STUB_PRINT_RC, and returns empty `list` output so the settle poll sees
  # the label ABSENT (fast). Always succeeds on bootout/bootstrap.
  STUB="${SANDBOX}/launchctl"
  cat >"${STUB}" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_LOG}"
case "${1}" in
  print) exit "${STUB_PRINT_RC:-0}" ;;
  *) exit 0 ;;
esac
STUB_EOF
  chmod +x "${STUB}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Source update.sh in an isolated subshell (contains set -e + ERR trap) and call
# the generalized reload. Env seams are exported by the caller before invoking.
call_refresh() {
  run bash -c 'source "${REAL_UPDATE}"; update_refresh_resident_launchd' _
}

@test "loaded autoagent-cycle -> re-copy rendered plist + bootout + bootstrap" {
  export REAL_UPDATE STUB_LOG
  export ATRIUM_UPDATE_LAUNCHCTL="${STUB}"
  export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="${RENDERED}"
  export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="${AGENTS}"
  export STUB_PRINT_RC=0 # loaded
  call_refresh
  [[ "${status}" -eq 0 ]]
  # the rendered plist was staged over the LaunchAgents copy (repoint takes effect);
  # a deployed plist absent from the sandbox is drift → re-copy fires.
  [[ -f "${DST}" ]]
  [[ "$(cat "${DST}")" == "RENDERED-STORE-PATH-PLIST" ]]
  # the reload half ran: probe, then bootout, then bootstrap
  grep -q '^print gui/' "${STUB_LOG}"
  grep -q '^bootout gui/.*/com.glass-atrium.autoagent-cycle' "${STUB_LOG}"
  grep -q '^bootstrap gui/.*com.glass-atrium.autoagent-cycle.plist' "${STUB_LOG}"
}

@test "not-loaded autoagent-cycle -> untouched (user opt-in load preserved)" {
  export REAL_UPDATE STUB_LOG
  export ATRIUM_UPDATE_LAUNCHCTL="${STUB}"
  export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="${RENDERED}"
  export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="${AGENTS}"
  export STUB_PRINT_RC=1 # not loaded
  call_refresh
  [[ "${status}" -eq 0 ]]
  # no staging, no reload — only the probe ran
  [[ ! -e "${DST}" ]]
  grep -q '^print gui/' "${STUB_LOG}"
  ! grep -q '^bootout' "${STUB_LOG}"
  ! grep -q '^bootstrap' "${STUB_LOG}"
}

@test "launchctl unresolvable -> graceful skip, no crash" {
  export REAL_UPDATE STUB_LOG
  export ATRIUM_UPDATE_LAUNCHCTL="${SANDBOX}/no-such-launchctl"
  export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="${RENDERED}"
  export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="${AGENTS}"
  call_refresh
  [[ "${status}" -eq 0 ]]
  [[ ! -e "${DST}" ]]
  [[ ! -e "${STUB_LOG}" ]] # stub never ran
}

@test "loaded but rendered plist missing -> warn, skip reload (existence guard)" {
  export REAL_UPDATE STUB_LOG
  export ATRIUM_UPDATE_LAUNCHCTL="${STUB}"
  # an EMPTY rendered dir → every resident job's rendered plist is absent
  mkdir -p "${SANDBOX}/rendered-absent"
  export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="${SANDBOX}/rendered-absent"
  export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="${AGENTS}"
  export STUB_PRINT_RC=0 # loaded
  call_refresh
  [[ "${status}" -eq 0 ]]
  # probe ran, but the missing src aborts before any staging or reload
  [[ ! -e "${DST}" ]]
  grep -q '^print gui/' "${STUB_LOG}"
  ! grep -q '^bootout' "${STUB_LOG}"
  ! grep -q '^bootstrap' "${STUB_LOG}"
}
