#!/usr/bin/env bash
# Sandbox acceptance test for the Glass Atrium install refactor.
# Self-contained: seeds its own sandbox, runs install/uninstall, asserts AC1-AC7.
# NEVER touches the real ~/.claude or the real GA config.toml (uses GA_TARGET_HOME
# + GA_CONFIG_TOML overrides pointed at a mktemp sandbox).
set -uo pipefail

# Repo root = parent of this script's test/ dir (portable: no hardcoded $HOME path).
GA="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Single entry point — install/uninstall both dispatch through `glass-atrium
# <subcommand>` (the in-process engine passthrough), so the same binary drives
# every exec site below; the `install` / `uninstall` subcommand token selects
# the in-process engine path. install.sh is NOT a retired shim — it is the
# ACTIVE one-line bundle bootstrap (curl|bash downloads+extracts the release
# bundle, no .git, then hands off to `glass-atrium install`, the engine this
# test drives directly). uninstall.sh IS retired; `glass-atrium uninstall` now
# owns its former path.
GA_BIN="${GA}/glass-atrium"
RENDER_ENV="${GA}/scripts/render-monitor-env.sh"
REAL_CLAUDE="${HOME}/.claude"
REAL_CONFIG="${GA}/config.toml"

PASS=0
FAIL=0
ok() {
  printf '  PASS: %s\n' "$1"
  PASS=$((PASS + 1))
}
no() {
  printf '  FAIL: %s\n' "$1"
  FAIL=$((FAIL + 1))
}
hdr() { printf '\n===== %s =====\n' "$1"; }

# --- safety guard snapshot ----------------------------------------------------
# leak detection (STEP 8) is content-hash + marker-anchored GA-artifact scoped:
# a whole-dir mtime compare on ~/.claude false-fails whenever the live harness
# rewrites a direct child (scheduled_tasks.lock etc.) during the run.
REAL_SETTINGS_HASH_BEFORE="$(shasum "${REAL_CLAUDE}/settings.json" 2>/dev/null | awk '{print $1}' || echo MISSING)"
REAL_CONFIG_HASH_BEFORE="$(shasum "${REAL_CONFIG}" 2>/dev/null | awk '{print $1}' || echo MISSING)"

# --- sandbox setup ------------------------------------------------------------
SANDBOX="$(mktemp -d -t ga-accept.XXXXXX)"
TARGET="${SANDBOX}/.claude"
CONFIG_OUT="${SANDBOX}/config.toml"
mkdir -p "${TARGET}"
# leak-scan time anchor — STEP 8 flags only GA artifacts CREATED after this
START_MARKER="${SANDBOX}/.start-marker"
touch "${START_MARKER}"
export GA_TARGET_HOME="${TARGET}"
export GA_CONFIG_TOML="${CONFIG_OUT}"
# hermetic sandbox — DB bootstrap touches machine-global PostgreSQL, never run here
export GA_SKIP_DB_SETUP=1
# hermetic sandbox — rendered plists land here, never in the real repo's rendered/
export GA_PLIST_OUT="${SANDBOX}/launchd-plists"
trap 'rm -rf -- "${SANDBOX}"' EXIT

printf 'SANDBOX=%s\n' "${SANDBOX}"

# tree-matched manifest: hermetic defense — drive install/uninstall against a
# manifest filtered to files that exist on THIS tree (via GA_MANIFEST, the
# sandbox override), so any future manifest/tree drift surfaces in the STEP 0
# SoT reconciliation gate instead of corrupting the install-mechanism
# assertions below.
SBX_MANIFEST="${SANDBOX}/manifest.tree-matched.json"
EXISTING="$(jq -r '.files[]' "${GA}/manifest.json" | while IFS= read -r r; do [[ -e "${GA}/${r}" ]] && printf '%s\n' "${r}"; done)"
printf '%s\n' "${EXISTING}" | jq -R . | jq -s '{files: .}' >"${SBX_MANIFEST}"
export GA_MANIFEST="${SBX_MANIFEST}"
MANIFEST_COUNT_RAW="$(jq '.files | length' "${GA}/manifest.json")"
# install is driven by GA_MANIFEST (the tree-matched sandbox manifest), so AC1
# MUST assert against THIS count — identical to the tracked manifest on a
# drift-free tree (STEP 0 guards that), hermetic against drift on principle.
SBX_MANIFEST_COUNT="$(jq '.files | length' "${SBX_MANIFEST}")"
printf 'tracked manifest=%s, tree-matched (sandbox) manifest=%s\n' \
  "${MANIFEST_COUNT_RAW}" "${SBX_MANIFEST_COUNT}"

