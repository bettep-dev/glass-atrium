#!/usr/bin/env bats
# P2 essential-symlinks-only + foldered-rules + legacy-farm migration (ga-core.sh).
#
# Covers the P2 farm mechanic this unit owns:
#   1. FOLDERED-RULES link lands correctly — with the manifest source path itself
#      foldered (rules/glass-atrium/<name>.md), swap_symlink is PATH-TRANSPARENT
#      (dst = TARGET/rel) and its per-file `mkdir -p` auto-creates the
#      glass-atrium/ subdir. swap_symlink is UNCHANGED (no rel->dst rewrite helper
#      — that would double-fold once the manifest is foldered); foldering is proven
#      by a nested-path case only.
#   2. UNINSTALL symmetry for the foldered layout — remove_manifest_links unlinks
#      the foldered link and read_manifest_dirs emits rules/glass-atrium BEFORE
#      rules (deepest-first), so remove_empty_dirs rmdir-prunes the emptied
#      glass-atrium/ subdir before its parent. Excluded surfaces are never linked
#      nor removal-attempted (single choke point).
#   3. LEGACY-FARM MIGRATION (migrate_layout) — an existing bare-name farm is
#      reconciled: GA-created legacy symlinks for the four dropped surfaces are
#      unlinked and flat rules links are relocated to the foldered path, while a
#      FOREIGN symlink and a REAL user file at those paths are byte-preserved
#      (every unlink routes through remove_if_ga_link's readlink-into-GA guard).
#      Idempotent: a second run is a clean no-op.
#
# Run via: bats test/essential-symlinks-migration.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+
#
# Hermetic strategy (mirrors uninstall-empty-dirs.bats): GA_TARGET_HOME +
# GA_MANIFEST + GA_LIB_DIR pin a throwaway sandbox; each driver sources the REAL
# engine in its own subprocess under `set -Eeuo pipefail`, so no real ~/.claude
# is touched and `readonly GA_ROOT` never leaks.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-p2-migr-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga" # sandbox GA_ROOT — the source bodies live here
  TARGET="${SANDBOX}/target" # throwaway install target
  MANIFEST="${SANDBOX}/manifest.json"
  mkdir -p "${TARGET}"

  export GA_LIB_DIR="${GA}/scripts/lib"
  export GA_TARGET_HOME="${TARGET}"
  export GA_MANIFEST="${MANIFEST}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Seed a GA_ROOT source file for <rel>.
seed_src() {
  local rel="$1"
  mkdir -p -- "$(dirname -- "${GA_SANDBOX}/${rel}")"
  printf 'ga-source: %s\n' "${rel}" >"${GA_SANDBOX}/${rel}"
}

# Write a synthetic manifest listing the given rels.
write_manifest() {
  printf '%s\n' "$@" | jq -R . | jq -s '{version:"1.0.0", files:.}' >"${MANIFEST}"
}

# Drive one or more sourced engine functions (fresh subprocess). Honors GA_TEST_DRY.
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

# === 1. FOLDERED-RULES link lands correctly (swap_symlink path-transparency) ==

@test "foldered-rules: a rules/glass-atrium/<name>.md manifest entry farms to the correct target with subdir auto-create" {
  seed_src "agents/dev-x.md"
  seed_src "rules/glass-atrium/rule-a.md"
  seed_src "hooks/hook-a.sh"          # excluded surface
  seed_src "agent-registry.json"      # excluded surface
  write_manifest "agents/dev-x.md" "rules/glass-atrium/rule-a.md" "hooks/hook-a.sh" "agent-registry.json"

  # precondition: no rules subdir yet
  [[ ! -e "${TARGET}/rules" ]]

  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]

  # the glass-atrium/ subdir was auto-created by swap_symlink's per-file mkdir -p
  [[ -d "${TARGET}/rules/glass-atrium" ]]
  # the foldered link is PATH-TRANSPARENT: dst == TARGET/rel, src == GA_ROOT/rel
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]]
  [[ "$(readlink "${TARGET}/rules/glass-atrium/rule-a.md")" == "${GA_SANDBOX}/rules/glass-atrium/rule-a.md" ]]
  # a plain still-farmed surface still lands
  [[ -L "${TARGET}/agents/dev-x.md" ]]
  # excluded surfaces are NOT farmed (create-site choke point)
  [[ ! -e "${TARGET}/hooks" ]]
  [[ ! -e "${TARGET}/agent-registry.json" ]]
}

