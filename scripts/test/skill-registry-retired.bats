#!/usr/bin/env bats
# skill-registry-retired.bats — pins the retirement of skills/skill-registry.json (G-12).
#
# The index shipped in the release bundle with ZERO readers: no tracked file ever
# opened it, and its entry set had drifted from the on-disk skills by two entries.
# An index nothing reads cannot report its own drift, so correcting the entries
# would only have refilled the same hole. It was retired instead (ADR-9), and this
# suite is the guard that keeps it retired.
#
# Each test asserts a property the others cannot produce:
#   AC-C1-A  two-armed retirement -> the path is absent from the RAW `git ls-files`
#                                    AND absent from the work tree. Both arms are
#                                    what generate-manifest.sh requires before it
#                                    will append a path to `retired`, so a restore
#                                    through EITHER arm silently un-retires the file
#   AC-C1-B  zero consumers       -> no tracked file carries the `skill-registry`
#                                    string, excluding this file and manifest.json
#                                    (the retired map is KEYED by that very path,
#                                    so the manifest naming it is the success state)
#   AC-C1-C  barrier state        -> once the barrier regeneration has run, the
#                                    retired map carries a hash array for the path
#                                    and files[] no longer lists it
#
# TRACKED-CONTENT SCAN: this file ships to the live install, where the scan root is
# not a git work tree and still holds the real file until the updater's retirement
# sweep removes it. A scan there would fail for the wrong reason and red the apply
# gate, so A and B scope themselves to git-tracked content and go inert off a
# checkout root — the same containment test/db-backup-path-consistency.bats uses.
#
# ANNOUNCED SKIP (AC-C1-C only): the retirement lands one commit before the barrier
# that regenerates manifest.json, so between the two the manifest still lists the
# path in files[] and the retired map is legitimately empty of it. C skips with that
# reason rather than asserting a state the tree has not reached yet. The skip is
# SELF-CLEARING: the moment the barrier regenerates, files[] no longer names the
# path, the skip condition is false forever after, and the assertion arms itself.
# Manifest/tree divergence in the meantime is not uncovered — scripts/test/manifest-
# check-clean.bats fails on exactly that window, independently of this file.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate a test's verdict (bash 3.2
# under bats keeps going and the LAST command decides), so every assertion here ends
# its test or `return 1`s explicitly.
#
# Run via: bats scripts/test/skill-registry-retired.bats
# Requires: bats >= 1.5.0, git, jq (C only), bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
RETIRED_PATH="skills/skill-registry.json"
# The needle is the file STEM, not its full path: a consumer that reappears is as
# likely to name it by stem (a glob, a basename, a doc reference) as by full path.
NEEDLE="skill-registry"
MANIFEST="${GA}/manifest.json"

# `-ef` (same inode) rather than string equality: a symlinked checkout resolves to a
# different spelling of the same root.
is_repo_root() {
  local top
  top="$(git -C "${GA}" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ -n "${top}" ]] || return 1
  [[ "${top}" -ef "${GA}" ]]
}

# This file's own repo-relative path, derived rather than hardcoded so a rename
# cannot quietly drop the self-exclusion and make B trip on its own text.
self_rel() {
  printf 'scripts/test/%s\n' "${BATS_TEST_FILENAME##*/}"
}

@test "AC-C1-A the retired index is absent from BOTH the git index and the work tree" {
  is_repo_root || skip "scan root is not a git checkout root: ${GA}"
  local tracked
  tracked="$(git -C "${GA}" ls-files -- "${RETIRED_PATH}")"
  [[ -z "${tracked}" ]] || {
    printf 'arm 1 broken — git still tracks the retired path: %s\n' "${tracked}" >&2
    return 1
  }
  [[ ! -e "${GA}/${RETIRED_PATH}" ]] || {
    printf 'arm 2 broken — the retired path is back in the work tree: %s\n' "${GA}/${RETIRED_PATH}" >&2
    return 1
  }
}

@test "AC-C1-B no tracked file names the retired index" {
  is_repo_root || skip "scan root is not a git checkout root: ${GA}"
  local hits
  hits="$(git -C "${GA}" grep -nIF --full-name -e "${NEEDLE}" \
    -- '.' ":(exclude)$(self_rel)" ":(exclude)manifest.json" || true)"
  [[ -z "${hits}" ]] || {
    printf 'a consumer of the retired index reappeared:\n%s\n' "${hits}" >&2
    return 1
  }
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
