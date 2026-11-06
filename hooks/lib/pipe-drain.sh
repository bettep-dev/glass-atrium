#!/usr/bin/env bash
# pipe-drain.sh — drain_after, the pipe-end wrapper for a reader that can stop before EOF
# (grep -q, grep -m, head). Under pipefail a writer with a write still to make after that reader exits
# dies of SIGPIPE, and the pipe then reports that 141 instead of the reader's verdict.
# A writer making more than one write races the reader at any output size; a single write within the
# 64 KiB pipe capacity is the safe case, since the reader can stop only after reading it.
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
