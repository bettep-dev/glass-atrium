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

# Untrack every in-scope path so git ls-files returns nothing the generator can
# collect; the physical files stay (BASH_SOURCE still resolves) and manifest.json
# stays tracked, because an untracked manifest is a different refusal (exit 5).
# Enumerated from git rather than a fixed path list — a newly seeded root artifact
# would otherwise silently refill the set this scenario needs empty.
untrack_in_scope() {
  local rel
  local -a tracked=()
  while IFS= read -r rel; do
    [[ "${rel}" == "manifest.json" ]] || tracked+=("${rel}")
  done < <(git -C "${WORK}" ls-files)
  if [[ "${#tracked[@]}" -gt 0 ]]; then
    git -C "${WORK}" rm -q --cached -- "${tracked[@]}"
  fi
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

# Row = "<name>|<path>": one path per byte class that default git output C-quotes.
QUOTED_PATH_ROWS=(
  "non-ASCII byte|agents/한글-agent.md"
  "double quote|agents/q\"b.md"
)

# Track one file per QUOTED_PATH_ROWS path. core.quotePath is pinned to git's default
# so an ambient `false` cannot hide the non-ASCII row.
track_quoted_paths() {
  local row
  git -C "${WORK}" config core.quotePath true
  for row in "${QUOTED_PATH_ROWS[@]}"; do
    printf '# %s\n' "${row%%|*}" >"${WORK}/${row#*|}"
    git -C "${WORK}" add -- "${row#*|}"
  done
  git -C "${WORK}" commit -qm 'track quoted-byte paths'
}

sha256_content() {
  local out
  if command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 <"$1")"
  else
    out="$(sha256sum <"$1")"
  fi
  printf '%s\n' "${out%% *}"
}

@test "generate: records a path git would quote verbatim, hashed from its content" {
  track_quoted_paths
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  local row name path recorded content mode
  for row in "${QUOTED_PATH_ROWS[@]}"; do
    name="${row%%|*}" path="${row#*|}"
    jq -e --arg f "${path}" 'any(.files[]; . == $f)' "${MANIFEST}" >/dev/null \
      || {
        echo "files[] lacks the ${name} path verbatim"
        return 1
      }
    recorded="$(jq -r --arg f "${path}" '.hashes[$f]' "${MANIFEST}")"
    content="$(sha256_content "${WORK}/${path}")"
    [[ "${recorded}" == "${content}" ]] \
      || {
        echo "hash of the ${name} path is not its content hash"
        return 1
      }
    mode="$(jq -r --arg f "${path}" '.modes[$f]' "${MANIFEST}")"
    [[ "${mode}" =~ ^[0-7]{3,4}$ ]] || {
      echo "modes lacks the ${name} path"
      return 1
    }
  done
}

@test "--check: exit 0 on a generated tree whose paths git would quote" {
  track_quoted_paths
  "${SCRIPT}" >/dev/null
  run "${SCRIPT}" --check
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"manifest matches generated set"* ]] || return 1
}

# Index-only entry: APFS refuses a non-UTF-8 file name, but git tracks one fine.
track_index_only() {
  local blob
  blob="$(git -C "${WORK}" hash-object -w --stdin </dev/null)"
  git -C "${WORK}" update-index --add --cacheinfo "100644,${blob},$1"
}

# Row = "<name>|<path suffix>": one byte class a manifest path cannot carry (exit 8).
UNCARRIABLE_ROWS=(
  "backslash|back\\slash.md"
  "tab|tab"$'\t'"name.md"
  "newline|new"$'\n'"line.md"
  "non-UTF-8 byte|bad"$'\xe9'"byte.md"
)

@test "generate: exit 8 names an in-scope path the pipeline cannot carry and leaves the manifest unchanged" {
  "${SCRIPT}" >/dev/null
  git -C "${WORK}" add manifest.json
  git -C "${WORK}" commit -qm 'baseline manifest'
  cp -- "${MANIFEST}" "${WORK}/before.json"
  local row name path quoted
  for row in "${UNCARRIABLE_ROWS[@]}"; do
    name="${row%%|*}" path="agents/${row#*|}"
    printf -v quoted '%q' "${path}"
    track_index_only "${path}"
    run "${SCRIPT}"
    [[ "${status}" -eq 8 ]] || {
      echo "${name}: exit ${status}, expected 8"
      return 1
    }
    [[ "${output}" == *"${quoted}"* ]] || {
      echo "${name}: path not named"
      return 1
    }
    cmp -s -- "${WORK}/before.json" "${MANIFEST}" || {
      echo "${name}: manifest rewritten"
      return 1
    }
    git -C "${WORK}" rm -q --cached -- "${path}"
  done
}

