#!/usr/bin/env bats
# init-test-repos.sh tests: sandbox GA-root init, idempotency (2nd run no-op),
# no-touch of a pre-existing corpus repo, and missing-dir loud-fail (exit 3,
# zero partial side effects).
#
# Run via: bats scripts/test/init-test-repos.bats
# Requires: bats (brew install bats-core), bash 3.2+, git

SCRIPT="${BATS_TEST_DIRNAME}/../init-test-repos.sh"

setup() {
  [[ -f "${SCRIPT}" ]] || skip "init-test-repos.sh not found: ${SCRIPT}"
  WORK="$(mktemp -d -t init-test-repos-bats.XXXXXX)"
  export GA_ROOT="${WORK}/ga"
  mkdir -p "${GA_ROOT}/test" "${GA_ROOT}/hooks/test" "${GA_ROOT}/scripts/test"
  printf 'fixture-a\n' >"${GA_ROOT}/test/a.txt"
  printf 'fixture-b\n' >"${GA_ROOT}/hooks/test/b.txt"
  printf 'fixture-c\n' >"${GA_ROOT}/scripts/test/c.txt"
  # Hermetic git: synthetic HOME (no global config / gpgsign leakage from the
  # host) + env identity so commits work without any user config.
  export HOME="${WORK}/home"
  mkdir -p "${HOME}"
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_AUTHOR_NAME='ga-fixture' GIT_AUTHOR_EMAIL='ga@fixture.invalid'
  export GIT_COMMITTER_NAME='ga-fixture' GIT_COMMITTER_EMAIL='ga@fixture.invalid'
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

@test "init: creates three independent repos with one initial commit each" {
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  for rel in test hooks/test scripts/test; do
    dir="${GA_ROOT}/${rel}"
    [[ -d "${dir}/.git" ]]
    # Independent repo rooted at the corpus dir itself, not a parent.
    top="$(git -C "${dir}" rev-parse --show-toplevel)"
    [[ "${top}" == "${dir}" ]]
    [[ "$(git -C "${dir}" rev-list --count HEAD)" -eq 1 ]]
    [[ "$(git -C "${dir}" log -1 --format=%s)" == "Initialize test-corpus version control" ]]
    # Corpus content committed: clean tree after init.
    [[ -z "$(git -C "${dir}" status --porcelain)" ]]
  done
  # GA root itself must NOT become a repo.
  [[ ! -e "${GA_ROOT}/.git" ]]
}

@test "idempotency: second run is a no-op (still one commit each)" {
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"already a repo, no-op: test"* ]]
  [[ "${output}" == *"already a repo, no-op: hooks/test"* ]]
  [[ "${output}" == *"already a repo, no-op: scripts/test"* ]]
  for rel in test hooks/test scripts/test; do
    [[ "$(git -C "${GA_ROOT}/${rel}" rev-list --count HEAD)" -eq 1 ]]
  done
}

@test "no-touch: a pre-existing corpus repo keeps its HEAD" {
  git -C "${GA_ROOT}/test" init --quiet
  git -C "${GA_ROOT}/test" add -A
  git -C "${GA_ROOT}/test" commit --quiet -m 'pre-existing history'
  head_before="$(git -C "${GA_ROOT}/test" rev-parse HEAD)"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  [[ "$(git -C "${GA_ROOT}/test" rev-parse HEAD)" == "${head_before}" ]]
  [[ "$(git -C "${GA_ROOT}/test" log -1 --format=%s)" == "pre-existing history" ]]
  # The other two corpora still get initialized.
  [[ "$(git -C "${GA_ROOT}/hooks/test" rev-list --count HEAD)" -eq 1 ]]
  [[ "$(git -C "${GA_ROOT}/scripts/test" rev-list --count HEAD)" -eq 1 ]]
}

@test "missing dir: loud-fail exit 3 with zero partial side effects" {
  rm -rf -- "${GA_ROOT}/hooks/test"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 3 ]]
  [[ "${output}" == *"corpus dir missing: ${GA_ROOT}/hooks/test"* ]]
  # Validate-all-first: nothing was initialized before the failure.
  [[ ! -e "${GA_ROOT}/test/.git" ]]
  [[ ! -e "${GA_ROOT}/scripts/test/.git" ]]
}
