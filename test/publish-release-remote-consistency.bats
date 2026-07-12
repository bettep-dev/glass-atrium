#!/usr/bin/env bats
# publish-release-remote-consistency.bats — red-team #17 residual items 3 & 4.
#
# ITEM 3 — remote-tag consistency gate (verify_publish_consistency, gate 3): if the
# release tag ALREADY exists on the remote, its peeled commit MUST equal the verified
# local HEAD (== the clean-tree, tarred bytes). A re-publish must never point a moved
# remote tag at a DIFFERENT commit than the assets it ships. Tag absent (first publish)
# or no remote configured → gate is a no-op. Fail-closed exit 7 on mismatch.
#   FAIL-BEFORE: pre-fix the function had gates 1+2 ONLY (no remote comparison), so a
#   moved remote tag PASSED. We reproduce that behavior with the REAL new code by
#   disengaging the gate (no remote configured) → the SAME mismatch passes; engaging it
#   (remote present) → exit 7. The gate is the discriminator.
#
# ITEM 4 — --replace-assets re-publish safety (replace_release_assets): the silent
# rollback closed = a delete-then-upload whose delete succeeds + upload fails leaves the
# release asset-less. The hardened path (a) requires the release to already exist, (b)
# uploads-then-swaps (stages the new bundle under a temp .swap name FIRST so a failed
# upload never touches the live bundle), (c) LOUD-fails (exit 8) on ANY re-upload failure,
# (d) POST-VERIFIES both canonical assets are present (exit 8 if not) before dropping temp.
#   FAIL-BEFORE: a bare `gh release upload --clobber` (the naive primitive the fix wraps)
#   returns 0 even when the release ends up WITHOUT its bundle — silent. replace_release_assets
#   exits 8 on the SAME stub.
#
# STRATEGY: publish-release.sh now carries a BASH_SOURCE==$0 source-guard, so a driver
# SOURCES it (main skipped) and overrides `git` / `gh` as shell functions to drive the
# pure gate logic. No real git remote, no real gh, no `gh release` against any remote.
#
# Every assertion is gated `|| return 1` (this bats fails only on the LAST command's status).
#
# Run via: bats test/publish-release-remote-consistency.bats
# Requires: bats 1.5+, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
PUB="${GA}/scripts/publish-release.sh"

setup() {
  [[ -f "${PUB}" ]] || skip "publish-release.sh not found: ${PUB}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  SANDBOX="$(mktemp -d -t ga-pub-consistency.XXXXXX)"
  OUT="${SANDBOX}/out"
  mkdir -p "${OUT}"
  # canonical staged assets the replace path copies + uploads (item 4)
  : >"${OUT}/manifest.json"
  : >"${OUT}/glass-atrium-bundle-1.0.1.tar.gz"

  # --- item 3 driver: source PUB, stub git, drive verify_publish_consistency ---
  CDRIVER="${SANDBOX}/consistency-driver.sh"
  cat >"${CDRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck disable=SC1090,SC2317
source "$1"
git() {
  # publish-release.sh sets IFS=$'\n\t', so "$*" would join args with newlines and break
  # the space-based glob patterns below — pin IFS to a space for the join.
  local IFS=' '
  local all="$*"
  case "${all}" in
  *"rev-parse --is-inside-work-tree"*) return 0 ;;
  *"diff --cached --quiet"*) return "${GIT_CACHED_DIRTY:-0}" ;;
  *"diff --quiet"*) return "${GIT_DIRTY:-0}" ;;
  *"rev-parse HEAD"*) printf '%s\n' "${GIT_HEAD:-HEADSHA}" ;;
  *"ls-remote --tags"*)
    if [[ "${GIT_LSREMOTE_RC:-0}" -ne 0 ]]; then return "${GIT_LSREMOTE_RC}"; fi
    printf '%b' "${GIT_LSREMOTE:-}"
    ;;
  *"remote"*) printf '%s\n' "${GIT_REMOTES-origin}" ;;
  *) : ;;
  esac
}
verify_publish_consistency "$2" "$3"
echo "GATE_OK"
DRV

  # --- item 4 driver: source PUB, stub gh, drive replace_release_assets ---
  RDRIVER="${SANDBOX}/replace-driver.sh"
  cat >"${RDRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck disable=SC1090,SC2317
