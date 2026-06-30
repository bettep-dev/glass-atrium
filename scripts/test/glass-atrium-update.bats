#!/usr/bin/env bats
# glass-atrium-update suite — pins the E3 T09 update-skill adapter contract:
#   * resolution helpers      — GA_ROOT / reports-dir / .apply-lock / release slug
#   * update_head_is_wip      — refuses a mid-apply [WIP-AUTO] HEAD, allows clean
#   * update_partition_sensitive — clean vs sensitive split, fail-CLOSED on error
#   * update_serialize_begin / update_cleanup — pause flag set + lock acquired,
#                               lock contention loud-fails, trap unwinds both
#   * end-to-end run via the ATRIUM_UPDATE_SRC_DIR test seam — verify → confirm →
#     deterministic non-agent sync → baseline; decline writes nothing
#   * boundary asserts        — NOT a merge engine (agent md excluded), NEVER
#                               writes core.autoagent_proposals
#
# Run via: bats scripts/test/glass-atrium-update.bats
# Requires: bats >= 1.5.0, jq, git, python3, diff, shasum/sha256sum
#
# Hermetic strategy: every test runs inside a per-test mktemp sandbox with
# GA_ROOT / AUTOAGENT_REPORTS_DIR / ATRIUM_PAUSE_STATE_DIR / ATRIUM_UPDATE_STATE_DIR
# redirected into it. The libs are sourced from the REAL install (the sandbox GA_ROOT
# only holds the test's fixture tree, not the libs), so the skill resolves its libs
# via a separate REAL_LIB_ROOT. Confirmation is injected via ATRIUM_UPDATE_CONFIRM_ANSWER
# and the download is bypassed via ATRIUM_UPDATE_SRC_DIR — /dev/tty and gh are never touched.

bats_require_minimum_version 1.5.0

# Exported so the `declare -f load_skill`-injected helper resolves them inside the
# fresh `bash -c` children that tests 4-6 spawn: a non-exported var is unbound
# under the strict-mode `set -u` load_skill enables → spurious rc1.
export SKILL="${HOME}/.glass-atrium/skills/glass-atrium-update/update.sh"
export REAL_LIB_ROOT="${HOME}/.glass-atrium"
export GEN_MANIFEST="${HOME}/.glass-atrium/scripts/generate-manifest.sh"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v git >/dev/null 2>&1 || skip "git required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t ga-update-bats.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install" # sandbox GA_ROOT (the live install under test)
  NEWSRC="${WORK}/newsrc"   # the staged new-release tree (test seam source)
  STATE="${WORK}/state"     # reports / pause / baseline sandbox
  mkdir -p "${INSTALL}" "${NEWSRC}" "${STATE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# Write file $2 (relative) with content $3 under root $1, creating parent dirs.
seed_file() {
  local root="$1" rel="$2" content="$3"
  mkdir -p -- "$(dirname -- "${root}/${rel}")"
  printf '%s' "${content}" >"${root}/${rel}"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Build a manifest.json at $1 listing relative paths $2.. rooted at the NEWSRC tree.
write_manifest() {
  local out="$1"
  shift
  local p hashes="" files=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
    hashes="${hashes}$(printf '%s' "${p}" | jq -R .):$(sha256_of "${NEWSRC}/${p}" | jq -R .),"
  done
  printf '{"version":"1.0.0","files":[%s],"hashes":{%s}}\n' \
    "${files%,}" "${hashes%,}" >"${out}"
}

# Source the skill (functions only — the `if BASH_SOURCE==$0` guard prevents
# update_main from running) then source its libs, under full strict mode.
load_skill() {
  set -Eeuo pipefail
  IFS=$'\n\t'
  export GA_ROOT="${INSTALL}"
  export AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports"
  export ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state"
  export ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state"
  # the sensitive helper lives in the REAL install (the sandbox GA_ROOT has none)
  export ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py"
  # shellcheck source=/dev/null
  source "${SKILL}"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/atrium-config.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/update-pause-flag.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-spine.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-gate.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/sensitive-refusal.sh"
}

# --- resolution helpers ----------------------------------------------------

@test "resolution helpers anchor on GA_ROOT and the daemon reports dir" {
  run bash -c '
    source "'"${SKILL}"'"
    GA_ROOT="/x" update_ga_root
    AUTOAGENT_REPORTS_DIR="/r" update_apply_lock_dir
  '
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "/x" ]]
  [[ "${lines[1]}" == "/r/.apply-lock" ]]
}

