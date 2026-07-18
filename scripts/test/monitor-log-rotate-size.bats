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

setup() {
  [[ -f "${ROTATE_SH}" ]] || skip "monitor-log-rotate.sh not found"
  MR_TMP="$(mktemp -d -t monitor-log-rotate.XXXXXX)"
  mkdir -p "${MR_TMP}/.claude/logs"
}

teardown() {
  [[ -n "${MR_TMP:-}" && -d "${MR_TMP}" ]] && rm -rf -- "${MR_TMP}" || true
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
