#!/usr/bin/env bats
# apply-spine.sh suite — pins the E3 safe-apply spine library contract:
#   T13  spine_find_changed_files — hash-diff change selection, with the
#        agents/**/*.md + *.local.md + config.toml exclusions, and the
#        missing-locally → changed rule
#   T11  spine_stage_and_verify  — stage + per-file SHA-256 verify; loud-fail
#        on a hash mismatch with ZERO install mutation
#        spine_commit_staged     — snapshot + swap success, and rollback to the
#        pre-swap state on a mid-swap failure (existing files restored, newly
#        created files removed)
#        spine_apply             — full verify-then-commit transaction
#   T14  spine_set_baseline / spine_get_baseline — capture + read the
#        base@install anchor (absence → rc 1, the `get` contract)
#
# Run via: bats scripts/test/apply-spine.bats
# Requires: bats >= 1.5.0, jq, shasum (or sha256sum)
#
# Hermetic strategy: every test operates inside a per-test mktemp sandbox; the
# baseline state dir is pinned to the sandbox via ATRIUM_UPDATE_STATE_DIR so the
# live ~/.claude/data/update tree is NEVER touched. The lib is sourced under
# full `set -Eeuo pipefail` to prove its functions are strict-mode-safe.

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

# --- helpers ---------------------------------------------------------------

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Write file $2 (relative) with content $3 under root $1, creating parent dirs.
seed_file() {
  local root="$1" rel="$2" content="$3"
  mkdir -p -- "$(dirname -- "${root}/${rel}")"
  printf '%s' "${content}" >"${root}/${rel}"
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

# ===========================================================================
# T13 — spine_find_changed_files
# ===========================================================================

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

@test "T13: agents/**/*.md is EXCLUDED even when changed (E4 merge path)" {
  seed_file "${NEW}" "agents/dev-shell.md" "vendor-new-body"
  seed_file "${LIVE}" "agents/dev-shell.md" "local-learned-body"
  seed_file "${NEW}" "agents/sub/nested.md" "vendor-nested"
  seed_file "${LIVE}" "agents/sub/nested.md" "local-nested"
  seed_file "${NEW}" "hooks/a.sh" "new"
  seed_file "${LIVE}" "hooks/a.sh" "old"
  build_manifest "${WORK}/manifest.json" "${NEW}" \
    "agents/dev-shell.md" "agents/sub/nested.md" "hooks/a.sh"
  run spine spine_find_changed_files "${WORK}/manifest.json" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "hooks/a.sh" ]]
  [[ "${output}" != *"agents/"* ]]
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

# ===========================================================================
# T11 — spine_stage_and_verify
# ===========================================================================

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

# ===========================================================================
# T11 — spine_commit_staged (swap success + rollback on failure)
# ===========================================================================

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

# ===========================================================================
# T11 — spine_apply (full transaction)
# ===========================================================================

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

# ===========================================================================
# T14 — baseline capture + read
# ===========================================================================

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
