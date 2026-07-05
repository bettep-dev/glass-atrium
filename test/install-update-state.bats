#!/usr/bin/env bats
# Update-state engine coverage (design C FINAL wave) — the E5 review flagged these
# three as MISSING:
#   T24  capture_install_baseline — the base@install hash baseline AND the NEW
#        base-content STORE (the region TEXT a real 3-way merge needs; the hash
#        manifest alone cannot supply it). Asserts the store is seeded basename-keyed
#        under <state-dir>/base-agents/ (the editable_merge.base_store_dir layout that
#        load_base_text CONSUMES), and that re-capturing after a body change re-seeds
#        it (hash changes — never a stale base anchor).
#   T26  teardown_update_state — the pause flag (ephemeral coordination state) is
#        ALWAYS removed on uninstall even if present beforehand; the baseline
#        (recovery state) is KEPT unless --purge-config.
#   T27  doctor section-9e — the STALE update-pause-flag advisory: WARN on a
#        present/stale flag, OK (no WARN) when absent, and MUTATION-FREE (doctor never
#        clears the flag, unlike the daemon honor predicate).
#
# Isolation strategy (two seams, both hermetic):
#   * T24/T26 drive SOURCED engine functions (capture_install_baseline /
#     teardown_update_state are NOT passthrough subcommands). To keep the lib's
#     `readonly GA_ROOT` from leaking between tests, each call runs in a CLEAN
#     subprocess (run-engine.sh) that sources + ga_init_env's fresh — the same
#     subprocess-isolation philosophy as install-prune.bats, and it keeps the
#     strict-mode ERR trap OUT of the Bats shell (sourced only inside the child).
#   * T27 drives the real `glass-atrium doctor` passthrough (run_doctor IS reachable
#     there), sandboxed via the GA_* / ATRIUM_* env overrides.
# Every path uses mktemp -d + teardown rm -rf — NEVER the live ~/.claude or the real
# ~/.glass-atrium/.update-state.
#
# Run via: bats test/install-update-state.bats
# Requires: bats >= 1.5.0, jq, python3 (pause-flag age check), bash 3.2+

bats_require_minimum_version 1.5.0

