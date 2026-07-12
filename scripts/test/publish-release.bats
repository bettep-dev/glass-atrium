#!/usr/bin/env bats
# publish-release.sh suite — pins the release-consistency gate (finding #17):
# cmd_publish MUST fail-closed (exit 7) before building the bundle when the local
# publish path is inconsistent, because build_assets tars the WORKING TREE — so the
# released bytes must already exist in a commit AND the release tag must equal
# v<manifest.version> (mirrors release.yml's tag-assert). Covered:
#   * clean tree + matching tag  -> dry-run succeeds (exit 0)
#   * dirty tree (unstaged)      -> exit 7 before any asset is built
#   * dirty tree (staged only)   -> exit 7
#   * --tag != v<version>        -> exit 7
#   * the existing generate-manifest --check gate is preserved (runs first)
# Hermetic: per-test standalone git repo under a pwd -P temp root, with COPIES of the
# real scripts at <sandbox>/scripts/ so their BASH_SOURCE-derived GA_ROOT resolves to
# the sandbox, never the live ~/.glass-atrium tree. A gh stub satisfies the publish
# preflight without touching the network (the gate fires before any gh invocation).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_PUBLISH="${GA}/scripts/publish-release.sh"
REAL_GENMAN="${GA}/scripts/generate-manifest.sh"
REAL_CONFIG="${GA}/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${REAL_PUBLISH}" ]] || skip "publish-release.sh not found: ${REAL_PUBLISH}"
  [[ -f "${REAL_GENMAN}" ]] || skip "generate-manifest.sh not found: ${REAL_GENMAN}"
  [[ -f "${REAL_CONFIG}" ]] || skip "atrium-config.sh not found: ${REAL_CONFIG}"

  # pwd -P resolves /var -> /private/var so GA_ROOT (pwd -P inside the script)
  # matches the paths the test computes.
  WORK="$(cd -- "$(mktemp -d -t pubrel-bats.XXXXXX)" && pwd -P)"
  SCRIPT="${WORK}/scripts/publish-release.sh"
  MANIFEST="${WORK}/manifest.json"
  OUT="${WORK}/relout"

  mkdir -p "${WORK}/scripts/lib" "${WORK}/agents"
  cp "${REAL_PUBLISH}" "${SCRIPT}"
  cp "${REAL_GENMAN}" "${WORK}/scripts/generate-manifest.sh"
  cp "${REAL_CONFIG}" "${WORK}/scripts/lib/atrium-config.sh"

  # An in-scope tracked file (feeds the manifest) + an out-of-scope tracked file
  # (root, absent from generate-manifest SCOPE_PATHS) used to dirty the tree
  # WITHOUT perturbing the --check gate.
  printf '# agent alpha\n' >"${WORK}/agents/alpha.md"
  printf 'release notes scratch\n' >"${WORK}/notes.txt"

  # Seed the minimal manifest carrying the _doc_settings_json key the generator
  # refuses to regenerate without (files/hashes start empty, then get stamped).
  printf '{"_doc_settings_json":"sandbox settings.json contract doc","files":[],"hashes":{}}\n' \
    >"${MANIFEST}"

  git -C "${WORK}" init -q
  git -C "${WORK}" config user.email bats@test.local
  git -C "${WORK}" config user.name bats
  git -C "${WORK}" add -A
  git -C "${WORK}" commit -qm init

  # Stamp a real manifest (version + files + per-file hashes), then commit it so
  # the tree is CLEAN and generate-manifest --check passes.
  run "${WORK}/scripts/generate-manifest.sh"
  [[ "${status}" -eq 0 ]] || {
    echo "manifest seed failed: ${output}" >&2
    return 1
  }
  git -C "${WORK}" add manifest.json
  git -C "${WORK}" commit -qm manifest

  MANIFEST_VERSION="$(jq -r '.version' "${MANIFEST}")"
  [[ -n "${MANIFEST_VERSION}" && "${MANIFEST_VERSION}" != "null" ]] || return 1

  # A no-op gh stub so `command -v gh` passes; the consistency gate fires before
  # any gh call, and dry-run never invokes gh — the stub is presence-only.
  STUBBIN="${WORK}/stubbin"
  mkdir -p "${STUBBIN}"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${STUBBIN}/gh"
  chmod +x "${STUBBIN}/gh"

  export PATH="${STUBBIN}:${PATH}"
  export ATRIUM_RELEASE_REPO="acme/atrium"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

@test "publish: clean tree + matching tag -> dry-run succeeds (exit 0)" {
  run "${SCRIPT}" publish --out "${OUT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"DRY RUN"* ]] || return 1
  # The staged bundle IS built on the happy path (gate passed).
  [[ -f "${OUT}/glass-atrium-bundle-${MANIFEST_VERSION}.tar.gz" ]] || return 1
}

@test "publish: dirty working tree (unstaged) -> consistency gate exit 7" {
  # Modify an out-of-scope tracked file so generate-manifest --check still passes
  # but the git work tree is dirty.
  printf 'uncommitted change\n' >>"${WORK}/notes.txt"

  run "${SCRIPT}" publish --out "${OUT}"
  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"working tree dirty"* ]] || return 1
  # Fail-closed BEFORE building any asset.
  [[ ! -e "${OUT}/glass-atrium-bundle-${MANIFEST_VERSION}.tar.gz" ]] || return 1
}

@test "publish: dirty working tree (staged only) -> consistency gate exit 7" {
  printf 'staged change\n' >>"${WORK}/notes.txt"
  git -C "${WORK}" add notes.txt

  run "${SCRIPT}" publish --out "${OUT}"
  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"working tree dirty"* ]] || return 1
}

@test "publish: --tag != v<manifest.version> -> consistency gate exit 7" {
  run "${SCRIPT}" publish --out "${OUT}" --tag "v0.0.0-nope"
  [[ "${status}" -eq 7 ]] || return 1
  [[ "${output}" == *"v0.0.0-nope != v${MANIFEST_VERSION}"* ]] || return 1
}

@test "publish: matching explicit --tag on a clean tree passes the gate (dry-run)" {
  run "${SCRIPT}" publish --out "${OUT}" --tag "v${MANIFEST_VERSION}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"DRY RUN"* ]] || return 1
}

@test "publish: stale manifest still fails the preserved --check gate (exit 4) before the consistency gate" {
  # Modify an IN-SCOPE tracked file without regenerating: generate-manifest --check
  # detects the hash drift and exits 4 — proving the existing gate runs first and
  # the new gate did not displace it.
  printf 'drifted content\n' >>"${WORK}/agents/alpha.md"

  run "${SCRIPT}" publish --out "${OUT}"
  [[ "${status}" -eq 4 ]] || return 1
  [[ "${output}" == *"manifest --check FAILED"* ]] || return 1
}
