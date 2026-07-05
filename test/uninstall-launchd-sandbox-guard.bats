#!/usr/bin/env bats
# unload_launchd_jobs — sandbox guard contract (lib/ga-core.sh is_sandbox_target).
#
# launchd gui-domain labels are per-UID, NOT per-HOME — a sandboxed engine run
# would still `launchctl bootout gui/$UID/com.glass-atrium.*` against the REAL
# user's live jobs. The guard MUST:
#   * skip the WHOLE teardown (bootout + plist rm) under the explicit
#     GA_TARGET_HOME seam (bats/CI style — HOME stays real, so the plist rm
#     would otherwise hit the real ~/Library/LaunchAgents);
#   * skip under a fake-HOME sandbox with GA_TARGET_HOME unset (the
#     oss-e2e-bootstrap.sh style — the seam that bit the authoring machine);
#   * keep real-home semantics byte-identical: real HOME + no override →
#     bootout every LAUNCHD_JOBS label (8 jobs).
#
# Run via: bats test/uninstall-launchd-sandbox-guard.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy (mirrors uninstall-db-backup.bats): source the REAL engine
# and call unload_launchd_jobs directly under the entry point's strict mode,
# with a PATH-prepended launchctl stub that RECORDS args (the real gui/$UID
# domain is unreachable even on a RED run). T1/T3 additionally stub `rm` as a
# record-only safety belt — those arms run with the REAL HOME, so a failed
# guard must never be able to delete the authoring machine's deployed plists.
# T2 deliberately keeps the real rm (targets live only inside the fake HOME)
# so the decoy-plist-survives assertion stays falsifiable.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-launchd-guard-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  TARGET="${SANDBOX}/target"
  FAKEHOME="${SANDBOX}/home"
  mkdir -p "${STUB_BIN}" "${TARGET}" "${FAKEHOME}"
  # launchctl stub: record "$*" to a file — the caller discards stdout/stderr,
  # so the verdict lives in the args file. exit 0 = "booted out".
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/launchctl-args"\nexit 0\n' \
    "${SANDBOX}" >"${STUB_BIN}/launchctl"
  chmod +x "${STUB_BIN}/launchctl"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# record-only rm stub (T1/T3 red-run safety belt — never deletes anything)
stub_rm() {
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/rm-args"\nexit 0\n' \
    "${SANDBOX}" >"${STUB_BIN}/rm"
  chmod +x "${STUB_BIN}/rm"
}

# Drive the REAL unload_launchd_jobs against the stubs under strict mode.
# Extra env tweaks (VAR=val / -u VAR) pass through to env; STUB_BIN leads PATH
# so launchctl (and rm, when stubbed) resolve to the recorders.
run_unload() {
  run env "$@" PATH="${STUB_BIN}:/usr/bin:/bin" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      DRY_RUN=false
      unload_launchd_jobs
    ' _ "${GA}"
}

@test "T1: GA_TARGET_HOME seam (real HOME) -> whole teardown skipped, bootout NOT called" {
  stub_rm
  run_unload GA_TARGET_HOME="${TARGET}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"sandbox target — launchd domain untouched"* ]]
  # no launchctl invocation reached the (stubbed) binary
  [[ ! -e "${SANDBOX}/launchctl-args" ]]
  # no plist rm either (vacuous on hosts without deployed plists; on a dev
  # machine with live plists a failed guard WOULD record here)
  [[ ! -e "${SANDBOX}/rm-args" ]]
  # skip happens BEFORE the teardown banner — nothing was torn down
  [[ "${output}" != *"tearing down"* ]]
}

@test "T2: fake-HOME sandbox (GA_TARGET_HOME unset) -> skipped, decoy plist survives" {
  # decoy in the FAKE home's LaunchAgents: a failed guard would rm it (real rm
  # is intentionally left on PATH — every deletion target lives in the sandbox)
  mkdir -p "${FAKEHOME}/Library/LaunchAgents"
  : >"${FAKEHOME}/Library/LaunchAgents/com.glass-atrium.monitor.plist"
  run_unload -u GA_TARGET_HOME HOME="${FAKEHOME}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"sandbox target — launchd domain untouched"* ]]
  [[ ! -e "${SANDBOX}/launchctl-args" ]]
  # plist rm skipped along with bootout — the decoy is intact
  [[ -e "${FAKEHOME}/Library/LaunchAgents/com.glass-atrium.monitor.plist" ]]
}

@test "T3: real HOME, no override -> guard does NOT trip, all 8 labels booted out" {
  # applicability: this arm needs the bats host itself to be a REAL home
  # (HOME == passwd-db home) — a containerized runner with divergent HOME would
  # trip the guard BY DESIGN. Resolve the passwd home the same dual-tool way.
  un="$(id -un)"
  if command -v dscl >/dev/null 2>&1; then
    pw="$(dscl . -read "/Users/${un}" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p')"
  elif command -v getent >/dev/null 2>&1; then
    pw="$(getent passwd "${un}" | cut -d: -f6)"
  else
    pw=""
  fi
  [[ -n "${pw}" && "${pw}" == "${HOME}" ]] \
    || skip "host HOME diverges from passwd home (${pw:-unresolved}) — real-home arm not runnable here"
  stub_rm # real HOME: a deployed-plist rm MUST be intercepted even on the GREEN path
  run_unload -u GA_TARGET_HOME
  [[ "${status}" -eq 0 ]]
  # pre-guard behavior byte-identical: no sandbox skip, teardown ran
  [[ "${output}" != *"sandbox target"* ]]
  [[ "${output}" == *"tearing down 8 com.glass-atrium."* ]]
  [[ "${output}" == *"8 booted out"* ]]
  # exactly the 8 LAUNCHD_JOBS labels, all via bootout on this uid's gui domain
  MYUID="$(id -u)"
  [[ "$(wc -l <"${SANDBOX}/launchctl-args" | tr -d ' ')" -eq 8 ]]
  [[ "$(grep -c "^bootout gui/${MYUID}/com.glass-atrium." "${SANDBOX}/launchctl-args")" -eq 8 ]]
  grep -q "^bootout gui/${MYUID}/com.glass-atrium.monitor$" "${SANDBOX}/launchctl-args"
  grep -q "^bootout gui/${MYUID}/com.glass-atrium.daemon-daily-restart$" "${SANDBOX}/launchctl-args"
}
