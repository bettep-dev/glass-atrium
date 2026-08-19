#!/usr/bin/env bats
# apply-spine.sh suite — pins the E3 safe-apply spine library contract:
# T13 spine_find_changed_files — hash-diff selection, excluding the agents markdown
# the E4 merge CLAIMS (top-level agents/<name>.md minus the charter) + *.local.md +
# config.toml, with the missing-locally → changed rule.
# T11 spine_stage_and_verify (per-file SHA-256 verify; loud-fail on a hash mismatch
# with ZERO install mutation) · spine_commit_staged (swap + rollback to pre-swap:
# existing files restored, newly created files DELETED) · spine_apply (full
# verify-then-commit transaction). T14 spine_set/get_baseline — capture + read the
# base@install anchor (absence → rc 1, the `get` contract).
# Hermetic: baseline state dir pinned via ATRIUM_UPDATE_STATE_DIR so the live
# ~/.claude/data/update tree is NEVER touched; the lib is sourced under
# set -Eeuo pipefail proving its functions strict-mode-safe.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/scripts/lib/apply-spine.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "apply-spine.sh not found: ${REAL_LIB}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  # pwd -P resolves /var -> /private/var so all sandbox paths are canonical.
  WORK="$(cd -- "$(mktemp -d -t apply-spine-bats.XXXXXX)" && pwd -P)"
  NEW="${WORK}/new"     # staged new-release tree
  LIVE="${WORK}/live"   # live install root
  STATE="${WORK}/state" # pinned baseline state dir
  WORKDIR="${WORK}/wd"  # spine_apply staging/snapshot work dir
  mkdir -p "${NEW}" "${LIVE}" "${STATE}" "${WORKDIR}"
  export ATRIUM_UPDATE_STATE_DIR="${STATE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# helpers

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Echo a file's inode number, portable across GNU coreutils and BSD/macOS stat.
# `stat --version` succeeds only on GNU, so it is a reliable discriminator (a
# BSD `stat -f '%i'` means something entirely different on GNU — filesystem id —
# so a blind fallback would silently return the wrong number).
inode_of() {
  if stat --version >/dev/null 2>&1; then
    stat -c '%i' -- "$1" # GNU coreutils
  else
    stat -f '%i' -- "$1" # BSD / macOS
  fi
}

# Write file $2 (relative) with content $3 under root $1, creating parent dirs.
seed_file() {
  local root="$1" rel="$2" content="$3"
  mkdir -p -- "$(dirname -- "${root}/${rel}")"
  printf '%s' "${content}" >"${root}/${rel}"
}

# Create a symlink at $2 (relative) under root $1 holding the literal target
# text $3, creating parent dirs. The target itself is a separate row and exists
# only where a fixture seeds it, so a seeded link may be dangling by design.
seed_link() {
  local root="$1" rel="$2" target="$3"
  mkdir -p -- "$(dirname -- "${root}/${rel}")"
  ln -sfn -- "${target}" "${root}/${rel}"
}

# Build a manifest.json at $1 whose files[] + hashes map describe the files
# under root $2 listed in $3.. (relative paths). Hashes are the real shasum of
# the files under $2 (the new-release tree).
build_manifest() {
  local manifest="$1" root="$2"
  shift 2
  local rel files_json hashes_json entries="" first=1
  files_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  for rel in "$@"; do
    [[ "${first}" -eq 1 ]] || entries+=$'\n'
    first=0
    entries+="$(printf '%s\t%s' "${rel}" "$(sha256_of "${root}/${rel}")")"
  done
  hashes_json="$(printf '%s\n' "${entries}" \
    | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}')"
  jq -n --argjson f "${files_json}" --argjson h "${hashes_json}" \
    '{version: "1.0.0", files: $f, hashes: $h}' >"${manifest}"
}

# Source the lib under strict mode and run "$@" in the same shell.
spine() {
  set -Eeuo pipefail
  IFS=$'\n\t'
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  "$@"
}

# T13 — spine_find_changed_files

@test "T13: detects a content hash diff (changed file selected)" {
  seed_file "${NEW}" "hooks/a.sh" "new-content"
  seed_file "${LIVE}" "hooks/a.sh" "old-content"
  build_manifest "${WORK}/manifest.json" "${NEW}" "hooks/a.sh"
  run spine spine_find_changed_files "${WORK}/manifest.json" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "hooks/a.sh" ]]
}

