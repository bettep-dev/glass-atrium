#!/usr/bin/env bats
# run_doctor healthy-CONSUMER-install regression (lib/ga-doctor.sh §7 + §8).
#
# A `glass-atrium doctor` on a HEALTHY deployed consumer install used to FAIL:
#   BUG 1 (§7 target-side deploy reconciliation): the loop iterated EVERY manifest
#     entry but never applied is_symlink_excluded, so the install-internal surfaces
#     (lib/ monitor/ hooks/ scoped/ scripts/ autoagent/ + the exact tail) — bundled
#     yet consumed IN PLACE from ~/.glass-atrium, NEVER symlinked into ~/.claude —
#     each reported "not installed" → hundreds of spurious FAILs. The write side
#     (run_symlink_farm) already skips them; §7 was the sole read_manifest_files
#     consumer that omitted the skip.
#   BUG 2 (§8 manifest drift gate): generate-manifest.sh --check hard-exits 3 on a
#     non-git root (git ls-files is its file-list SoT) BEFORE any comparison, and
#     the gate read ANY non-zero as DRIFT → a false manifest-DRIFT warn on EVERY
#     deployed install (~/.glass-atrium ships no .git).
#
# This suite pins the fixed behavior AND proves the real-detection paths survive:
#   - a healthy fixture (only agents/skills/rules symlinked; no .git) → §7 ok, §8 ok,
#     doctor PASS.
#   - §7 still HARD-FAILs a genuinely-undeployed farmed entry (real-gap detection
#     not weakened).
#   - §8's git-independent hash reconciliation still catches real content drift.
#   - §4 source-presence still HARD-FAILs a genuinely-missing bundled source.
#
# Run via: bats test/doctor-consumer-install.bats
# Requires: bats >= 1.5.0, jq, shasum (macOS/CI) or sha256sum, bash 3.2+
#
# Hermetic strategy (mirrors essential-symlinks-migration.bats): GA_TARGET_HOME +
# GA_MANIFEST + GA_LIB_DIR pin a throwaway sandbox; the driver sources the REAL
# engine in its own subprocess under `set -Eeuo pipefail` and calls run_doctor
# directly, so no real ~/.claude is touched and `readonly GA_ROOT` never leaks. The
# sandbox GA_ROOT carries NO .git, reproducing the consumer-install code path.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || skip "shasum/sha256sum required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-consumer-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga" # sandbox GA_ROOT (consumer install root — NO .git)
  TARGET="${SANDBOX}/target" # throwaway ~/.claude target
  MANIFEST="${SANDBOX}/manifest.json"
  mkdir -p "${TARGET}"

  export GA_LIB_DIR="${GA}/scripts/lib"
  export GA_TARGET_HOME="${TARGET}"
  export GA_MANIFEST="${MANIFEST}"

  # The natively-discovered surfaces farmed into ~/.claude.
  FARMED=(
    "agents/dev-a.md"
    "skills/skill-a/SKILL.md"
    "rules/glass-atrium/rule-a.md"
  )
  # Install-internal surfaces: bundled + hash-verified, consumed IN PLACE from the
  # GA root, NEVER symlinked (is_symlink_excluded PREFIXES + EXACT). §7 MUST skip
  # every one of these — the BUG-1 regression surface.
  INTERNAL=(
    "lib/ga-core.sh"
    "monitor/package.json"
    "hooks/hook-a.sh"
    "scoped/scope-a.md"
    "scripts/wiki-sync.sh"
    "autoagent/daemon-cycle.sh"
    "config.toml.example"
    "requirements.txt"
    "agent-registry.json"
    "glass-atrium"
  )
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Seed a GA_ROOT source file for <rel> with deterministic content.
seed_src() {
  local rel="$1"
  mkdir -p -- "$(dirname -- "${GA_SANDBOX}/${rel}")"
  printf 'ga-source: %s\n' "${rel}" >"${GA_SANDBOX}/${rel}"
}

# Symlink one farmed <rel> into the target (the real deploy shape: TARGET/rel -> GA_ROOT/rel).
deploy_link() {
  local rel="$1"
  mkdir -p -- "$(dirname -- "${TARGET}/${rel}")"
  ln -s "${GA_SANDBOX}/${rel}" "${TARGET}/${rel}"
}

# Sha256 hex of a file (first whitespace field), tool-portable like generate-manifest.sh.
sha_hex() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Write the sandbox manifest {version, files, hashes} with REAL sha256 of each seeded
# source — so §8's git-independent reconciliation has recorded hashes to compare.
write_manifest_with_hashes() {
  local rel files_json hashes_json
  files_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  hashes_json="$(
    for rel in "$@"; do
      printf '%s\t%s\n' "${rel}" "$(sha_hex "${GA_SANDBOX}/${rel}")"
    done | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}'
  )"
  jq -n --arg ver "1.0.1" --argjson files "${files_json}" --argjson hashes "${hashes_json}" \
    '{version:$ver, files:$files, hashes:$hashes}' >"${MANIFEST}"
}

# Stub the manifest generator to mimic generate-manifest.sh's exit-3 on a non-git
# root (git ls-files is its file-list SoT, unavailable off a work tree) — the exact
# condition BUG 2's pre-fix §8 misread as DRIFT. A real consumer install DOES ship
# scripts/generate-manifest.sh, so this matches the deployed shape. The FIXED §8
# branches on .git absence BEFORE consulting the generator, so this stub only shapes
# what the pre-fix code path would have done (post-fix never runs it here).
seed_exit3_generator() {
  local stub="${SANDBOX}/generate-manifest.sh"
  cat >"${stub}" <<'SH'
#!/usr/bin/env bash
echo "generate-manifest: not a git work tree" >&2
exit 3
SH
  chmod +x "${stub}"
  export GA_GENERATE_MANIFEST="${stub}"
}

