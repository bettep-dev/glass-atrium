#!/usr/bin/env bats
# update-symlink-mode-row.bats — update_enforce_manifest_modes vs. symlink rows.
#
# THE DEFECT (deterministic deploy abort, reproduced by the first test below):
# the reconciler mixed follow and no-follow semantics on ONE path. The existence
# gate `[[ ! -f ]]` FOLLOWS the link, `chmod` FOLLOWS the link, but
# update_file_mode_octal probes with BSD `stat -f '%Lp'` — `%L` is LSTAT, so it
# reads the LINK's own mode (macOS creates symlinks 0755). The repair therefore
# changed the TARGET while the re-read kept observing the LINK, the re-read could
# never move, and the post-apply verify update_die fired on EVERY run.
#
# THE CONTRACT NOW UNDER TEST:
#   * a symlink row is SKIPPED — it has no mode of its own to reconcile, the
#     manifest entry describes the TARGET (generate-manifest.sh probes with
#     `stat -L`, i.e. FOLLOW), and that target is itself a files[] member
#     reconciled on its own row. Neither the link nor the target is touched.
#   * REGULAR files are untouched by the fix in both directions: real drift is
#     still repaired + verified, and a mode that cannot converge is still a LOUD
#     update_die — the D6 R1 anti-masking property the skip must not become a
#     hole in.
#
# STRATEGY: update.sh internals are driven through a DRIVER command that sources
# update.sh (update_main is skipped when sourced — established suite pattern) and
# clears the inherited ERR trap. The driver is invoked DIRECTLY as a command, never
# via `bash <path>` — that bypasses the exec bit, the governing lesson from the
# shipped-inert incident. No ~/.claude or ~/.glass-atrium mutation: every fixture
# lives in a mktemp sandbox, and the real-manifest row runs against a tar-cloned
# MIRROR of the tracked tree (modes + symlinks preserved) so the worktree itself
# is never chmod'ed.
#
# Every assertion is gated `|| return 1`.
#
# Run via: bats scripts/test/update-symlink-mode-row.bats
# Requires: bats 1.5+, jq, tar, bash 3.2+
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

# lstat octal mode (the LINK's own mode for a symlink) — BSD first, GNU fallback.
# Output-validated: GNU `stat -f` is FILESYSTEM status (exit 0, "?p" garbage), so
# the exit code alone cannot select the right form.
lmode_of() {
  local m
  m="$(stat -f '%Lp' "$1" 2>/dev/null || true)"
  [[ "${m}" =~ ^[0-7]{3,4}$ ]] || m="$(stat -c '%a' "$1" 2>/dev/null || true)"
  [[ "${m}" =~ ^[0-7]{3,4}$ ]] || return 1
  printf '%s\n' "${m}"
}

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  SANDBOX="$(mktemp -d -t ga-symlink-mode.XXXXXX)"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX:-}" ]] && rm -rf -- "${SANDBOX}"
}

# DRIVER command: source update.sh, clear the inherited ERR trap, run "$@".
make_update_driver() {
  DRIVER="${SANDBOX}/driver.sh"
  cat >"${DRIVER}" <<DRV
#!/usr/bin/env bash
set -uo pipefail
source "${GA}/scripts/update.sh"
trap - ERR
"\$@"
DRV
  chmod 755 "${DRIVER}"
}

# The live shape: a manifest row whose path is a SYMLINK whose own mode (755,
# as macOS creates them) differs from its target's (644, what the manifest
# records via the generator's follow-probe). The target is a manifest row too —
# exactly the repo's rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md ->
# ../../agents/GLASS_ATRIUM_GLOBAL_RULES.md pairing.
make_symlink_fixture() {
  ROOT="${SANDBOX}/root"
  MM="${SANDBOX}/mm.json"
  mkdir -p "${ROOT}/agents" "${ROOT}/rules"
  printf 'shared rule body\n' >"${ROOT}/agents/G.md"
  chmod 644 "${ROOT}/agents/G.md"
  ln -sfn ../agents/G.md "${ROOT}/rules/G.md"
  jq -n '{files:[], hashes:{}, modes:{"rules/G.md":"644","agents/G.md":"644"}}' >"${MM}"
}

# Regular files ONLY — no symlink row. The two loud-posture guards below use this
# so they isolate the behavior they protect: both PASS AT HEAD and after the fix,
# which is precisely their point (they assert a property the change must not
# weaken, so a HEAD failure would prove the opposite of what they are for). On the
# shared fixture they would abort on the symlink row first and their result would
# say nothing about the regular-file path.
make_regular_fixture() {
  ROOT="${SANDBOX}/rroot"
  MM="${SANDBOX}/rm.json"
  mkdir -p "${ROOT}/agents"
  printf 'plain body\n' >"${ROOT}/agents/G.md"
  chmod 644 "${ROOT}/agents/G.md"
  jq -n '{files:[], hashes:{}, modes:{"agents/G.md":"644"}}' >"${MM}"
}

# --- direction 1: the symlink row (FAILS AT HEAD) --------------------------