@test "T13: identical content is NOT selected" {
  seed_file "${NEW}" "hooks/a.sh" "same"
  seed_file "${LIVE}" "hooks/a.sh" "same"
  build_manifest "${WORK}/manifest.json" "${NEW}" "hooks/a.sh"
  run spine spine_find_changed_files "${WORK}/manifest.json" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}

@test "T13: a file missing from the live install is selected (must install)" {
  seed_file "${NEW}" "scripts/new.sh" "brand-new"
  build_manifest "${WORK}/manifest.json" "${NEW}" "scripts/new.sh"
  run spine spine_find_changed_files "${WORK}/manifest.json" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "scripts/new.sh" ]]
}

@test "T13: a MERGE-CLAIMED agent body is EXCLUDED, the rest of agents/ is SELECTED" {
  seed_file "${NEW}" "agents/dev-shell.md" "vendor-new-body"
  seed_file "${LIVE}" "agents/dev-shell.md" "local-learned-body"
  seed_file "${NEW}" "agents/GLASS_ATRIUM_GLOBAL_RULES.md" "vendor-charter"
  seed_file "${LIVE}" "agents/GLASS_ATRIUM_GLOBAL_RULES.md" "local-charter"
  seed_file "${NEW}" "agents/sub/nested.md" "vendor-nested"
  seed_file "${LIVE}" "agents/sub/nested.md" "local-nested"
  seed_file "${NEW}" "hooks/a.sh" "new"
  seed_file "${LIVE}" "hooks/a.sh" "old"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "agents/dev-shell.md" "agents/GLASS_ATRIUM_GLOBAL_RULES.md" \
    "agents/sub/nested.md" "hooks/a.sh"
  run spine spine_find_changed_files "${WORK}/manifest.json" "${LIVE}"
  [[ "${status}" -eq 0 ]] || return 1
  # `|| return 1` is load-bearing: under bats a FAILING bare `[[ ]]` that is not
  # the test's final command does not fail the test.
  # the E4 merge CLAIMS a top-level agent body → the spine must never touch it
  [[ "${output}" != *"agents/dev-shell.md"* ]] || return 1
  # the merge reaches NEITHER the charter nor a nested doc (basename skip / the
  # non-recursive glob), so the spine owns them — the deploy partition, which
  # previously left both hash-verified by nobody.
  [[ "${output}" == *"agents/GLASS_ATRIUM_GLOBAL_RULES.md"* ]] || return 1
  [[ "${output}" == *"agents/sub/nested.md"* ]] || return 1
  [[ "${output}" == *"hooks/a.sh"* ]] || return 1
}

@test "T13: *.local.md overlay and config.toml are EXCLUDED" {
  seed_file "${NEW}" "rules/x.local.md" "vendor-overlay"
  seed_file "${LIVE}" "rules/x.local.md" "local-overlay"
  seed_file "${NEW}" "config.toml" "vendor-config"
  seed_file "${LIVE}" "config.toml" "local-config"
  seed_file "${NEW}" "rules/real.md" "new"
  seed_file "${LIVE}" "rules/real.md" "old"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "rules/x.local.md" "config.toml" "rules/real.md"
  run spine spine_find_changed_files "${WORK}/manifest.json" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "rules/real.md" ]]
}

@test "T13: loud-fail (rc 1) when a manifest path carries no hash" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  jq -n '{version:"1.0.0", files:["hooks/a.sh"], hashes:{}}' >"${WORK}/manifest.json"
  run spine spine_find_changed_files "${WORK}/manifest.json" "${LIVE}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"no hash for hooks/a.sh"* ]]
}

# T11 — spine_stage_and_verify

@test "T11 stage: staged copies verify against the manifest hashes" {
  seed_file "${NEW}" "hooks/a.sh" "alpha"
  seed_file "${NEW}" "scripts/b.sh" "beta"
  build_manifest "${WORK}/manifest.json" "${NEW}" "hooks/a.sh" "scripts/b.sh"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" "scripts/b.sh" \
      | spine_stage_and_verify "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${WORKDIR}/staging"
  [[ "${status}" -eq 0 ]]
  [[ "$(sha256_of "${WORKDIR}/staging/hooks/a.sh")" == "$(sha256_of "${NEW}/hooks/a.sh")" ]]
}

