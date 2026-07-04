#!/usr/bin/env bats
# swap_symlink (lib/ga-core.sh) — coexistence + collision characterization net.
#
# Pins the CURRENT safe collision behavior of the H-3 atomic per-file symlink
# swap so a later mutation phase cannot silently regress it. swap_symlink creates
# TARGET_HOME/<rel> -> GA_ROOT/<rel>, and its clobber-refusal / collision branches
# are the coexistence contract for a per-file farm sharing ~/.claude with user
# files. Cases pinned here:
#   1. foreign-symlink die      → a non-GA symlink at <rel> is a HARD die; the
#                                 user's own symlink is left byte-intact.
#   2. out-of-scope die         → a REAL user file at a NON-collision-scope path
#                                 (rules/, hooks/) is a HARD die; file preserved.
#   3. agents/ collision skip   → a real user file under agents/ → WARN + return 2
#      skills/ collision skip     (same under skills/); user file preserved.
#   4. collision prompt, NO tty → --collision-prompt with a non-tty stdin falls
#                                 through the `[[ -t 0 ]]` gate to the SAFE skip
#                                 (return 2) — a scripted run is never blocked.
#   5. collision prompt + tty+y → the interactive OVERWRITE arm: the user file is
#                                 MOVED to a .ga-collision.<ts> backup (never rm),
#                                 then the Atrium symlink is created. Driven via a
#                                 BSD `script(1)` pty harness (the only seam that
#                                 makes `[[ -t 0 ]]` true without a product change).
#   6. already-correct skip     → an EXACT GA symlink is an idempotent skip; the
#                                 pointer is unchanged (distinct from re-swap).
#   7. GA-wrong-rel re-swap     → a GA-pointing alias at the WRONG rel is SILENTLY
#                                 re-swapped to the correct src (no WARN, no die);
#                                 the old alias pointer is replaced. Pinned with
#                                 assertions distinct from the idempotent skip so a
#                                 later path-transparency change cannot collapse the
#                                 two branches into one.
#
# OUT OF P1 SCOPE (documented exclusions, NOT gaps):
#   * is_never_touch → die (ga-core.sh:710) — the manifest never lists a
#     never-touch path, so this defense-in-depth branch is unreachable from the
#     real manifest; excluded by design.
#   * manifest-source-missing → die (ga-core.sh:714) — a missing source is an
#     unapplied-release edge, NOT a user-file clobber refusal, so it is out of the
#     collision-net's boundary (the mirror-farm suite covers the filtered scope).
#
# Run via: bats scripts/test/swap-symlink-collision.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+, BSD script(1) (macOS)
#
# Hermetic strategy: a per-test mktemp sandbox holds a synthetic GA root (source
# files at the tested rels) with GA_LIB_DIR pointed at the real worktree
# scripts/lib (so ga_init_env's E5-lib precondition is met without copying), and
# GA_TARGET_HOME pins TARGET_HOME (and thus every swap dst) to <sandbox>/facade —
# the real ~/.claude is NEVER written. swap_symlink has no standalone subcommand,
# so — mirroring the engine's own "source ga-core.sh + ga_init_env" contract — a
# runner script sources the engine and calls the function directly under the same
# `set -Eeuo pipefail` the entry point arms.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd -P)"
CORE="${GA}/lib/ga-core.sh"

