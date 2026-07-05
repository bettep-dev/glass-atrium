#!/usr/bin/env bats
# update.sh -> update_refresh_autoagent_launchd: the post-apply reload of the
# com.glass-atrium.autoagent-cycle launchd job. Its ProgramArguments were
# repointed to the store-path daemon-cycle.sh, so a bare kickstart would re-run
# the STALE loaded definition — the new path takes effect ONLY by re-copying the
# freshly rendered plist over the LaunchAgents copy then bootout+bootstrap.
#
# Run via: bats test/update-launchd-autoagent.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy: update.sh is SOURCED inside a `run bash -c` subshell so its
# `set -Eeuo pipefail` + ERR trap stay contained (never leak into the bats shell),
# and the file's BASH_SOURCE==$0 guard keeps update_main from executing. launchctl
# is a recording stub selected via the ATRIUM_UPDATE_LAUNCHCTL seam; the plist
# src/dst are mktemp paths via the ATRIUM_UPDATE_AUTOAGENT_*_PLIST seams. Nothing
# touches the real ~/Library/LaunchAgents or the live daemon.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_UPDATE="${GA}/scripts/update.sh"

setup() {
  [[ -f "${REAL_UPDATE}" ]] || skip "updater not found: ${REAL_UPDATE}"
  SANDBOX="$(mktemp -d -t ga-update-launchd.XXXXXX)"
  STUB_LOG="${SANDBOX}/launchctl-calls.log"
  SRC="${SANDBOX}/rendered/com.glass-atrium.autoagent-cycle.plist"
  DST="${SANDBOX}/LaunchAgents/com.glass-atrium.autoagent-cycle.plist"
  mkdir -p "${SANDBOX}/rendered" "${SANDBOX}/LaunchAgents"
  # a rendered-parity SoT the reload must re-copy (store-path ProgramArguments)
  printf 'RENDERED-STORE-PATH-PLIST\n' >"${SRC}"

  # recording launchctl stub — logs its subcommand, drives the `print` (loaded)
  # probe via STUB_PRINT_RC, always succeeds on bootout/bootstrap.
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
# the reload function. Env seams are exported by the caller before invoking.
call_refresh() {
  run bash -c 'source "${REAL_UPDATE}"; update_refresh_autoagent_launchd' _
}

@test "loaded job -> re-copy rendered plist + bootout + bootstrap" {
  export REAL_UPDATE STUB_LOG
  export ATRIUM_UPDATE_LAUNCHCTL="${STUB}"
  export ATRIUM_UPDATE_AUTOAGENT_RENDERED_PLIST="${SRC}"
  export ATRIUM_UPDATE_AUTOAGENT_PLIST="${DST}"
  export STUB_PRINT_RC=0 # loaded
  call_refresh
  [[ "${status}" -eq 0 ]]
  # the rendered plist was staged over the LaunchAgents copy (repoint takes effect)
  [[ -f "${DST}" ]]
  [[ "$(cat "${DST}")" == "RENDERED-STORE-PATH-PLIST" ]]
  # the reload half ran: probe, then bootout, then bootstrap
  grep -q '^print gui/' "${STUB_LOG}"
  grep -q '^bootout gui/' "${STUB_LOG}"
  grep -q '^bootstrap gui/' "${STUB_LOG}"
}

@test "not-loaded job -> untouched (user opt-in load preserved)" {
  export REAL_UPDATE STUB_LOG
  export ATRIUM_UPDATE_LAUNCHCTL="${STUB}"
  export ATRIUM_UPDATE_AUTOAGENT_RENDERED_PLIST="${SRC}"
  export ATRIUM_UPDATE_AUTOAGENT_PLIST="${DST}"
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
  export ATRIUM_UPDATE_AUTOAGENT_RENDERED_PLIST="${SRC}"
  export ATRIUM_UPDATE_AUTOAGENT_PLIST="${DST}"
  call_refresh
  [[ "${status}" -eq 0 ]]
  [[ ! -e "${DST}" ]]
  [[ ! -e "${STUB_LOG}" ]] # stub never ran
}

@test "loaded but rendered plist missing -> warn, skip reload (existence guard)" {
  export REAL_UPDATE STUB_LOG
  export ATRIUM_UPDATE_LAUNCHCTL="${STUB}"
  export ATRIUM_UPDATE_AUTOAGENT_RENDERED_PLIST="${SANDBOX}/rendered/absent.plist"
  export ATRIUM_UPDATE_AUTOAGENT_PLIST="${DST}"
  export STUB_PRINT_RC=0 # loaded
  call_refresh
  [[ "${status}" -eq 0 ]]
  # probe ran, but the missing src aborts before any staging or reload
  [[ ! -e "${DST}" ]]
  grep -q '^print gui/' "${STUB_LOG}"
  ! grep -q '^bootout' "${STUB_LOG}"
  ! grep -q '^bootstrap' "${STUB_LOG}"
}