# seed a realistic pre-existing user settings.json
cat >"${TARGET}/settings.json" <<'JSON'
{
  "model": "user-pinned-model",
  "permissions": { "allow": ["Bash(ls:*)", "Read"], "deny": ["Bash(rm:*)"] },
  "env": { "MY_USER_VAR": "keepme", "ANOTHER": "alsokeep" },
  "statusLine": { "type": "command", "command": "my-statusline.sh" },
  "fooTopLevelKey": { "nested": [1, 2, 3] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/my-own-hook.sh" } ] }
    ]
  }
}
JSON
cp -p "${TARGET}/settings.json" "${SANDBOX}/user-settings.ORIGINAL.json"

# seed a COLLIDING user-owned agent file (a real Atrium agent basename)
COLLIDE_REL="$(jq -r '.files[]' "${GA}/manifest.json" | grep '^agents/.*\.md$' | head -1)"
mkdir -p "${TARGET}/$(dirname "${COLLIDE_REL}")"
printf 'USER OWNED CONTENT — must survive\n' >"${TARGET}/${COLLIDE_REL}"
COLLIDE_HASH_BEFORE="$(shasum "${TARGET}/${COLLIDE_REL}" | awk '{print $1}')"
MANIFEST_COUNT="$(jq '.files | length' "${GA}/manifest.json")"
printf 'colliding user file: %s\nmanifest count: %s\n' "${COLLIDE_REL}" "${MANIFEST_COUNT}"

# =============================================================================
hdr "STEP 0 — manifest SoT reconciliation (AC0: generator --check, both directions)"
# manifest.json is generator-owned (scripts/generate-manifest.sh) — a hand edit
# or a tracked-file add/delete without regeneration must fail HERE, before the
# install-mechanism steps run against a drifted manifest.
"${GA}/scripts/generate-manifest.sh" --check >"${SANDBOX}/manifest-check.log" 2>&1
MCHECK_RC=$?
tail -2 "${SANDBOX}/manifest-check.log"
[[ "${MCHECK_RC}" -eq 0 ]] \
  && ok "generate-manifest --check clean (zero orphans + zero unlisted, both directions)" \
  || no "generate-manifest --check rc=${MCHECK_RC} (manifest diverged from git ls-files)"
# fresh-clone guarantee: every listed entry must be git-TRACKED — an untracked
# (gitignored/local-only) entry passes a LOCAL doctor but hard-fails doctor §4
# on a fresh clone. LC_ALL=C on comm is load-bearing (BSD comm collates by the
# session locale and mis-diffs C-sorted input otherwise).
UNTRACKED_LISTED="$(LC_ALL=C comm -23 \
  <(jq -r '.files[]' "${GA}/manifest.json" | LC_ALL=C sort) \
  <(git -C "${GA}" ls-files | LC_ALL=C sort) | wc -l | tr -d ' ')"
[[ "${UNTRACKED_LISTED}" -eq 0 ]] \
  && ok "zero manifest entries outside git ls-files (fresh-clone doctor safe)" \
  || no "${UNTRACKED_LISTED} manifest entries are not git-tracked"
# the settings.json never-touch contract doc must survive regeneration
jq -er '._doc_settings_json | type == "string" and length > 0' "${GA}/manifest.json" >/dev/null \
  && ok "_doc_settings_json carried over (settings.json contract doc intact)" \
  || no "_doc_settings_json missing/empty after regeneration"

# =============================================================================
hdr "STEP 1 — doctor preflight (sandbox)"
"${GA_BIN}" doctor >"${SANDBOX}/doctor1.log" 2>&1
DOCTOR_RC=$?
tail -3 "${SANDBOX}/doctor1.log"
[[ "${DOCTOR_RC}" -eq 0 ]] && ok "doctor exits 0 (PASS or PASS-with-warnings)" || no "doctor rc=${DOCTOR_RC}"

