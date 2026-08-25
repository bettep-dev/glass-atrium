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
# The generator sources the spine for the retired-map family bar, so the sandbox
# needs the real library at the path the copied script resolves.
REAL_SPINE="${GA}/scripts/lib/apply-spine.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "generate-manifest.sh not found: ${REAL_SCRIPT}"
  [[ -f "${REAL_SPINE}" ]] || skip "apply-spine.sh not found: ${REAL_SPINE}"
  # pwd -P resolves /var -> /private/var so GA_ROOT (pwd -P inside the script)
  # matches the paths the test computes.
  WORK="$(cd -- "$(mktemp -d -t genman-bats.XXXXXX)" && pwd -P)"
  SCRIPT="${WORK}/scripts/generate-manifest.sh"
  MANIFEST="${WORK}/manifest.json"
  mkdir -p "${WORK}/scripts/lib" "${WORK}/agents" "${WORK}/rules"
  cp "${REAL_SCRIPT}" "${SCRIPT}"
  cp "${REAL_SPINE}" "${WORK}/scripts/lib/apply-spine.sh"
  seed_manifest
  printf '# agent alpha\n' >"${WORK}/agents/alpha.md"
  printf '# rule beta\n' >"${WORK}/rules/beta.md"
  # Root artifacts the bundle must carry. SCOPE_PATHS membership is only observable
  # once git tracks them here — generate_files() takes its file set from git ls-files.
  printf 'license text\n' >"${WORK}/LICENSE"
  printf '# third-party notices\n' >"${WORK}/LICENSES-THIRD-PARTY.md"
  printf '{"permissions":{"deny":[]}}\n' >"${WORK}/settings.template.json"
  git -C "${WORK}" init -q
  git -C "${WORK}" config user.email bats@test.local
  git -C "${WORK}" config user.name bats
  git -C "${WORK}" add -A
  git -C "${WORK}" commit -qm init
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Seed the minimal manifest the generator refuses to regenerate without
# (files/hashes start empty).
seed_manifest() {
  printf '{"files":[],"hashes":{}}\n' >"${MANIFEST}"
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

@test "generate: top-level key order is version, files, hashes, modes, retired" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  [[ "$(jq -r 'keys_unsorted | join(",")' "${MANIFEST}")" == "version,files,hashes,modes,retired" ]]
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

@test "generate: modes map records a symlink's TARGET mode, not its lstat bits (FB-2)" {
  # A tracked symlink is stored git-mode 120000; on disk it lstats 0755 (macOS)
  # or 0777 (Linux), but post-extract `chmod` FOLLOWS the link, so the modes map
  # must record the TARGET's 0644. Pre-fix mode_of used bare `stat -f %Lp` (no
  # -L / lstat) and recorded the link's own bits — observed 755 at HEAD on the
  # live macOS host, which then chmod'd the real GLASS_ATRIUM_GLOBAL_RULES.md
  # target (the tree's one symlink) to 755. This row FAILS at HEAD (recorded=755
  # != 644) and passes once mode_of dereferences via `stat -L`.
  # Assertions are `|| return 1` gated: bats fails a test only on its LAST
  # command, so a bare intermediate `[[ ]]` would not gate the recorded==644
  # check (mirrors the sibling manifest-mode-integrity.bats convention).
  printf '# real rule target\n' >"${WORK}/rules/target.md"
  chmod 644 "${WORK}/rules/target.md"
  ln -s target.md "${WORK}/rules/link.md"
  git -C "${WORK}" add rules/target.md rules/link.md
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  local link_lstat recorded
  link_lstat="$(stat -f '%Lp' "${WORK}/rules/link.md" 2>/dev/null || stat -c '%a' "${WORK}/rules/link.md")"
  recorded="$(jq -r '.modes["rules/link.md"]' "${MANIFEST}")"
  # the link's own lstat bits are NOT 644 (755 macOS / 777 Linux) — proving a
  # recorded 644 came from dereferencing the link, not lstat'ing it.
  [[ "${link_lstat}" != "644" ]] || return 1
  # the contract: modes[link] follows the link to the 644 target.
  [[ "${recorded}" == "644" ]] || return 1
  # the target's own entry is 644 too.
  [[ "$(jq -r '.modes["rules/target.md"]' "${MANIFEST}")" == "644" ]] || return 1
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

@test "generate: refuses without a tracked manifest (exit 5)" {
  rm -f -- "${MANIFEST}"
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

# --- retired map -------------------------------------------------------------
# The map records what the vendor STOPPED shipping, so every fixture below moves a
# path out of (or back into) the tracked set and reads what the regeneration then
# writes. Fixtures are single-commit-per-step repos with no packed history: the
# carry-forward reads the committed manifest and `git ls-files`, never a log, which
# is what lets --check run on the depth-1 checkouts CI and the release path use.

# Ship one in-scope library file, commit it, and stamp it into the manifest.
# Echoes its recorded hash so a caller can assert the retired provenance later.
ship_lib_a() {
  printf '# lib a\n' >"${WORK}/scripts/lib/a.sh"
  git -C "${WORK}" add scripts/lib/a.sh
  git -C "${WORK}" commit -qm add-a
  "${SCRIPT}" >/dev/null
  jq -r '.hashes["scripts/lib/a.sh"]' "${MANIFEST}"
}

@test "retired: a committed path git no longer tracks is retired at its committed hash" {
  local shipped
  shipped="$(ship_lib_a)"
  [[ "${shipped}" =~ ^[0-9a-f]{64}$ ]] || return 1
  git -C "${WORK}" rm -q scripts/lib/a.sh
  git -C "${WORK}" commit -qm drop-a

  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"RETIRED + scripts/lib/a.sh"* ]] || return 1
  [[ "$(jq -r '.retired["scripts/lib/a.sh"] | join(",")' "${MANIFEST}")" == "${shipped}" ]] || return 1
  # the dropped path leaves the deploy rows entirely — retired is not a files[] row
  jq -e 'any(.files[]; . == "scripts/lib/a.sh") | not' "${MANIFEST}" >/dev/null || return 1
  jq -e '(.hashes | has("scripts/lib/a.sh")) | not' "${MANIFEST}" >/dev/null || return 1
  jq -e '(.modes | has("scripts/lib/a.sh")) | not' "${MANIFEST}" >/dev/null || return 1
}

@test "retired: a path that left files[] by exclusion rule or gitignore is NOT retired" {
  # arm 1 — tracked, but the exclusion pattern now claims it. The manifest row is
  # hand-stamped because a path cannot be both listed and excluded by generation.
  mkdir -p "${WORK}/scripts/lib/archive"
  printf '# archived\n' >"${WORK}/scripts/lib/archive/old.sh"
  git -C "${WORK}" add scripts/lib/archive/old.sh
  # arm 2 — untracked via `git rm --cached` behind a new ignore entry, still on disk.
  printf '# lib b\n' >"${WORK}/scripts/lib/b.sh"
  git -C "${WORK}" add scripts/lib/b.sh
  git -C "${WORK}" commit -qm 'seed both arms'
  "${SCRIPT}" >/dev/null
  git -C "${WORK}" rm -q --cached scripts/lib/b.sh
  printf 'scripts/lib/b.sh\n' >"${WORK}/.gitignore"
  git -C "${WORK}" add .gitignore
  git -C "${WORK}" commit -qm 'untrack b behind gitignore'
  jq '.files += ["scripts/lib/archive/old.sh"]
      | .hashes["scripts/lib/archive/old.sh"] = "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"' \
    "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"

  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"RETIRED +"* ]] || return 1
  [[ -f "${WORK}/scripts/lib/b.sh" ]] || return 1
  jq -e '(.retired | has("scripts/lib/archive/old.sh")) | not' "${MANIFEST}" >/dev/null || return 1
  jq -e '(.retired | has("scripts/lib/b.sh")) | not' "${MANIFEST}" >/dev/null || return 1
}

