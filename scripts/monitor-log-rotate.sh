#!/usr/bin/env bash
# monitor-log-rotate.sh — size-triggered, fd-preserving rotation for monitor logs
# Usage: monitor-log-rotate.sh
#
# Behavior: (1) iterate the canonical monitor logs (out + err); (2) rotate a log
#   only when size exceeds the threshold (default 50 MiB), else skip silently;
#   (3) copy to a timestamped sibling, gzip it, then truncate the original in place
#      (`: > "${log}"`). Truncation (NOT unlink + recreate) is mandatory: launchd
#      opens the StandardOutPath/StandardErrorPath fds at launch and never reopens
#      them — replacing the inode orphans the daemon's fd, silently swallowing log
#      output until restart.
#   (4) prune .gz archives older than 30 days via `find -delete` — the one place
#      files are removed; glob-bounded in a known dir, build-artifact exception.
#
# Rationale: monitor.out.log can accumulate 4 MiB+ in 3 days, masking the err.log
# stale-mtime diagnostic. Daily size-triggered rotation keeps the active log small
# for grep + tail while preserving compressed history.
#
# Idempotency: safe to re-invoke. Below-threshold = no-op; the per-second timestamp
# suffix would collide only on same-second concurrent runs — acceptable since launchd
# dispatches this at 02:30 daily, never concurrently.
#
# Invoked by: launchd (com.glass-atrium.monitor-log-rotate.plist) daily at 02:30 KST.
# Manual invocation: bash monitor-log-rotate.sh
#
# Exit codes:
#   0 = success (zero or more rotations completed)
#   1 = unrecoverable error (handled by set -e + trap)
set -Eeuo pipefail
IFS=$'\n\t'

readonly LOG_ROOT="${HOME}/.claude/logs"
# 50 MiB threshold — keeps the active log under a single grep buffer, batching
# rotations to ~weekly cadence at observed write rates.
readonly MAX_SIZE_BYTES=$((50 * 1024 * 1024))
# 30 days — compressed archive retention; older .gz files are pruned. Adjust
# only if regulatory retention requirements change.
readonly ARCHIVE_RETENTION_DAYS=30

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

rotate_one() {
  local log_path="$1"

  # Missing file is normal for monitor.err.log (zero stderr since the last launchd
  # reload) — skip silently rather than warn.
  if [[ ! -f "${log_path}" ]]; then
    return 0
  fi

  local size
  size="$(stat -f "%z" "${log_path}")"

  if ((size <= MAX_SIZE_BYTES)); then
    return 0
  fi

  # 1. snapshot the live log to a timestamped sibling
  local stamp
  stamp="$(date +"%Y-%m-%d_%H%M%S")"
  local rotated="${log_path}.${stamp}"

  cp "${log_path}" "${rotated}"

  # 2. compress the snapshot — gzip removes the source on success
  gzip "${rotated}"

  # 3. truncate the original in place; preserves the daemon's open fd
  : >"${log_path}"

  echo "rotated: ${rotated}.gz (size=${size})"
}

prune_archives() {
  # `|| true` justified: find exits non-zero on an empty dir or a concurrent-delete
  # race — a no-op here that MUST NOT fail the rotation cycle.
  find "${LOG_ROOT}" -maxdepth 1 -name "*.gz" -mtime +"${ARCHIVE_RETENTION_DAYS}" -delete 2>/dev/null || true
}

main() {
  local log
  for log in "${LOG_ROOT}/monitor.out.log" "${LOG_ROOT}/monitor.err.log"; do
    rotate_one "${log}"
  done
  prune_archives
}

main "$@"
