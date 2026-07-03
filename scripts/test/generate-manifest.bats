#!/usr/bin/env bats
# generate-manifest.sh suite — pins the v1.0.0 manifest contract:
#   * regenerate stamps a top-level version == 1.0.0
#   * every files[] path carries a 64-hex sha256 in the parallel hashes map
#     (hashes count == files count; recorded hash == a direct shasum)
#   * files[] stays an array of STRINGS (installer/doctor backward-compat)
#   * --check exit codes: 0 on a matching tree · 1 on orphan / missing /
#     version-mismatch / content-hash-mismatch divergence · 6 on an empty set
#   * regeneration is deterministic (byte-identical across two runs)
#
# Run via: bats scripts/test/generate-manifest.bats
# Requires: bats >= 1.5.0, git, jq, shasum (or sha256sum)
#
# Hermetic strategy: a per-test standalone git repo under a realpath-resolved
# (pwd -P) temp root, with a COPY of the real generate-manifest.sh placed at
# <sandbox>/scripts/ so the script's own BASH_SOURCE-derived GA_ROOT resolves to
# the sandbox, never the live ~/.glass-atrium tree. The ambient git/jq/shasum
# are used (no stub bin needed — none of them is masked here).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/scripts/generate-manifest.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "generate-manifest.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so GA_ROOT (pwd -P inside the script)
  # matches the paths the test computes.
  WORK="$(cd -- "$(mktemp -d -t genman-bats.XXXXXX)" && pwd -P)"
  SCRIPT="${WORK}/scripts/generate-manifest.sh"
  MANIFEST="${WORK}/manifest.json"
  mkdir -p "${WORK}/scripts" "${WORK}/agents" "${WORK}/rules"
  cp "${REAL_SCRIPT}" "${SCRIPT}"
  seed_manifest_doc
  printf '# agent alpha\n' >"${WORK}/agents/alpha.md"
  printf '# rule beta\n' >"${WORK}/rules/beta.md"
  git -C "${WORK}" init -q
  git -C "${WORK}" config user.email bats@test.local
  git -C "${WORK}" config user.name bats
  git -C "${WORK}" add -A
  git -C "${WORK}" commit -qm init
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Seed a minimal manifest carrying ONLY the _doc_settings_json contract key the
# generator refuses to regenerate without (files/hashes start empty).
seed_manifest_doc() {
  printf '{"_doc_settings_json":"sandbox settings.json contract doc","files":[],"hashes":{}}\n' \
    >"${MANIFEST}"
}

@test "generate: stamps top-level version == 1.0.0" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  [[ "$(jq -r '.version' "${MANIFEST}")" == "1.0.0" ]]
}

@test "generate: top-level key order is version, _doc_settings_json, files, hashes" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  [[ "$(jq -r 'keys_unsorted | join(",")' "${MANIFEST}")" == "version,_doc_settings_json,files,hashes" ]]
}

@test "generate: every files entry has a 64-hex sha256 (count parity + format)" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  local files hashes
  files="$(jq '.files | length' "${MANIFEST}")"
  hashes="$(jq '.hashes | length' "${MANIFEST}")"
  [[ "${files}" -eq "${hashes}" ]]
  [[ "${files}" -gt 0 ]]
  run jq -e '.hashes | to_entries | all(.value | test("^[0-9a-f]{64}$"))' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
}

@test "generate: files[] stays an array of strings (installer/doctor backward-compat)" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  run jq -e '(.files | type == "array") and (.files | all(type == "string"))' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
}

@test "generate: recorded hash equals a direct shasum of the file" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  local recorded actual
  recorded="$(jq -r '.hashes["agents/alpha.md"]' "${MANIFEST}")"
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${WORK}/agents/alpha.md" | awk '{print $1}')"
  else
    actual="$(sha256sum "${WORK}/agents/alpha.md" | awk '{print $1}')"
  fi
  [[ "${recorded}" == "${actual}" ]]
}

@test "generate: deterministic — two runs produce a byte-identical manifest" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  local first
  first="$(cat "${MANIFEST}")"
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  [[ "$(cat "${MANIFEST}")" == "${first}" ]]
}

@test "--check: exit 0 on a freshly generated, matching tree" {
  "${SCRIPT}"
  run "${SCRIPT}" --check
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"manifest matches generated set"* ]]
}

@test "--check: exit 1 on a content-hash mismatch (path unchanged)" {
  "${SCRIPT}"
  printf '# agent alpha MUTATED\n' >"${WORK}/agents/alpha.md"
  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"HASH mismatches"* ]]
  [[ "${output}" == *"agents/alpha.md"* ]]
}

@test "--check: exit 1 on a version mismatch" {
  "${SCRIPT}"
  jq '.version = "0.9.0"' "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"
  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"VERSION mismatch"* ]]
}

@test "--check: exit 1 on an ORPHAN entry (listed, not tracked/in-scope)" {
  "${SCRIPT}"
  jq '.files += ["agents/ghost.md"] | .hashes["agents/ghost.md"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"' \
    "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"
  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"ORPHAN entries"* ]]
  [[ "${output}" == *"agents/ghost.md"* ]]
}

@test "--check: exit 1 on a MISSING entry (tracked in-scope, not listed)" {
  "${SCRIPT}"
  # add a new tracked in-scope file the manifest does not list yet
  printf '# rule gamma\n' >"${WORK}/rules/gamma.md"
  git -C "${WORK}" add rules/gamma.md
  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"MISSING entries"* ]]
  [[ "${output}" == *"rules/gamma.md"* ]]
}

@test "--check: exit 6 on an empty generated set" {
  "${SCRIPT}"
  # untrack every in-scope path so git ls-files returns nothing in scope; the
  # script copy stays physically present (BASH_SOURCE still resolves) but
  # untracked, so the generated set is empty.
  git -C "${WORK}" rm -q -r --cached agents rules scripts
  run "${SCRIPT}" --check
  [[ "${status}" -eq 6 ]]
  [[ "${output}" == *"EMPTY"* ]]
}

@test "generate: exit 6 on an empty generated set (refuses to write)" {
  git -C "${WORK}" rm -q -r --cached agents rules scripts
  run "${SCRIPT}"
  [[ "${status}" -eq 6 ]]
  [[ "${output}" == *"EMPTY"* ]]
}

@test "generate: refuses without the _doc_settings_json contract key (exit 5)" {
  printf '{"files":[],"hashes":{}}\n' >"${MANIFEST}"
  run "${SCRIPT}"
  [[ "${status}" -eq 5 ]]
}
