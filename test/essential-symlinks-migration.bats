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
#   4. DISPATCH PATH — the `glass-atrium migrate` passthrough subcommand reaches
#      migrate_layout through the REAL binary (GA_ROOT = the repo dir, so the
#      seeded legacy links point into the repo), honoring --dry-run.
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
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

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
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
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

# Failed check → the last run's output + the actual state of <path> (a real dir recursively), then fail.
fail_with_state() {
  printf 'output:\n%s\n' "${output-}"
  if [[ $# -gt 0 ]]; then
    ls -ld -- "$1" 2>&1
    [[ -d "$1" && ! -L "$1" ]] && ls -lAR -- "$1" 2>&1
  fi
  return 1
}

# === 1. FOLDERED-RULES link lands correctly (swap_symlink path-transparency) ==

@test "foldered-rules: a rules/glass-atrium/<name>.md manifest entry farms to the correct target with subdir auto-create" {
  seed_src "agents/dev-x.md"
  seed_src "rules/glass-atrium/rule-a.md"
  seed_src "hooks/hook-a.sh"                  # excluded surface
  seed_src "scripts/wiki-sync.sh"            # newly-excluded surface
  seed_src "autoagent/daemon-cycle.sh"       # newly-excluded surface
  seed_src "agent-registry.json"             # excluded surface
  seed_src "test/root-suite.bats"            # root test/ — bundled, run in place, never farmed
  seed_src "LICENSE"                         # root artifacts — bundled, never farmed
  seed_src "LICENSES-THIRD-PARTY.md"
  seed_src "settings.template.json"
  write_manifest "agents/dev-x.md" "rules/glass-atrium/rule-a.md" "hooks/hook-a.sh" \
    "scripts/wiki-sync.sh" "autoagent/daemon-cycle.sh" "agent-registry.json" \
    "test/root-suite.bats" "LICENSE" "LICENSES-THIRD-PARTY.md" "settings.template.json"

  # precondition: no rules subdir yet
  [[ ! -e "${TARGET}/rules" ]] || fail_with_state "${TARGET}/rules"

  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]] || fail_with_state

  # the glass-atrium/ subdir was auto-created by swap_symlink's per-file mkdir -p
  [[ -d "${TARGET}/rules/glass-atrium" ]] || fail_with_state "${TARGET}/rules/glass-atrium"
  # the foldered link is PATH-TRANSPARENT: dst == TARGET/rel, src == GA_ROOT/rel
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"
  [[ "$(readlink "${TARGET}/rules/glass-atrium/rule-a.md")" == "${GA_SANDBOX}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"
  # a plain still-farmed surface still lands
  [[ -L "${TARGET}/agents/dev-x.md" ]] || fail_with_state "${TARGET}/agents/dev-x.md"
  # excluded surfaces are NOT farmed (create-site choke point)
  [[ ! -e "${TARGET}/hooks" ]] || fail_with_state "${TARGET}/hooks"
  [[ ! -e "${TARGET}/scripts" ]] || fail_with_state "${TARGET}/scripts"
  [[ ! -e "${TARGET}/autoagent" ]] || fail_with_state "${TARGET}/autoagent"
  [[ ! -e "${TARGET}/agent-registry.json" ]] || fail_with_state "${TARGET}/agent-registry.json"
  # root test/ rides the SYMLINK_EXCLUDE_PREFIXES "test/" prefix — bundled but never symlinked
  [[ ! -e "${TARGET}/test" ]] || fail_with_state "${TARGET}/test"
  # Root artifacts ride SYMLINK_EXCLUDE_EXACT: a ~/.claude/settings.template.json
  # beside the real settings.json is a confusion surface, and the licence pair has
  # no ~/.claude consumer. One chained final command, so every member gates on both
  # legs — a mid-body bare `[[ ]]` is inert on bash 3.2.57 (measured, bats 1.13.0 on
  # both legs, so bash is the variable, not bats).
  [[ ! -e "${TARGET}/LICENSE" ]] && [[ ! -e "${TARGET}/LICENSES-THIRD-PARTY.md" ]] &&
    [[ ! -e "${TARGET}/settings.template.json" ]] || fail_with_state "${TARGET}"
}

# === 2. UNINSTALL symmetry for the foldered layout ===========================

@test "foldered-rules: read_manifest_dirs emits rules/glass-atrium BEFORE rules (deepest-first)" {
  seed_src "rules/glass-atrium/rule-a.md"
  seed_src "hooks/hook-a.sh"
  write_manifest "rules/glass-atrium/rule-a.md" "hooks/hook-a.sh"

  run_ga read_manifest_dirs
  [[ "${status}" -eq 0 ]] || fail_with_state
  # both ancestor dirs are emitted, excluded prefixes are not
  [[ "${output}" == *"rules/glass-atrium"* ]] || fail_with_state
  [[ "${output}" != *"hooks"* ]] || fail_with_state

  local idx_child idx_parent
  idx_child="$(printf '%s\n' "${lines[@]}" | grep -nxF 'rules/glass-atrium' | cut -d: -f1)"
  idx_parent="$(printf '%s\n' "${lines[@]}" | grep -nxF 'rules' | cut -d: -f1)"
  [[ -n "${idx_child}" && -n "${idx_parent}" ]] || fail_with_state
  # deepest-first → the subdir is pruned before its parent
  [[ "${idx_child}" -lt "${idx_parent}" ]] || fail_with_state
}

@test "foldered-rules: uninstall unlinks the foldered link + prunes the emptied glass-atrium subdir" {
  seed_src "agents/dev-x.md"
  seed_src "rules/glass-atrium/rule-a.md"
  seed_src "hooks/hook-a.sh"
  seed_src "glass-atrium"
  write_manifest "agents/dev-x.md" "rules/glass-atrium/rule-a.md" "hooks/hook-a.sh" "glass-atrium"

  run_ga run_symlink_farm install
  [[ "${status}" -eq 0 ]] || fail_with_state
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"

  run env GA_LIB_DIR="${GA_LIB_DIR}" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      remove_manifest_links
      sweep_orphans
      remove_empty_dirs
    ' _ "${GA}" "${GA_SANDBOX}"
  [[ "${status}" -eq 0 ]] || fail_with_state

  # the foldered link is unlinked and BOTH the emptied subdir and its parent pruned
  [[ ! -e "${TARGET}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"
  [[ ! -e "${TARGET}/rules/glass-atrium" ]] || fail_with_state "${TARGET}/rules/glass-atrium"
  [[ ! -e "${TARGET}/rules" ]] || fail_with_state "${TARGET}/rules"
  # excluded surfaces were never linked → nothing dangling
  [[ ! -e "${TARGET}/hooks" ]] || fail_with_state "${TARGET}/hooks"
  [[ ! -e "${TARGET}/glass-atrium" ]] || fail_with_state "${TARGET}/glass-atrium"
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
  seed_src "scripts/wiki-sync.sh"            # newly-excluded surface (top-level)
  seed_src "scripts/lib/atrium-config.sh"    # newly-excluded surface (nested → recursive sweep)
  seed_src "autoagent/daemon-cycle.sh"       # newly-excluded surface (top-level)
  seed_src "autoagent/lib/git-txn.sh"        # newly-excluded surface (nested → recursive sweep)
  seed_src "agent-registry.json"
  seed_src "glass-atrium"
  seed_src "rules/rule-a.md"                 # legacy flat source (pre-fold)
  seed_src "rules/rule-b.md"                 # legacy flat source, NOT foldable
  seed_src "rules/glass-atrium/rule-a.md"    # foldered source EXISTS → rule-a foldable

  mkdir -p "${TARGET}/hooks" "${TARGET}/scoped" "${TARGET}/scripts/lib" \
    "${TARGET}/autoagent/lib" "${TARGET}/rules"
  # legacy GA symlinks (must be removed)
  ln -s "${GA_SANDBOX}/hooks/hook-a.sh" "${TARGET}/hooks/hook-a.sh"
  ln -s "${GA_SANDBOX}/scoped/scope-x.md" "${TARGET}/scoped/scope-x.md"
  # scripts/ + autoagent/ legacy links, incl. NESTED — the recursive find sweep
  # (no maxdepth) must drop the nested links too, not just the top-level ones.
  ln -s "${GA_SANDBOX}/scripts/wiki-sync.sh" "${TARGET}/scripts/wiki-sync.sh"
  ln -s "${GA_SANDBOX}/scripts/lib/atrium-config.sh" "${TARGET}/scripts/lib/atrium-config.sh"
  ln -s "${GA_SANDBOX}/autoagent/daemon-cycle.sh" "${TARGET}/autoagent/daemon-cycle.sh"
  ln -s "${GA_SANDBOX}/autoagent/lib/git-txn.sh" "${TARGET}/autoagent/lib/git-txn.sh"
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
  [[ "${status}" -eq 0 ]] || fail_with_state

  # (A) the dropped surfaces' GA symlinks are unlinked (incl. the two newly-excluded
  # prefixes scripts/ + autoagent/, both top-level AND nested — recursive sweep)
  [[ ! -e "${TARGET}/hooks/hook-a.sh" ]] || fail_with_state "${TARGET}/hooks/hook-a.sh"
  [[ ! -e "${TARGET}/scoped/scope-x.md" ]] || fail_with_state "${TARGET}/scoped/scope-x.md"
  [[ ! -e "${TARGET}/scripts/wiki-sync.sh" ]] || fail_with_state "${TARGET}/scripts/wiki-sync.sh"
  [[ ! -e "${TARGET}/scripts/lib/atrium-config.sh" ]] || fail_with_state "${TARGET}/scripts/lib/atrium-config.sh"
  [[ ! -e "${TARGET}/autoagent/daemon-cycle.sh" ]] || fail_with_state "${TARGET}/autoagent/daemon-cycle.sh"
  [[ ! -e "${TARGET}/autoagent/lib/git-txn.sh" ]] || fail_with_state "${TARGET}/autoagent/lib/git-txn.sh"
  [[ ! -e "${TARGET}/agent-registry.json" ]] || fail_with_state "${TARGET}/agent-registry.json"
  [[ ! -e "${TARGET}/glass-atrium" ]] || fail_with_state "${TARGET}/glass-atrium"

  # DATA-SAFETY: the FOREIGN symlink + REAL user file are byte-preserved
  [[ -L "${TARGET}/hooks/foreign-user.sh" ]] || fail_with_state "${TARGET}/hooks/foreign-user.sh"
  [[ "$(readlink "${TARGET}/hooks/foreign-user.sh")" == "/tmp/ga-user-owned-target.sh" ]] || fail_with_state "${TARGET}/hooks/foreign-user.sh"
  [[ "$(cat "${TARGET}/hooks/user-real.sh")" == "USER HOOK BODY" ]] || fail_with_state "${TARGET}/hooks/user-real.sh"
  # hooks/ dir SURVIVES (still holds the foreign + user files) — rmdir-only safety
  [[ -d "${TARGET}/hooks" ]] || fail_with_state "${TARGET}/hooks"
  # scoped/ held ONLY a top-level GA link → emptied → rmdir-pruned
  [[ ! -e "${TARGET}/scoped" ]] || fail_with_state "${TARGET}/scoped"
  # scripts/ + autoagent/ carried NESTED links, so after the recursive sweep drops
  # every link the top-level rmdir-prune (non-recursive) fails on the leftover empty
  # lib/ subdir → the dir survives as EMPTY residue (0 links = AC-T2b threshold met;
  # empty-dir residue is outside the threshold, cleaned manually post-deploy). Assert
  # the invariant that actually matters: zero GA links remain under either prefix.
  [[ -z "$(find "${TARGET}/scripts" -type l -lname "${GA_SANDBOX}/*" 2>/dev/null)" ]] || fail_with_state "${TARGET}/scripts"
  [[ -z "$(find "${TARGET}/autoagent" -type l -lname "${GA_SANDBOX}/*" 2>/dev/null)" ]] || fail_with_state "${TARGET}/autoagent"

  # (B) the foldable flat rules link is RELOCATED to the foldered path
  [[ ! -e "${TARGET}/rules/rule-a.md" ]] || fail_with_state "${TARGET}/rules/rule-a.md"
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"
  [[ "$(readlink "${TARGET}/rules/glass-atrium/rule-a.md")" == "${GA_SANDBOX}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"
  # the NON-foldable flat rules link (no foldered source) is LEFT INTACT (no dangling)
  [[ -L "${TARGET}/rules/rule-b.md" ]] || fail_with_state "${TARGET}/rules/rule-b.md"
  [[ ! -e "${TARGET}/rules/glass-atrium/rule-b.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-b.md"
}

@test "migrate_layout: a second run is a clean no-op, preservation holds" {
  seed_legacy_farm
  run_ga migrate_layout
  [[ "${status}" -eq 0 ]] || fail_with_state

  # second run drops nothing and folds nothing
  run_ga migrate_layout
  [[ "${status}" -eq 0 ]] || fail_with_state
  [[ "${output}" == *"0 legacy GA symlink(s) dropped, 0 rules link(s) foldered"* ]] || fail_with_state

  # preservation still holds after the idempotent re-run
  [[ -L "${TARGET}/hooks/foreign-user.sh" ]] || fail_with_state "${TARGET}/hooks/foreign-user.sh"
  [[ "$(cat "${TARGET}/hooks/user-real.sh")" == "USER HOOK BODY" ]] || fail_with_state "${TARGET}/hooks/user-real.sh"
  [[ -L "${TARGET}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"
  [[ -L "${TARGET}/rules/rule-b.md" ]] || fail_with_state "${TARGET}/rules/rule-b.md"
}

@test "migrate_layout: dry-run performs zero mutation" {
  seed_legacy_farm

  GA_TEST_DRY="true" run_ga migrate_layout
  [[ "${status}" -eq 0 ]] || fail_with_state

  # every legacy GA symlink is still present (report-only)
  [[ -L "${TARGET}/hooks/hook-a.sh" ]] || fail_with_state "${TARGET}/hooks/hook-a.sh"
  [[ -L "${TARGET}/scoped/scope-x.md" ]] || fail_with_state "${TARGET}/scoped/scope-x.md"
  [[ -L "${TARGET}/agent-registry.json" ]] || fail_with_state "${TARGET}/agent-registry.json"
  [[ -L "${TARGET}/glass-atrium" ]] || fail_with_state "${TARGET}/glass-atrium"
  [[ -L "${TARGET}/rules/rule-a.md" ]] || fail_with_state "${TARGET}/rules/rule-a.md"
  # no foldered link was created
  [[ ! -e "${TARGET}/rules/glass-atrium/rule-a.md" ]] || fail_with_state "${TARGET}/rules/glass-atrium/rule-a.md"
}

@test "migrate_layout: never touches a foreign symlink at an excluded EXACT path" {
  # a user's OWN symlink at agent-registry.json pointing outside GA root
  ln -s "/tmp/ga-user-registry.json" "${TARGET}/agent-registry.json"

  run_ga migrate_layout
  [[ "${status}" -eq 0 ]] || fail_with_state

  # the foreign symlink is preserved (readlink-into-GA guard rejects it)
  [[ -L "${TARGET}/agent-registry.json" ]] || fail_with_state "${TARGET}/agent-registry.json"
  [[ "$(readlink "${TARGET}/agent-registry.json")" == "/tmp/ga-user-registry.json" ]] || fail_with_state "${TARGET}/agent-registry.json"
}

# === 4. DISPATCH PATH (`glass-atrium migrate` passthrough subcommand) =========
# Drives the REAL binary: its ga_init_env pins GA_ROOT to the repo dir, so the
# legacy links are seeded pointing INTO the repo (${GA}) for the -lname /
# readlink-into-GA guards to accept them. GA_TARGET_HOME keeps it hermetic.

# Seed one legacy GA symlink under hooks/ pointing into the REPO GA root.
seed_repo_legacy_link() {
  mkdir -p "${TARGET}/hooks"
  ln -s "${GA}/hooks/track-outcome.sh" "${TARGET}/hooks/legacy-hook.sh"
}

@test "dispatch: 'glass-atrium migrate' drops a legacy GA link via the passthrough" {
  seed_repo_legacy_link

  run env GA_TARGET_HOME="${TARGET}" bash "${GA}/glass-atrium" migrate
  [[ "${status}" -eq 0 ]] || fail_with_state
  [[ "${output}" == *"== migrate:"* ]] || fail_with_state
  [[ "${output}" == *"1 legacy GA symlink(s) dropped"* ]] || fail_with_state
  [[ ! -e "${TARGET}/hooks/legacy-hook.sh" ]] || fail_with_state "${TARGET}/hooks/legacy-hook.sh"
}

@test "dispatch: 'glass-atrium --dry-run migrate' reports without mutating" {
  seed_repo_legacy_link

  run env GA_TARGET_HOME="${TARGET}" bash "${GA}/glass-atrium" --dry-run migrate
  [[ "${status}" -eq 0 ]] || fail_with_state
  [[ "${output}" == *"dry-run: report only"* ]] || fail_with_state
  [[ -L "${TARGET}/hooks/legacy-hook.sh" ]] || fail_with_state "${TARGET}/hooks/legacy-hook.sh"
}

@test "remove_if_ga_link: an unlink that leaves the GA link in place fails loudly and is not reported removed" {
  seed_src "agents/dev-x.md"
  mkdir -p "${TARGET}/agents"
  ln -s "${GA_SANDBOX}/agents/dev-x.md" "${TARGET}/agents/dev-x.md"
  # an rm that deletes nothing: the unlink reports success while the link survives
  local stub="${SANDBOX}/stub-bin"
  mkdir -p "${stub}"
  printf '#!/bin/sh\nexit 0\n' >"${stub}/rm"
  chmod +x "${stub}/rm"
  PATH="${stub}:${PATH}" run_ga remove_if_ga_link "${TARGET}/agents/dev-x.md"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"still present after unlink"* ]] || return 1
  [[ "${output}" != *"removed:"* ]] || return 1
  [[ -L "${TARGET}/agents/dev-x.md" ]]
}
