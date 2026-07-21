#!/usr/bin/env bats
# generate-manifest.sh suite — pins the manifest contract: version stamped from the
# ATRIUM_VERSION SoT (not a literal); every files[] path carries a 64-hex sha256 in
# the parallel hashes map (count parity; hash == direct shasum); files[] stays an
# array of STRINGS (installer/doctor backward-compat); --check exit codes (0 match ·
# 1 orphan/missing/version/hash divergence · 6 empty set); regeneration deterministic.
# Hermetic: per-test standalone git repo under a pwd -P temp root, with a COPY of the
# real script at <sandbox>/scripts/ so its BASH_SOURCE-derived GA_ROOT resolves to the
# sandbox, never the live ~/.glass-atrium tree. Ambient git/jq/shasum (none masked).

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

@test "generate: stamps top-level version matching ATRIUM_VERSION" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  # Derive the expected version from the SCRIPT copy's ATRIUM_VERSION SoT so the
  # assertion tracks a version bump instead of pinning a literal.
  local expected
  expected="$(sed -n 's/^readonly ATRIUM_VERSION="\([^"]*\)".*/\1/p' "${SCRIPT}")"
  [[ -n "${expected}" ]]
  [[ "$(jq -r '.version' "${MANIFEST}")" == "${expected}" ]]
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

# T1b — the four executable-suite roots must bundle so the daemon-apply preflight
# can run the suite from the installed tree; monitor/test must stay out. Seeds one
# .bats per root (+ a test_*.py under autoagent) and a monitor/test .test.ts decoy —
# the .test.ts is the trap a blanket (^|/)test/ drop would leak (no pattern catches .ts).
seed_test_roots() {
  mkdir -p "${WORK}/test" "${WORK}/hooks/test" "${WORK}/scripts/test" \
    "${WORK}/autoagent/test" "${WORK}/monitor/test"
  printf '@test "root" { true; }\n' >"${WORK}/test/root-suite.bats"
  printf '@test "hooks" { true; }\n' >"${WORK}/hooks/test/hooks-suite.bats"
  printf '@test "scripts" { true; }\n' >"${WORK}/scripts/test/scripts-suite.bats"
  printf '@test "auto" { true; }\n' >"${WORK}/autoagent/test/auto-suite.bats"
  printf 'def test_x():\n    assert True\n' >"${WORK}/autoagent/test/test_thing.py"
  printf 'it("dash", () => {});\n' >"${WORK}/monitor/test/dash.test.ts"
  git -C "${WORK}" add -A
  git -C "${WORK}" commit -qm 'seed test roots'
}

@test "generate: bundles all four executable-suite roots + their .bats/test_*.py" {
  seed_test_roots
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  # Root test/ enters only via the explicit SCOPE_PATHS entry (rides no parent prefix).
  run jq -e 'any(.files[]; . == "test/root-suite.bats")' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
  # Sub-roots ride hooks/, scripts/, autoagent/ scope; un-excluded once the blanket
  # test/ + .bats + test_*.py alternations are gone.
  run jq -e 'any(.files[]; . == "hooks/test/hooks-suite.bats")' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
  run jq -e 'any(.files[]; . == "scripts/test/scripts-suite.bats")' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
  run jq -e 'any(.files[]; . == "autoagent/test/auto-suite.bats")' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
  run jq -e 'any(.files[]; . == "autoagent/test/test_thing.py")' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
}

@test "generate: monitor/test .test.ts stays excluded (surgical carve-out, not blanket)" {
  seed_test_roots
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  # The named decoy is absent, and no .test.ts leaks anywhere — the surgical
  # monitor/test carve-out holds where a blanket test/ drop would fail.
  run jq -e 'any(.files[]; . == "monitor/test/dash.test.ts")' "${MANIFEST}"
  [[ "${status}" -ne 0 ]]
  run jq -e 'any(.files[]; endswith(".test.ts"))' "${MANIFEST}"
  [[ "${status}" -ne 0 ]]
}

@test "generate: every tracked .bats under the four roots is bundled (count parity)" {
  seed_test_roots
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  local tracked bundled
  tracked="$(git -C "${WORK}" ls-files -- test hooks/test scripts/test autoagent/test | grep -c '\.bats$')"
  bundled="$(jq -r '.files[] | select(endswith(".bats"))' "${MANIFEST}" | grep -c '\.bats$')"
  [[ "${tracked}" -gt 0 ]]
  [[ "${bundled}" -eq "${tracked}" ]]
}