# =============================================================================
hdr "STEP 2 — install run #1 (config render + symlink farm + wire_hooks)"
"${GA_BIN}" install >"${SANDBOX}/install1.log" 2>&1
INSTALL_RC=$?
[[ "${INSTALL_RC}" -eq 0 ]] && ok "install rc=0" || { no "install rc=${INSTALL_RC}"; tail -20 "${SANDBOX}/install1.log"; }
# DB bootstrap gating honored — the hermetic opt-out (GA_SKIP_DB_SETUP) must be
# acknowledged in the log, proving setup_database ran its gate and never reached
# the machine-global PostgreSQL path.
grep -q 'DB bootstrap skipped (GA_SKIP_DB_SETUP set)' "${SANDBOX}/install1.log" \
  && ok "DB bootstrap gated off (GA_SKIP_DB_SETUP honored)" \
  || no "GA_SKIP_DB_SETUP skip message missing from install log"
# launchd plist render wired into run_install — 8 plists in the sandboxed
# GA_PLIST_OUT dir (file-write only; launchctl never invoked by render_plists)
PLIST_COUNT="$(find "${GA_PLIST_OUT}" -name 'com.glass-atrium.*.plist' 2>/dev/null | wc -l | tr -d ' ')"
[[ "${PLIST_COUNT}" -eq 8 ]] \
  && ok "launchd plist render: 8 plists in sandboxed GA_PLIST_OUT" \
  || no "launchd plist render: expected 8 plists, found ${PLIST_COUNT}"

# --- AC2: config rendered with real $HOME, zero unexpanded ${HOME} ---
hdr "STEP 2 / AC2 — config.toml render"
if [[ -f "${CONFIG_OUT}" ]]; then
  ok "config.toml rendered at ${CONFIG_OUT}"
  UNEXP="$(grep -c '\${HOME}' "${CONFIG_OUT}" || true)"; [[ -z "${UNEXP}" ]] && UNEXP=0
  [[ "${UNEXP}" -eq 0 ]] && ok "zero unexpanded \${HOME} in rendered config" || no "${UNEXP} unexpanded \${HOME} remain"
  if grep -qF "${HOME}/.glass-atrium/monitor/data/documents" "${CONFIG_OUT}"; then
    ok "real \$HOME substituted (monitor_docs_html_root = ${HOME}/.glass-atrium/...)"
  else
    no "real \$HOME not found in rendered monitor_docs_html_root"
  fi
else
  no "config.toml NOT rendered"
fi

