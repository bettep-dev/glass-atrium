#!/usr/bin/env bash
# tracked-paths.sh — the "git still tracks this path" oracle shared by the manifest generator,
# the retired-seed derivation and the install acceptance count. Sourced, not executable.

# Every path the index of repo root $1 holds, whole-repo and unfiltered, byte-sorted, once each.
# -z → raw bytes like a manifest key (default ls-files C-quotes a byte >= 0x80, `"`, `\` or a
# control byte) · -u → an unmerged path repeats once per index stage · a newline path is skipped:
# never a manifest key, and split it could fake a match.
# shellcheck disable=SC2312  # under the callers' pipefail git's status leaves the pipe; the [[ ]] is a filter
ga_get_tracked_paths() {
  local root="$1" path
  git -C "${root}" ls-files -z | while IFS= read -r -d '' path; do
    if [[ "${path}" != *$'\n'* ]]; then printf '%s\n' "${path}"; fi
  done | LC_ALL=C sort -u
}
