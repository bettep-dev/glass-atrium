#!/usr/bin/env bats
# test/install-acceptance.sh → untracked_listed_count: a manifest files[] entry counts
# as untracked exactly when the git index does not hold that raw path. manifest.json
# stores raw paths, so the index side must not be C-quoted by core.quotePath.
#
# Run via: bats test/install-acceptance-untracked-listed.bats
# Requires: bats >= 1.5.0, git, jq

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  SANDBOX="$(mktemp -d -t ga-acceptance-untracked.XXXXXX)"
  git -C "${SANDBOX}" init -q
  # the default quotePath=true is the state under test, whatever the host config says
  git -C "${SANDBOX}" config core.quotePath true
  EMPTY_BLOB="$(git -C "${SANDBOX}" hash-object -w --stdin </dev/null)"
  awk 'index($0, "untracked_listed_count() {") == 1 {f = 1} f {print} f && /^}/ {exit}' \
    "${GA}/test/install-acceptance.sh" >"${SANDBOX}/oracle.sh"
  # shellcheck source=/dev/null
  source "${SANDBOX}/oracle.sh"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# track_path — add an index-only entry, so no on-disk name is needed for any byte.
track_path() {
  git -C "${SANDBOX}" update-index --add --cacheinfo "100644,${EMPTY_BLOB},$1"
}

# list_path — write a one-entry manifest files[] holding the raw path.
list_path() {
  jq -n --arg p "$1" '{files: [$p]}' >"${SANDBOX}/manifest.json"
}

@test "untracked_listed_count counts a listed entry iff its raw path is absent from the index" {
  declare -f untracked_listed_count >/dev/null

  local nl=$'\n' row name tracked listed expected got
  # name | tracked path | listed path | expected count
  local rows=(
    "ascii path tracked|agents/a.md|agents/a.md|0"
    "non-ascii path tracked|docs/한글.md|docs/한글.md|0"
    "double-quote path tracked|docs/a\"b.md|docs/a\"b.md|0"
    "listed path not tracked|agents/a.md|agents/b.md|1"
    "listed path is a fragment of a tracked newline path|docs/x${nl}agents/a.md|agents/a.md|1"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r -d '' name tracked listed expected <<<"${row}" || true
    expected="${expected%$'\n'}"
    rm -f -- "${SANDBOX}/.git/index"
    track_path "${tracked}"
    list_path "${listed}"
    got="$(untracked_listed_count "${SANDBOX}")"
    [[ "${got}" == "${expected}" ]] || {
      echo "${name}: expected ${expected}, got ${got}"
      return 1
    }
  done
}