# === 2. UNINSTALL symmetry for the foldered layout ===========================

@test "foldered-rules: read_manifest_dirs emits rules/glass-atrium BEFORE rules (deepest-first)" {
  seed_src "rules/glass-atrium/rule-a.md"
  seed_src "hooks/hook-a.sh"
  write_manifest "rules/glass-atrium/rule-a.md" "hooks/hook-a.sh"

  run_ga read_manifest_dirs
  [[ "${status}" -eq 0 ]]
  # both ancestor dirs are emitted, excluded prefixes are not
  [[ "${output}" == *"rules/glass-atrium"* ]]
  [[ "${output}" != *"hooks"* ]]

  local idx_child idx_parent
  idx_child="$(printf '%s\n' "${lines[@]}" | grep -nxF 'rules/glass-atrium' | cut -d: -f1)"
  idx_parent="$(printf '%s\n' "${lines[@]}" | grep -nxF 'rules' | cut -d: -f1)"
  [[ -n "${idx_child}" && -n "${idx_parent}" ]]
  # deepest-first → the subdir is pruned before its parent
  [[ "${idx_child}" -lt "${idx_parent}" ]]
}

@test "foldered-rules: uninstall unlinks the foldered link + prunes the emptied glass-atrium subdir" {
  seed_src "agents/dev-x.md"
  seed_src "rules/glass-atrium/rule-a.md"
  seed_src "hooks/hook-a.sh"
  seed_src "glass-atrium"
  write_manifest "agents/dev-x.md" "rules/glass-atrium/rule-a.md" "hooks/hook-a.sh" "glass-atrium"

  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]]
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]]

  run env GA_LIB_DIR="${GA_LIB_DIR}" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      remove_manifest_links
      sweep_orphans
      remove_empty_dirs
    ' _ "${GA}" "${GA_SANDBOX}"
  [[ "${status}" -eq 0 ]]

  # the foldered link is unlinked and BOTH the emptied subdir and its parent pruned
  [[ ! -e "${TARGET}/rules/glass-atrium/rule-a.md" ]]
  [[ ! -e "${TARGET}/rules/glass-atrium" ]]
  [[ ! -e "${TARGET}/rules" ]]
  # excluded surfaces were never linked → nothing dangling
  [[ ! -e "${TARGET}/hooks" ]]
  [[ ! -e "${TARGET}/glass-atrium" ]]
}

# === 3. LEGACY-FARM MIGRATION (migrate_layout) ===============================

# Seed an EXISTING bare-name farm into the target: GA symlinks for the dropped
# surfaces + flat rules links, plus a FOREIGN symlink and a REAL user file that
# migrate_layout must preserve.
seed_legacy_farm() {
  # GA sources (for realism; remove_if_ga_link keys on the readlink prefix, not
  # source existence).
  seed_src "hooks/hook-a.sh"
  seed_src "scoped/scope-x.md"
  seed_src "agent-registry.json"
  seed_src "glass-atrium"
  seed_src "rules/rule-a.md"                 # legacy flat source (pre-fold)
  seed_src "rules/rule-b.md"                 # legacy flat source, NOT foldable
  seed_src "rules/glass-atrium/rule-a.md"    # foldered source EXISTS → rule-a foldable

  mkdir -p "${TARGET}/hooks" "${TARGET}/scoped" "${TARGET}/rules"
  # legacy GA symlinks (must be removed)
  ln -s "${GA_SANDBOX}/hooks/hook-a.sh" "${TARGET}/hooks/hook-a.sh"
  ln -s "${GA_SANDBOX}/scoped/scope-x.md" "${TARGET}/scoped/scope-x.md"
  ln -s "${GA_SANDBOX}/agent-registry.json" "${TARGET}/agent-registry.json"
  ln -s "${GA_SANDBOX}/glass-atrium" "${TARGET}/glass-atrium"
  ln -s "${GA_SANDBOX}/rules/rule-a.md" "${TARGET}/rules/rule-a.md"   # foldable flat link
  ln -s "${GA_SANDBOX}/rules/rule-b.md" "${TARGET}/rules/rule-b.md"   # non-foldable flat link
  # a FOREIGN symlink + a REAL user file that MUST be preserved
  ln -s "/tmp/ga-user-owned-target.sh" "${TARGET}/hooks/foreign-user.sh"
  printf 'USER HOOK BODY\n' >"${TARGET}/hooks/user-real.sh"
}

