#!/usr/bin/env bats
# Install/uninstall DIRECTORY-lifecycle symmetry (ga-core.sh).
#
# PART A — INSTALL creates the dirs: on a CLEAN target that has NONE of the GA
#   component dirs, the symlink farm (run_symlink_farm → swap_symlink) MUST
#   `mkdir -p` every symlink's parent dir BEFORE `ln -s`, so a new-user install
#   materializes agents/, skills/<name>/, agents/references/, rules/ itself.
# PART B — UNINSTALL empty-dir cleanup (remove_empty_dirs): AFTER the symlink
#   passes (remove_manifest_links + sweep_orphans) unlink every GA symlink, the
#   empty directory skeletons the farm created are removed — rmdir-ONLY, so:
#     * a dir still holding a USER file survives (rmdir fails on non-empty → the
#       safety invariant; NEVER rm -rf);
#     * deepest-first, so a parent goes only after its children were emptied;
#     * TARGET_HOME itself is never a candidate (boundary);
#     * install-internal (lib/, ...) + top-level files contribute no dir.
#
# ESSENTIAL-SYMLINKS-ONLY drop-set (P2): hooks/ + scoped/ (prefixes) and
#   agent-registry.json + glass-atrium (exacts) are is_symlink_excluded — bundled
#   + hash-verified but consumed IN PLACE from ~/.glass-atrium, never farmed into
#   ~/.claude. is_symlink_excluded is the SINGLE choke point consulted at all
#   three farm sites (create=run_symlink_farm, remove=remove_manifest_links,
#   dir-prune=read_manifest_dirs), so this file asserts the four surfaces are
#   absent from create + remove + dir-prune (the symmetry the choke point buys).
#   The empty-dir-prune intent is re-based onto the still-farmed surfaces
#   (agents/skills/rules).
#
# Run via: bats test/uninstall-empty-dirs.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+
#
# Hermetic strategy (mirrors unwire-hooks.bats / install-update-state.bats):
# GA_TARGET_HOME points the install target at a throwaway temp dir, GA_MANIFEST at
# a synthetic manifest, and GA_LIB_DIR at the REAL scripts/lib (the E5 libs
# ga_init_env sources). Each driver sources the REAL engine + ga_init_env's fresh
# in its own subprocess under the entry point's `set -Eeuo pipefail`, so
# `readonly GA_ROOT` never leaks and no real ~/.claude is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-empty-dirs-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga" # sandbox GA_ROOT — the farmed SOURCE bodies live here
  TARGET="${SANDBOX}/target" # throwaway install target (starts with NO GA dirs)
  MANIFEST="${SANDBOX}/manifest.json"
  mkdir -p "${TARGET}"

  export GA_LIB_DIR="${GA}/scripts/lib"
  export GA_TARGET_HOME="${TARGET}"
  export GA_MANIFEST="${MANIFEST}"

  # still-farmed multi-level dirs + a top-level file (no dir) + install-internal
  # (lib/) + ALL FOUR now-excluded surfaces (hooks/, scoped/, agent-registry.json,
  # glass-atrium) so the exclusion is provably tested at every farm site.
  FARMED=(
    "agents/dev-x.md"
    "agents/references/ref-a.md"
    "skills/skill-one/SKILL.md"
    "skills/skill-one/references/deep.md"
    "rules/rule-a.md"
    "hooks/hook-a.sh"
    "scoped/scope-x.md"
    "agent-registry.json"
    "glass-atrium"
    "top-file.md"
    "lib/ga-core.sh"
  )
  local rel
  for rel in "${FARMED[@]}"; do
    mkdir -p "${GA_SANDBOX}/$(dirname -- "${rel}")"
    printf 'src %s\n' "${rel}" >"${GA_SANDBOX}/${rel}"
  done
  printf '%s\n' "${FARMED[@]}" | jq -R . | jq -s '{version:"1.0.0", files:.}' >"${MANIFEST}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Drive ONE sourced engine function (fresh subprocess). Honors GA_TEST_DRY.