@test "T11 stage: loud-fail on a hash mismatch, install untouched" {
  seed_file "${NEW}" "hooks/a.sh" "tampered-content"
  seed_file "${LIVE}" "hooks/a.sh" "live-unchanged"
  # manifest hash describes a DIFFERENT content than the new-release file
  seed_file "${WORK}" "decoy" "expected-content"
  local good_hash
  good_hash="$(sha256_of "${WORK}/decoy")"
  jq -n --arg h "${good_hash}" \
    '{version:"1.0.0", files:["hooks/a.sh"], hashes:{"hooks/a.sh":$h}}' \
    >"${WORK}/manifest.json"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" | spine_stage_and_verify "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${WORKDIR}/staging"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"hash mismatch staging hooks/a.sh"* ]]
  # the live install was never read/written by staging
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "live-unchanged" ]]
}

@test "T11 stage: loud-fail when a staged source file is missing" {
  build_manifest "${WORK}/manifest.json" "${NEW}"
  jq -n '{version:"1.0.0", files:["hooks/ghost.sh"], hashes:{"hooks/ghost.sh":"deadbeef"}}' \
    >"${WORK}/manifest.json"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/ghost.sh" | spine_stage_and_verify "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${WORKDIR}/staging"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"staged source missing"* ]]
}

@test "T1 link: a link row whose target is NOT staged stages as a link and verifies" {
  # The manifest records the TARGET's content hash for a link row, and a link
  # preserved into staging is dangling there while its target stays out of the
  # change set — so the row can only verify at its release-tree position.
  seed_file "${NEW}" "agents/CHARTER.md" "charter-body"
  seed_link "${NEW}" "rules/glass-atrium/CHARTER.md" "../../agents/CHARTER.md"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "agents/CHARTER.md" "rules/glass-atrium/CHARTER.md"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "rules/glass-atrium/CHARTER.md" \
      | spine_stage_and_verify "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${WORKDIR}/staging"
  # One && chain: a bats verdict is its LAST command's status, so a mid-body
  # bracket would pass silently. The trailing member is the danglingness inside
  # the staging dir, which is why the hash is read at the source position.
  [[ "${status}" -eq 0 ]] \
    && [[ -L "${WORKDIR}/staging/rules/glass-atrium/CHARTER.md" ]] \
    && [[ "$(readlink "${WORKDIR}/staging/rules/glass-atrium/CHARTER.md")" == "../../agents/CHARTER.md" ]] \
    && [[ ! -e "${WORKDIR}/staging/rules/glass-atrium/CHARTER.md" ]]
}

@test "T1 link: a staging copy that FAILS on a link row loud-fails the stage" {
  # A link row is hash-verified at its release-tree position, so the hash cannot
  # see a staged link that never landed — the copy's own status is the only
  # signal, and the substitution below is a copy that fails on every row.
  # The call carries the production caller's `|| rc=$?` form, which suspends
  # errexit for the whole invocation: with the status unchecked the run reports
  # a clean stage and the swap then finds nothing to move.
  seed_file "${NEW}" "agents/CHARTER.md" "charter-body"
  seed_link "${NEW}" "rules/glass-atrium/CHARTER.md" "../../agents/CHARTER.md"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "agents/CHARTER.md" "rules/glass-atrium/CHARTER.md"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    spine_copy_entry() { return 1; }
    rc=0
    printf "%s\n" "rules/glass-atrium/CHARTER.md" \
      | spine_stage_and_verify "$1" "$2" "$3" || rc=$?
    exit "${rc}"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${WORKDIR}/staging"
  # One && chain: a bats verdict is its LAST command's status, so a mid-body
  # bracket would pass silently.
  [[ "${status}" -eq 1 ]] \
    && [[ "${output}" == *"staging copy failed"* ]] \
    && [[ ! -L "${WORKDIR}/staging/rules/glass-atrium/CHARTER.md" ]]
}