# --- AC1: sandbox-manifest GA symlinks created (farmed subset minus 1 collision) ---
hdr "STEP 2 / AC1 — symlink farm"
# The farm is a SUBSET of the manifest: install-internal surfaces (lib/, monitor/,
# hooks/, scoped/, scripts/, autoagent/, config.toml.example, requirements.txt,
# agent-registry.json, glass-atrium) are bundled + hash-verified but consumed in
# place from ~/.glass-atrium and NEVER symlinked into ~/.claude. So the expectation
# is DERIVED — run every sandbox-manifest rel through the ENGINE's OWN filter
# (is_symlink_excluded), never a hardcoded count minus one; an inline mirror of
# SYMLINK_EXCLUDE_* would go stale as the exclusion set evolves. Mirrors the
# oss-e2e-bootstrap.sh engine-derivation precedent. Collision skip subtracts 1.
FARM_EXPECT="$(
  # subshell: sourcing the engine arms readonly globals — keep them contained
  # shellcheck source=lib/ga-core.sh
  source "${GA}/lib/ga-core.sh" || exit 1
  ga_init_env "${GA}" || exit 1
  expect=0
  while IFS= read -r rel; do
    [[ "$(is_symlink_excluded "${rel}")" == "no" ]] && expect=$((expect + 1))
  done < <(jq -r '.files[]' "${SBX_MANIFEST}")
  printf '%s\n' "$((expect - 1))"
)"
GA_LINKS="$(find "${TARGET}" -type l -lname "${GA}/*" 2>/dev/null | wc -l | tr -d ' ')"
printf '  GA-pointing symlinks: %s (sandbox manifest=%s, engine-derived farmed subset minus 1 collision=%s)\n' \
  "${GA_LINKS}" "${SBX_MANIFEST_COUNT}" "${FARM_EXPECT}"
[[ "${FARM_EXPECT}" =~ ^[0-9]+$ ]] || no "farm expectation derivation failed (got '${FARM_EXPECT}')"
[[ "${GA_LINKS}" -eq "${FARM_EXPECT}" ]] \
  && ok "symlink count = engine-derived farmed subset minus 1 collision (${GA_LINKS}/${FARM_EXPECT})" \
  || no "symlink count ${GA_LINKS} != engine-derived farmed subset minus 1 collision ${FARM_EXPECT}"

# --- AC4: collision — seeded user agent file survives byte-identical + warned ---
hdr "STEP 2 / AC4 — collision detection"
COLLIDE_HASH_AFTER="$(shasum "${TARGET}/${COLLIDE_REL}" | awk '{print $1}')"
[[ "${COLLIDE_HASH_AFTER}" == "${COLLIDE_HASH_BEFORE}" ]] \
  && ok "colliding user file survives byte-identical (${COLLIDE_REL})" \
  || no "colliding user file MUTATED"
[[ ! -L "${TARGET}/${COLLIDE_REL}" ]] && ok "colliding path is still a real file (not symlinked over)" || no "colliding path was symlinked over"
grep -q "COLLISION:" "${SANDBOX}/install1.log" && ok "collision warning logged" || no "no collision warning in log"

# --- AC3: settings.json additive — only .hooks grew, all other keys identical ---
hdr "STEP 2 / AC3 — settings additive merge"
# user-owned keys byte-identical
for key in model permissions env statusLine fooTopLevelKey; do
  ORIG="$(jq -Sc --arg k "${key}" '.[$k]' "${SANDBOX}/user-settings.ORIGINAL.json")"
  NOW="$(jq -Sc --arg k "${key}" '.[$k]' "${TARGET}/settings.json")"
  [[ "${ORIG}" == "${NOW}" ]] && ok "key '${key}' preserved byte-identical" || no "key '${key}' changed: ${ORIG} -> ${NOW}"
done
# user's own hook entry survives
MYHOOK="$(jq '[ .hooks.PreToolUse[]? | .hooks[]? | .command | select(endswith("/my-own-hook.sh")) ] | length' "${TARGET}/settings.json")"
[[ "${MYHOOK}" -eq 1 ]] && ok "user's own hook (my-own-hook.sh) preserved" || no "user hook lost (count=${MYHOOK})"
# all Atrium bindings added — expected count derived from the EXPECTED_HOOK_BINDINGS
# array (the SoT), which now lives in lib/ga-env.sh declared INSIDE ga_init_env
# (indented, two-step `ARR=(...)` then `readonly ARR` — the bash-3.2 cross-fn
# nounset-safe idiom). The awk range matches the indented `EXPECTED_HOOK_BINDINGS=(`
# open line through its closing `)` (the `^readonly -a` anchor no longer applies).
GACORE="${GA}/lib/ga-env.sh"
EXPECTED_BINDING_COUNT="$(awk '/EXPECTED_HOOK_BINDINGS=\(/,/^[[:space:]]*\)/' "${GACORE}" | grep -c "$(printf '\t')")"
# hook-repoint: wire_hooks now emits "$HOME/.glass-atrium/hooks/<basename>" (the in-place
# consumer), NOT the legacy ~/.claude/hooks farm — so the bound-command match keys on
# /.glass-atrium/hooks/ (canonical per test/wire-hooks-merge.bats). Pre-repoint /.claude/hooks/
# matched zero and false-failed this additive-merge assertion.
ATRIUM_BOUND="$(jq '[ .hooks[]?[]? | .hooks[]? | .command | select(contains("/.glass-atrium/hooks/")) | select(endswith("/my-own-hook.sh") | not) ] | length' "${TARGET}/settings.json")"
printf '  Atrium hook commands bound: %s (expect %s)\n' "${ATRIUM_BOUND}" "${EXPECTED_BINDING_COUNT}"
[[ "${ATRIUM_BOUND}" -eq "${EXPECTED_BINDING_COUNT}" ]] && ok "exactly ${EXPECTED_BINDING_COUNT} Atrium bindings added" || no "Atrium bindings = ${ATRIUM_BOUND} != ${EXPECTED_BINDING_COUNT}"
# backup taken
BK="$(find "${TARGET}" -name 'settings.json.ga-backup.*' | head -1)"
[[ -n "${BK}" ]] && ok "timestamped settings backup created" || no "no settings backup"

# =============================================================================
hdr "STEP 3 — render-monitor-env.sh ordering (AC2 — render precedes validation)"
# point render-monitor-env at the sandbox-rendered config; it validates the
# monitor_docs_html_root as an existing absolute dir → ensure that dir exists.
mkdir -p "${HOME}/.glass-atrium/monitor/data/documents" 2>/dev/null || true
# render-monitor-env reads GA_ROOT/config.toml; symlink the rendered config there
# via a sandbox GA_ROOT so we never touch the real config.toml.
SBX_GAROOT="${SANDBOX}/ga-root"
mkdir -p "${SBX_GAROOT}/monitor"
cp "${CONFIG_OUT}" "${SBX_GAROOT}/config.toml"
GA_ROOT="${SBX_GAROOT}" "${RENDER_ENV}" >"${SANDBOX}/renderenv.log" 2>&1
RENDERENV_RC=$?
tail -2 "${SANDBOX}/renderenv.log"
[[ "${RENDERENV_RC}" -eq 0 ]] \
  && ok "render-monitor-env.sh exits 0 on the rendered config (absolute-dir validation passed)" \
  || no "render-monitor-env.sh rc=${RENDERENV_RC} (ordering/validation issue)"

# =============================================================================
hdr "STEP 4 — install run #2 (AC7 idempotency)"
"${GA_BIN}" install >"${SANDBOX}/install2.log" 2>&1
INSTALL2_RC=$?
[[ "${INSTALL2_RC}" -eq 0 ]] && ok "second install rc=0" || no "second install rc=${INSTALL2_RC}"
# no NEW symlinks: every manifest entry logs "skip (already correct)" except the collision
SKIPS="$(grep -c 'skip (already correct)' "${SANDBOX}/install2.log" || true)"; [[ -z "${SKIPS}" ]] && SKIPS=0
NEWLINKS="$(grep -c '^linked: ' "${SANDBOX}/install2.log" || true)"; [[ -z "${NEWLINKS}" ]] && NEWLINKS=0
printf '  run#2: %s skip-already-correct, %s new links\n' "${SKIPS}" "${NEWLINKS}"
[[ "${NEWLINKS}" -eq 0 ]] && ok "idempotent: zero new symlinks on re-run" || no "${NEWLINKS} new symlinks on re-run"
grep -q 'already wired' "${SANDBOX}/install2.log" && ok "idempotent: hooks already wired (no dup)" || no "hooks re-wired on second run"
grep -q 'already fully expanded — skip' "${SANDBOX}/install2.log" && ok "idempotent: config render no-op on re-run" || no "config re-rendered on second run"
# count Atrium bindings still matches the SoT count (no duplicates) — repointed
# /.glass-atrium/hooks/ match (see the AC3 note above; pre-repoint /.claude/hooks/ counted 0).
ATRIUM_BOUND2="$(jq '[ .hooks[]?[]? | .hooks[]? | .command | select(contains("/.glass-atrium/hooks/")) | select(endswith("/my-own-hook.sh") | not) ] | length' "${TARGET}/settings.json")"
[[ "${ATRIUM_BOUND2}" -eq "${EXPECTED_BINDING_COUNT}" ]] && ok "still exactly ${EXPECTED_BINDING_COUNT} Atrium bindings (no duplicates)" || no "binding count drifted to ${ATRIUM_BOUND2}"

# =============================================================================
hdr "STEP 5 — malformed-settings loud-fail (AC6)"
MSAND="$(mktemp -d -t ga-malformed.XXXXXX)"
printf '%s\n' '{ this is not json' >"${MSAND}/settings.json"
MAL_HASH_BEFORE="$(shasum "${MSAND}/settings.json" | awk '{print $1}')"
GA_TARGET_HOME="${MSAND}" "${GA_BIN}" wire-hooks >"${MSAND}/wire.log" 2>&1
MAL_RC=$?
[[ "${MAL_RC}" -ne 0 ]] && ok "malformed settings aborts (rc=${MAL_RC})" || no "malformed settings did NOT abort"
grep -q 'not valid JSON' "${MSAND}/wire.log" && ok "loud-fail message emitted" || no "no loud-fail message"
MAL_HASH_AFTER="$(shasum "${MSAND}/settings.json" | awk '{print $1}')"
[[ "${MAL_HASH_BEFORE}" == "${MAL_HASH_AFTER}" ]] && ok "malformed settings left byte-identical (no partial merge)" || no "malformed settings was mutated"
rm -rf -- "${MSAND}"

# =============================================================================
# STEP 6-7 — the DESTRUCTIVE full-uninstall path (AC5 + idempotency + --verify-clean
# + --purge-config) is intentionally NOT exercised here.
#
# WHY SKIPPED (hermeticity, not a real-uninstall regression): this harness is the
# LIGHT sandbox — it overrides only GA_TARGET_HOME (+ GA_CONFIG_TOML / GA_MANIFEST),
# reusing the REAL $HOME and $GA_ROOT. But `glass-atrium uninstall` (a) requires an
# explicit --yes (initial-commit destructive-consent gate — NOT a T1-T6 change) and
# (b) its run_uninstall path calls drop_databases (REAL peer-auth socket + real DB
# name), remove_node_modules (rm -rf ${GA_ROOT}/monitor/node_modules — GA_ROOT is
# readonly + non-overridable, so this is the real worktree tree), and
# stop_detached_daemons — NONE of which the GA_TARGET_HOME seam redirects. The light
# sandbox therefore cannot isolate them, so on any live-install / built-worktree
# machine the full uninstall would touch real resources. Additionally the old AC5
# "settings.json restored byte-identical" assertion predates the ~/.claude/hooks ->
# ~/.glass-atrium/hooks command repoint (install now repoints a farm-dir binding),
# so it encodes a superseded model.
#
# COVERAGE LIVES ELSEWHERE: hermetic full-uninstall parity (symlinks gone, bindings
# un-wired, throwaway db dropped, launchd sandbox-guarded) is exercised by
# test/oss-e2e-bootstrap.sh — a FULL-$HOME sandbox with a throwaway db + --yes. The
# un-wire logic itself is unit-covered by test/unwire-hooks.bats. This harness owns
# the install-mechanism ACs (STEP 0-5) + the real-target safety guard (STEP 8).
hdr "STEP 6-7 — full uninstall (SKIPPED: requires a clean/hermetic machine)"
printf '  SKIP: destructive uninstall (real db drop + %s/monitor/node_modules rm -rf +\n' "${GA}"
printf '        detached-daemon teardown) is not isolatable in this light GA_TARGET_HOME sandbox.\n'
printf '  SKIP: hermetic full-uninstall coverage — test/oss-e2e-bootstrap.sh (isolated HOME + throwaway db + --yes);\n'
printf '        un-wire unit coverage — test/unwire-hooks.bats.\n'

# =============================================================================
hdr "STEP 8 — SAFETY GUARD: real ~/.claude + real config.toml UNTOUCHED"
REAL_SETTINGS_HASH_AFTER="$(shasum "${REAL_CLAUDE}/settings.json" 2>/dev/null | awk '{print $1}' || echo MISSING)"
[[ "${REAL_SETTINGS_HASH_AFTER}" == "${REAL_SETTINGS_HASH_BEFORE}" ]] \
  && ok "real settings.json UNCHANGED (sha ${REAL_SETTINGS_HASH_BEFORE})" \
  || no "real settings.json CHANGED ${REAL_SETTINGS_HASH_BEFORE} -> ${REAL_SETTINGS_HASH_AFTER}"
# any GA symlink/artifact CREATED in the REAL target during this run = override
# leak. Scan is scoped to the component dirs the install engine can write + the top
# level (a full-tree find would crawl the huge, never-touch projects/ tree).
LEAKS=0
for d in agents autoagent hooks rules scoped scripts skills; do
  [[ -d "${REAL_CLAUDE}/${d}" ]] || continue
  N_NEW="$(find "${REAL_CLAUDE}/${d}" -type l -lname "${GA}/*" -newer "${START_MARKER}" 2>/dev/null | wc -l | tr -d ' ')"
  LEAKS=$((LEAKS + N_NEW))
done
TOP_NEW="$(find "${REAL_CLAUDE}" -maxdepth 1 \( -name '*.ga-backup.*' -o -name '*.ga-tmp.*' -o -name '*.ga-wire.*' \) -newer "${START_MARKER}" 2>/dev/null | wc -l | tr -d ' ')"
LEAKS=$((LEAKS + TOP_NEW))
[[ "${LEAKS}" -eq 0 ]] \
  && ok "zero GA symlinks/artifacts created in real ~/.claude during the run" \
  || no "${LEAKS} GA artifact(s) leaked into real ~/.claude"
REAL_CONFIG_HASH_AFTER="$(shasum "${REAL_CONFIG}" 2>/dev/null | awk '{print $1}' || echo MISSING)"
[[ "${REAL_CONFIG_HASH_AFTER}" == "${REAL_CONFIG_HASH_BEFORE}" ]] \
  && ok "real config.toml UNCHANGED (sha ${REAL_CONFIG_HASH_BEFORE})" \
  || no "real config.toml CHANGED"

hdr "RESULT"
printf 'PASS=%s  FAIL=%s\n' "${PASS}" "${FAIL}"
[[ "${FAIL}" -eq 0 ]] && printf 'ALL ACCEPTANCE CHECKS GREEN\n' || printf 'SOME CHECKS FAILED\n'
exit "${FAIL}"