source "$1"
gh() {
  # publish-release.sh sets IFS=$'\n\t'; pin IFS to a space so "$*" joins with spaces and
  # the glob patterns below match.
  local IFS=' '
  local all="$*"
  case "${all}" in
  *"release view"*"--json assets"*)
    if [[ "${GH_VIEWJSON_RC:-0}" -ne 0 ]]; then return "${GH_VIEWJSON_RC}"; fi
    printf '%b' "${GH_ASSETS:-}"
    ;;
  *"release view"*) return "${GH_VIEW_RC:-0}" ;;
  *"release upload"*".swap"*) return "${GH_STAGE_RC:-0}" ;;
  *"release upload"*) return "${GH_CANON_RC:-0}" ;;
  *"release delete-asset"*) return "${GH_DELASSET_RC:-0}" ;;
  *) return 0 ;;
  esac
}
replace_release_assets "v1.0.1" "owner/repo" "1.0.1" "$2" "$2/glass-atrium-bundle-1.0.1.tar.gz"
echo "REPLACE_OK"
DRV

  # --- item 4 fail-before driver: the naive `gh release upload --clobber` primitive ---
  NDRIVER="${SANDBOX}/naive-driver.sh"
  cat >"${NDRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck disable=SC2317
set -Eeuo pipefail
gh() { return "${GH_CANON_RC:-0}"; } # a 'successful' clobber that nonetheless left no bundle
gh release upload "v1.0.1" --repo "owner/repo" --clobber /x/manifest.json /x/bundle.tar.gz
echo "NAIVE_RC=$?"
DRV
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

drive_consistency() {
  run env GA_ROOT="${SANDBOX}" "$@" bash "${CDRIVER}" "${PUB}" "${TAG:-v1.0.1}" "${VERSION:-1.0.1}"
}

drive_replace() {
  run env GA_ROOT="${SANDBOX}" "$@" bash "${RDRIVER}" "${PUB}" "${OUT}"
}

# ==========================================================================================
# ITEM 3 — remote-tag consistency gate
# ==========================================================================================

@test "item3 pass-after: a remote tag pointing at a DIFFERENT commit than HEAD → exit 7" {
  drive_consistency GIT_HEAD=abc123 GIT_REMOTES=origin GIT_LSREMOTE='def456	refs/tags/v1.0.1'
  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"remote tag v1.0.1 points at def456"* ]] || return 1
  [[ "${output}" != *"GATE_OK"* ]] || return 1
}

@test "item3 fail-before: the SAME mismatch with the gate disengaged (no remote) PASSES" {
  # GIT_REMOTES='' (set-but-empty) → no remote → gate 3 no-op == pre-fix behavior (gates 1+2).
  drive_consistency GIT_HEAD=abc123 GIT_REMOTES= GIT_LSREMOTE='def456	refs/tags/v1.0.1'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"GATE_OK"* ]] || return 1
}

@test "item3: a remote tag matching HEAD (lightweight) PASSES" {
  drive_consistency GIT_HEAD=abc123 GIT_REMOTES=origin GIT_LSREMOTE='abc123	refs/tags/v1.0.1'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"GATE_OK"* ]] || return 1
}

@test "item3: an ABSENT remote tag (first publish) PASSES" {
  drive_consistency GIT_HEAD=abc123 GIT_REMOTES=origin GIT_LSREMOTE=
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"GATE_OK"* ]] || return 1
}

