#!/usr/bin/env bats
# skill-registry-retired.bats — pins the retired-map row for skills/skill-registry.json (G-12).
#
# `generate-manifest.sh --check` cannot see an eroded retired map: build_retired_json
# carries entries forward FROM the same manifest --check compares against, so a deleted
# retired row is self-consistent and passes green. A row lost that way leaves the updater
# with no removal instruction and the retired file installed on every consumer.
#
# TRACKED-CONTENT SCAN: this file ships to the live install, where the scan root is not a
# git work tree. The test goes inert off a checkout root rather than failing for the wrong
# reason — the same containment test/db-backup-path-consistency.bats uses.
#
# ANNOUNCED SKIP: while the manifest still lists the path in files[], the retired map is
# legitimately empty of it and the assertion skips with that reason. The skip is SELF-
# CLEARING — once a regeneration drops the files[] row the condition is false forever after.
# The divergence window itself is covered by scripts/test/manifest-check-clean.bats.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate a test's verdict (bash 3.2 under
# bats keeps going and the LAST command decides), so the assertion `return 1`s explicitly.
#
# Run via: bats scripts/test/skill-registry-retired.bats
# Requires: bats >= 1.5.0, git, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
RETIRED_PATH="skills/skill-registry.json"
MANIFEST="${GA}/manifest.json"

# `-ef` (same inode) rather than string equality: a symlinked checkout resolves to a
# different spelling of the same root.
is_repo_root() {
  local top
  top="$(git -C "${GA}" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ -n "${top}" ]] || return 1
  [[ "${top}" -ef "${GA}" ]]
}

@test "AC-C1-C the barrier manifest carries the retired array and drops the files[] row" {
  is_repo_root || skip "scan root is not a git checkout root: ${GA}"
  command -v jq >/dev/null 2>&1 || skip "jq not found — manifest assertions need it"
  [[ -f "${MANIFEST}" ]] || skip "manifest not found: ${MANIFEST}"

  local in_files hashes
  in_files="$(jq -r --arg p "${RETIRED_PATH}" '[.files[] | select(. == $p)] | length' -- "${MANIFEST}")"
  [[ "${in_files}" == "0" ]] ||
    skip "manifest predates the retirement barrier (files[] still lists ${RETIRED_PATH}) — the barrier regeneration arms this assertion"

  hashes="$(jq -r --arg p "${RETIRED_PATH}" '(.retired // {})[$p] // [] | length' -- "${MANIFEST}")"
  [[ "${hashes}" -ge 1 ]] || {
    printf 'files[] dropped %s but the retired map carries no hash array for it — the updater will leave the file installed\n' \
      "${RETIRED_PATH}" >&2
    return 1
  }
}