run_ga() {
  run env GA_LIB_DIR="${GA_LIB_DIR}" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_TEST_DRY="${GA_TEST_DRY:-false}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      DRY_RUN="${GA_TEST_DRY:-false}"
      shift 2
      "$@"
    ' _ "${GA}" "${GA_SANDBOX}" "$@"
}

# Drive the uninstall SYMLINK + EMPTY-DIR passes in run_uninstall order.
run_cleanup_seq() {
  run env GA_LIB_DIR="${GA_LIB_DIR}" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_TEST_DRY="${GA_TEST_DRY:-false}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      DRY_RUN="${GA_TEST_DRY:-false}"
      remove_manifest_links
      sweep_orphans
      remove_empty_dirs
    ' _ "${GA}" "${GA_SANDBOX}"
}

# Assert NONE of the four excluded surfaces materialized in the target.
assert_excluded_absent() {
  [[ ! -e "${TARGET}/hooks" ]] || { echo "excluded hooks/ present"; return 1; }
  [[ ! -e "${TARGET}/scoped" ]] || { echo "excluded scoped/ present"; return 1; }
  [[ ! -e "${TARGET}/agent-registry.json" ]] || { echo "excluded agent-registry.json present"; return 1; }
  [[ ! -e "${TARGET}/glass-atrium" ]] || { echo "excluded glass-atrium present"; return 1; }
}

# === PART A — install (farm builder) creates every needed dir ===============

@test "PART A: a clean-target install mkdir -p's every still-farmed GA dir before ln -s" {
  # precondition: a brand-new user has NONE of these dirs
  [[ ! -e "${TARGET}/agents" && ! -e "${TARGET}/skills" && ! -e "${TARGET}/rules" ]]

  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]

  # every still-farmed dir (incl. nested) was CREATED by the farm
  local d
  for d in agents agents/references skills skills/skill-one skills/skill-one/references rules; do
    [[ -d "${TARGET}/${d}" ]] || { echo "missing dir: ${d}"; false; }
  done
  # and the per-file symlinks are placed
  [[ -L "${TARGET}/agents/references/ref-a.md" ]]
  [[ -L "${TARGET}/skills/skill-one/references/deep.md" ]]
  [[ -L "${TARGET}/rules/rule-a.md" ]]
  [[ -L "${TARGET}/top-file.md" ]]
  # install-internal payload (lib/) is NEVER symlinked → its dir is never created
  [[ ! -e "${TARGET}/lib" ]]
  # CREATE-SITE exclusion: the four dropped surfaces are NOT farmed (asserted last
  # so it genuinely gates the test).
  assert_excluded_absent
}

@test "PART A: excluded surfaces log a skip and never reach swap_symlink" {
  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]
  # each excluded rel is logged as an install-internal skip (choke-point proof)
  [[ "${output}" == *"skip (install-internal, not symlinked): hooks/hook-a.sh"* ]]
  [[ "${output}" == *"skip (install-internal, not symlinked): scoped/scope-x.md"* ]]
  [[ "${output}" == *"skip (install-internal, not symlinked): agent-registry.json"* ]]
  [[ "${output}" == *"skip (install-internal, not symlinked): glass-atrium"* ]]
}

# === PART B — uninstall empty-dir cleanup ===================================

@test "PART B: cleanup removes the empty still-farmed GA dir skeletons; TARGET_HOME survives" {
  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]

  run_cleanup_seq
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"empty-dir cleanup:"* ]]

  # every empty still-farmed GA dir (flat + nested) is gone
  local d
  for d in agents agents/references skills skills/skill-one skills/skill-one/references rules; do
    [[ ! -e "${TARGET}/${d}" ]] || { echo "leftover dir: ${d}"; false; }
  done
  # the boundary — TARGET_HOME itself — is NEVER removed
  [[ -d "${TARGET}" ]]
  # excluded surfaces were never farmed → still absent after cleanup
  assert_excluded_absent
}

