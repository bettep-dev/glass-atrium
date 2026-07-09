#!/usr/bin/env bash
# wiki-compile-lock.sh — shared 3-branch wiki-compile lock dispatch for the W5/W6
# stage runners (wiki-dedup.sh, wiki-deadlinks.sh). Sourced, not executable.
#
# run_under_compile_lock <log_tag> -- <cmd...> runs <cmd> under the wiki-compile
# lock, branching on ancestor-lock state:
#   * WIKI_COMPILE_LOCK_HELD=1 → an ancestor (wiki-daemon-cycle.sh) already holds
#     the non-reentrant wiki-compile lock; a self-`with` would deadlock it to
#     timeout → run direct.
#   * lock script not executable → no lock → run direct (WARN).
#   * else → wiki-lock.sh with wiki-compile 30 -- <cmd>.
# The inner rc is captured via `<cmd> || rc=$?` and returned unchanged, so the
# caller surfaces it (stage=… rc=N). wiki-lock.sh resolves one level up from this
# lib dir, mirroring the callers' own LOCK_SCRIPT resolution.

WIKI_COMPILE_LOCK_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly WIKI_COMPILE_LOCK_LIB_DIR
WIKI_COMPILE_LOCK_SCRIPT="${WIKI_COMPILE_LOCK_LIB_DIR}/../wiki-lock.sh"
readonly WIKI_COMPILE_LOCK_SCRIPT

run_under_compile_lock() {
  local log_tag="${1:?run_under_compile_lock requires a log tag}"
  shift
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi

  # No internal set -e: this sourced function runs in the caller's shell, so
  # toggling errexit would leak + abort the caller before it captures RC.
  # `<cmd> || rc=$?` is errexit-neutral (`||` suppresses -e) and always captures rc.
  local rc=0
  if [[ "${WIKI_COMPILE_LOCK_HELD:-0}" -eq 1 ]]; then
    "$@" || rc=$?
  elif [[ ! -x "${WIKI_COMPILE_LOCK_SCRIPT}" ]]; then
    printf '[%s] WARN: lock script not executable (%s) — running without lock\n' \
      "${log_tag}" "${WIKI_COMPILE_LOCK_SCRIPT}" >&2
    "$@" || rc=$?
  else
    "${WIKI_COMPILE_LOCK_SCRIPT}" with wiki-compile 30 -- "$@" || rc=$?
  fi

  return "${rc}"
}