@test "release slug prefers ATRIUM_RELEASE_REPO over config" {
  run bash -c '
    source "'"${SKILL}"'"
    source "'"${REAL_LIB_ROOT}"'/scripts/lib/atrium-config.sh"
    ATRIUM_RELEASE_REPO="owner/repo" update_release_slug
  '
  [ "$status" -eq 0 ]
  [[ "$output" == "owner/repo" ]]
}

# --- WIP HEAD refusal ------------------------------------------------------

@test "update_head_is_wip refuses a [WIP-AUTO] HEAD and allows a clean one" {
  git -C "${INSTALL}" init -q
  git -C "${INSTALL}" config user.email t@t.t
  git -C "${INSTALL}" config user.name t
  seed_file "${INSTALL}" "f.txt" "a"
  git -C "${INSTALL}" add f.txt
  git -C "${INSTALL}" commit -qm "clean commit"
  run bash -c 'source "'"${SKILL}"'"; GA_ROOT="'"${INSTALL}"'" update_head_is_wip'
  [ "$status" -eq 1 ] # clean HEAD → not WIP

  git -C "${INSTALL}" commit -q --allow-empty -m "[WIP-AUTO] snapshot"
  run bash -c 'source "'"${SKILL}"'"; GA_ROOT="'"${INSTALL}"'" update_head_is_wip'
  [ "$status" -eq 0 ] # WIP HEAD → refuse
}

# --- sensitive partition (fail-closed) -------------------------------------

@test "update_partition_sensitive splits clean vs sensitive, fail-closed" {
  # Exercises the T09 partition MECHANISM (does it route each path to the right
  # bucket per the shared helper's verdict). GLOBAL_RULES.md is the canonical
  # sensitive fixture — it matches the compiled refusal pattern, so the split is
  # asserted independently of any single pattern's coverage. (The launchd-plist
  # refusal contract is pinned separately below.)
  run bash -c '
    '"$(declare -f load_skill seed_file)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    printf "scripts/foo.sh\nagents/../GLOBAL_RULES.md\n" \
      | update_partition_sensitive "'"${WORK}"'/clean" "'"${WORK}"'/sens"
    echo "CLEAN:"; cat "'"${WORK}"'/clean"
    echo "SENS:"; cat "'"${WORK}"'/sens"
  '
  [ "$status" -eq 0 ]
  # clean path lands in the clean bucket, sensitive path in the sensitive bucket
  [[ "$output" == *"CLEAN:"*"scripts/foo.sh"* ]]
  [[ "$output" == *"SENS:"*"GLOBAL_RULES.md"* ]]
}

@test "update_partition_sensitive refuses a glass-atrium launchd plist (gate G7)" {
  # SECURITY CONTRACT: the project's launchd plists (com.glass-atrium.*.plist —
  # the live launchctl bootstrap surface) MUST be partitioned OUT of the auto-sync
  # set. Enforced now that daemon_cycle.py _SAFETY_SENSITIVE_PATH_PATTERNS carries
  # the additive com.glass-atrium.*.plist pattern alongside the legacy com.claude.*.
  run bash -c '
    '"$(declare -f load_skill seed_file)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    printf "scripts/foo.sh\nlaunchd/com.glass-atrium.autoagent-cycle.plist\n" \
      | update_partition_sensitive "'"${WORK}"'/clean" "'"${WORK}"'/sens"
    echo "CLEAN:"; cat "'"${WORK}"'/clean"
    echo "SENS:"; cat "'"${WORK}"'/sens"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"SENS:"*"plist"* ]]
}

# --- serialize begin + cleanup unwind --------------------------------------

@test "serialize_begin sets the pause flag + acquires the lock; cleanup unwinds both" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    update_serialize_begin
    flag="$(update_pause_flag_path)"
    lock="$(update_apply_lock_dir)"
    [[ -e "${flag}" ]] && echo "FLAG_SET"
    [[ -d "${lock}" ]] && echo "LOCK_HELD"
    update_cleanup
    [[ ! -e "${flag}" ]] && echo "FLAG_CLEARED"
    [[ ! -d "${lock}" ]] && echo "LOCK_RELEASED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"FLAG_SET"* ]]
  [[ "$output" == *"LOCK_HELD"* ]]
  [[ "$output" == *"FLAG_CLEARED"* ]]
  [[ "$output" == *"LOCK_RELEASED"* ]]
}