@test "T1 link: with the link-preserving copy reverted the same fixture stages a REGULAR file" {
  # The load-bearing check for the staging branch: substituting the pre-T1
  # dereferencing copy on the identical fixture reproduces the loss, so the
  # branch is what preserves the link rather than the fixture being trivial.
  seed_file "${NEW}" "agents/CHARTER.md" "charter-body"
  seed_link "${NEW}" "rules/glass-atrium/CHARTER.md" "../../agents/CHARTER.md"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "agents/CHARTER.md" "rules/glass-atrium/CHARTER.md"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    spine_copy_entry() { cp -p -- "$1" "$2"; }
    printf "%s\n" "rules/glass-atrium/CHARTER.md" \
      | spine_stage_and_verify "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${WORKDIR}/staging"
  [[ "${status}" -eq 0 ]] \
    && [[ ! -L "${WORKDIR}/staging/rules/glass-atrium/CHARTER.md" ]] \
    && [[ -f "${WORKDIR}/staging/rules/glass-atrium/CHARTER.md" ]] \
    && [[ "$(cat "${WORKDIR}/staging/rules/glass-atrium/CHARTER.md")" == "charter-body" ]]
}

# T11 — spine_commit_staged (swap success + rollback on failure)

@test "T11 commit: swaps staged files into the live install" {
  seed_file "${WORKDIR}/staging" "hooks/a.sh" "NEW-a"
  seed_file "${WORKDIR}/staging" "scripts/b.sh" "NEW-b"
  seed_file "${LIVE}" "hooks/a.sh" "OLD-a"
  # scripts/b.sh is a brand-new file (no live original)
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" "scripts/b.sh" \
      | spine_commit_staged "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${WORKDIR}/staging" "${LIVE}" "${WORKDIR}/snapshot"
  [[ "${status}" -eq 0 ]]
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "NEW-a" ]]
  [[ "$(cat "${LIVE}/scripts/b.sh")" == "NEW-b" ]]
}

@test "T11 commit: rolls back ALL on a mid-swap failure" {
  # Two files in sorted order: hooks/a.sh swaps first, then scripts/z.sh fails
  # (its staged source is intentionally absent), forcing rollback of hooks/a.sh.
  seed_file "${WORKDIR}/staging" "hooks/a.sh" "NEW-a"
  # scripts/z.sh staged source is MISSING → swap fails at the 2nd file
  seed_file "${LIVE}" "hooks/a.sh" "ORIGINAL-a"
  seed_file "${LIVE}" "scripts/z.sh" "ORIGINAL-z"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" "scripts/z.sh" \
      | spine_commit_staged "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${WORKDIR}/staging" "${LIVE}" "${WORKDIR}/snapshot"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"commit FAILED at scripts/z.sh"* ]]
  [[ "${output}" == *"rolling back"* ]]
  # hooks/a.sh restored to its pre-swap content
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "ORIGINAL-a" ]]
  # scripts/z.sh (never reached) untouched
  [[ "$(cat "${LIVE}/scripts/z.sh")" == "ORIGINAL-z" ]]
}

@test "T11 commit: rollback removes a newly created file (no snapshot)" {
  # first file is brand-new (gets created), second fails → rollback must DELETE
  # the new file rather than restore a non-existent snapshot.
  seed_file "${WORKDIR}/staging" "scripts/created.sh" "FRESH"
  # scripts/z.sh staged source missing → fails after created.sh was made
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "scripts/created.sh" "scripts/z.sh" \
      | spine_commit_staged "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${WORKDIR}/staging" "${LIVE}" "${WORKDIR}/snapshot"
  [[ "${status}" -eq 1 ]]
  [[ ! -e "${LIVE}/scripts/created.sh" ]]
}

@test "T1 link: a driven apply lands the live row as a link holding the release's target text" {
  seed_file "${NEW}" "agents/CHARTER.md" "charter-new"
  seed_link "${NEW}" "rules/glass-atrium/CHARTER.md" "../../agents/CHARTER.md"
  seed_file "${LIVE}" "agents/CHARTER.md" "charter-old"
  seed_link "${LIVE}" "rules/glass-atrium/CHARTER.md" "../../agents/OLD-CHARTER.md"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "agents/CHARTER.md" "rules/glass-atrium/CHARTER.md"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "rules/glass-atrium/CHARTER.md" \
      | spine_apply "$1" "$2" "$3" "$4"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${LIVE}" "${WORKDIR}"
  # the closing member: the row the link points at is a separate manifest row,
  # untouched by this change set
  [[ "${status}" -eq 0 ]] \
    && [[ -L "${LIVE}/rules/glass-atrium/CHARTER.md" ]] \
    && [[ "$(readlink "${LIVE}/rules/glass-atrium/CHARTER.md")" == "$(readlink "${NEW}/rules/glass-atrium/CHARTER.md")" ]] \
    && [[ "$(cat "${LIVE}/agents/CHARTER.md")" == "charter-old" ]]
}