REAL_GA_DIR="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${REAL_GA_DIR}/glass-atrium"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required (pause-flag age check)"
  command -v shasum >/dev/null 2>&1 || skip "shasum required"
  [[ -f "${REAL_GA_DIR}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${REAL_GA_DIR}"
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium entry not found: ${REAL_GA}"

  SANDBOX="$(mktemp -d -t install-update-state-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga" # sandbox GA_ROOT — the agent SOURCE bodies live here
  TARGET="${SANDBOX}/target" # throwaway install target
  STATE="${SANDBOX}/state"   # update-state dir (baseline + base-agents + pause flag)
  MANIFEST="${SANDBOX}/manifest.json"
  ENGINE_RUNNER="${SANDBOX}/run-engine.sh"
  mkdir -p "${GA_SANDBOX}/agents" "${TARGET}" "${STATE}"

  # Sandbox overrides consumed by ga_init_env + the E5 helpers. GA_LIB_DIR points the
  # E5-lib source at the REAL scripts/lib while GA_ROOT stays the sandbox; the two
  # ATRIUM_* dirs pin the baseline/base-content store + the pause flag into the sandbox.
  export REAL_GA_DIR GA_SANDBOX
  export GA_LIB_DIR="${REAL_GA_DIR}/scripts/lib"
  export GA_TARGET_HOME="${TARGET}"
  export GA_MANIFEST="${MANIFEST}"
  export ATRIUM_UPDATE_STATE_DIR="${STATE}"
  export ATRIUM_PAUSE_STATE_DIR="${STATE}"
  export EBATS_DRY="false"   # per-test override for DRY_RUN
  export EBATS_PURGE="false" # per-test override for PURGE_CONFIG

  # Clean-subprocess engine runner: a FRESH source + ga_init_env each invocation so
  # the lib's `readonly GA_ROOT` can never leak between tests, and the strict-mode
  # source stays isolated to this child (never the Bats shell). Reads its sandbox env
  # from the exported vars above. `"$@"` = the engine function + args to drive.
  cat >"${ENGINE_RUNNER}" <<'RUNNER'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
# shellcheck source=/dev/null
source "${REAL_GA_DIR}/lib/ga-core.sh"
ga_init_env "${GA_SANDBOX}"
DRY_RUN="${EBATS_DRY:-false}"
PURGE_CONFIG="${EBATS_PURGE:-false}"
"$@"
RUNNER
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# write a v1.0.0 manifest whose .files is the given relative-path list, with a
# placeholder hash per path (the store/teardown paths never verify the hash value).
write_manifest() {
  printf '%s\n' "$@" \
    | jq -R . \
    | jq -s '{version: "1.0.0", files: ., hashes: (reduce .[] as $p ({}; . + {($p): "hash-of-\($p)"}))}' \
      >"${MANIFEST}"
}

# drive a SOURCED engine function in a clean isolated subprocess (sets $status/$output).
run_engine() {
  run bash "${ENGINE_RUNNER}" "$@"
}

# lowercase 64-hex sha256 of a file (BSD/macOS shasum), first whitespace field only.
file_hash() {
  local out
  out="$(shasum -a 256 -- "$1")"
  printf '%s\n' "${out%% *}"
}

# === T24 — capture_install_baseline base-content store ======================

@test "T24: capture_install_baseline seeds the hash baseline AND the base-content store" {
  printf 'AGENT BODY dev-x v1\n' >"${GA_SANDBOX}/agents/dev-x.md"
  mkdir -p "${GA_SANDBOX}/agents/sub"
  printf 'AGENT BODY nested v1\n' >"${GA_SANDBOX}/agents/sub/dev-z.md"
  write_manifest "agents/dev-x.md" "agents/sub/dev-z.md" "rules/glass-atrium/r.md"

  run_engine capture_install_baseline
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"base-content store seeded"* ]]

  # the hash-only baseline manifest (the spine anchor) is captured
  [[ -f "${STATE}/baseline-manifest.json" ]]
  # the NEW base-content store is seeded basename-keyed (flat AND nested agent files)
  [[ -f "${STATE}/base-agents/dev-x.md" ]]
  [[ -f "${STATE}/base-agents/dev-z.md" ]]
  # a NON-agent manifest entry is excluded from the store (rules/glass-atrium/*.md → not stored)
  [[ ! -e "${STATE}/base-agents/r.md" ]]
  # the stored body is the REAL base@install text (a true 3-way anchor, not a hash)
  [[ "$(cat "${STATE}/base-agents/dev-x.md")" == "AGENT BODY dev-x v1" ]]
  [[ "$(cat "${STATE}/base-agents/dev-z.md")" == "AGENT BODY nested v1" ]]
}

@test "T24: re-capturing after the agent body changes re-seeds the store (hash changes)" {
  printf 'V1 body\n' >"${GA_SANDBOX}/agents/dev-x.md"
  write_manifest "agents/dev-x.md"

  run_engine capture_install_baseline
  [[ "${status}" -eq 0 ]]
  local h1
  h1="$(file_hash "${STATE}/base-agents/dev-x.md")"

  # a later install/apply lands a NEW base@install body; the store must re-seed.
  printf 'V2 CHANGED body\n' >"${GA_SANDBOX}/agents/dev-x.md"
  run_engine capture_install_baseline
  [[ "${status}" -eq 0 ]]
  local h2
  h2="$(file_hash "${STATE}/base-agents/dev-x.md")"

  [[ "${h1}" != "${h2}" ]] # hash changed → no stale base anchor
  [[ "$(cat "${STATE}/base-agents/dev-x.md")" == "V2 CHANGED body" ]]
}

