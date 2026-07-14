#!/usr/bin/env bats
# mirror-farm.sh suite — pins the shared facade mirror-farm refresh wrapper
# (incident #58325 systemic fix): the install / update / manifest-regeneration
# flows re-run the ~/.claude per-file symlink farm through ONE probe-guarded
# wrapper around the CANONICAL sync entrypoint (`glass-atrium agents-only`).
#
# The cases pinned here:
#   1. new-file-gets-mirrored     → farm_refresh creates <facade>/<rel> ->
#                                   <ga_root>/<rel> for a new manifest entry
#   2. idempotent double-run      → 2nd run is "skip (already correct)", the
#                                   link set is unchanged
#   3. mistargeted mirror repaired→ a GA-pointing link with the WRONG target is
#                                   atomically re-swapped to the correct one
#   4. facade-absent no-op        → rc 3 clean skip, nothing created (consumer
#                                   machine without a facade)
#   5. launcher-absent loud skip  → rc 3 + WARN (never a silent absorb)
#   6. non-facade files untouched → real user files + foreign symlinks survive
#                                   refresh AND the opt-in prune byte-intact
#   7. stale mirror pruning       → --dry-run ADVISORY reports without removing;
#                                   the explicit opt-in `prune` removes it under
#                                   the 4-criteria guard
#   8. missing-source filter      → farm_write_present_manifest warn+skips a
#                                   manifest entry with no on-disk source (the
#                                   update-context sensitive-refusal edge)
#   9. deployment detection       → farm_has_ga_links flips no -> yes once a
#                                   mirror exists
#
# Run via: bats scripts/test/mirror-farm.bats
# Requires: bats >= 1.5.0, jq
#
# Hermetic strategy: a per-test mktemp sandbox holds a REAL engine copy
# (glass-atrium + lib/ga-core.sh + lib/ga-deps.sh) as the sandbox GA root, and
# GA_TARGET_HOME pins the facade to <sandbox>/claude-target — the real
# ~/.claude and the live ~/.glass-atrium install are NEVER written.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
LIB="${GA}/scripts/lib/mirror-farm.sh"