@test "T1 link: an apply carrying BOTH the link row and its target row lands both" {
  seed_file "${NEW}" "agents/CHARTER.md" "charter-new"
  seed_link "${NEW}" "rules/glass-atrium/CHARTER.md" "../../agents/CHARTER.md"
  seed_file "${LIVE}" "agents/CHARTER.md" "charter-old"
  seed_link "${LIVE}" "rules/glass-atrium/CHARTER.md" "../../agents/OLD-CHARTER.md"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "agents/CHARTER.md" "rules/glass-atrium/CHARTER.md"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "agents/CHARTER.md" "rules/glass-atrium/CHARTER.md" \
      | spine_apply "$1" "$2" "$3" "$4"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${LIVE}" "${WORKDIR}"
  # the closing member: the two rows are one file again, so reading through the
  # link reaches the target's new content
  [[ "${status}" -eq 0 ]] \
    && [[ -L "${LIVE}/rules/glass-atrium/CHARTER.md" ]] \
    && [[ "$(readlink "${LIVE}/rules/glass-atrium/CHARTER.md")" == "../../agents/CHARTER.md" ]] \
    && [[ "$(cat "${LIVE}/agents/CHARTER.md")" == "charter-new" ]] \
    && [[ "$(cat "${LIVE}/rules/glass-atrium/CHARTER.md")" == "charter-new" ]]
}

# #10 / #11 — atomic swap + atomic rollback restore (sibling temp + rename(2))

@test "#10/#11 commit: swap replaces the live file via atomic rename (inode changes, no temp residue)" {
  # The crux of #10: overwriting an EXISTING live file (e.g. the running
  # update.sh) in place keeps the SAME inode, so a process reading that inode
  # can see a half-written tail. An atomic temp+rename gives the path a NEW
  # inode; the old inode is unlinked-but-open and reaches clean EOF.
  seed_file "${WORKDIR}/staging" "scripts/update.sh" "NEW-self-updated-body"
  seed_file "${LIVE}" "scripts/update.sh" "OLD-running-body"
  local before after
  before="$(inode_of "${LIVE}/scripts/update.sh")"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "scripts/update.sh" | spine_commit_staged "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${WORKDIR}/staging" "${LIVE}" "${WORKDIR}/snapshot"
  [[ "${status}" -eq 0 ]]
  [[ "$(cat "${LIVE}/scripts/update.sh")" == "NEW-self-updated-body" ]]
  after="$(inode_of "${LIVE}/scripts/update.sh")"
  # atomic rename => live path points at a fresh inode (in-place cp would keep it)
  [[ "${before}" != "${after}" ]]
  # no sibling temp leaked into the install dir
  run bash -c 'ls "$1"/scripts/*.tmp.* 2>/dev/null || true' _ "${LIVE}"
  [[ -z "${output}" ]]
}

@test "#11 rollback: in-isolation restore uses atomic rename (inode changes, content restored, no temp residue)" {
  # spine_rollback restoring a snapshot must NOT cp in place (a crash mid-copy
  # truncates the live target). Atomic temp+rename => the restored path gets a
  # fresh inode and the snapshot content lands intact.
  seed_file "${WORKDIR}/snapshot" "hooks/a.sh" "SNAP-pre-swap-body"
  seed_file "${LIVE}" "hooks/a.sh" "LIVE-corrupted-body"
  local before after
  before="$(inode_of "${LIVE}/hooks/a.sh")"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    spine_rollback "$1" "$2" "hooks/a.sh"
  ' _ "${REAL_LIB}" "${LIVE}" "${WORKDIR}/snapshot"
  [[ "${status}" -eq 0 ]]
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "SNAP-pre-swap-body" ]]
  after="$(inode_of "${LIVE}/hooks/a.sh")"
  [[ "${before}" != "${after}" ]]
  run bash -c 'ls "$1"/hooks/*.tmp.* 2>/dev/null || true' _ "${LIVE}"
  [[ -z "${output}" ]]
}

