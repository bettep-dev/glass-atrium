#!/usr/bin/env bats
# update-fetch-bundle-derivation.bats — update_fetch_release fixed-URL curl fetch
# (T6 pre-bundle de-dependency) + manifest-first bundle-name derivation.
#
# CONTRACT UNDER TEST: update_fetch_release fetches WITHOUT gh (no auth wall) via
# unauthenticated curl against the two fixed GitHub release-asset URL forms,
# MANIFEST-FIRST (curl cannot glob an asset name):
#   1. latest-form  — releases/latest/download/manifest.json
#   2. parse .version → derive glass-atrium-bundle-<version>.tar.gz
#   3. tag-form     — releases/download/v<version>/<bundle> (publish-release's
#      v<manifest.version> tag contract; closes the two-request "latest" race)
# -f is load-bearing (plain curl exits 0 on a 404 HTML body); an HTTP-layer
# failure on either asset is a loud named exit 14 carrying the failing URL, and a
# manifest with no .version is exit 14 (no bundle name derivable). The former
# find-glob zero/ambiguous/mismatch branches are structurally dead (the bundle is
# downloaded to its derived name — nothing to guess at) and intentionally unpinned.
#
# STRATEGY: source update.sh (BASH_SOURCE!=$0 → update_main skipped) and drive
# update_fetch_release with a PATH-STUB curl (NOT the local-tree seam — the seam
# covers apply acceptance only; fetch coverage must exercise the URL builder).
# The stub logs every argv + URL, then materializes the asset keyed on the URL
# form: manifest.json (version from CURL_MANIFEST_VERSION, or {} when
# CURL_NOVERSION) or a real tiny tar.gz bundle. ATRIUM_RELEASE_REPO is set so
# update_release_slug never needs the lazily-sourced atrium-config.sh lib. Real
# `tar` extracts the happy-path bundle. No network, no ~/.claude or
# ~/.glass-atrium mutation.
#
# Every assertion is gated `|| return 1`.
#
# Run via: bats test/update-fetch-bundle-derivation.bats
# Requires: bats 1.5+, tar, bash 3.2+
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
UPDATE="${GA}/scripts/update.sh"

setup() {
  [[ -f "${UPDATE}" ]] || skip "update.sh not found: ${UPDATE}"
  command -v tar >/dev/null 2>&1 || skip "tar required"
  SANDBOX="$(mktemp -d -t ga-fetch-derive.XXXXXX)"
  DL="${SANDBOX}/dl"
  NEW="${SANDBOX}/new"
  DRIVER="${SANDBOX}/driver.sh"
  STUB_BIN="${SANDBOX}/bin"
  URL_LOG="${SANDBOX}/curl-url.log"
  ARGV_LOG="${SANDBOX}/curl-argv.log"
  mkdir -p "${STUB_BIN}"

  # PATH-stub curl: record argv + URL, then materialize the requested asset at the
  # -o path. Failure toggles (CURL_FAIL_MANIFEST / CURL_FAIL_BUNDLE) return curl's
  # HTTP-error rc 22, exercising the -f fail-on-HTTP-error contract. The bundle
  # branch tars the ALREADY-DOWNLOADED manifest.json from the same dl dir — the
  # stub itself depends on the manifest-first order it pins.
  cat >"${STUB_BIN}/curl" <<STUB
#!/usr/bin/env bash
set -Eeuo pipefail
out="" url="" prev=""
for tok in "\$@"; do
  [[ "\${prev}" == "-o" ]] && out="\${tok}"
  prev="\${tok}"
  url="\${tok}"
done
printf '%s\n' "\$*" >>"${ARGV_LOG}"
printf '%s\n' "\${url}" >>"${URL_LOG}"
case "\${url}" in
  */manifest.json)
    [[ -n "\${CURL_FAIL_MANIFEST:-}" ]] && exit 22
    if [[ -n "\${CURL_NOVERSION:-}" ]]; then
      printf '%s\n' '{}' >"\${out}"
    else
      printf '{"version":"%s"}\n' "\${CURL_MANIFEST_VERSION:-1.0.1}" >"\${out}"
    fi
    ;;
  *.tar.gz)
    [[ -n "\${CURL_FAIL_BUNDLE:-}" ]] && exit 22
    tar -czf "\${out}" -C "\$(dirname -- "\${out}")" manifest.json
    ;;
  *) exit 9 ;;
