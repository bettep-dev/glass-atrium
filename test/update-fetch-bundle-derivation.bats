#!/usr/bin/env bats
# update-fetch-bundle-derivation.bats — red-team #17 residual item 5.
#
# DEFECT (confirmed by code-trace): update_fetch_release resolved the downloaded bundle via
# `find … -name 'glass-atrium-bundle-*.tar.gz' -print -quit`, SILENTLY taking the FIRST match
# and deriving no expected name from the release manifest. Two failure modes: a MULTIPLE-match
# release (ambiguous — silently picked one) and a version-mismatched bundle went unnoticed.
# FIX: derive the EXPECTED name from the downloaded manifest's .version, collect EVERY candidate,
# and loud-fail with the named exit code 14 on zero OR >1 matches, and assert the single match
# equals the expected name.
#
# STRATEGY: source update.sh (BASH_SOURCE!=$0 → update_main skipped) and override `gh` as a
# shell function that materializes the requested assets (a manifest.json with a chosen .version
# + N bundle files) into --dir. ATRIUM_RELEASE_REPO is set so update_release_slug never needs the
# lazily-sourced atrium-config.sh lib. Real `tar` extracts the happy-path bundle. No real gh /
# GitHub, no ~/.claude or ~/.glass-atrium mutation.
#
# The pass-after cases below pin the fixed behavior directly (zero / one / multiple / mismatch /
# no-version), so the MULTIPLE-bundle → exit 14 case covers the original ambiguity defect.
#
# Every assertion is gated `|| return 1`.
#
# Run via: bats test/update-fetch-bundle-derivation.bats
# Requires: bats 1.5+, jq, tar, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
UPDATE="${GA}/scripts/update.sh"

setup() {
  [[ -f "${UPDATE}" ]] || skip "update.sh not found: ${UPDATE}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v tar >/dev/null 2>&1 || skip "tar required"
  SANDBOX="$(mktemp -d -t ga-fetch-derive.XXXXXX)"
  DL="${SANDBOX}/dl"
  NEW="${SANDBOX}/new"
  DRIVER="${SANDBOX}/driver.sh"

  # gh stub: on `release download --dir <dir>` it writes manifest.json (version from
  # GH_MANIFEST_VERSION, or a version-less {} when GH_NOVERSION set) + one real tiny tar.gz
  # per name in GH_BUNDLES. `for tok in "$@"` is IFS-immune; the bundle split pins IFS to space
  # (update.sh sets IFS=$'\n\t').
  cat >"${DRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck disable=SC1090,SC2317,SC2086
set -Eeuo pipefail
unset ATRIUM_UPDATE_SRC_DIR ATRIUM_UPDATE_SRC_MANIFEST
source "$1"
gh() {
  local dir="" want=0 tok
  for tok in "$@"; do
    if [[ "${want}" -eq 1 ]]; then
      dir="${tok}"
      want=0
      continue
    fi
    [[ "${tok}" == "--dir" ]] && want=1
  done
  [[ -n "${dir}" ]] || return 3
  mkdir -p -- "${dir}"
  if [[ -n "${GH_NOVERSION:-}" ]]; then
    printf '%s\n' '{}' >"${dir}/manifest.json"
  else
    printf '{"version":"%s"}\n' "${GH_MANIFEST_VERSION:-1.0.1}" >"${dir}/manifest.json"
  fi
  local name IFS=' '
  for name in ${GH_BUNDLES:-}; do
    tar -czf "${dir}/${name}" -C "${dir}" manifest.json
  done
  return 0
}
update_fetch_release "$2" "$3"
echo "FETCH_OK"
DRV
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

drive_fetch() {
  # $1 = update.sh path to source; env toggles set by caller
  run env GA_ROOT="${SANDBOX}" ATRIUM_RELEASE_REPO="owner/repo" "$@" \
    bash "${DRIVER}" "${SRC:-${UPDATE}}" "${DL}" "${NEW}"
}

# === PASS-AFTER — the fixed update_fetch_release ============================================

@test "item5 pass-after: exactly one matching bundle → exit 0, extracted into new_dir" {
  drive_fetch GH_MANIFEST_VERSION=1.0.1 GH_BUNDLES='glass-atrium-bundle-1.0.1.tar.gz'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"FETCH_OK"* ]] || return 1
  [[ -f "${NEW}/manifest.json" ]] || return 1
}

@test "item5 pass-after: ZERO matching bundles → loud exit 14" {
  drive_fetch GH_MANIFEST_VERSION=1.0.1 GH_BUNDLES=''
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"no release bundle asset matched"* ]] || return 1
  [[ "${output}" != *"FETCH_OK"* ]] || return 1
}

@test "item5 pass-after: MULTIPLE matching bundles → loud exit 14 (refuses to guess)" {
  drive_fetch GH_MANIFEST_VERSION=1.0.1 \
    GH_BUNDLES='glass-atrium-bundle-1.0.1.tar.gz glass-atrium-bundle-9.9.9.tar.gz'
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"ambiguous release"* ]] || return 1
  [[ "${output}" != *"FETCH_OK"* ]] || return 1
}

@test "item5 pass-after: a single bundle whose version MISMATCHES the manifest → loud exit 14" {
  drive_fetch GH_MANIFEST_VERSION=1.0.1 GH_BUNDLES='glass-atrium-bundle-2.0.0.tar.gz'
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"does not match the manifest version bundle"* ]] || return 1
}

@test "item5 pass-after: a manifest with no .version → loud exit 14" {
  drive_fetch GH_NOVERSION=1 GH_BUNDLES='glass-atrium-bundle-1.0.1.tar.gz'
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"carries no .version"* ]] || return 1
}