setup() {
  [[ -f "${CORE}" ]] || skip "ga-core.sh not found: ${CORE}"
  command -v script >/dev/null 2>&1 || skip "script(1) required for the pty harness"
  WORK="$(cd -- "$(mktemp -d -t ga-swap-bats.XXXXXX)" && pwd -P)"
  GAROOT="${WORK}/garoot"       # synthetic GA root (source files live here)
  FACADE="${WORK}/facade"       # sandbox TARGET_HOME (every swap dst lives here)
  mkdir -p "${GAROOT}" "${FACADE}"

  # runner: source the real engine + call swap_symlink directly, env-driven so no
  # nested-quoting is needed for the pty harness. Non-tty tests invoke it plainly;
  # the tty+y test pipes it through `script -q /dev/null`.
  RUNNER="${WORK}/swap-runner.sh"
  cat >"${RUNNER}" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail
source "${SWAP_CORE}"
ga_init_env "${SWAP_GAROOT}"
if [[ -n "${SWAP_CP:-}" ]]; then COLLISION_PROMPT=true; fi
swap_symlink "${SWAP_REL}"
RUN
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Seed a GA_ROOT source file for <rel> (the swap src that must exist).
seed_src() {
  local rel="$1"
  mkdir -p -- "$(dirname -- "${GAROOT}/${rel}")"
  printf 'ga-source: %s\n' "${rel}" >"${GAROOT}/${rel}"
}

# Run the runner (non-tty). $1 = rel, $2 = "prompt" to arm --collision-prompt.
run_swap() {
  local rel="$1" cp=""
  [[ "${2:-}" == "prompt" ]] && cp=1
  run env GA_TARGET_HOME="${FACADE}" GA_LIB_DIR="${GA}/scripts/lib" \
    SWAP_CORE="${CORE}" SWAP_GAROOT="${GAROOT}" SWAP_REL="${rel}" SWAP_CP="${cp}" \
    bash "${RUNNER}"
}

# Run the runner through a BSD script(1) pty so `[[ -t 0 ]]` is true, feeding 'y'
# to the interactive overwrite prompt. The delayed feed keeps the master open
# past the child's `read` (a bare pipe races EOF ahead of the data on BSD script).
run_swap_pty_yes() {
  local rel="$1"
  run env GA_TARGET_HOME="${FACADE}" GA_LIB_DIR="${GA}/scripts/lib" \
    SWAP_CORE="${CORE}" SWAP_GAROOT="${GAROOT}" SWAP_REL="${rel}" SWAP_CP=1 \
    bash -c '{ printf "y\n"; sleep 1; } | script -q /dev/null bash "$1"' _ "${RUNNER}"
}

@test "foreign symlink at rel -> hard die, user symlink preserved byte-intact" {
  seed_src "scripts/lib/newlib.sh"
  mkdir -p "${FACADE}/scripts/lib"
  # a NON-GA symlink (the user's own) — must be refused, never overwritten.
  ln -s "/tmp/user-owned-target.sh" "${FACADE}/scripts/lib/newlib.sh"
  run_swap "scripts/lib/newlib.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"refusing to overwrite foreign symlink not into GA root"* ]]
  # the user's symlink is untouched — still a symlink at its original target
  [[ -L "${FACADE}/scripts/lib/newlib.sh" ]]
  [[ "$(readlink "${FACADE}/scripts/lib/newlib.sh")" == "/tmp/user-owned-target.sh" ]]
}

@test "out-of-scope real user file (rules/) -> hard die, user file preserved" {
  seed_src "rules/my-rule.md"
  mkdir -p "${FACADE}/rules"
  printf 'user rule content\n' >"${FACADE}/rules/my-rule.md"
  run_swap "rules/my-rule.md"
  [ "$status" -ne 0 ]
  [[ "$output" == *"refusing to symlink-over existing non-symlink user file"* ]]
  # user file preserved: still a regular file with the original content
  [[ -f "${FACADE}/rules/my-rule.md" && ! -L "${FACADE}/rules/my-rule.md" ]]
  [[ "$(cat "${FACADE}/rules/my-rule.md")" == "user rule content" ]]
}

@test "out-of-scope real user file (hooks/) -> hard die, user file preserved" {
  seed_src "hooks/my-hook.sh"
  mkdir -p "${FACADE}/hooks"
  printf 'user hook body\n' >"${FACADE}/hooks/my-hook.sh"
  run_swap "hooks/my-hook.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"refusing to symlink-over existing non-symlink user file"* ]]
  [[ "$(cat "${FACADE}/hooks/my-hook.sh")" == "user hook body" ]]
}

@test "agents/ collision -> WARN + skip (return 2), user file preserved" {
  seed_src "agents/foo.md"
  mkdir -p "${FACADE}/agents"
  printf 'user agent foo\n' >"${FACADE}/agents/foo.md"
  run_swap "agents/foo.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"COLLISION: a different user file already exists"* ]]
  [[ "$output" == *"collision: skipping agents/foo.md (user file preserved"* ]]
  # user file preserved: regular file, original content, NOT a symlink
  [[ -f "${FACADE}/agents/foo.md" && ! -L "${FACADE}/agents/foo.md" ]]
  [[ "$(cat "${FACADE}/agents/foo.md")" == "user agent foo" ]]
}

@test "skills/ collision -> WARN + skip (return 2), user file preserved" {
  seed_src "skills/bar/SKILL.md"
  mkdir -p "${FACADE}/skills/bar"
  printf 'user skill bar\n' >"${FACADE}/skills/bar/SKILL.md"
  run_swap "skills/bar/SKILL.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"collision: skipping skills/bar/SKILL.md (user file preserved"* ]]
  [[ "$(cat "${FACADE}/skills/bar/SKILL.md")" == "user skill bar" ]]
}

@test "collision prompt with NO tty -> safe skip (return 2), never blocks a scripted run" {
  # --collision-prompt armed, but stdin is a pipe (not a tty): the `[[ -t 0 ]]`
  # gate is false, `read` is skipped, reply='' → the safe *) skip arm (return 2).
  seed_src "agents/foo.md"
  mkdir -p "${FACADE}/agents"
  printf 'user agent foo\n' >"${FACADE}/agents/foo.md"
  run_swap "agents/foo.md" prompt
  [ "$status" -eq 2 ]
  [[ "$output" == *"collision: skipping agents/foo.md (user file preserved"* ]]
  # NO overwrite happened — no backup was created, file untouched
  [[ -z "$(find "${FACADE}/agents" -name 'foo.md.ga-collision.*' 2>/dev/null | head -1)" ]]
  [[ "$(cat "${FACADE}/agents/foo.md")" == "user agent foo" ]]
}

@test "collision prompt + tty + 'y' -> user file MOVED to .ga-collision backup, symlink created" {
  seed_src "agents/foo.md"
  mkdir -p "${FACADE}/agents"
  printf 'user agent foo\n' >"${FACADE}/agents/foo.md"
  run_swap_pty_yes "agents/foo.md"
  # the .ga-collision.<ts> backup holds the ORIGINAL user content (never rm'd)
  local backup
  backup="$(find "${FACADE}/agents" -name 'foo.md.ga-collision.*' | head -1)"
  [[ -n "${backup}" ]]
  [[ "$(cat "${backup}")" == "user agent foo" ]]
  # the dst is now the Atrium symlink into the GA root (overwrite completed)
  [[ -L "${FACADE}/agents/foo.md" ]]
  [[ "$(readlink "${FACADE}/agents/foo.md")" == "${GAROOT}/agents/foo.md" ]]
}

@test "already-correct GA symlink -> idempotent skip, pointer unchanged" {
  seed_src "agents/foo.md"
  mkdir -p "${FACADE}/agents"
  ln -s "${GAROOT}/agents/foo.md" "${FACADE}/agents/foo.md"
  run_swap "agents/foo.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skip (already correct): agents/foo.md"* ]]
  # pointer is UNCHANGED (skip branch, not a re-swap)
  [[ "$(readlink "${FACADE}/agents/foo.md")" == "${GAROOT}/agents/foo.md" ]]
}

@test "GA-pointing wrong-rel alias -> silently re-swapped to correct src (pointer replaced, no warn)" {
  seed_src "agents/foo.md"
  mkdir -p "${FACADE}/agents"
  # a GA-pointing alias at the WRONG rel (an aliased/renamed target inside GA root)
  ln -s "${GAROOT}/agents/renamed-away.md" "${FACADE}/agents/foo.md"
  run_swap "agents/foo.md"
  [ "$status" -eq 0 ]
  # the re-swap is SILENT: no collision WARN, no die — just the plain link log
  [[ "$output" != *"COLLISION"* ]]
  [[ "$output" != *"refusing"* ]]
  [[ "$output" == *"linked: agents/foo.md"* ]]
  # the old alias pointer is REPLACED by the correct src (distinct from skip)
  [[ "$(readlink "${FACADE}/agents/foo.md")" == "${GAROOT}/agents/foo.md" ]]
  [[ "$(readlink "${FACADE}/agents/foo.md")" != "${GAROOT}/agents/renamed-away.md" ]]
}