esac
STUB
  chmod +x "${STUB_BIN}/curl"

  cat >"${DRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck disable=SC1090
set -Eeuo pipefail
unset ATRIUM_UPDATE_SRC_DIR ATRIUM_UPDATE_SRC_MANIFEST
source "$1"
update_fetch_release "$2" "$3"
echo "FETCH_OK"
DRV
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

drive_fetch() {
  # env toggles set by caller; the stub curl wins PATH resolution.
  run env PATH="${STUB_BIN}:${PATH}" GA_ROOT="${SANDBOX}" ATRIUM_RELEASE_REPO="owner/repo" "$@" \
    bash "${DRIVER}" "${UPDATE}" "${DL}" "${NEW}"
}

# === happy path — both URL forms + manifest-first derivation ================================

@test "fetch: happy path → exit 0, bundle extracted into new_dir (no gh anywhere)" {
  drive_fetch CURL_MANIFEST_VERSION=1.0.1
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"FETCH_OK"* ]] || return 1
  [[ -f "${NEW}/manifest.json" ]] || return 1
}

@test "fetch: manifest via the latest-form URL, bundle via the v<version> tag-form URL (manifest-first)" {
  drive_fetch CURL_MANIFEST_VERSION=1.0.1
  [[ "${status}" -eq 0 ]] || return 1
  # exactly two requests, in manifest→bundle order (the derivation NEEDS the manifest first).
  [[ "$(wc -l <"${URL_LOG}" | tr -d ' ')" -eq 2 ]] || return 1
  [[ "$(sed -n 1p "${URL_LOG}")" == "https://github.com/owner/repo/releases/latest/download/manifest.json" ]] || return 1
  [[ "$(sed -n 2p "${URL_LOG}")" == "https://github.com/owner/repo/releases/download/v1.0.1/glass-atrium-bundle-1.0.1.tar.gz" ]] || return 1
}

@test "fetch: curl is invoked fail-on-HTTP-error with bounded retries (-fSL --retry 3)" {
  drive_fetch CURL_MANIFEST_VERSION=1.0.1
  [[ "${status}" -eq 0 ]] || return 1
  # every request carries the flags (-f = 404 body can never poison the download).
  run grep -cE -- '-fSL --retry 3' "${ARGV_LOG}"
  [[ "${output}" == "2" ]] || return 1
}

# === HTTP-layer failures → loud named exit 14 with the failing URL ==========================

@test "fetch: manifest download HTTP failure → exit 14 naming the latest-form URL" {
  drive_fetch CURL_FAIL_MANIFEST=1
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"manifest download failed: https://github.com/owner/repo/releases/latest/download/manifest.json"* ]] || return 1
  [[ "${output}" != *"FETCH_OK"* ]] || return 1
}

@test "fetch: bundle download HTTP failure → exit 14 naming the tag-form URL" {
  drive_fetch CURL_MANIFEST_VERSION=1.0.1 CURL_FAIL_BUNDLE=1
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"bundle download failed: https://github.com/owner/repo/releases/download/v1.0.1/glass-atrium-bundle-1.0.1.tar.gz"* ]] || return 1
  [[ "${output}" != *"FETCH_OK"* ]] || return 1
}

# === derivation guard — a version-less manifest cannot name a bundle ========================

@test "fetch: a manifest with no .version → loud exit 14 (no bundle name derivable)" {
  drive_fetch CURL_NOVERSION=1
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"carries no .version"* ]] || return 1
  # failed BEFORE any bundle request — the manifest-first order is load-bearing.
  [[ "$(wc -l <"${URL_LOG}" | tr -d ' ')" -eq 1 ]] || return 1
}