setup() {
  [[ -f "${LIB}" ]] || skip "mirror-farm.sh not found: ${LIB}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  # pwd -P resolves /var -> /private/var so the link targets the engine derives
  # (resolve_self pwd -P) match the paths the test computes.
  WORK="$(cd -- "$(mktemp -d -t mirror-farm-bats.XXXXXX)" && pwd -P)"
  GAROOT="${WORK}/garoot"        # sandbox GA root (real engine copy)
  FACADE="${WORK}/claude-target" # sandbox facade home (GA_TARGET_HOME pin)
  mkdir -p "${GAROOT}/lib" "${GAROOT}/scripts/lib" "${GAROOT}/skills/testkit"
  cp -p "${GA}/glass-atrium" "${GAROOT}/glass-atrium"
  # ga-core.sh is now a THIN LOADER over its domain siblings; the launcher-exec
  # `glass-atrium prune` path sources it, so the whole lib/*.sh set must be
  # present. Glob-copy the full set (byte-identical to the prior explicit list)
  # so a future sibling auto-tracks here instead of loud-failing on the omission.
  cp -p "${GA}/lib/"*.sh "${GAROOT}/lib/"
  # ga_init_env hard-requires several libs from <root>/scripts/lib (loud-fails on
  # ANY omission — the E5 trio AND branch-new siblings like fakechat-cleanup.sh).
  # Glob-copy the full set (mirrors the lib/*.sh copy above, and the sibling
  # install-bootstrap-subcommand.bats) so a future required lib auto-tracks here
  # instead of reintroducing the exact "lib missing" loud-fail.
  cp -p "${GA}/scripts/lib/"*.sh "${GAROOT}/scripts/lib/"
  printf '# shipped lib v1\n' >"${GAROOT}/skills/testkit/newlib.sh"
  write_manifest "skills/testkit/newlib.sh"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Write ${GAROOT}/manifest.json listing the relative paths $@ (farm scope —
# read_manifest_files consumes only .files; hashes are irrelevant to the farm).
write_manifest() {
  local p files=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
  done
  printf '{"version":"1.0.0","files":[%s],"hashes":{}}\n' "${files%,}" \
    >"${GAROOT}/manifest.json"
}

# Run farm_refresh under strict mode with the facade pinned to the sandbox.
# $1 (optional) = a GA_MANIFEST override path passed as farm_refresh $2.
run_refresh() {
  run env GA_TARGET_HOME="${FACADE}" bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    farm_refresh "'"${GAROOT}"'" '"${1:+\"$1\"}"'
  '
}

@test "a new manifest file gains its facade mirror (canonical agents-only subprocess)" {
  mkdir -p "${FACADE}"
  run_refresh
  [ "$status" -eq 0 ]
  [[ -L "${FACADE}/skills/testkit/newlib.sh" ]]
  [[ "$(readlink "${FACADE}/skills/testkit/newlib.sh")" == "${GAROOT}/skills/testkit/newlib.sh" ]]
}

@test "double-run is idempotent (skip already-correct, link unchanged)" {
  mkdir -p "${FACADE}"
  run_refresh
  [ "$status" -eq 0 ]
  run_refresh
  [ "$status" -eq 0 ]
  [[ "$output" == *"skip (already correct): skills/testkit/newlib.sh"* ]]
  [[ "$(readlink "${FACADE}/skills/testkit/newlib.sh")" == "${GAROOT}/skills/testkit/newlib.sh" ]]
}

@test "a mistargeted GA-pointing mirror is repaired (atomic re-swap)" {
  mkdir -p "${FACADE}/skills/testkit"
  # points into the GA root but at the WRONG rel — swap_symlink's safe re-swap
  # branch (a foreign-target symlink would be refused instead).
  ln -s "${GAROOT}/skills/testkit/renamed-away.sh" "${FACADE}/skills/testkit/newlib.sh"
  run_refresh
  [ "$status" -eq 0 ]
  [[ "$(readlink "${FACADE}/skills/testkit/newlib.sh")" == "${GAROOT}/skills/testkit/newlib.sh" ]]
}

@test "facade-absent is a clean no-op (rc 3, nothing created)" {
  # FACADE deliberately NOT created — the consumer-machine-without-facade case.
  run_refresh
  [ "$status" -eq 3 ]
  [[ "$output" == *"mirror refresh skipped"* ]]
  [[ ! -e "${FACADE}" ]]
}

@test "launcher-absent is a loud skip (rc 3 + WARN), never a silent absorb" {
  mkdir -p "${FACADE}"
  rm -f "${GAROOT}/glass-atrium"
  run_refresh
  [ "$status" -eq 3 ]
  [[ "$output" == *"WARN: launcher missing"* ]]
  [[ -z "$(ls -A "${FACADE}")" ]] # nothing was farmed
}

@test "non-facade files are untouched by refresh AND the opt-in prune" {
  mkdir -p "${FACADE}/skills/testkit"
  printf 'my private notes\n' >"${FACADE}/skills/testkit/user-notes.txt" # real user file
  ln -s "/tmp/somewhere-else.sh" "${FACADE}/skills/testkit/foreign.sh"   # foreign symlink
  run_refresh
  [ "$status" -eq 0 ]
  run env GA_TARGET_HOME="${FACADE}" "${GAROOT}/glass-atrium" prune
  [ "$status" -eq 0 ]
  [[ "$(cat "${FACADE}/skills/testkit/user-notes.txt")" == "my private notes" ]]
  [[ "$(readlink "${FACADE}/skills/testkit/foreign.sh")" == "/tmp/somewhere-else.sh" ]]
  [[ -L "${FACADE}/skills/testkit/newlib.sh" ]] # the legitimate mirror survives too
}

@test "stale mirror: --dry-run advisory reports without removing; opt-in prune removes" {
  mkdir -p "${FACADE}/skills/testkit"
  # orphan: IS a symlink + GA-target + BROKEN (no source) + not in the manifest.
  ln -s "${GAROOT}/skills/testkit/ghost.sh" "${FACADE}/skills/testkit/ghost.sh"
  run env GA_TARGET_HOME="${FACADE}" bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    farm_prune_advisory "'"${GAROOT}"'"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"would prune orphan GA symlink"*"ghost.sh"* ]]
  [[ -L "${FACADE}/skills/testkit/ghost.sh" ]] # advisory NEVER removes
  run env GA_TARGET_HOME="${FACADE}" "${GAROOT}/glass-atrium" prune
  [ "$status" -eq 0 ]
  [[ "$output" == *"removed orphan GA symlink"*"ghost.sh"* ]]
  [[ ! -L "${FACADE}/skills/testkit/ghost.sh" ]]
}

@test "missing-source manifest entries are warn+skipped via the filtered scope (update context)" {
  # ghost.sh is listed but has NO source under GAROOT (the sensitive-refused /
  # unapplied release-file edge) — unfiltered, swap_symlink would loud-die.
  write_manifest "skills/testkit/newlib.sh" "skills/testkit/ghost.sh"
  mkdir -p "${FACADE}"
  run env GA_TARGET_HOME="${FACADE}" bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    farm_write_present_manifest "'"${GAROOT}"'" "'"${GAROOT}"'/manifest.json" "'"${WORK}"'/filtered.json"
    farm_refresh "'"${GAROOT}"'" "'"${WORK}"'/filtered.json"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"mirror skipped: skills/testkit/ghost.sh"* ]]
  [[ -L "${FACADE}/skills/testkit/newlib.sh" ]]
  [[ ! -e "${FACADE}/skills/testkit/ghost.sh" ]]
  # the filtered scope carries only the present entry
  [[ "$(jq -r '.files | join(",")' "${WORK}/filtered.json")" == "skills/testkit/newlib.sh" ]]
}

@test "farm_has_ga_links detects deployment links (no -> yes)" {
  mkdir -p "${FACADE}"
  run env GA_TARGET_HOME="${FACADE}" bash -c '
    set -Eeuo pipefail
    source "'"${LIB}"'"
    farm_has_ga_links "'"${FACADE}"'" "'"${GAROOT}"'"
    farm_refresh "'"${GAROOT}"'" >/dev/null 2>&1
    farm_has_ga_links "'"${FACADE}"'" "'"${GAROOT}"'"
  '
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "no" ]]
  # Bash 3.2-safe last-line index (negative subscripts need 4.3+; bats runs
  # under env bash = stock macOS 3.2).
  [[ "${lines[${#lines[@]} - 1]}" == "yes" ]]
}