@test "generate: an excluded path is dropped whatever bytes it carries" {
  local row name path
  for row in "${UNCARRIABLE_ROWS[@]}"; do
    name="${row%%|*}" path="scripts/lib/archive/${row#*|}"
    track_index_only "${path}"
    run "${SCRIPT}"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: exit ${status}, expected 0: ${output}"
      return 1
    }
    jq -e 'any(.files[]; test("/archive/")) | not' "${MANIFEST}" >/dev/null || {
      echo "${name}: excluded path entered files[]"
      return 1
    }
    git -C "${WORK}" rm -q --cached -- "${path}"
  done
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
  # Assertions are `|| return 1` gated: @test bodies run under errexit, but a bare
  # intermediate `[[ ]]` does NOT gate on macOS bash 3.2.57 — it DOES from bash 4.4
  # onward, CI's bash 5.3.9 included (measured on 3.2.57 / 4.4.23 / 5.0.18 / 5.3.15 —
  # bash is the variable, not bats) — so unguarded the recorded==644 check would assert
  # nothing locally (mirrors the sibling manifest-mode-integrity.bats convention).
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
  untrack_in_scope
  run "${SCRIPT}" --check
  [[ "${status}" -eq 6 ]]
  [[ "${output}" == *"EMPTY"* ]]
}

@test "generate: exit 6 on an empty generated set (refuses to write)" {
  untrack_in_scope
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

@test "retired: a dropped path stays retired when a tracked path splits on a newline into its name" {
  local shipped
  shipped="$(ship_lib_a)"
  git -C "${WORK}" rm -q scripts/lib/a.sh
  git -C "${WORK}" commit -qm drop-a
  track_index_only "docs/x"$'\n'"scripts/lib/a.sh"

  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"RETIRED + scripts/lib/a.sh"* ]] || return 1
  jq -e --arg h "${shipped}" '.retired["scripts/lib/a.sh"] == [$h]' "${MANIFEST}" >/dev/null || return 1
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

@test "retired: a still-tracked path git would quote is NOT retired once it leaves the disk" {
  # The on-disk arm is removed so only the tracked-paths oracle can keep the row out.
  git -C "${WORK}" config core.quotePath true
  mkdir -p "${WORK}/scripts/lib/archive"
  printf '# archived\n' >"${WORK}/scripts/lib/archive/한글.sh"
  git -C "${WORK}" add scripts/lib/archive/한글.sh
  git -C "${WORK}" commit -qm 'track an excluded non-ASCII path'
  "${SCRIPT}" >/dev/null
  rm -f -- "${WORK}/scripts/lib/archive/한글.sh"
  jq '.files += ["scripts/lib/archive/한글.sh"]
      | .hashes["scripts/lib/archive/한글.sh"] = "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"' \
    "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"

  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"RETIRED +"* ]] || return 1
  jq -e '(.retired | has("scripts/lib/archive/한글.sh")) | not' "${MANIFEST}" >/dev/null || return 1
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

# Stamp one retired entry into a freshly generated manifest, then run --check. The
# default value is a REAL shipped hash, so only the entry's shape can fail the gate.
check_with_retired_entry() {
  local key="$1" value="${2:-}"
  "${SCRIPT}" >/dev/null
  [[ -n "${value}" ]] || value="$(jq -r '.hashes["LICENSE"]' "${MANIFEST}")"
  jq --arg k "${key}" --arg v "${value}" '.retired = {($k): [$v]}' \
    "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"
  run "${SCRIPT}" --check
}

@test "--check: exit 1 names a dot-dot escaping retired key" {
  check_with_retired_entry "../../escape"
  [ "${status}" -eq 1 ] || return 1
  [[ "${output}" == *"RETIRED shape INVALID:"* ]] || return 1
  [[ "${output}" == *'! "../../escape"'* ]] || return 1
}

@test "--check: exit 1 names an absolute retired key" {
  check_with_retired_entry "/scripts/lib/gone.sh"
  [ "${status}" -eq 1 ] || return 1
  [[ "${output}" == *"RETIRED shape INVALID:"* ]] || return 1
  [[ "${output}" == *'! "/scripts/lib/gone.sh"'* ]] || return 1
}

@test "--check: exit 1 names a retired key with a mid-path dot-dot segment" {
  check_with_retired_entry "a/../../x"
  [ "${status}" -eq 1 ] || return 1
  [[ "${output}" == *"RETIRED shape INVALID:"* ]] || return 1
  [[ "${output}" == *'! "a/../../x"'* ]] || return 1
}

