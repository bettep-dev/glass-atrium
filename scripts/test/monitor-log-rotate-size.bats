#!/usr/bin/env bats
# monitor-log-rotate-size.bats — pins the OS-portable byte-size read in monitor-log-rotate.sh. The
# pre-fix code sized the log with a bare BSD `stat -f "%z"`; on GNU/Linux `-f` means --file-system, so
# '%z' becomes a bad file operand and the `set -Eeuo pipefail` ERR trap kills the run (exit 1). The fix
# uses POSIX `wc -c` (identical on BSD+GNU), mirroring scripts/pg-backup.sh.
#
# The rotation threshold is a large fixed 50 MiB (not env-overridable), so these tests exercise the
# below-threshold branch — which still runs the size read + the `((size <= MAX))` arithmetic under
# strict mode. Reaching exit 0 with the log untouched PROVES the size read yields a valid integer
# (the old Linux code would have died in the ERR trap before ever comparing).

ROTATE_SH="${BATS_TEST_DIRNAME}/../monitor-log-rotate.sh"
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../lib/path-guard.sh"

setup() {
  [[ -f "${ROTATE_SH}" ]] || skip "monitor-log-rotate.sh not found"
  MR_TMP="$(mktemp -d -t monitor-log-rotate.XXXXXX)"
  mkdir -p "${MR_TMP}/.claude/logs" "${MR_TMP}/tmpsink"
  # Hermetic second sink: without the override the run would reach the real /tmp
  # launchd sink the script now covers.
  export GA_TMP_LOG_ROOT="${MR_TMP}/tmpsink"
}

teardown() {
  if ga_guard_path "${MR_TMP:-}"; then rm -rf -- "${MR_TMP:?}"; fi
}

@test "below-threshold log: size read succeeds, no rotation, log untouched (portable wc -c)" {
  local logdir="${MR_TMP}/.claude/logs"
  local content="line1
line2
line3"
  printf '%s\n' "${content}" >"${logdir}/monitor.out.log"
  local before
  before="$(cat "${logdir}/monitor.out.log")"

  run env HOME="${MR_TMP}" bash "${ROTATE_SH}"
  # Old Linux `stat -f "%z"` would die in the ERR trap here — exit 0 is the portability proof.
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  # Below 50 MiB → no-op: the live log is unchanged and no .gz archive was produced.
  [ -f "${logdir}/monitor.out.log" ] || { echo "log vanished"; return 1; }
  [ "$(cat "${logdir}/monitor.out.log")" == "${before}" ] || { echo "log mutated below threshold"; return 1; }
  ! ls "${logdir}"/*.gz >/dev/null 2>&1 || { echo "unexpected rotation archive"; return 1; }
  # No "rotated:" line on the no-op path.
  [[ "${output}" != *"rotated:"* ]] || { echo "unexpected rotation on below-threshold log"; return 1; }
}

@test "missing log file: skipped silently, exit 0" {
  # No monitor.out.log / monitor.err.log present — rotate_one returns early per file.
  run env HOME="${MR_TMP}" bash "${ROTATE_SH}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  [[ "${output}" != *"rotated:"* ]] || return 1
}

@test "oversized /tmp sink: active job logs rotate in place, retired job logs and non-members stay untouched" {
  local sink="${MR_TMP}/tmpsink" oversize=$((51 * 1024 * 1024))
  # name|expected — the sink members are named, not globbed, so only active jobs' logs rotate.
  local -a rows=(
    "autoagent-daemon-loop.log|rotated"
    "wiki-compile.log|rotated"
    "autoagent-daemon.log|kept"
    "wiki-daemon.log|kept"
    "daemon-daily-restart.log|kept"
    "unrelated.log|kept"
  )
  local row name size
  for row in "${rows[@]}"; do
    # sparse file 1 MiB past the fixed 50 MiB threshold
    python3 -c "import sys; f = open(sys.argv[1], 'wb'); f.seek(int(sys.argv[2]) - 1); f.write(b'x')" \
      "${sink}/${row%%|*}" "${oversize}"
  done
  printf 'small\n' >"${sink}/pg-backup.log"

  run env HOME="${MR_TMP}" bash "${ROTATE_SH}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  for row in "${rows[@]}"; do
    name="${row%%|*}"
    if [[ "${row##*|}" == "rotated" ]]; then
      [[ ! -s "${sink}/${name}" ]] && ls "${sink}/${name}".*.gz >/dev/null 2>&1 \
        || { echo "${name}: not rotated and truncated in place: ${output}"; return 1; }
    else
      size="$(wc -c <"${sink}/${name}")"
      [[ "${size}" -eq "${oversize}" ]] \
        && ! ls "${sink}/${name}".*.gz >/dev/null 2>&1 \
        || { echo "${name}: touched by the rotator: ${output}"; return 1; }
    fi
  done
  [ "$(cat "${sink}/pg-backup.log")" == "small" ] || { echo "below-threshold member mutated"; return 1; }
}