@test "migrate_layout: drops legacy GA symlinks, preserves foreign symlink + real user file, folds rules" {
  seed_legacy_farm

  run_ga migrate_layout
  [[ "${status}" -eq 0 ]]

  # (A) the four dropped surfaces' GA symlinks are unlinked
  [[ ! -e "${TARGET}/hooks/hook-a.sh" ]]
  [[ ! -e "${TARGET}/scoped/scope-x.md" ]]
  [[ ! -e "${TARGET}/agent-registry.json" ]]
  [[ ! -e "${TARGET}/glass-atrium" ]]

  # DATA-SAFETY: the FOREIGN symlink + REAL user file are byte-preserved
  [[ -L "${TARGET}/hooks/foreign-user.sh" ]]
  [[ "$(readlink "${TARGET}/hooks/foreign-user.sh")" == "/tmp/ga-user-owned-target.sh" ]]
  [[ "$(cat "${TARGET}/hooks/user-real.sh")" == "USER HOOK BODY" ]]
  # hooks/ dir SURVIVES (still holds the foreign + user files) — rmdir-only safety
  [[ -d "${TARGET}/hooks" ]]
  # scoped/ held ONLY the GA link → emptied → rmdir-pruned
  [[ ! -e "${TARGET}/scoped" ]]

  # (B) the foldable flat rules link is RELOCATED to the foldered path
  [[ ! -e "${TARGET}/rules/rule-a.md" ]]
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]]
  [[ "$(readlink "${TARGET}/rules/glass-atrium/rule-a.md")" == "${GA_SANDBOX}/rules/glass-atrium/rule-a.md" ]]
  # the NON-foldable flat rules link (no foldered source) is LEFT INTACT (no dangling)
  [[ -L "${TARGET}/rules/rule-b.md" ]]
  [[ ! -e "${TARGET}/rules/glass-atrium/rule-b.md" ]]
}

@test "migrate_layout: a second run is a clean no-op, preservation holds" {
  seed_legacy_farm
  run_ga migrate_layout
  [[ "${status}" -eq 0 ]]

  # second run drops nothing and folds nothing
  run_ga migrate_layout
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"0 legacy GA symlink(s) dropped, 0 rules link(s) foldered"* ]]

  # preservation still holds after the idempotent re-run
  [[ -L "${TARGET}/hooks/foreign-user.sh" ]]
  [[ "$(cat "${TARGET}/hooks/user-real.sh")" == "USER HOOK BODY" ]]
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]]
  [[ -L "${TARGET}/rules/rule-b.md" ]]
}

@test "migrate_layout: dry-run performs zero mutation" {
  seed_legacy_farm

  GA_TEST_DRY="true" run_ga migrate_layout
  [[ "${status}" -eq 0 ]]

  # every legacy GA symlink is still present (report-only)
  [[ -L "${TARGET}/hooks/hook-a.sh" ]]
  [[ -L "${TARGET}/scoped/scope-x.md" ]]
  [[ -L "${TARGET}/agent-registry.json" ]]
  [[ -L "${TARGET}/glass-atrium" ]]
  [[ -L "${TARGET}/rules/rule-a.md" ]]
  # no foldered link was created
  [[ ! -e "${TARGET}/rules/glass-atrium/rule-a.md" ]]
}

@test "migrate_layout: never touches a foreign symlink at an excluded EXACT path" {
  # a user's OWN symlink at agent-registry.json pointing outside GA root
  ln -s "/tmp/ga-user-registry.json" "${TARGET}/agent-registry.json"

  run_ga migrate_layout
  [[ "${status}" -eq 0 ]]

  # the foreign symlink is preserved (readlink-into-GA guard rejects it)
  [[ -L "${TARGET}/agent-registry.json" ]]
  [[ "$(readlink "${TARGET}/agent-registry.json")" == "/tmp/ga-user-registry.json" ]]
}