@test "#11 commit: rollback via atomic restore recovers pre-swap content after a mid-swap failure" {
  # Same shape as the existing rollback test, but asserts the atomic-restore
  # path end-to-end: hooks/a.sh swaps (atomic), scripts/z.sh's staged source is
  # missing → rollback atomically restores hooks/a.sh from its snapshot.
  seed_file "${WORKDIR}/staging" "hooks/a.sh" "NEW-a"
  seed_file "${LIVE}" "hooks/a.sh" "ORIGINAL-a"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" "scripts/z.sh" \
      | spine_commit_staged "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${WORKDIR}/staging" "${LIVE}" "${WORKDIR}/snapshot"
  [[ "${status}" -eq 1 ]]
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "ORIGINAL-a" ]]
  # rollback left no sibling temp behind in the install dir
  run bash -c 'ls "$1"/hooks/*.tmp.* 2>/dev/null || true' _ "${LIVE}"
  [[ -z "${output}" ]]
}

@test "T1 link rollback: a failure AFTER the link row swapped restores it as a LINK with its original target" {
  # The failure path reaches the same destruction as the success path: without a
  # link-preserving snapshot the restore writes a regular file holding the OLD
  # target's bytes over the link position.
  seed_file "${LIVE}" "agents/CHARTER.md" "charter-live"
  seed_link "${LIVE}" "rules/glass-atrium/CHARTER.md" "../../agents/CHARTER.md"
  seed_link "${WORKDIR}/staging" "rules/glass-atrium/CHARTER.md" "../../agents/NEW-CHARTER.md"
  # scripts/z.sh has no staged source → the commit fails on the row AFTER the link
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "rules/glass-atrium/CHARTER.md" "scripts/z.sh" \
      | spine_commit_staged "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${WORKDIR}/staging" "${LIVE}" "${WORKDIR}/snapshot"
  # the failure-row member is load-bearing: it pins that the link row swapped
  # and the run then failed on a LATER row, which is what reaches the rollback
  [[ "${status}" -eq 1 ]] \
    && [[ "${output}" == *"commit FAILED at scripts/z.sh"* ]] \
    && [[ -L "${LIVE}/rules/glass-atrium/CHARTER.md" ]] \
    && [[ "$(readlink "${LIVE}/rules/glass-atrium/CHARTER.md")" == "../../agents/CHARTER.md" ]]
}

@test "T1 link rollback: the same forced failure leaves the live link row PRESENT" {
  # Separate guard on the remove-if-no-snapshot default: the snapshot entry for a
  # link row is itself dangling inside the snapshot dir, and a dereferencing
  # snapshot test reads it as absent and DELETES the live row. This fixture's
  # live link points outside the install root, so -e is false for it and only
  # link-ness can witness that the row survived at all.
  seed_link "${LIVE}" "rules/glass-atrium/CHARTER.md" "../../agents/ABSENT-CHARTER.md"
  seed_link "${WORKDIR}/staging" "rules/glass-atrium/CHARTER.md" "../../agents/NEW-CHARTER.md"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "rules/glass-atrium/CHARTER.md" "scripts/z.sh" \
      | spine_commit_staged "$1" "$2" "$3"
  ' _ "${REAL_LIB}" "${WORKDIR}/staging" "${LIVE}" "${WORKDIR}/snapshot"
  [[ "${status}" -eq 1 ]] \
    && [[ "${output}" == *"commit FAILED at scripts/z.sh"* ]] \
    && [[ ! -e "${LIVE}/rules/glass-atrium/CHARTER.md" ]] \
    && [[ -L "${LIVE}/rules/glass-atrium/CHARTER.md" ]] \
    && [[ "$(readlink "${LIVE}/rules/glass-atrium/CHARTER.md")" == "../../agents/ABSENT-CHARTER.md" ]]
}

# T11 — spine_apply (full transaction)

@test "T11 apply: verify-then-commit applies the whole change set" {
  seed_file "${NEW}" "hooks/a.sh" "applied-a"
  seed_file "${NEW}" "scripts/b.sh" "applied-b"
  seed_file "${LIVE}" "hooks/a.sh" "old-a"
  build_manifest "${WORK}/manifest.json" "${NEW}" "hooks/a.sh" "scripts/b.sh"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" "scripts/b.sh" \
      | spine_apply "$1" "$2" "$3" "$4"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${LIVE}" "${WORKDIR}"
  [[ "${status}" -eq 0 ]]
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "applied-a" ]]
  [[ "$(cat "${LIVE}/scripts/b.sh")" == "applied-b" ]]
}