@test "retired: a second drop of the same path appends, dedupes and sorts its hashes" {
  local shipped prior
  shipped="$(ship_lib_a)"
  # an earlier shipped hash the map already carries, plus a duplicate of the
  # current one so the dedupe arm is exercised in the same regeneration.
  prior="00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff"
  jq --arg p "${prior}" --arg s "${shipped}" \
    '.retired = {"scripts/lib/a.sh": [$s, $p]}' "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"
  git -C "${WORK}" rm -q scripts/lib/a.sh
  git -C "${WORK}" commit -qm drop-a

  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(jq -r '.retired["scripts/lib/a.sh"] | length' "${MANIFEST}")" == "2" ]] || return 1
  [[ "$(jq -r '.retired["scripts/lib/a.sh"] | join(",")' "${MANIFEST}")" == "${prior},${shipped}" ]] || return 1
}

@test "retired: a re-shipped path is DROPPED from the map (disjoint from files[])" {
  local shipped
  shipped="$(ship_lib_a)"
  git -C "${WORK}" rm -q scripts/lib/a.sh
  git -C "${WORK}" commit -qm drop-a
  "${SCRIPT}" >/dev/null
  jq -e '.retired | has("scripts/lib/a.sh")' "${MANIFEST}" >/dev/null || return 1

  printf '# lib a again\n' >"${WORK}/scripts/lib/a.sh"
  git -C "${WORK}" add scripts/lib/a.sh
  git -C "${WORK}" commit -qm reship-a
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  jq -e '(.retired | has("scripts/lib/a.sh")) | not' "${MANIFEST}" >/dev/null || return 1
  jq -e 'any(.files[]; . == "scripts/lib/a.sh")' "${MANIFEST}" >/dev/null || return 1
  # the re-shipped provenance is the NEW hash, not the retired one
  [[ "$(jq -r '.hashes["scripts/lib/a.sh"]' "${MANIFEST}")" != "${shipped}" ]] || return 1
}