@test "symlink row: skipped instead of aborting the deploy" {
  make_update_driver
  make_symlink_fixture
  # precondition — the mixed-semantics trigger actually exists in the fixture:
  # the LINK's own mode differs from the mode the manifest records.
  [ "$(lmode_of "${ROOT}/rules/G.md")" != "644" ] || return 1
  [ "$(lmode_of "${ROOT}/agents/G.md")" = "644" ] || return 1

  run -0 "${DRIVER}" update_enforce_manifest_modes "${MM}" "${ROOT}"
  [[ "${output}" == *"symlink (skipped"* ]] || return 1
  # the abort this fix removes — pinned verbatim so a regression is unambiguous
  [[ "${output}" != *"post-apply mode mismatch"* ]] || return 1
  [[ "${output}" != *"FATAL"* ]] || return 1
}

@test "symlink row: neither the link nor its target is mutated" {
  make_update_driver
  make_symlink_fixture
  local before_link before_target
  before_link="$(lmode_of "${ROOT}/rules/G.md")"
  before_target="$(lmode_of "${ROOT}/agents/G.md")"

  run -0 "${DRIVER}" update_enforce_manifest_modes "${MM}" "${ROOT}"
  [ "$(lmode_of "${ROOT}/rules/G.md")" = "${before_link}" ] || return 1
  [ "$(lmode_of "${ROOT}/agents/G.md")" = "${before_target}" ] || return 1
  # the skip must not repair THROUGH the alias: no delta logged against the link
  [[ "${output}" != *"mode applied: rules/G.md"* ]] || return 1
  [ -L "${ROOT}/rules/G.md" ] || return 1
}

# --- direction 2: regular files keep the loud posture ----------------------

@test "regular file: real drift is still repaired and verified" {
  make_update_driver
  make_symlink_fixture
  chmod 600 "${ROOT}/agents/G.md" # genuine drift on the symlink's TARGET row

  run -0 "${DRIVER}" update_enforce_manifest_modes "${MM}" "${ROOT}"
  # the delta is logged against the REAL path, not the alias
  [[ "${output}" == *"mode applied: agents/G.md 600 -> 644"* ]] || return 1
  [ "$(lmode_of "${ROOT}/agents/G.md")" = "644" ] || return 1
}

@test "regular file: a mode that cannot converge still aborts loudly" {
  # The anti-hole guard: the skip must not have widened into "tolerate any
  # mismatch". A no-op chmod shim makes the repair silently fail on a REGULAR
  # file, which must still reach the post-apply update_die (exit 1) — the D6 R1
  # property that keeps auto-repair from masking an upstream mode-dropping bug.
  make_update_driver
  make_regular_fixture
  local shim="${SANDBOX}/shim"
  mkdir -p "${shim}"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${shim}/chmod"
  command chmod 755 "${shim}/chmod"
  command chmod 600 "${ROOT}/agents/G.md"

  run -1 env PATH="${shim}:${PATH}" "${DRIVER}" update_enforce_manifest_modes "${MM}" "${ROOT}"
  [[ "${output}" == *"post-apply mode mismatch for agents/G.md: applied 644, observed 600"* ]] || return 1
  [[ "${output}" == *"FATAL"* ]] || return 1
}

@test "regular file: a malformed octal is still a loud failure" {
  # the other loud row in the same loop — pinned so the symlink skip cannot be
  # reordered ahead of the map-validity gate
  make_update_driver
  make_regular_fixture
  jq -n '{files:[], hashes:{}, modes:{"agents/G.md":"nonsense"}}' >"${MM}"
  run -1 "${DRIVER}" update_enforce_manifest_modes "${MM}" "${ROOT}"
  [[ "${output}" == *"not a valid octal mode"* ]] || return 1
}

# --- the real manifest, not only a fixture ---------------------------------

@test "real manifest: the tracked modes map reconciles with no abort" {
  # Guards the actual deploy condition, on a tar-cloned MIRROR of the tracked
  # tree (modes + symlinks preserved) so the worktree is never chmod'ed.
  command -v tar >/dev/null 2>&1 || skip "tar required"
  command -v git >/dev/null 2>&1 || skip "git required"
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "not a git checkout (consumer install — no tracked tree to mirror)"
  [[ -f "${GA}/manifest.json" ]] || skip "manifest.json absent"
  jq -e '(.modes // empty) | type == "object"' "${GA}/manifest.json" >/dev/null \
    || skip "manifest carries no modes map"

  make_update_driver
  local mirror="${SANDBOX}/mirror"
  mkdir -p "${mirror}"
  # -T - reads the path list on stdin; symlinks are archived as symlinks
  jq -r '.files[]' "${GA}/manifest.json" \
    | (cd "${GA}" && tar -cf - -T -) \
    | (cd "${mirror}" && tar -xf -) || return 1

  # precondition — the mirror really does carry the live symlink shape
  [ -L "${mirror}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md" ] || return 1

  run -0 "${DRIVER}" update_enforce_manifest_modes "${GA}/manifest.json" "${mirror}"
  [[ "${output}" != *"FATAL"* ]] || return 1
  [[ "${output}" != *"post-apply mode mismatch"* ]] || return 1
  [[ "${output}" == *"symlink (skipped"* ]] || return 1
}