@test "T24: dry-run skips base@install capture entirely (no baseline, no store)" {
  printf 'V1\n' >"${GA_SANDBOX}/agents/dev-x.md"
  write_manifest "agents/dev-x.md"
  export EBATS_DRY="true"

  run_engine capture_install_baseline
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"dry-run"* ]]
  [[ ! -e "${STATE}/baseline-manifest.json" ]]
  [[ ! -d "${STATE}/base-agents" ]]
}

@test "T24: a missing manifest agent source is counted + advisory, capture still succeeds" {
  printf 'present body\n' >"${GA_SANDBOX}/agents/present.md"
  # agents/ghost.md is in the manifest but has NO source file on disk
  write_manifest "agents/present.md" "agents/ghost.md"

  run_engine capture_install_baseline
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"source(s) missing"* ]]
  [[ -f "${STATE}/base-agents/present.md" ]]
  [[ ! -e "${STATE}/base-agents/ghost.md" ]] # the absent source is degraded, never faked
}

# === T26 — teardown_update_state (uninstall non-symlink state) ==============

@test "T26: teardown_update_state removes the pause flag when present" {
  printf 'pid=1 created=1\n' >"${STATE}/autoagent-pause.flag"
  [[ -e "${STATE}/autoagent-pause.flag" ]]

  run_engine teardown_update_state
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"removed update pause flag"* ]]
  # the ephemeral coordination flag is GONE after uninstall, even though present before
  [[ ! -e "${STATE}/autoagent-pause.flag" ]]
}

@test "T26: teardown_update_state is a clean no-op when no pause flag is present" {
  [[ ! -e "${STATE}/autoagent-pause.flag" ]]

  run_engine teardown_update_state
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"no update pause flag to remove"* ]]
}

@test "T26: teardown keeps the base@install baseline by default (no --purge-config)" {
  printf '{"version":"1.0.0"}\n' >"${STATE}/baseline-manifest.json"

  run_engine teardown_update_state
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"base@install baseline kept"* ]]
  # recovery state is preserved unless --purge-config (mirrors config.toml policy)
  [[ -f "${STATE}/baseline-manifest.json" ]]
}

@test "T26: dry-run reports the pause-flag removal without performing it" {
  printf 'pid=1 created=1\n' >"${STATE}/autoagent-pause.flag"
  export EBATS_DRY="true"

  run_engine teardown_update_state
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"would remove update pause flag"* ]]
  [[ -e "${STATE}/autoagent-pause.flag" ]] # report-only — still present
}

# === T27 — doctor section-9e STALE update-pause-flag advisory ===============

@test "T27: doctor section-9 reports OK (no WARN) when no pause flag is present" {
  write_manifest "agents/dev-x.md"

  run "${REAL_GA}" doctor
  [[ "${output}" == *"no update pause flag"* ]]
  [[ "${output}" != *"STALE update pause flag"* ]]
}

@test "T27: doctor section-9 WARNs on a STALE pause flag and leaves it in place" {
  write_manifest "agents/dev-x.md"
  printf 'pid=1 created=1\n' >"${STATE}/autoagent-pause.flag"
  # age the flag past the 1800s TTL → crashed-updater residue (BSD -v / GNU -d fallback)
  touch -t "$(date -v-2H +%Y%m%d%H%M 2>/dev/null || date -d '2 hours ago' +%Y%m%d%H%M)" \
    "${STATE}/autoagent-pause.flag"

  run "${REAL_GA}" doctor
  [[ "${output}" == *"STALE update pause flag"* ]]
  # doctor is MUTATION-FREE — unlike the daemon honor predicate it never clears the flag
  [[ -e "${STATE}/autoagent-pause.flag" ]]
}

@test "T27: doctor section-9 reports a fresh pause flag as an ACTIVE in-progress update" {
  write_manifest "agents/dev-x.md"
  printf 'pid=1 created=1\n' >"${STATE}/autoagent-pause.flag" # fresh mtime = now

  run "${REAL_GA}" doctor
  [[ "${output}" == *"update pause flag active"* ]]
  [[ "${output}" != *"STALE update pause flag"* ]]
  [[ -e "${STATE}/autoagent-pause.flag" ]]
}