@test "retired: an empty map is still emitted as a key" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  jq -e 'has("retired")' "${MANIFEST}" >/dev/null || return 1
  [[ "$(jq -c '.retired' "${MANIFEST}")" == "{}" ]] || return 1
}

@test "--check: exit 1 with a RETIRED-ADDITIONS block and a RETIRED delta line" {
  ship_lib_a >/dev/null
  git -C "${WORK}" rm -q scripts/lib/a.sh
  git -C "${WORK}" commit -qm drop-a

  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]] || return 1
  [[ "${output}" == *"RETIRED-ADDITIONS (1):"* ]] || return 1
  [[ "${output}" == *"+ scripts/lib/a.sh"* ]] || return 1
  [[ "${output}" == *"RETIRED delta"* ]] || return 1
}

@test "--check: exit 1 when the manifest carries no retired key at all" {
  "${SCRIPT}"
  jq 'del(.retired)' "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"
  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]] || return 1
  [[ "${output}" == *"RETIRED key ABSENT"* ]] || return 1
}

@test "--validate: rejects a retired key that is also a files[] entry" {
  "${SCRIPT}"
  local victim
  victim="$(jq -r '.files[0]' "${MANIFEST}")"
  jq --arg v "${victim}" \
    '.retired = {($v): ["aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"]}' \
    "${MANIFEST}" >"${WORK}/bad.json"
  run "${SCRIPT}" --validate "${WORK}/bad.json"
  [[ "${status}" -eq 6 ]] || return 1
  [[ "${output}" == *"FAILED structural validation"* ]] || return 1
}

@test "--validate: rejects a retired key in the barred migrations family" {
  "${SCRIPT}"
  jq '.retired = {"monitor/prisma/migrations/20260101000000_x/migration.sql": ["aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"]}' \
    "${MANIFEST}" >"${WORK}/bad.json"
  run "${SCRIPT}" --validate "${WORK}/bad.json"
  [[ "${status}" -eq 6 ]] || return 1
}

@test "--validate: rejects a retired value that is not a non-empty 64-hex array" {
  "${SCRIPT}"
  jq '.retired = {"scripts/lib/gone.sh": []}' "${MANIFEST}" >"${WORK}/empty.json"
  run "${SCRIPT}" --validate "${WORK}/empty.json"
  [[ "${status}" -eq 6 ]] || return 1
  jq '.retired = {"scripts/lib/gone.sh": ["not-a-hash"]}' "${MANIFEST}" >"${WORK}/nothex.json"
  run "${SCRIPT}" --validate "${WORK}/nothex.json"
  [[ "${status}" -eq 6 ]] || return 1
  jq '.retired = {"scripts/lib/gone.sh": "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"}' \
    "${MANIFEST}" >"${WORK}/scalar.json"
  run "${SCRIPT}" --validate "${WORK}/scalar.json"
  [[ "${status}" -eq 6 ]] || return 1
}

@test "--validate: accepts the manifest the generator just wrote" {
  "${SCRIPT}"
  run "${SCRIPT}" --validate "${MANIFEST}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"valid"* ]] || return 1
}

@test "generate: root LICENSE pair and permissions template are manifest members" {
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
  local rel
  for rel in LICENSE LICENSES-THIRD-PARTY.md settings.template.json; do
    run jq -e --arg f "${rel}" '.files | index($f)' "${MANIFEST}"
    [[ "${status}" -eq 0 ]] || {
      echo "not a manifest member: ${rel}"
      return 1
    }
  done
}