@test "--check: exit 1 names a retired key whose value is not 64-hex" {
  check_with_retired_entry "scripts/lib/gone.sh" \
    "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"
  [ "${status}" -eq 1 ] || return 1
  [[ "${output}" == *"RETIRED shape INVALID:"* ]] || return 1
  [[ "${output}" == *'! "scripts/lib/gone.sh"'* ]] || return 1
}

# Rewrite the generated manifest with jq filter $1 applied. The LICENSE entry it
# rewrites carries its real generated hash and mode, so only the key shape can fail.
rewrite_manifest() {
  "${SCRIPT}" >/dev/null
  jq "$1" "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"
}

readonly MODES_KEY_SWAP_JQ='.modes["../../x"] = .modes["LICENSE"] | del(.modes["LICENSE"])'
readonly FILES_KEY_ESCAPE_JQ='.files |= map(if . == "LICENSE" then "../../x" else . end)
  | .hashes["../../x"] = .hashes["LICENSE"] | del(.hashes["LICENSE"])
  | .modes["../../x"] = .modes["LICENSE"] | del(.modes["LICENSE"])'

@test "--check: exit 1 lists both keys of a modes entry swapped out of the files set" {
  rewrite_manifest "${MODES_KEY_SWAP_JQ}"
  run "${SCRIPT}" --check
  [ "${status}" -eq 1 ] || return 1
  [[ "${output}" == *"MODES key set differs from files:"* ]] || return 1
  [[ "${output}" == *'+ "../../x"'* ]] || return 1
  [[ "${output}" == *'- "LICENSE"'* ]] || return 1
}

@test "--validate: rejects a modes entry swapped out of the files set" {
  rewrite_manifest "${MODES_KEY_SWAP_JQ}"
  run "${SCRIPT}" --validate "${MANIFEST}"
  [ "${status}" -eq 6 ] || return 1
}

@test "--check: exit 1 names an escaping files entry" {
  rewrite_manifest "${FILES_KEY_ESCAPE_JQ}"
  run "${SCRIPT}" --check
  [ "${status}" -eq 1 ] || return 1
  [[ "${output}" == *"FILES key INVALID:"* ]] || return 1
  [[ "${output}" == *'! "../../x"'* ]] || return 1
}

@test "--validate: rejects an escaping files entry whose hashes and modes keys agree" {
  rewrite_manifest "${FILES_KEY_ESCAPE_JQ}"
  run "${SCRIPT}" --validate "${MANIFEST}"
  [ "${status}" -eq 6 ] || return 1
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

@test "--validate: rejects an absolute, a dot-dot-segment and an empty retired key" {
  "${SCRIPT}"
  local key
  for key in "/scripts/lib/gone.sh" "../../.claude/data/update/pending.json" ""; do
    jq --arg k "${key}" \
      '.retired = {($k): ["aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"]}' \
      "${MANIFEST}" >"${WORK}/bad.json"
    run "${SCRIPT}" --validate "${WORK}/bad.json"
    [ "${status}" -eq 6 ] || {
      printf 'retired key accepted: "%s" (status %s)\n' "${key}" "${status}"
      return 1
    }
  done
}

@test "--validate: accepts a dot-dot inside a retired key segment name" {
  "${SCRIPT}"
  jq '.retired = {"scripts/lib/foo..bar": ["aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"]}' \
    "${MANIFEST}" >"${WORK}/ok.json"
  run "${SCRIPT}" --validate "${WORK}/ok.json"
  [ "${status}" -eq 0 ] || return 1
}

@test "generate: a committed dot-dot retired key stops regeneration and leaves the manifest unchanged" {
  "${SCRIPT}"
  jq '.retired = {"../../.claude/data/update/pending.json": ["aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"]}' \
    "${MANIFEST}" >"${MANIFEST}.tmp"
  mv -f "${MANIFEST}.tmp" "${MANIFEST}"
  # a newly shipped file makes a swapped-in regeneration differ from the committed bytes
  printf '# lib c\n' >"${WORK}/scripts/lib/c.sh"
  git -C "${WORK}" add manifest.json scripts/lib/c.sh
  git -C "${WORK}" commit -qm 'carry an escaping retired key'
  cp -- "${MANIFEST}" "${WORK}/before.json"
  run "${SCRIPT}"
  [ "${status}" -eq 6 ] || return 1
  cmp -s -- "${WORK}/before.json" "${MANIFEST}" || return 1
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
    jq -e --arg f "${rel}" 'any(.files[]; . == $f)' "${MANIFEST}" >/dev/null || {
      echo "not a manifest member: ${rel}"
      return 1
    }
  done
}