@test "serialize_begin loud-fails when the .apply-lock is already held" {
  mkdir -p "${STATE}/daemon-reports/.apply-lock" # pre-existing held lock
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    update_serialize_begin
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"another apply is in progress"* ]]
}

# --- end-to-end apply via the test seam ------------------------------------

@test "full run applies a non-agent change on confirm and captures a baseline" {
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]]
  # baseline anchor captured under the update-state dir
  [[ -f "${STATE}/update-state/baseline-manifest.json" ]]
  # pause flag + lock cleaned up by the trap
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "full run writes NOTHING when the confirm gate is declined" {
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="n" \
    bash "${SKILL}"

  [ "$status" -ne 0 ]                                  # declined → non-zero
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "old" ]] # unchanged
  [[ ! -f "${STATE}/update-state/baseline-manifest.json" ]]
  # failure-trap (T09): BOTH the pause flag AND the daemon .apply-lock are
  # released on the non-zero (declined) exit path so the launchd daemon resumes —
  # the lock-release leg was previously unasserted on the failure path.
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "full run is a clean no-op (rc0, trap unwound) when nothing changed" {
  # install == new release (identical content + matching manifest hashes) → the
  # spine selects zero changed files → update_run returns 0 BEFORE the confirm
  # gate, and the trap still releases the flag + lock. Pins the "already up to
  # date" orchestration branch (previously untested).
  seed_file "${INSTALL}" "scripts/tool.sh" "same content"
  seed_file "${NEWSRC}" "scripts/tool.sh" "same content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="n" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "same content" ]]
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "boundary: an agents/**/*.md change is EXCLUDED from the deterministic sync" {
  seed_file "${INSTALL}" "agents/foo.md" "old agent"
  seed_file "${NEWSRC}" "agents/foo.md" "new agent"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  write_manifest "${WORK}/manifest.json" "agents/foo.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]] # non-agent synced
  [[ "$(cat "${INSTALL}/agents/foo.md")" == "old agent" ]]  # agent md untouched (E4 path)
}

# --- roster-migration gate (T20 / gate G8) --------------------------------

# Seed a minimal agent-registry.json at $1 listing the agent keys $2.. so the
# roster comparison has a registry signal alongside the file-set signal.
seed_registry() {
  local root="$1"
  shift
  local k objs=""
  for k in "$@"; do
    objs="${objs}$(printf '%s' "${k}" | jq -R .):{},"
  done
  mkdir -p -- "${root}"
  printf '{"version":"1.0.0","agents":{%s}}\n' "${objs%,}" >"${root}/agent-registry.json"
}

# Seed a prior-vendor baseline manifest at <state-dir>/baseline-manifest.json
# (what spine_get_baseline reads) listing the file paths $2.. in `.files[]`. This
# is the PRIOR-VENDOR roster provenance the T20 fix scopes removals against: only
# an agent in THIS baseline that the new release drops is a vendor removal — a
# user-local agent never recorded here is not. $1 = update-state dir.
seed_baseline() {
  local statedir="$1"
  shift
  local p files=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
  done
  mkdir -p -- "${statedir}"
  printf '{"version":"1.0.0","files":[%s],"hashes":{}}\n' \
    "${files%,}" >"${statedir}/baseline-manifest.json"
}

@test "roster gate REFUSES an update that ADDS an agent (file-set signal)" {
  # The release introduces a brand-new agent file (dev-new) absent locally — a
  # roster ADD. The gate must refuse/defer BEFORE any sync and write nothing.
  seed_file "${INSTALL}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-new.md" "new agent body"
  write_manifest "${WORK}/manifest.json" "agents/dev-existing.md" "agents/dev-new.md"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -ne 0 ]                                # gated → non-zero
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"add dev-new"* ]]
  [[ "$output" == *"agent_lifecycle"* ]]             # directs to the ceremony
  [[ ! -f "${INSTALL}/agents/dev-new.md" ]]          # nothing written
  [[ ! -f "${STATE}/update-state/baseline-manifest.json" ]]
  # trap still unwinds the pause flag + lock on the refused exit
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "roster gate REFUSES an update that REMOVES a VENDOR agent (registry signal)" {
  # GENUINE vendor removal: dev-b was a PRIOR-VENDOR agent (recorded in the
  # base@install baseline) that the new release drops. Local registry carries
  # dev-a + dev-b; the release registry drops dev-b. The T20 fix scopes removals
  # against the prior-vendor baseline (not the full local set), so seeding the
  # baseline with dev-b is what makes this a vendor removal that MUST gate.
  seed_baseline "${STATE}/update-state" "agents/dev-a.md" "agents/dev-b.md"
  seed_registry "${INSTALL}" "dev-a" "dev-b"
  seed_registry "${NEWSRC}" "dev-a"
  write_manifest "${WORK}/manifest.json" "agent-registry.json"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -ne 0 ]
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"remove dev-b"* ]]
  # registry NOT silently swapped — local still carries dev-b
  run jq -r '.agents | keys[]' "${INSTALL}/agent-registry.json"
  [[ "$output" == *"dev-b"* ]]
}

