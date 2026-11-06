#!/usr/bin/env bats
# tracked-paths.bats — pins ga_get_tracked_paths (scripts/lib/tracked-paths.sh): every path
# the index holds is listed exactly once, whatever number of index stages it carries.

bats_require_minimum_version 1.5.0

TRACKED_LIB="${BATS_TEST_DIRNAME}/../lib/tracked-paths.sh"

# git_scratch — git in the scratch repo with a fixed identity and no signing, whatever the host config.
git_scratch() {
  git -C "${REPO}" -c user.name=bats -c user.email=bats@example.invalid \
    -c commit.gpgsign=false "$@"
}

setup() {
  REPO="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${REPO}"
  git_scratch init -q -b main
}

@test "an unmerged path holding several index stages is listed once" {
  printf 'base\n' >"${REPO}/conflicted.txt"
  printf 'clean\n' >"${REPO}/clean.txt"
  git_scratch add conflicted.txt clean.txt
  git_scratch commit -q -m base
  git_scratch checkout -q -b side
  printf 'side\n' >"${REPO}/conflicted.txt"
  git_scratch commit -q -am side
  git_scratch checkout -q main
  printf 'main\n' >"${REPO}/conflicted.txt"
  git_scratch commit -q -am main
  run -1 git_scratch merge -q side
  run git_scratch ls-files --stage -- conflicted.txt
  [[ "${#lines[@]}" -eq 3 ]] || {
    echo "fixture is not a three-stage conflict: ${output}"
    return 1
  }

  # shellcheck source-path=SCRIPTDIR source=../lib/tracked-paths.sh
  source "${TRACKED_LIB}"
  run ga_get_tracked_paths "${REPO}"
  [[ "${status}" -eq 0 && "${output}" == $'clean.txt\nconflicted.txt' ]] || {
    echo "status ${status}, output: ${output}"
    return 1
  }
}
