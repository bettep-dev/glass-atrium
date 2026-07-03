#!/usr/bin/env bats
# glass-atrium `prune` subcommand — unit coverage for the SAFE orphan-dangling-GA-
# symlink remover (recurrence-prevention for the dangling-symlink issue).
#
# The symlink farm has no prune path: a source dropped from the GA root AND the
# manifest leaves its installed symlink in the target dangling forever (doctor §5
# only WARN-counts danglers). run_prune unlinks an orphan ONLY when ALL FOUR
# criteria hold — (a) IS a symlink, (b) is BROKEN, (c) target under GA root,
# (d) its TARGET_HOME-rel path is NOT in manifest .files — plus an is_never_touch
# defense-in-depth preserve branch. A broken link that IS in the manifest is a
# transiently-missing should-exist source → preserved + flagged.
#
# Hermetic strategy: GA_TARGET_HOME points the target at a throwaway dir and
# GA_MANIFEST points at a tree-matched sandbox manifest (mirrors the GA_TARGET_HOME
# override in doctor-hook-bindings.bats). BUT the prune `find -lname` matches the
# REAL GA_ROOT (= the dir of the glass-atrium entry being run), so each test plants its
# symlink targets under that REAL root — links into a foreign tree would not be
# enumerated. mktemp -d + teardown rm -rf, NEVER the live ~/.claude.
#
# Run via: bats test/install-prune.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA_ROOT_DIR="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA_ROOT_DIR}/glass-atrium"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  SANDBOX="$(mktemp -d -t install-prune-bats.XXXXXX)"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  # symlink-target scratch UNDER the real GA root so `find -lname GA_ROOT/*`
  # enumerates the planted links. A unique per-run subdir keeps it isolated; it
  # holds only orphan placeholders (we delete the source to make a link broken),
  # so it is regenerable scratch — rm in teardown.
  GA_SCRATCH="${GA_ROOT_DIR}/.prune-bats-scratch.$$"
  mkdir -p "${TARGET}/agents" "${GA_SCRATCH}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
  [[ -n "${GA_SCRATCH:-}" && -d "${GA_SCRATCH}" ]] && rm -rf -- "${GA_SCRATCH}" || true
}

# write a manifest.json whose .files is the given relative-path list.
write_manifest() {
  local f="${MANIFEST}"
  printf '%s\n' "$@" | jq -R . | jq -s '{files: .}' >"${f}"
}

# run the real glass-atrium prune against the sandboxed target + manifest.
run_prune_sandbox() {
  GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" run "${REAL_GA}" "$@"
}

# plant a BROKEN symlink at <target-rel> pointing into the GA scratch dir at a
# source that does NOT exist (orphan dangler into GA root).
plant_orphan_link() {
  local target_rel="$1"
  ln -s "${GA_SCRATCH}/gone-${RANDOM}.md" "${TARGET}/${target_rel}"
}

# plant a RESOLVING symlink at <target-rel> pointing into the GA scratch dir at a
# source that DOES exist.
plant_live_link() {
  local target_rel="$1" src
  src="${GA_SCRATCH}/live-${RANDOM}.md"
  printf 'src\n' >"${src}"
  ln -s "${src}" "${TARGET}/${target_rel}"
}

# === orphan removed ==========================================================
@test "orphan symlink (broken, into GA, not in manifest) is unlinked" {
  write_manifest "agents/kept.md"
  plant_orphan_link "agents/orphan.md"
  run_prune_sandbox prune
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"removed orphan GA symlink"* ]]
  [[ "${output}" == *"1 pruned"* ]]
  # filesystem: the symlink is gone.
  [[ ! -L "${TARGET}/agents/orphan.md" ]]
}

# === resolving symlink preserved =============================================
@test "resolving symlink (source exists) is preserved and not pruned" {
  write_manifest "agents/kept.md"
  plant_live_link "agents/live.md"
  run_prune_sandbox prune
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"0 pruned"* ]]
  # still present (criterion b: a resolving link is never a removal candidate).
  [[ -L "${TARGET}/agents/live.md" ]]
  [[ -e "${TARGET}/agents/live.md" ]]
}

