#!/usr/bin/env bats
# Violation probe for the suite scratch-cwd seat (test/lib/bats-hermetic-env.bash): a script a
# test starts runs a cwd-relative recursive forced delete, the shape of a mutated script run by
# bats, and that delete must land inside the bats run's scratch tree.
#
# Harmless when the seat fails: nothing is planted or deleted unless the physical cwd sits under
# BATS_RUN_TMPDIR, and the delete glob matches only this test's own uniquely named canaries.
# The verdict comes from that cwd assertion and the canaries, never from the checkout surviving.

@test "a cwd-relative delete by a started script removes only its canaries, inside the run scratch tree" {
  local run_root cwd
  run_root="$(cd -P -- "${BATS_RUN_TMPDIR:?}" && pwd)"
  cwd="$(pwd -P)"
  [[ "${cwd}" == "${run_root}/"* ]] || {
    printf 'cwd %s is not under BATS_RUN_TMPDIR %s: nothing planted, nothing deleted\n' \
      "${cwd}" "${run_root}" >&2
    return 1
  }

  local canary="ga-scratch-cwd-canary.${BATS_ROOT_PID:-$$}.${RANDOM}${RANDOM}"
  mkdir "${canary}.dir"
  touch "${canary}.dir/nested" "${canary}.file"
  [[ -f "${cwd}/${canary}.file" && -f "${cwd}/${canary}.dir/nested" ]] || {
    printf 'canaries were not planted in the cwd %s\n' "${cwd}" >&2
    return 1
  }

  # The started script re-checks its own inherited cwd right before the delete: BASH_ENV or
  # anything else run at its startup could move it after the check above.
  local rc=0
  bash -c '[[ "$(pwd -P)" == "$2/"* ]] || exit 3; rm -rf -- ./"$1".*' \
    probe "${canary}" "${run_root}" || rc=$?
  [[ "${rc}" -eq 0 ]] || {
    printf 'the started script refused or failed (rc %s) in cwd %s\n' "${rc}" "${cwd}" >&2
    return 1
  }

  local left
  left="$(find "${cwd}" -maxdepth 1 -name "${canary}.*")"
  [[ -z "${left}" ]] || {
    printf 'canaries survived the cwd-relative delete:\n%s\n' "${left}" >&2
    return 1
  }
}
