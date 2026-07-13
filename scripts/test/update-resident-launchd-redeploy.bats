#!/usr/bin/env bats
# update.sh install-parity post-step — the GENERALIZED resident launchd re-deploy+reload
# (update_refresh_resident_launchd). Pins the daily-restart incident fix: render-parity
# re-renders all 8 com.glass-atrium.* plists, but BEFORE this generalization only the
# monitor (kickstart) + autoagent-cycle were re-deployed — the other 6 resident jobs
# (daemon-daily-restart, autoagent-daemon, wiki-daemon, pg-backup, monitor-log-rotate,
# wiki-compile) were re-rendered but NEVER re-copied to ~/Library/LaunchAgents nor
# reloaded → indefinite stale drift → `glass-atrium update` could not self-heal.
#
# fail-before/pass-after: the assertions below exercise update_refresh_resident_launchd,
# which did NOT exist before the fix (the pre-change post-step never touched these jobs) —
# reverting the change leaves the function undefined (status 127) or the deployed plist
# stale, failing every redeploy assertion.
#
# Hermetic: launchctl is a STUB (never touches real launchd); rendered/deployed plist dirs
# are per-test mktemp sandboxes redirected via ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR /
# ATRIUM_UPDATE_LAUNCH_AGENTS_DIR. No real launchctl, ~/Library/LaunchAgents, or job touched.

bats_require_minimum_version 1.5.0

export SKILL="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)/scripts/update.sh"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v cmp >/dev/null 2>&1 || skip "cmp required"
  WORK="$(cd -- "$(mktemp -d -t ga-resident-launchd.XXXXXX)" && pwd -P)"
  RENDERED="${WORK}/rendered/launchd"
  AGENTS="${WORK}/LaunchAgents"
  mkdir -p -- "${RENDERED}" "${AGENTS}"
  export LAUNCHCTL="${WORK}/launchctl"
  export LAUNCHCTL_LOG="${WORK}/launchctl.log"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# A STUB launchctl: logs "$*" to $LAUNCHCTL_LOG; NEVER touches real launchd.
#   print gui/UID/<label> → exit 0 iff <label> ∈ $LOADED_LABELS (drives the loaded probe)
#   list                  → empty stdout → the settle poll sees every label ABSENT (fast)
# any other verb (bootout/bootstrap/kickstart) logs + exits 0.
write_stub_launchctl() {
  cat >"${LAUNCHCTL}" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${LAUNCHCTL_LOG}"
case "${1:-}" in
  print)
    lbl="${2##*/}"
    case " ${LOADED_LABELS:-} " in
      *" ${lbl} "*) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  list) exit 0 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${LAUNCHCTL}"
}

# Write a minimal plist at $1 whose PATH string is $2 (content differs by PATH → drift).
write_plist() {
  cat >"$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$2</string></dict>
</dict></plist>
PLIST
}

# Extract the newline-separated elements of a literal bash array from source text $1,
# anchored on the array-open line containing the literal $2 (e.g. `LAUNCHD_JOBS=(`).
_extract_array() {
  awk -v anchor="$2" '
    index($0, anchor) { collecting = 1; next }
    collecting && index($0, ")") { collecting = 0; next }
    collecting { gsub(/[[:space:]]/, "", $0); if ($0 != "") print $0 }
  ' "$1"
}

@test "resident redeploy: a LOADED job whose deployed plist DRIFTED is re-copied + bootout+bootstrap" {
  write_stub_launchctl
  # daemon-daily-restart (an incident job): loaded, deployed plist STALE vs rendered.
  write_plist "${RENDERED}/com.glass-atrium.daemon-daily-restart.plist" "/new/bin:/usr/bin"
  write_plist "${AGENTS}/com.glass-atrium.daemon-daily-restart.plist" "/stale/bin:/usr/bin"
  run bash -c '
    source "'"${SKILL}"'"
    export ATRIUM_UPDATE_LAUNCHCTL="'"${LAUNCHCTL}"'"
    export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="'"${RENDERED}"'"
    export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="'"${AGENTS}"'"
    export LAUNCHCTL_LOG="'"${LAUNCHCTL_LOG}"'"
    export LOADED_LABELS="com.glass-atrium.daemon-daily-restart"
    update_refresh_resident_launchd
  '
  [ "$status" -eq 0 ] || return 1
  # deployed plist now BYTE-IDENTICAL to the rendered SoT (re-copied).
  cmp -s "${AGENTS}/com.glass-atrium.daemon-daily-restart.plist" \
    "${RENDERED}/com.glass-atrium.daemon-daily-restart.plist" || return 1
  # reload happened: bootout THEN bootstrap the label (mirrors load_launchd_jobs).
  grep -q "bootout gui/.*/com.glass-atrium.daemon-daily-restart" "${LAUNCHCTL_LOG}" || return 1
  grep -q "bootstrap gui/.* .*com.glass-atrium.daemon-daily-restart.plist" "${LAUNCHCTL_LOG}" || return 1
}

