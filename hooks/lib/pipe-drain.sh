#!/usr/bin/env bash
# pipe-drain.sh — drain_after, the pipe-end wrapper for a reader that can stop before EOF
# (grep -q, grep -m, head). Under pipefail the writer of such a reader dies of SIGPIPE above the
# 64 KiB pipe capacity, and the pipe then reports that 141 instead of the reader's verdict.
# Pipe-stage use only: outside a pipe, the drain would read the caller's own stdin.
# Bash 3.2+ (macOS stock).

# shellcheck disable=SC2317  # source-context-unaware false positive on this double-source guard
if [[ -n "${_PIPE_DRAIN_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _PIPE_DRAIN_LOADED=1

# Runs "$@" as the reader, then reads stdin to EOF → the writer never meets a closed pipe.
# Returns: the reader's own exit status.
drain_after() {
  local rc=0
  "$@" || rc=$?
  cat >/dev/null || true
  return "${rc}"
}