# === manifest-listed broken symlink preserved + flagged ======================
@test "broken symlink whose rel IS in manifest is preserved and flagged" {
  write_manifest "agents/inmanifest.md"
  plant_orphan_link "agents/inmanifest.md"
  run_prune_sandbox prune
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"broken GA symlink in manifest"* ]]
  [[ "${output}" == *"1 flagged in-manifest"* ]]
  # NOT pruned — a transiently-missing should-exist source.
  [[ "${output}" == *"0 pruned"* ]]
  [[ -L "${TARGET}/agents/inmanifest.md" ]]
}

# === non-symlink real file preserved =========================================
@test "non-symlink real file is preserved (find -type l never selects it)" {
  write_manifest "agents/kept.md"
  printf 'real\n' >"${TARGET}/agents/real.md"
  plant_orphan_link "agents/orphan.md"
  run_prune_sandbox prune
  [[ "${status}" -eq 0 ]]
  # the orphan goes, the real file stays.
  [[ ! -L "${TARGET}/agents/orphan.md" ]]
  [[ -f "${TARGET}/agents/real.md" ]]
  [[ ! -L "${TARGET}/agents/real.md" ]]
}

# === --dry-run removes nothing ===============================================
@test "--dry-run prune reports but removes nothing" {
  write_manifest "agents/kept.md"
  plant_orphan_link "agents/orphan.md"
  run_prune_sandbox --dry-run prune
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"would prune orphan GA symlink"* ]]
  [[ "${output}" == *"1 would be pruned"* ]]
  # the link is STILL present (report-only).
  [[ -L "${TARGET}/agents/orphan.md" ]]
}

# === empty-set no-op =========================================================
@test "no GA symlinks under target → no-op rc 0" {
  write_manifest "agents/kept.md"
  printf 'real\n' >"${TARGET}/agents/real.md"
  run_prune_sandbox prune
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"no GA symlinks under target"* ]]
  [[ -f "${TARGET}/agents/real.md" ]]
}

# === never-touch path preserved ==============================================
@test "broken GA symlink under a never-touch top-level is preserved" {
  write_manifest "agents/kept.md"
  # "projects" is a NEVER_TOUCH_EXACT entry — a broken GA symlink there must be
  # preserved by the is_never_touch defense-in-depth branch even though its rel
  # is NOT in the manifest (criterion d alone would otherwise prune it).
  mkdir -p "${TARGET}/projects"
  plant_orphan_link "projects/stray.md"
  run_prune_sandbox prune
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"never-touch path preserved"* ]]
  [[ "${output}" == *"0 pruned"* ]]
  [[ "${output}" == *"1 preserved never-touch"* ]]
  [[ -L "${TARGET}/projects/stray.md" ]]
}

# === foreign dangling symlink preserved ======================================
@test "broken symlink pointing OUTSIDE GA root is not a candidate" {
  write_manifest "agents/kept.md"
  # target points into the sandbox (outside the GA root) → find -lname GA/* never
  # matches it, so it is neither pruned nor even counted as a candidate.
  ln -s "${SANDBOX}/foreign/nope.md" "${TARGET}/agents/foreign.md"
  run_prune_sandbox prune
  [[ "${status}" -eq 0 ]]
  # no GA symlinks were enumerated → the no-orphan no-op path.
  [[ "${output}" == *"no GA symlinks under target"* ]]
  [[ -L "${TARGET}/agents/foreign.md" ]]
}

# === precondition loud-fail — missing target dir =============================
@test "missing target home exits PRUNE_EXIT_NO_TARGET (2)" {
  write_manifest "agents/kept.md"
  GA_TARGET_HOME="${SANDBOX}/does-not-exist" GA_MANIFEST="${MANIFEST}" \
    run "${REAL_GA}" prune
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"prune target home not a directory"* ]]
}

# === precondition loud-fail — unparseable manifest ===========================
@test "manifest with non-array .files exits PRUNE_EXIT_NO_MANIFEST (3)" {
  printf '{"files": "not-an-array"}\n' >"${MANIFEST}"
  run_prune_sandbox prune
  [[ "${status}" -eq 3 ]]
  [[ "${output}" == *"manifest absent or .files not an array"* ]]
}