@test "T11 apply: a verify failure aborts before the install is touched" {
  seed_file "${NEW}" "hooks/a.sh" "tampered"
  seed_file "${LIVE}" "hooks/a.sh" "live-original"
  # manifest hash does NOT match the new-release file content
  jq -n '{version:"1.0.0", files:["hooks/a.sh"],
          hashes:{"hooks/a.sh":"0000000000000000000000000000000000000000000000000000000000000000"}}' \
    >"${WORK}/manifest.json"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" | spine_apply "$1" "$2" "$3" "$4"
  ' _ "${REAL_LIB}" "${NEW}" "${WORK}/manifest.json" "${LIVE}" "${WORKDIR}"
  [[ "${status}" -eq 1 ]]
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "live-original" ]]
}

# T14 — baseline capture + read

@test "T14: capture stores the manifest and read returns its path" {
  build_manifest "${WORK}/manifest.json" "${NEW}"
  jq -n '{version:"1.0.0", files:[], hashes:{}}' >"${WORK}/manifest.json"
  run spine spine_set_baseline "${WORK}/manifest.json"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "${STATE}/baseline-manifest.json" ]]
  [[ -f "${STATE}/baseline-manifest.json" ]]
  # stored copy is byte-identical to the applied manifest
  [[ "$(sha256_of "${STATE}/baseline-manifest.json")" == "$(sha256_of "${WORK}/manifest.json")" ]]
  # read returns the path and rc 0
  run spine spine_get_baseline
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "${STATE}/baseline-manifest.json" ]]
}

@test "T14: read returns rc 1 when no baseline has been captured (get contract)" {
  run spine spine_get_baseline
  [[ "${status}" -eq 1 ]]
  [[ -z "${output}" ]]
}

@test "T14: capture loud-fails when the source manifest is missing" {
  run spine spine_set_baseline "${WORK}/does-not-exist.json"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"baseline source manifest missing"* ]]
}

@test "T14: an explicit state-dir argument overrides the env default" {
  local alt="${WORK}/alt-state"
  jq -n '{version:"1.0.0", files:[], hashes:{}}' >"${WORK}/manifest.json"
  run spine spine_set_baseline "${WORK}/manifest.json" "${alt}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "${alt}/baseline-manifest.json" ]]
  run spine spine_get_baseline "${alt}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "${alt}/baseline-manifest.json" ]]
}

# === T6 — jq-less manifest parse fallback (install.sh bootstrap surface) =====
# spine_stage_and_verify + spine_get_manifest_hash must work with jq HIDDEN
# (runnable-python3 fallback): install.sh sources this lib from the fresh bundle
# BEFORE ga-deps can ever install jq. jq is hidden via an allowlisted TOOLBIN of
# symlinks (the run's ONLY PATH entry) — never by touching the live system.

# Build the jq-less TOOLBIN. The python3 symlink resolves OFF /usr/bin, so the
# probe's Apple-shim CLT gate stays out of the way and the REAL python3 backs
# the hash lookups. bash is listed for #!/usr/bin/env bash shebang resolution.
t6_build_jqless_toolbin() {
  JQLESS_BIN="${WORK}/jqless-bin"
  mkdir -p "${JQLESS_BIN}"
  local t src
  for t in bash cat cp mkdir dirname shasum python3; do
    src="$(command -v "${t}")" || return 1
    ln -s "${src}" "${JQLESS_BIN}/${t}"
  done
}

@test "T6: jq-hidden end-to-end — spine_stage_and_verify verifies via the python3 fallback" {
  seed_file "${NEW}" "scripts/tool.sh" "tool content"
  seed_file "${NEW}" "hooks/h.sh" "hook content"
  build_manifest "${WORK}/manifest.json" "${NEW}" "scripts/tool.sh" "hooks/h.sh"
  t6_build_jqless_toolbin || return 1
  run env PATH="${JQLESS_BIN}" /bin/bash -c "
    set -Eeuo pipefail
    source '${REAL_LIB}'
    command -v jq >/dev/null 2>&1 && { echo 'jq NOT hidden'; exit 90; }
    printf '%s\n' 'scripts/tool.sh' 'hooks/h.sh' \
      | spine_stage_and_verify '${NEW}' '${WORK}/manifest.json' '${WORK}/staging'
  "
  [[ "${status}" -eq 0 ]]
  [[ -f "${WORK}/staging/scripts/tool.sh" ]]
  [[ -f "${WORK}/staging/hooks/h.sh" ]]
  [[ "$(sha256_of "${WORK}/staging/scripts/tool.sh")" == "$(sha256_of "${NEW}/scripts/tool.sh")" ]]
}