@test "roster gate PASSES THROUGH a content-only edit (same roster both sides)" {
  # dev-a is present on BOTH sides (a content EDIT, not a roster change) and a
  # plain non-agent file changes. The gate must NOT fire; the non-agent sync runs
  # and the agent md stays untouched (E4 path).
  seed_file "${INSTALL}" "agents/dev-a.md" "old agent body"
  seed_file "${NEWSRC}" "agents/dev-a.md" "new agent body"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" != *"ROSTER CHANGE DETECTED"* ]]      # gate stayed silent
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]   # non-agent synced
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "old agent body" ]] # agent md untouched
}

@test "roster gate PASSES a content update on a CUSTOMIZED install (T20 fix: user-local agent does NOT block)" {
  # THE T20 FALSE-POSITIVE REGRESSION GUARD. The prior-vendor baseline holds only
  # dev-a. The user added dev-custom via agent_lifecycle (present locally — file +
  # registry — but in NO vendor release). The new release is a pure content change
  # (dev-a edited, a non-agent file changed) and its registry still lists only the
  # vendor roster {dev-a}. Before the fix the remove side compared release-vs-local
  # and flagged `remove dev-custom`, killing EVERY update on a customized install.
  # The provenance fix scopes removals to prior-vendor\release, so dev-custom — a
  # user-local agent never in the baseline — is NOT a vendor removal and the
  # content update flows through. agent-registry.json is absent from the manifest,
  # so the deterministic sync never clobbers the user's dev-custom registry entry.
  seed_baseline "${STATE}/update-state" "agents/dev-a.md"
  seed_file "${INSTALL}" "agents/dev-a.md" "old agent body"
  seed_file "${INSTALL}" "agents/dev-custom.md" "user added via agent_lifecycle"
  seed_registry "${INSTALL}" "dev-a" "dev-custom"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "agents/dev-a.md" "new agent body"
  seed_registry "${NEWSRC}" "dev-a"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" != *"ROSTER CHANGE DETECTED"* ]]               # gate stayed silent
  [[ "$output" != *"remove dev-custom"* ]]                    # no false removal
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]   # content update applied
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "old agent body" ]] # agent md E4-excluded
  # the user's local-only agent is preserved on every layer
  [[ -f "${INSTALL}/agents/dev-custom.md" ]]
  run jq -r '.agents | keys[]' "${INSTALL}/agent-registry.json"
  [[ "$output" == *"dev-custom"* ]]
}

@test "roster gate REFUSES a genuine vendor remove even on a customized install (file-set signal)" {
  # Provenance still gates a REAL vendor drop alongside a user-local agent. Baseline
  # (prior vendor) = {dev-a, dev-b}; the new release ships only dev-a (dev-b dropped
  # by the vendor). dev-custom is user-local. The gate must flag `remove dev-b`
  # (vendor drop) while NEVER flagging dev-custom.
  seed_baseline "${STATE}/update-state" "agents/dev-a.md" "agents/dev-b.md"
  seed_file "${INSTALL}" "agents/dev-a.md" "a"
  seed_file "${INSTALL}" "agents/dev-b.md" "b"
  seed_file "${INSTALL}" "agents/dev-custom.md" "user added"
  seed_file "${NEWSRC}" "agents/dev-a.md" "a"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -ne 0 ]                                  # genuine vendor remove gates
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"remove dev-b"* ]]                  # vendor-dropped agent flagged
  [[ "$output" != *"remove dev-custom"* ]]             # user-local agent NOT flagged
}