@test "resident redeploy: a LOADED job whose deployed plist MATCHES needs no reload" {
  write_stub_launchctl
  # wiki-daemon: loaded, deployed plist already byte-identical to rendered → no reload.
  write_plist "${RENDERED}/com.glass-atrium.wiki-daemon.plist" "/same/bin:/usr/bin"
  write_plist "${AGENTS}/com.glass-atrium.wiki-daemon.plist" "/same/bin:/usr/bin"
  run bash -c '
    source "'"${SKILL}"'"
    export ATRIUM_UPDATE_LAUNCHCTL="'"${LAUNCHCTL}"'"
    export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="'"${RENDERED}"'"
    export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="'"${AGENTS}"'"
    export LAUNCHCTL_LOG="'"${LAUNCHCTL_LOG}"'"
    export LOADED_LABELS="com.glass-atrium.wiki-daemon"
    update_refresh_resident_launchd
  '
  [ "$status" -eq 0 ] || return 1
  # NO bootout/bootstrap for a plist that did not drift (the drift gate skipped it).
  ! grep -q "bootout gui/.*/com.glass-atrium.wiki-daemon" "${LAUNCHCTL_LOG}" || return 1
  ! grep -q "bootstrap gui/.* .*com.glass-atrium.wiki-daemon.plist" "${LAUNCHCTL_LOG}" || return 1
}

@test "resident redeploy: a NOT-loaded job is a clean skip (never auto-bootstrapped, deployed left stale)" {
  write_stub_launchctl
  # pg-backup: NOT loaded (absent from LOADED_LABELS) + deployed plist STALE vs rendered.
  write_plist "${RENDERED}/com.glass-atrium.pg-backup.plist" "/new/bin:/usr/bin"
  write_plist "${AGENTS}/com.glass-atrium.pg-backup.plist" "/stale/bin:/usr/bin"
  run bash -c '
    source "'"${SKILL}"'"
    export ATRIUM_UPDATE_LAUNCHCTL="'"${LAUNCHCTL}"'"
    export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="'"${RENDERED}"'"
    export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="'"${AGENTS}"'"
    export LAUNCHCTL_LOG="'"${LAUNCHCTL_LOG}"'"
    export LOADED_LABELS=""
    update_refresh_resident_launchd
  '
  [ "$status" -eq 0 ] || return 1
  # NOT loaded → no bootstrap AND the deployed plist stays UNCHANGED (user opt-in preserved).
  ! grep -q "bootstrap gui/.* .*com.glass-atrium.pg-backup.plist" "${LAUNCHCTL_LOG}" || return 1
  grep -q "/stale/bin" "${AGENTS}/com.glass-atrium.pg-backup.plist" || return 1
}

@test "resident redeploy: update_post_step is wired to the generalized resident refresh (not the retired autoagent-only path)" {
  # Wiring guard: the post-step must call the generalized function. Pre-change it called
  # the retired update_refresh_autoagent_launchd (autoagent-cycle only) → this fails-before.
  run bash -c '
    source "'"${SKILL}"'"
    declare -f update_post_step
  '
  [ "$status" -eq 0 ] || return 1
  grep -q "update_refresh_resident_launchd" <<<"$output" || return 1
  ! grep -q "update_refresh_autoagent_launchd" <<<"$output" || return 1
}