@test "T6: jq-hidden verify still LOUD-FAILS on a hash mismatch (fallback is no weaker)" {
  seed_file "${NEW}" "scripts/tool.sh" "original"
  build_manifest "${WORK}/manifest.json" "${NEW}" "scripts/tool.sh"
  printf 'tampered' >"${NEW}/scripts/tool.sh"
  t6_build_jqless_toolbin || return 1
  run env PATH="${JQLESS_BIN}" /bin/bash -c "
    set -Eeuo pipefail
    source '${REAL_LIB}'
    printf '%s\n' 'scripts/tool.sh' \
      | spine_stage_and_verify '${NEW}' '${WORK}/manifest.json' '${WORK}/staging'
  "
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"hash mismatch"* ]]
}

@test "T6: jq-hidden spine_get_manifest_hash parity — recorded hash echoed, unknown path empty" {
  seed_file "${NEW}" "scripts/tool.sh" "tool content"
  build_manifest "${WORK}/manifest.json" "${NEW}" "scripts/tool.sh"
  want="$(sha256_of "${NEW}/scripts/tool.sh")"
  t6_build_jqless_toolbin || return 1
  run env PATH="${JQLESS_BIN}" /bin/bash -c "
    set -Eeuo pipefail
    source '${REAL_LIB}'
    spine_get_manifest_hash '${WORK}/manifest.json' 'scripts/tool.sh'
  "
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "${want}" ]]
  # unknown path → empty output, rc 0 (the `.hashes[$p] // empty` contract)
  run env PATH="${JQLESS_BIN}" /bin/bash -c "
    set -Eeuo pipefail
    source '${REAL_LIB}'
    spine_get_manifest_hash '${WORK}/manifest.json' 'no/such/path'
  "
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}

@test "T6: neither jq nor python3 → spine_stage_and_verify loud-fails naming both parsers" {
  seed_file "${NEW}" "scripts/tool.sh" "tool content"
  build_manifest "${WORK}/manifest.json" "${NEW}" "scripts/tool.sh"
  BARE_BIN="${WORK}/bare-bin"
  mkdir -p "${BARE_BIN}"
  local t
  for t in bash cat cp mkdir dirname shasum; do
    ln -s "$(command -v "${t}")" "${BARE_BIN}/${t}"
  done
  run env PATH="${BARE_BIN}" /bin/bash -c "
    set -Eeuo pipefail
    source '${REAL_LIB}'
    printf '%s\n' 'scripts/tool.sh' \
      | spine_stage_and_verify '${NEW}' '${WORK}/manifest.json' '${WORK}/staging'
  "
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"no JSON parser (jq or runnable python3)"* ]]
}

# === T4b — Tier-C negative guard ============================================
# The domain-data-separation seam moved the Tier-A daemon reports to
# ${GA_DATA_ROOT:-~/.glass-atrium}/data, but spine_baseline_dir (Tier C) must
# STILL default under ~/.claude — the updater consumes its own baseline during
# the very update that would relocate it, so it is deliberately left behind. This
# is a regression guard: it PASSES both before and after the seam conversion.

@test "T4b Tier-C guard: spine_baseline_dir with no override STILL resolves ~/.claude/data/update" {
  # setup() exports ATRIUM_UPDATE_STATE_DIR; strip it AND GA_DATA_ROOT so the bare
  # default surfaces — proving the seam did NOT drag Tier C to ~/.glass-atrium.
  run env -u ATRIUM_UPDATE_STATE_DIR -u GA_DATA_ROOT bash -c '
    set -Eeuo pipefail
    source "$1"
    spine_baseline_dir
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "${HOME}/.claude/data/update" ]]
  [[ "${output}" != *".glass-atrium"* ]]
}

@test "T4b Tier-C guard: ATRIUM_UPDATE_STATE_DIR override still wins unchanged" {
  run env -u GA_DATA_ROOT ATRIUM_UPDATE_STATE_DIR="/tmp/custom-update-state" bash -c '
    set -Eeuo pipefail
    source "$1"
    spine_baseline_dir
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "/tmp/custom-update-state" ]]
}
