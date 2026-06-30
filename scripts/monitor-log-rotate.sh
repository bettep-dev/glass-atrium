#!/usr/bin/env bash
# monitor-log-rotate.sh — size-triggered, fd-preserving rotation for monitor logs
# Usage: monitor-log-rotate.sh
#
# Behavior:
#   1. Iterate over the canonical monitor log paths (out + err).
#   2. For each present log file, read its size; rotate only when size exceeds
#      the threshold (default 50 MiB). Below threshold → skip silently.
#   3. Copy the log to a timestamped sibling, gzip the copy, then truncate the
#      original in place via `: > "${log}"`. Truncation (not unlink + recreate)
#      is mandatory: launchd opens the StandardOutPath/StandardErrorPath file
#      descriptors at daemon launch and never reopens them — replacing the
#      inode would orphan the daemon's fd, silently swallowing subsequent log
#      output until the daemon restarts.
#   4. Prune .gz archives older than 30 days via `find -delete`. This is the
#      one place the script removes files; `find -delete` over a glob-bounded
#      pattern in a known directory is acceptable per the build-artifact
#      exception in the harness rules.
#
# Rationale: monitor.out.log can accumulate 4 MiB+ in 3 days with
# no rotation policy, masking the err.log stale-mtime diagnostic. A daily
# size-triggered rotation keeps the active log small enough for grep + tail
# while preserving historical evidence in compressed form.
#
# Idempotency: safe to invoke repeatedly. Below-threshold runs are no-ops;
# above-threshold runs produce a fresh timestamp suffix per second so
# consecutive invocations within the same second would collide on the rotated
# path — acceptable because launchd dispatches this script at 02:30 daily,
# never concurrently with itself.
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
# 50 MiB threshold — chosen to keep the active log under a single grep buffer
# while batching rotations to roughly weekly cadence at observed write rates.
readonly MAX_SIZE_BYTES=$((50 * 1024 * 1024))
# 30 days — compressed archive retention; older .gz files are pruned. Adjust
# only if regulatory retention requirements change.
readonly ARCHIVE_RETENTION_DAYS=30

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

rotate_one() {
  local log_path="$1"

  # Missing file is the normal case for monitor.err.log when the daemon
  # has emitted zero stderr lines since the last launchd reload — skip
  # silently rather than warn.
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
  # `|| true` is justified: find may emit a non-zero exit when the directory
  # is empty or when concurrent deletion races us; either case is a no-op
  # from our perspective and MUST NOT fail the rotation cycle.
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