@test "T24: a successful apply captures the new-release agent bodies into the base-content store" {
  # After a confirmed apply the new (= base@install) agent *.md bodies are persisted
  # BASENAME-keyed under <state>/base-agents, exactly where editable_merge.load_base_text
  # reads them, so the NEXT update can do a true 3-way merge instead of the gated
  # 2-way fallback. dev-a is present on both sides (content edit, no roster gate).
  seed_baseline "${STATE}/update-state" "agents/dev-a.md"
  seed_file "${INSTALL}" "agents/dev-a.md" "old local body"
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "agents/dev-a.md" "new vendor body"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  # base-content store populated with the NEW (base@install) body, basename-keyed
  [[ -f "${STATE}/update-state/base-agents/dev-a.md" ]]
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "new vendor body" ]]

  # cross-check the store path/key the Python reader resolves matches what we wrote
  run python3 -c '
import sys
sys.path.insert(0, "'"${REAL_LIB_ROOT}"'/autoagent/lib")
import editable_merge as em
print(em.load_base_text("agents/dev-a.md", state_dir="'"${STATE}/update-state"'"))
'
  [ "$status" -eq 0 ]
  [[ "$output" == *"new vendor body"* ]]
}

@test "roster gate OVERRIDE (ATRIUM_UPDATE_ALLOW_ROSTER) proceeds past an add" {
  # The explicit, non-silent opt-in downgrades the refusal to a warning and lets
  # the update proceed (agent md still excluded from the deterministic sync).
  seed_file "${INSTALL}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-new.md" "new agent body"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" \
    "agents/dev-existing.md" "agents/dev-new.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    ATRIUM_UPDATE_ALLOW_ROSTER="1" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ATRIUM_UPDATE_ALLOW_ROSTER set"* ]]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]  # non-agent synced
  [[ ! -f "${INSTALL}/agents/dev-new.md" ]]                  # agent md still E4-excluded
}

@test "boundary: the skill performs no DB writes (no psql / no SQL DML)" {
  # The adapter swaps files only — it must never touch core.autoagent_proposals or
  # any DB surface. Assert there is no psql invocation and no SQL DML in the script
  # (a documentation mention of the table name in a comment is allowed).
  run grep -nE 'psql|INSERT[[:space:]]+INTO|UPDATE[[:space:]]+[a-z_.]+[[:space:]]+SET|DELETE[[:space:]]+FROM' "${SKILL}"
  [ "$status" -ne 0 ] # grep finds nothing → exit 1
  [[ -z "${output}" ]]
}

# --- agent EDITABLE-region merge (E4 / T19) --------------------------------
#
# These pin the LIVE merge integration: each changed agents/<name>.md flows
# through editable_merge `plan` → the SAME T12 confirm gate → git_txn_apply. The
# merge is git-sandboxed, so unlike the earlier non-git fixtures (where it
# loud-skips) these init a real git repo in the INSTALL sandbox so the
# WIP-snapshot → apply → verify → commit transaction actually runs.

# Init a git repo at the INSTALL sandbox + commit whatever is already seeded, so
# git_txn_apply has a clean tracked worktree to transact against.
git_init_install() {
  git -C "${INSTALL}" init -q
  git -C "${INSTALL}" config user.email t@t.t
  git -C "${INSTALL}" config user.name t
  git -C "${INSTALL}" add -A
  git -C "${INSTALL}" commit -qm "seed" || true
}

# Seed the base@install body for agents/<name>.md into the base-content store
# (basename-keyed at <state>/base-agents/<name>.md) — the provenance the resolver
# reads via editable_merge.load_base_text for a true 3-way merge. $1 = name, $2 = body.
seed_base_store() {
  mkdir -p -- "${STATE}/update-state/base-agents"
  printf '%s' "$2" >"${STATE}/update-state/base-agents/$1"
}

