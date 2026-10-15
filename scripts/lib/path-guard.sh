#!/usr/bin/env bash
# path-guard.sh — the shared path guard a recursive or forced delete target passes first. Sourced,
# not executable. One file for every tree: hooks, autoagent, lib and the test corpora already source
# scripts/lib (a hook resolves its real install dir first — the ~/.claude/hooks farm has no scripts/).
#
# Usage contract, the one shape scripts/audit-rm.sh accepts:
#   if ga_guard_path "${DIR}"; then rm -rf -- "${DIR:?}"; fi

# Refuses an empty value silently (a teardown whose setup never ran stays a skip), and the filesystem
# root or a non-absolute value with a stderr message. A wrong absolute path still passes.
ga_guard_path() {
  local target="${1:-}"
  if [[ -z "${target}" ]]; then
    return 1
  fi
  # Trailing slashes stripped → any all-slash spelling of the root is caught.
  if [[ -z "${target%"${target##*[!/]}"}" ]]; then
    printf 'ga_guard_path: refusing the filesystem root as a delete target: %q\n' "${target}" >&2
    return 1
  fi
  if [[ "${target}" != /* ]]; then
    printf 'ga_guard_path: refusing a non-absolute delete target: %q\n' "${target}" >&2
    return 1
  fi
  return 0
}