@test "PART B: excluded surfaces are never unlinked at remove (symmetric skip, user file survives)" {
  # a prior/user REAL file sits at each excluded manifest path (an excluded rel is
  # skipped by remove_manifest_links, so it must never touch these).
  mkdir -p "${TARGET}/hooks" "${TARGET}/scoped"
  printf 'user hook body\n' >"${TARGET}/hooks/hook-a.sh"
  printf 'user scoped body\n' >"${TARGET}/scoped/scope-x.md"
  printf 'user registry\n' >"${TARGET}/agent-registry.json"
  printf 'user launcher\n' >"${TARGET}/glass-atrium"

  run_ga remove_manifest_links
  [[ "${status}" -eq 0 ]]

  # every excluded-path file survives byte-intact (never a remove attempt)
  [[ "$(cat "${TARGET}/hooks/hook-a.sh")" == "user hook body" ]]
  [[ "$(cat "${TARGET}/scoped/scope-x.md")" == "user scoped body" ]]
  [[ "$(cat "${TARGET}/agent-registry.json")" == "user registry" ]]
  [[ "$(cat "${TARGET}/glass-atrium")" == "user launcher" ]]
}

@test "PART B safety: a user file in a GA dir keeps that dir (rmdir-only, never rm -rf)" {
  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]
  # user drops a real file into a GA-managed dir
  printf 'USER CONTENT\n' >"${TARGET}/skills/skill-one/USER_KEEP.md"

  run_cleanup_seq
  [[ "${status}" -eq 0 ]]

  # the dir holding user content survives, and so does the user file
  [[ -d "${TARGET}/skills/skill-one" ]]
  [[ "$(cat "${TARGET}/skills/skill-one/USER_KEEP.md")" == "USER CONTENT" ]]
  # its ancestor survives too (still holds skill-one)
  [[ -d "${TARGET}/skills" ]]
  # the empty sibling subtree (references/) was still removed
  [[ ! -e "${TARGET}/skills/skill-one/references" ]]
  # unrelated empty GA dirs are gone
  [[ ! -e "${TARGET}/agents" && ! -e "${TARGET}/rules" ]]
}

@test "PART B: round-trip — reinstall re-creates the still-farmed dirs after cleanup" {
  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]
  run_cleanup_seq
  [[ "${status}" -eq 0 ]]
  [[ ! -e "${TARGET}/agents" ]]

  # install AGAIN → the farm re-creates every still-farmed dir (closes the round-trip)
  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]
  local d
  for d in agents agents/references skills/skill-one/references rules; do
    [[ -d "${TARGET}/${d}" ]] || { echo "not re-created: ${d}"; false; }
  done
}

@test "PART B: dry-run cleanup removes nothing (report-only)" {
  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]

  GA_TEST_DRY="true" run_cleanup_seq
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"would rmdir GA dir if empty"* ]]

  # symlinks + dirs are all still present (zero mutation)
  [[ -L "${TARGET}/agents/dev-x.md" ]]
  [[ -d "${TARGET}/agents/references" ]]
  [[ -d "${TARGET}/rules" ]]
}

# === read_manifest_dirs — the derived candidate set ==========================

@test "read_manifest_dirs: deepest-first, skips install-internal + top-level files + excluded surfaces" {
  run_ga read_manifest_dirs
  [[ "${status}" -eq 0 ]]

  # install-internal (lib/) and the top-level file contribute NO dir
  [[ "${output}" != *"lib"* ]]
  # every still-farmed ancestor dir is present
  [[ "${output}" == *"agents/references"* ]]
  [[ "${output}" == *"skills/skill-one/references"* ]]
  # DIR-PRUNE-SITE exclusion: the excluded prefixes never contribute a dir
  [[ "${output}" != *"hooks"* ]]
  [[ "${output}" != *"scoped"* ]]

  # deepest-first: a descendant is listed BEFORE its ancestor (rmdir children first)
  local idx_child idx_parent
  idx_child="$(printf '%s\n' "${lines[@]}" | grep -nxF 'agents/references' | cut -d: -f1)"
  idx_parent="$(printf '%s\n' "${lines[@]}" | grep -nxF 'agents' | cut -d: -f1)"
  [[ -n "${idx_child}" && -n "${idx_parent}" ]]
  [[ "${idx_child}" -lt "${idx_parent}" ]]
}