# Standard three-anchor agent fixture for dev-a: a Goal region the user learned
# locally + a Rules section the vendor owns. base region == release region (vendor
# never touched the protected region) so the resolver KEEPS the local learned
# region while TAKING the new vendor structure.
GOAL_BASE='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
base goal
<!-- EDITABLE:END -->
## Rules
old vendor rules'
GOAL_LOCAL='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
local learned goal
<!-- EDITABLE:END -->
## Rules
old vendor rules'
GOAL_RELEASE='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
base goal
<!-- EDITABLE:END -->
## Rules
NEW vendor rules'

run_update() {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="${1:-y}" \
    bash "${SKILL}"
}

@test "T19: keep-local region preserved + release structure applied through git_txn (agent-only change)" {
  # Pure agent change (no non-agent file) → update_run hits the early-return branch
  # but STILL runs the merge. base==release region → keep-local; vendor structure
  # changed → take-release structure. needs_llm=False → no Haiku call in verify.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  git_init_install
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  # local learned region kept, vendor Rules structure taken
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" != *"base goal"* ]]
  # the merge committed an [AUTO] apply commit in the install worktree
  run git -C "${INSTALL}" log -1 --format=%s
  [[ "$output" == *"[AUTO] glass-atrium-update EDITABLE-region merge: agents/dev-a.md"* ]]
}

@test "T19: a declined confirm leaves the agent file unmerged (zero writes)" {
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  git_init_install
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update n
  [ "$status" -eq 0 ] # agent merge decline is non-fatal (non-agent path already done/none)
  [[ "$output" == *"declined"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${GOAL_LOCAL}" ]] # untouched
}

@test "T19: STRUCTURAL region-count mismatch routes to the agent_lifecycle ceremony (not applied)" {
  # local has TWO EDITABLE regions, the release ONE → region-count mismatch. The
  # resolver returns structural-change; the skill must NOT auto-apply it.
  local two_region='# dev-a
<!-- EDITABLE:BEGIN -->
region one
<!-- EDITABLE:END -->
<!-- EDITABLE:BEGIN -->
region two
<!-- EDITABLE:END -->'
  local one_region='# dev-a
<!-- EDITABLE:BEGIN -->
region one vendor
<!-- EDITABLE:END -->'
  seed_file "${INSTALL}" "agents/dev-a.md" "${two_region}"
  git_init_install
  seed_file "${NEWSRC}" "agents/dev-a.md" "${one_region}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  [[ "$output" == *"STRUCTURAL"* ]]
  [[ "$output" == *"agent_lifecycle"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${two_region}" ]] # local kept verbatim
}

@test "T19: a sensitive diff in an agent merge is REFUSED (not applied)" {
  # The release introduces an irreversible command (rm -rf) inside the region. The
  # candidate diff matches the compiled sensitive-diff source → plan rc 3 → the
  # skill refuses the file and writes nothing.
  local local_body='# dev-a
<!-- EDITABLE:BEGIN -->
safe local line
<!-- EDITABLE:END -->'
  local danger_body='# dev-a
<!-- EDITABLE:BEGIN -->
rm -rf /tmp/everything
<!-- EDITABLE:END -->'
  seed_file "${INSTALL}" "agents/dev-a.md" "${local_body}"
  git_init_install
  seed_file "${NEWSRC}" "agents/dev-a.md" "${danger_body}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  [[ "$output" == *"REFUSED sensitive"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${local_body}" ]] # untouched
}

@test "T19: non-git install loud-skips the agent merge (transaction needs git)" {
  # No git init → git_txn cannot run; the merge must LOUD-SKIP (Precondition
  # Loud-Fail) rather than silently corrupt or silently no-op a learned region.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  [[ "$output" == *"not a git repo"* ]]
  [[ "$output" == *"SKIPPED"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${GOAL_LOCAL}" ]] # unmerged
}

@test "T19: agent merge coexists with the non-agent sync (both apply on one confirm)" {
  # A non-agent file AND an agent file both change. The non-agent sync applies via
  # the spine; the agent merge applies via git_txn — both gated by the same y.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  git_init_install
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run_update y
  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]            # non-agent synced
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]] # region kept
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]   # structure taken
}