@test "resident redeploy: a mkdir failure degrades to WARN + continues (never aborts under set -e)" {
  write_stub_launchctl
  # daemon-daily-restart: loaded + drifted, but the deployed dir's PARENT is a regular FILE,
  # so `mkdir -p` on the LaunchAgents dir CANNOT succeed. The never-aborts contract must hold
  # even called DIRECTLY under set -e (not only via the caller's `if ! update_post_step`).
  write_plist "${RENDERED}/com.glass-atrium.daemon-daily-restart.plist" "/new/bin:/usr/bin"
  printf 'not-a-dir\n' >"${WORK}/blocker"
  run bash -c '
    source "'"${SKILL}"'"
    export ATRIUM_UPDATE_LAUNCHCTL="'"${LAUNCHCTL}"'"
    export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="'"${RENDERED}"'"
    export ATRIUM_UPDATE_LAUNCH_AGENTS_DIR="'"${WORK}"'/blocker/LaunchAgents"
    export LAUNCHCTL_LOG="'"${LAUNCHCTL_LOG}"'"
    export LOADED_LABELS="com.glass-atrium.daemon-daily-restart"
    update_refresh_resident_launchd 2>"'"${WORK}"'/warn.log"
  '
  [ "$status" -eq 0 ] || return 1 # did NOT abort (set -e safe)
  grep -q "WARN: failed to create .*/blocker/LaunchAgents" "${WORK}/warn.log" || return 1
  ! grep -q "bootstrap gui/" "${LAUNCHCTL_LOG}" || return 1 # no reload — the job was skipped
}

@test "monitor refresh: a mkdir failure degrades to WARN + still reaches the reload probe (never aborts under set -e)" {
  write_stub_launchctl
  # monitor rendered + drifted, but the DEPLOYED plist's parent dir cannot be created (parent
  # is a FILE). The re-copy WARNs + skips; the kickstart reload probe still runs (no abort).
  write_plist "${RENDERED}/com.glass-atrium.monitor.plist" "/new/bin:/usr/bin"
  printf 'not-a-dir\n' >"${WORK}/blocker"
  run bash -c '
    source "'"${SKILL}"'"
    export ATRIUM_UPDATE_LAUNCHCTL="'"${LAUNCHCTL}"'"
    export ATRIUM_UPDATE_RENDERED_LAUNCHD_DIR="'"${RENDERED}"'"
    export ATRIUM_UPDATE_MONITOR_PLIST="'"${WORK}"'/blocker/mon/com.glass-atrium.monitor.plist"
    export LAUNCHCTL_LOG="'"${LAUNCHCTL_LOG}"'"
    export LOADED_LABELS="com.glass-atrium.monitor"
    update_refresh_monitor_launchd 2>"'"${WORK}"'/warn.log"
  '
  [ "$status" -eq 0 ] || return 1 # did NOT abort (set -e safe)
  grep -q "WARN: failed to create monitor plist dir" "${WORK}/warn.log" || return 1
  grep -q "kickstart -k gui/" "${LAUNCHCTL_LOG}" || return 1 # reload probe still ran
}

@test "resident set == canonical LAUNCHD_JOBS minus monitor (inline-drift guard, both parsed from source)" {
  # Defense-in-depth: this incident was a deploy-propagation gap, so guard the inline resident
  # set against the canonical lib/ga-env.sh LAUNCHD_JOBS SoT — a canonical change not mirrored
  # here would re-open the same class of gap. Parse BOTH arrays from source text and compare.
  local ga_env="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)/lib/ga-env.sh"
  [[ -f "${ga_env}" ]] || skip "ga-env.sh not found: ${ga_env}"
  local canonical inline expected got
  canonical="$(_extract_array "${ga_env}" "LAUNCHD_JOBS=(")"
  inline="$(_extract_array "${SKILL}" "local jobs=(")"
  [[ -n "${canonical}" ]] || return 1
  [[ -n "${inline}" ]] || return 1
  grep -qx "monitor" <<<"${canonical}" || return 1 # monitor IS the excluded job
  expected="$(grep -vx "monitor" <<<"${canonical}" | sort)"
  got="$(sort <<<"${inline}")"
  [[ "${expected}" == "${got}" ]] || return 1
}