@test "item3: an ANNOTATED tag whose PEELED commit matches HEAD PASSES" {
  drive_consistency GIT_HEAD=abc123 GIT_REMOTES=origin \
    GIT_LSREMOTE='tagobj00	refs/tags/v1.0.1\nabc123	refs/tags/v1.0.1^{}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"GATE_OK"* ]] || return 1
}

@test "item3: an ANNOTATED tag whose PEELED commit MISMATCHES HEAD → exit 7" {
  drive_consistency GIT_HEAD=abc123 GIT_REMOTES=origin \
    GIT_LSREMOTE='tagobj00	refs/tags/v1.0.1\ndef456	refs/tags/v1.0.1^{}'
  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"points at def456"* ]] || return 1
}

@test "item3: an UNREACHABLE remote (ls-remote fails) warns + proceeds (not a mismatch)" {
  drive_consistency GIT_HEAD=abc123 GIT_REMOTES=origin GIT_LSREMOTE_RC=2
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"remote-tag consistency check SKIPPED"* ]] || return 1
  [[ "${output}" == *"GATE_OK"* ]] || return 1
}

@test "item3 regression: gate 1 (dirty tree) still fails BEFORE the remote gate → exit 7" {
  drive_consistency GIT_DIRTY=1 GIT_REMOTES=origin
  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"working tree dirty"* ]] || return 1
}

@test "item3 regression: gate 2 (tag != v<version>) still fails → exit 7" {
  TAG=vWRONG drive_consistency GIT_HEAD=abc123 GIT_REMOTES=origin
  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"vWRONG != v1.0.1"* ]] || return 1
}

# ==========================================================================================
# ITEM 4 — --replace-assets re-publish safety
# ==========================================================================================

@test "item4 pass-after: happy path (release exists, both uploads ok, both assets verified) → exit 0" {
  drive_replace GH_ASSETS='manifest.json\nglass-atrium-bundle-1.0.1.tar.gz'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"replaced assets on v1.0.1"* ]] || return 1
  [[ "${output}" == *"REPLACE_OK"* ]] || return 1
}

@test "item4 pass-after: release does NOT exist → LOUD exit 8 (can't replace a non-existent release)" {
  drive_replace GH_VIEW_RC=1
  [[ "${status}" -eq 8 ]] || return 1
  [[ "${output}" == *"not found"* ]] || return 1
  [[ "${output}" != *"REPLACE_OK"* ]] || return 1
}

@test "item4 pass-after: a failed STAGING upload → exit 8, live bundle untouched (no asset-less window)" {
  drive_replace GH_STAGE_RC=1
  [[ "${status}" -eq 8 ]] || return 1
  [[ "${output}" == *"LIVE bundle is untouched"* ]] || return 1
}

@test "item4 pass-after: a failed CANONICAL upload after staging → exit 8, new bytes preserved in .swap" {
  drive_replace GH_CANON_RC=1
  [[ "${status}" -eq 8 ]] || return 1
  [[ "${output}" == *"preserved as"* ]] || return 1
}

@test "item4 pass-after: POST-VERIFY catches a silent asset-less outcome (bundle missing) → exit 8" {
  # both uploads 'succeed' but the release ends up WITHOUT its bundle — the exact silent rollback.
  drive_replace GH_ASSETS='manifest.json'
  [[ "${status}" -eq 8 ]] || return 1
  [[ "${output}" == *"MISSING its bundle"* ]] || return 1
}

@test "item4 pass-after: POST-VERIFY catches a missing manifest.json → exit 8" {
  drive_replace GH_ASSETS='glass-atrium-bundle-1.0.1.tar.gz'
  [[ "${status}" -eq 8 ]] || return 1
  [[ "${output}" == *"MISSING manifest.json"* ]] || return 1
}

@test "item4 fail-before: the naive 'gh release upload --clobber' the fix replaces returns 0 (silent) even when no bundle lands" {
  run env GH_CANON_RC=0 bash "${SANDBOX}/naive-driver.sh"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"NAIVE_RC=0"* ]] || return 1
}