# Seed sources for every FARMED + INTERNAL rel, the exit-3 generator stub, and a
# matching hashed manifest — the faithful healthy consumer-install shape.
seed_full_fixture() {
  local rel
  for rel in "${FARMED[@]}" "${INTERNAL[@]}"; do
    seed_src "${rel}"
  done
  seed_exit3_generator
  write_manifest_with_hashes "${FARMED[@]}" "${INTERNAL[@]}"
}

# Deploy the real consumer shape: symlink ONLY the farmed surfaces.
deploy_farmed_links() {
  local rel
  for rel in "${FARMED[@]}"; do
    deploy_link "${rel}"
  done
}

# Run the REAL run_doctor against the sandbox in a fresh strict-mode subprocess.
run_doctor_sandbox() {
  run env GA_LIB_DIR="${GA_LIB_DIR}" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

# === 1. healthy consumer install → §7 ok, §8 ok, doctor PASS =================

@test "healthy consumer install: §7 reports all deployed (no install-internal false-FAIL)" {
  seed_full_fixture
  deploy_farmed_links
  # precondition: this is a consumer install — no .git at the GA root
  [[ ! -e "${GA_SANDBOX}/.git" ]]

  run_doctor_sandbox

  # §7 skips every install-internal entry and finds the 3 farmed ones deployed
  [[ "${output}" == *"ok   : all manifest entries deployed to target"* ]]
  # the BUG-1 symptom is GONE: no install-internal entry is reported undeployed
  [[ "${output}" != *"manifest entry not installed: lib/ga-core.sh"* ]]
  [[ "${output}" != *"manifest entry not installed: monitor/package.json"* ]]
  [[ "${output}" != *"manifest entry not installed: hooks/hook-a.sh"* ]]
  [[ "${output}" != *"manifest entry not installed: scoped/scope-a.md"* ]]
  [[ "${output}" != *"manifest entry not installed: scripts/wiki-sync.sh"* ]]
  [[ "${output}" != *"manifest entry not installed: autoagent/daemon-cycle.sh"* ]]
  [[ "${output}" != *"manifest entry not installed: config.toml.example"* ]]
  [[ "${output}" != *"manifest entry not installed: requirements.txt"* ]]
  [[ "${output}" != *"manifest entry not installed: agent-registry.json"* ]]
  [[ "${output}" != *"manifest entry not installed: glass-atrium"* ]]
}

@test "healthy consumer install: §8 hash reconciliation ok (no false manifest-DRIFT)" {
  seed_full_fixture
  deploy_farmed_links

  run_doctor_sandbox

  # git-independent reconciliation matches → ok, and NO false drift warn
  [[ "${output}" == *"ok   : manifest matches on-disk hashes (git-independent consumer-install reconciliation)"* ]]
  [[ "${output}" != *"manifest DRIFT"* ]]
}

@test "healthy consumer install: doctor PASSes (exit 0, no FAIL banner)" {
  seed_full_fixture
  deploy_farmed_links

  run_doctor_sandbox

  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"== doctor: PASS"* ]]
  [[ "${output}" != *"== doctor: FAIL =="* ]]
}

# === 2. §7 real-gap detection NOT weakened ==================================

@test "§7 still HARD-FAILs a genuinely-undeployed farmed entry" {
  seed_full_fixture
  deploy_farmed_links
  # remove ONE farmed symlink (skills/rules stay linked → ga_links>0 → not 'fresh'
  # target → genuine partial drift on an established install → hard FAIL)
  rm -f -- "${TARGET}/agents/dev-a.md"

  run_doctor_sandbox

  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"manifest entry not installed: agents/dev-a.md"* ]]
  [[ "${output}" == *"== doctor: FAIL =="* ]]
  # install-internal entries still are NOT the cause (still skipped)
  [[ "${output}" != *"manifest entry not installed: lib/ga-core.sh"* ]]
}

# === 3. §8 git-independent reconciliation catches REAL drift =================

@test "§8 detects real content drift on a consumer install (hash mismatch)" {
  seed_full_fixture
  deploy_farmed_links
  # tamper an install-internal source AFTER the manifest hashes were recorded: §4
  # still sees it present, §7 still skips it, but §8's hash reconciliation must flag it
  printf 'tampered\n' >>"${GA_SANDBOX}/lib/ga-core.sh"

  run_doctor_sandbox

  [[ "${output}" == *"manifest DRIFT — content hash mismatch: lib/ga-core.sh"* ]]
  # drift is a WARNING, not a FAIL — doctor still PASSes (§1-7 clean)
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"manifest hash drift(s) on this consumer install"* ]]
}

# === 4. §4 source-presence NOT weakened =====================================

@test "§4 still HARD-FAILs a genuinely-missing bundled source" {
  seed_full_fixture
  deploy_farmed_links
  # delete a bundled install-internal SOURCE (present in the manifest, gone on disk):
  # §4 checks manifest entry -> SOURCE present, independent of the §7 symlink skip
  rm -f -- "${GA_SANDBOX}/hooks/hook-a.sh"

  run_doctor_sandbox

  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"FAIL : manifest source missing: hooks/hook-a.sh"* ]]
  [[ "${output}" == *"== doctor: FAIL =="* ]]
}
