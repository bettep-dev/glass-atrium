#!/usr/bin/env bats
# glass-atrium-update suite — pins the E3 T09 update-skill adapter contract:
#   * resolution helpers      — GA_ROOT / reports-dir / .apply-lock / release slug
#   * .apply-lock serialize    — a mid-apply daemon is signalled by .apply-lock
#                               CONTENTION (the retired update_head_is_wip /
#                               [WIP-AUTO]-HEAD detector is gone): a stale/dead lock
#                               is reclaimed, a live one blocks
#   * update_partition_sensitive — clean vs sensitive split, fail-CLOSED on error
#   * update_serialize_begin / update_cleanup — pause flag set + lock acquired,
#                               lock contention loud-fails, stale lock reclaimed,
#                               trap unwinds both
#   * end-to-end run via the ATRIUM_UPDATE_SRC_DIR test seam — verify → confirm →
#     deterministic non-agent sync → baseline; decline writes nothing
#   * boundary asserts        — NOT a merge engine (agent md excluded), NEVER
#                               writes core.autoagent_proposals
#
# Run via: bats scripts/test/glass-atrium-update.bats
# Requires: bats >= 1.5.0, jq, python3, diff, shasum/sha256sum
# (git deliberately NOT required — the flow under test is git-free end to end,
# and this suite must prove it runs on a git-less no-.git consumer host.)
#
# Hermetic strategy: every test runs inside a per-test mktemp sandbox with
# GA_ROOT / AUTOAGENT_REPORTS_DIR / ATRIUM_PAUSE_STATE_DIR / ATRIUM_UPDATE_STATE_DIR
# redirected into it. The libs are sourced from the REAL install (the sandbox GA_ROOT
# only holds the test's fixture tree, not the libs), so the skill resolves its libs
# via a separate REAL_LIB_ROOT. Confirmation is injected via ATRIUM_UPDATE_CONFIRM_ANSWER
# and the download is bypassed via ATRIUM_UPDATE_SRC_DIR — /dev/tty and gh are never touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

# Exported so the `declare -f load_skill`-injected helper resolves them inside the
# fresh `bash -c` children that tests 4-6 spawn: a non-exported var is unbound
# under the strict-mode `set -u` load_skill enables → spurious rc1.
export SKILL="${GA}/scripts/update.sh"
export REAL_LIB_ROOT="${GA}"
export GEN_MANIFEST="${GA}/scripts/generate-manifest.sh"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t ga-update-bats.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install" # sandbox GA_ROOT (the live install under test)
  NEWSRC="${WORK}/newsrc"   # the staged new-release tree (test seam source)
  STATE="${WORK}/state"     # reports / pause / baseline sandbox
  mkdir -p "${INSTALL}" "${NEWSRC}" "${STATE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
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
  # The git-free serialize path (update_serialize_begin / update_cleanup) resolves
  # apply_lock_acquire / apply_lock_release from this lib; update_main sources it at
  # runtime, so the function-only test seam must source it here too.
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-lock.sh"
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

@test "serialize_begin RECLAIMS a stale dead .apply-lock (retired [WIP-AUTO] mid-apply detector)" {
  # The OLD mid-apply-daemon signal (update_head_is_wip / a [WIP-AUTO] HEAD) is
  # DELETED; a mid-apply daemon is now signalled by .apply-lock CONTENTION. A daemon
  # that was SIGKILLed leaves a stranded lock (no EXIT trap) — the shared stale-reclaim
  # acquire must let the updater PROCEED (reclaim) rather than loud-fail forever, so
  # this is the git-free replacement for the retired WIP-HEAD detector.
  mkdir -p "${STATE}/daemon-reports/.apply-lock" # stranded lock, no pid = not-live
  # Backdate the lock dir mtime well past the (tiny) TTL so it reads as crashed
  # residue, not a fresh mid-acquire racer (mtime via python3 os.utime — the portable
  # idiom, never BSD/GNU-divergent stat -f / stat -c).
  python3 -c 'import os,sys,time; t=time.time()-3600; os.utime(sys.argv[1], (t, t))' \
    "${STATE}/daemon-reports/.apply-lock"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    export ATRIUM_APPLY_LOCK_TTL_SECS=1
    load_skill
    update_serialize_begin && echo "ACQUIRED"
    update_cleanup && echo "RELEASED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ACQUIRED"* ]]                  # reclaimed the stale lock (no permanent wedge)
  [[ "$output" == *"RELEASED"* ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]] # cleanup released the reclaimed lock
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
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]] # non-agent → deterministic sync
  # agents/*.md is EXCLUDED from the deterministic sync (spine_is_excluded_path); it
  # flows through the SEPARATE git-free E4 merge instead, which take-releases this
  # region-less vendor file. The distinct "agent merged + applied" log line proves it
  # went through the E4 path, not the tar sync (whose diff lists only scripts/tool.sh).
  [[ "$output" == *"agent merged + applied: agents/foo.md"* ]]
  [[ "$(cat "${INSTALL}/agents/foo.md")" == "new agent" ]]
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
  # and the agent md is merged via the SEPARATE git-free E4 path.
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
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "new agent body" ]] # agent md merged via the git-free E4 path
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
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "new agent body" ]] # agent md merged via the git-free E4 path
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

@test "boundary: the skill NEVER writes core.autoagent_proposals (only core.update_job)" {
  # P3 gave the headless path a DB surface: core.update_job status tracking. That
  # is the ONLY table the adapter may touch — core.autoagent_proposals belongs to
  # the autoagent self-improvement loop and MUST stay off-limits. Assert (a) no SQL
  # statement (INSERT/UPDATE/DELETE/SELECT ... FROM) targets autoagent_proposals —
  # a bare prose mention of the table name in a header comment is allowed — and (b)
  # every DML statement targets core.update_job (the single allowed write surface).
  run grep -nE '(INTO|UPDATE|FROM|TABLE)[[:space:]]+(core\.)?autoagent_proposals' "${SKILL}"
  [ "$status" -ne 0 ] # grep finds nothing → exit 1
  [[ -z "${output}" ]]
  # Every INSERT INTO / UPDATE ... SET / DELETE FROM must name core.update_job.
  run grep -nE 'INSERT[[:space:]]+INTO[[:space:]]+(core\.)?[a-z_]+|DELETE[[:space:]]+FROM[[:space:]]+(core\.)?[a-z_]+' "${SKILL}"
  local line
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    [[ "${line}" == *"core.update_job"* ]] || {
      echo "unexpected DML target: ${line}"
      return 1
    }
  done <<<"${output}"
}

# --- agent EDITABLE-region merge (E4 / T19) --------------------------------
#
# These pin the LIVE merge integration: each changed agents/<name>.md flows
# through editable_merge `plan` → the SAME T12 confirm gate → git_txn_apply. The
# transaction is git-FREE (before-image copy → apply → verify → atomic restore on
# fail; no git repo, no rev-parse — proven by autoagent/test/git-txn-gitfree.bats),
# so these fixtures run in a plain NON-git INSTALL sandbox and the merge PROCEEDS
# and applies whether or not a .git repo is present (no git_init needed).

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
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  # local learned region kept, vendor Rules structure taken
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" != *"base goal"* ]]
  # git-free transaction: git_txn_apply applies via a before-image copy + verify and
  # runs NO git op, so the on-disk content above IS the applied-state proof. The merge
  # created no repo — a plain non-git INSTALL sandbox stays git-free end to end.
  [[ ! -d "${INSTALL}/.git" ]]
}

@test "T19: a declined confirm leaves the agent file unmerged (zero writes)" {
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
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
  seed_file "${NEWSRC}" "agents/dev-a.md" "${danger_body}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  [[ "$output" == *"REFUSED sensitive"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${local_body}" ]] # untouched
}

@test "T19: non-git install still MERGES the agent file (git-free transaction, no SKIP)" {
  # No git repo in the INSTALL sandbox. Post-P2-T2 the merge is git-FREE (git_txn_apply
  # captures a before-image copy + restores atomically — proven by git-txn-gitfree.bats),
  # so it PROCEEDS and applies the region rather than loud-skipping. Regression guard for
  # the retired update_git_root "requires git" premise (the DC-1 review finding).
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  [[ "$output" != *"not a git repo"* ]]                                 # no SKIP path
  [[ "$output" != *"SKIPPED"* ]]
  [[ ! -d "${INSTALL}/.git" ]]                                          # stayed git-free
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]] # region kept
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]   # structure taken
}

@test "T19: agent merge coexists with the non-agent sync (both apply on one confirm)" {
  # A non-agent file AND an agent file both change. The non-agent sync applies via
  # the spine; the agent merge applies via git_txn — both gated by the same y.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run_update y
  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]            # non-agent synced
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]] # region kept
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]   # structure taken
}

@test "T19/P2-T2: the pre-merge local body lands in the PERSISTENT agents-bak (single authoritative before-image)" {
  # The transaction's before-image is the SAME per-run agents-bak copy that
  # --restore-agents reads AND that the merge verify anchors on — no ephemeral
  # merge-dir localbak duplicate exists anymore (P2-T2 AC3).
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ]
  # the merge applied — proof the verify PASSED while anchored on the agents-bak copy
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]
  # the persistent per-run before-image holds the pre-merge local body byte-for-byte
  # (glob over the <cycle_date>_update-<version> dir — date computed in the child)
  local bak
  bak="$(printf '%s\n' "${INSTALL}/agents-bak/"*"_update-1.0.0/dev-a.md.bak" | head -1)"
  [[ -f "${bak}" ]]
  [[ "$(cat "${bak}")" == "${GOAL_LOCAL}" ]]
}

@test "T19: a failed per-file transaction summarizes as rolled-back/unapplied, NOT declined (rc-collision fix)" {
  # A CONFIRMED run whose single agent transaction fails (read-only target → the
  # apply cp cannot write → GIT_TXN_APPLY_FAIL) must surface the distinct rc-3
  # summary. Before the fix the commit callback returned 1, colliding with the
  # gate's own 1=declined — a confirmed-but-failed run was mislabeled "declined"
  # and the rolled-back summary branch was unreachable.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"
  chmod a-w "${INSTALL}/agents/dev-a.md" # plan/diff still read it; the apply cp loud-fails

  run_update y
  [ "$status" -eq 0 ] # the agent merge stays best-effort / non-fatal
  [[ "$output" == *"rolled-back or unapplied file(s)"* ]]
  [[ "$output" != *"merge declined"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${GOAL_LOCAL}" ]] # untouched
}

# --- P3-T2: headless / web-triggered orchestration ------------------------------
#
# These pin the P3 headless layer added ON TOP of the E3 interactive flow:
#   * core.update_job DB status tracking (in-progress → heartbeat → completed/failed)
#     via the ATRIUM_UPDATE_PSQL seam — a mock psql that logs argv+SQL and returns a
#     RETURNING id, so NO live Postgres is touched
#   * single-active enforcement (partial unique index violation → loud-fail exit 8)
#   * heartbeat + pause-flag mtime refresh on a long-stage tick
#   * the EXIT-trap in-progress→failed marking (abort/crash recovery) + WHERE-guarded
#     terminal writes (a stale-swept row is never resurrected)
#   * confirm-seam fail-closed (a blank token declines, zero writes)
#   * install-parity post-step (mock npm build + launchctl kickstart/bootstrap probe)
#   * the decoupled one-shot launchd plist render
#   * the claude -p precondition (resolve ok / unresolvable → exit 7 / plist PATH miss)
#   * agents-bak restore mode (--restore-agents) + 14-day retention prune
#
# All external effects are seamed to mocks (ATRIUM_UPDATE_PSQL / _NPM / _LAUNCHCTL /
# _CLAUDE_BIN / _MONITOR_DIR / _RENDER_*): no real build, launchctl, claude, or DB.

# A mock psql: logs "$*" + the stdin SQL to $PSQL_LOG, returns a fake RETURNING id,
# and (when $PSQL_FAIL=unique|dberr) simulates a unique-violation / connection error.
write_mock_psql() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
sql="$(cat)"
{ printf 'ARGS:%s\n' "$*"; printf 'SQL:%s\n' "${sql}"; } >>"${PSQL_LOG:-/dev/null}"
case "${PSQL_FAIL:-}" in
  unique) printf 'ERROR: duplicate key value violates unique constraint "update_job_single_active_uniq"\n' >&2; exit 1 ;;
  dberr) printf 'ERROR: could not connect to server\n' >&2; exit 2 ;;
esac
[[ "${sql}" == *"RETURNING id"* ]] && printf '42\n'
exit 0
MOCK
  chmod +x "$1"
}

# A mock npm: logs "$*" to $NPM_LOG, exits $NPM_RC (default 0).
write_mock_npm() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${NPM_LOG:-/dev/null}"
exit "${NPM_RC:-0}"
MOCK
  chmod +x "$1"
}

# A mock launchctl: logs "$*" to $LAUNCHCTL_LOG. `print` returns 0 when
# $LAUNCHCTL_LOADED=1 (loaded) else non-zero — driving the kickstart-vs-bootstrap probe.
write_mock_launchctl() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${LAUNCHCTL_LOG:-/dev/null}"
if [[ "$1" == "print" ]]; then
  [[ "${LAUNCHCTL_LOADED:-1}" == "1" ]] && exit 0 || exit 1
fi
exit 0
MOCK
  chmod +x "$1"
}

# A mock claude binary — presence + executability is all the precondition checks.
write_mock_claude() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
  chmod +x "$1"
}

# A minimal, plutil-parseable launchd plist whose EnvironmentVariables.PATH = $2.
write_plist_path() {
  cat >"$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$2</string>
	</dict>
</dict>
</plist>
PLIST
}

@test "P3 headless: update_job transitions in-progress INSERT → heartbeat → completed (psql seam)" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    update_job_begin
    echo "ID=${_update_job_id}"
    update_job_heartbeat
    update_job_complete
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ID=42"* ]] # RETURNING id captured from the INSERT
  grep -q "INSERT INTO core.update_job" "${WORK}/psql.log"
  grep -q "status = 'completed'" "${WORK}/psql.log"
  grep -q "heartbeat_at = now()" "${WORK}/psql.log"
  # heartbeat + completion are WHERE-guarded on the in-progress row
  grep -q "status = 'in-progress'" "${WORK}/psql.log"
}

@test "P3 headless: update_job_fail records status='failed' + failure_reason (WHERE-guarded)" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    _update_job_id=42
    update_job_fail "boom reason"
  '
  [ "$status" -eq 0 ]
  grep -q "status = 'failed'" "${WORK}/psql.log"
  grep -q "failure_reason = :'fr'" "${WORK}/psql.log" # bound, not concatenated (injection-safe)
  grep -q "fr=boom reason" "${WORK}/psql.log"         # the reason rides a psql -v bind
  grep -q "status = 'in-progress'" "${WORK}/psql.log" # WHERE-guard (never clobber a swept row)
}

@test "P3 headless: a 2nd concurrent in-progress INSERT (partial unique index violation) loud-fails exit 8" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    export PSQL_FAIL=unique
    _update_headless=1
    update_job_begin
  '
  [ "$status" -eq 8 ] # single-active DB guard → named exit 8
  [[ "$output" == *"another update is already in-progress"* ]]
}

@test "P3 headless: ATRIUM_UPDATE_JOB_ID adopts the route-created row (no INSERT, heartbeat only)" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    export ATRIUM_UPDATE_JOB_ID=777
    _update_headless=1
    update_job_begin
    echo "ID=${_update_job_id}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ID=777"* ]]                              # adopted the pre-created row id
  ! grep -q "INSERT INTO core.update_job" "${WORK}/psql.log" # adopted, never re-INSERTed
  grep -q "heartbeat_at = now()" "${WORK}/psql.log"          # heartbeated the adopted row
}

@test "P3: ATRIUM_UPDATE_DB=off (and interactive mode) performs ZERO psql calls" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    export ATRIUM_UPDATE_DB=off
    _update_headless=1
    update_job_begin; update_job_heartbeat; update_job_complete
    _update_headless=0
    update_job_begin # interactive path never touches the DB
  '
  [ "$status" -eq 0 ]
  [[ ! -s "${WORK}/psql.log" ]] # no psql process was ever invoked
}

@test "P3 headless: update_heartbeat refreshes BOTH the pause-flag mtime and the DB heartbeat" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    update_serialize_begin # sets the pause flag (_update_pause_created=1) + lock
    flag="$(update_pause_flag_path)"
    _update_job_id=42
    # backdate the flag past the 1800s TTL so a genuine refresh is observable
    python3 -c "import os,sys,time; t=time.time()-3600; os.utime(sys.argv[1],(t,t))" "${flag}"
    aged="$(update_pause_flag_age_secs "${flag}" 2>/dev/null || echo 0)"
    update_heartbeat # long-stage tick: refresh flag mtime + DB heartbeat
    fresh="$(update_pause_flag_age_secs "${flag}" 2>/dev/null || echo 999)"
    if [[ "${aged}" -ge 1800 && "${fresh}" -lt 60 ]]; then echo "PAUSE_REFRESHED"; fi
    update_cleanup
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"PAUSE_REFRESHED"* ]]           # mtime advanced from 3600s to near-0
  grep -q "heartbeat_at = now()" "${WORK}/psql.log" # DB heartbeat fired on the same tick
}

@test "P3 headless: the EXIT trap marks an unfinalized in-progress row 'failed' (abort/crash recovery)" {
  # A headless run that dies mid-flight (update_die, a declined gate, a crash caught by
  # the trap) leaves an in-progress row → update_cleanup marks it 'failed' with the exit
  # code so the P3-T3 stale sweep + the web UI never see a phantom-active job.
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    _update_job_id=42
    _update_job_final=0 # not yet completed → the trap must fail it
    update_cleanup      # simulates the EXIT trap firing on an abnormal exit
  '
  [ "$status" -eq 0 ]
  grep -q "status = 'failed'" "${WORK}/psql.log"
  grep -q "fr=aborted (exit=" "${WORK}/psql.log" # failure_reason carries the exit code
}

@test "P3 headless: terminal writes are WHERE-guarded (a stale-swept row is never resurrected)" {
  # complete + fail both carry `WHERE ... status = 'in-progress'`, so a P3-T3 stale
  # sweep that already flipped the row to 'failed' can never be clobbered back by a
  # late terminal write from the (crashed) running process.
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    _update_job_id=42
    update_job_complete
    _update_job_final=0
    update_job_fail "late"
  '
  [ "$status" -eq 0 ]
  run grep -c "AND status = 'in-progress'" "${WORK}/psql.log"
  [ "$output" -ge 2 ] # both terminal writes name the in-progress guard
}

@test "P3 headless: a blank confirm token is fail-closed (declines, writes nothing)" {
  # The web commit injects ATRIUM_UPDATE_CONFIRM_ANSWER=yes; ANY other value — including
  # the empty string that a missing token / no-TTY both resolve to — declines via the
  # gate's `case "" ) …decline` branch. DB disabled + a stubbed claude keep the run
  # hermetic; the assertion is that a headless apply with a blank token writes ZERO files.
  local claude="${WORK}/claude"
  write_mock_claude "${claude}"
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
    ATRIUM_UPDATE_DB=off \
    ATRIUM_UPDATE_CLAUDE_BIN="${claude}" \
    ATRIUM_UPDATE_MONITOR_PLIST="${WORK}/nonexistent-monitor.plist" \
    ATRIUM_UPDATE_ONESHOT_PLIST="${WORK}/nonexistent-oneshot.plist" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="" \
    bash "${SKILL}" --headless

  [ "$status" -ne 0 ] # declined → non-zero
  [[ "$output" == *"declined"* ]]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "old" ]] # zero writes
  [[ ! -f "${STATE}/update-state/baseline-manifest.json" ]]
  # trap unwound the pause flag + lock on the fail-closed exit
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "P3 headless: a confirmed apply drives in-progress→completed and runs the install-parity post-step" {
  # Full headless success e2e with every external effect seamed to a mock: psql (DB
  # tracking), claude (precondition), npm (monitor rebuild), launchctl (launchd refresh).
  # No real build/restart/claude/DB is touched; the monitor stays live.
  local claude="${WORK}/claude"
  write_mock_claude "${claude}"
  write_mock_psql "${WORK}/psql"
  write_mock_npm "${WORK}/npm"
  write_mock_launchctl "${WORK}/launchctl"
  mkdir -p "${WORK}/monitor" # a monitor dir so the build step runs
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
    ATRIUM_UPDATE_CONFIRM_ANSWER="yes" \
    ATRIUM_UPDATE_PSQL="${WORK}/psql" \
    PSQL_LOG="${WORK}/psql.log" \
    ATRIUM_UPDATE_CLAUDE_BIN="${claude}" \
    ATRIUM_UPDATE_MONITOR_PLIST="${WORK}/nonexistent-monitor.plist" \
    ATRIUM_UPDATE_ONESHOT_PLIST="${WORK}/oneshot.plist" \
    ATRIUM_UPDATE_MONITOR_DIR="${WORK}/monitor" \
    ATRIUM_UPDATE_NPM="${WORK}/npm" \
    NPM_LOG="${WORK}/npm.log" \
    ATRIUM_UPDATE_LAUNCHCTL="${WORK}/launchctl" \
    LAUNCHCTL_LOG="${WORK}/launchctl.log" \
    LAUNCHCTL_LOADED=1 \
    ATRIUM_UPDATE_RENDER_LAUNCHD="${WORK}/nonexistent-render-launchd.sh" \
    ATRIUM_UPDATE_RENDER_MONITOR_ENV="${WORK}/nonexistent-render-env.sh" \
    bash "${SKILL}" --headless

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]]       # applied
  grep -q "INSERT INTO core.update_job" "${WORK}/psql.log"           # opened in-progress
  grep -q "status = 'completed'" "${WORK}/psql.log"                  # closed completed
  grep -q "run build" "${WORK}/npm.log"                              # monitor rebuilt (npm run build)
  grep -q "kickstart -k" "${WORK}/launchctl.log"                     # loaded → kickstart -k
  [[ -f "${WORK}/oneshot.plist" ]]                                   # one-shot plist rendered
  grep -q "com.glass-atrium.update-oneshot" "${WORK}/oneshot.plist"  # correct decoupled label
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]            # trap unwound
}

@test "P3: install-parity post-step is idempotent (loaded→kickstart -k, unloaded→bootstrap; mock npm/launchctl)" {
  write_mock_npm "${WORK}/npm"
  write_mock_launchctl "${WORK}/launchctl"
  mkdir -p "${WORK}/monitor"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export NPM_LOG="'"${WORK}"'/npm.log" LAUNCHCTL_LOG="'"${WORK}"'/lc.log"
    export ATRIUM_UPDATE_NPM="'"${WORK}"'/npm" ATRIUM_UPDATE_LAUNCHCTL="'"${WORK}"'/launchctl"
    export ATRIUM_UPDATE_MONITOR_DIR="'"${WORK}"'/monitor"
    export ATRIUM_UPDATE_MONITOR_PLIST="'"${WORK}"'/mon.plist"
    # loaded: the print probe returns 0 → kickstart -k, run twice (idempotent verb)
    export LAUNCHCTL_LOADED=1
    update_build_monitor && echo "BUILD_OK"
    update_refresh_monitor_launchd
    update_refresh_monitor_launchd
    # unloaded: the print probe returns non-zero → bootstrap (kickstart -k is
    # non-idempotent when unloaded, so the probe picks the correct verb)
    export LAUNCHCTL_LOADED=0
    update_refresh_monitor_launchd
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"BUILD_OK"* ]]
  grep -q "run build" "${WORK}/npm.log"                            # build ran through the npm seam
  [[ "$(grep -c 'kickstart -k' "${WORK}/lc.log")" -eq 2 ]]         # loaded → kickstart -k, both times
  grep -q "bootstrap" "${WORK}/lc.log"                            # unloaded → bootstrap
}

@test "P3: the decoupled one-shot launchd plist renders with the update-oneshot label + --headless args" {
  local claude="${WORK}/bin/claude"
  mkdir -p "${WORK}/bin"
  write_mock_claude "${claude}"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_CLAUDE_BIN="'"${claude}"'"
    export ATRIUM_UPDATE_ONESHOT_PLIST="'"${WORK}"'/oneshot.plist"
    out="$(update_render_oneshot_plist)"
    echo "OUT=${out}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"OUT=${WORK}/oneshot.plist"* ]]
  [[ -f "${WORK}/oneshot.plist" ]]
  grep -q "<string>com.glass-atrium.update-oneshot</string>" "${WORK}/oneshot.plist"
  grep -q "<string>--headless</string>" "${WORK}/oneshot.plist" # runs headless update.sh
  grep -q "<key>RunAtLoad</key>" "${WORK}/oneshot.plist"        # one-shot: runs on bootstrap
  if command -v plutil >/dev/null 2>&1; then
    run plutil -lint -s "${WORK}/oneshot.plist"
    [ "$status" -eq 0 ] # the rendered plist is valid
  fi
}

@test "P3 headless: claude precondition PASSES when the binary resolves and each plist PATH contains it" {
  local claude="${WORK}/bin/claude"
  mkdir -p "${WORK}/bin"
  write_mock_claude "${claude}"
  write_plist_path "${WORK}/ok.plist" "${WORK}/bin:/usr/bin:/bin"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_CLAUDE_BIN="'"${claude}"'"
    update_verify_claude_precondition "'"${WORK}"'/ok.plist" && echo "PRECOND_OK"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"PRECOND_OK"* ]]
  [[ "$output" == *"claude precondition ok"* ]]
}

@test "P3 headless: claude precondition LOUD-FAILS exit 7 when the binary is unresolvable" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    # a bogus BASENAME resolves nowhere (not on PATH, not in the common install dirs)
    export ATRIUM_UPDATE_CLAUDE_BIN="claude-nonexistent-xyztest"
    update_verify_claude_precondition
  '
  [ "$status" -eq 7 ] # named loud-fail exit 7 (the merge stage would fail)
  [[ "$output" == *"claude binary NOT resolvable"* ]]
}

@test "P3 headless: claude precondition LOUD-FAILS exit 7 when a plist PATH omits claude" {
  local claude="${WORK}/bin/claude"
  mkdir -p "${WORK}/bin"
  write_mock_claude "${claude}"
  write_plist_path "${WORK}/bad.plist" "/usr/bin:/bin" # PATH lacks the claude dir
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_CLAUDE_BIN="'"${claude}"'" # resolves in the process env
    update_verify_claude_precondition "'"${WORK}"'/bad.plist"
  '
  [ "$status" -eq 7 ]
  [[ "$output" == *"claude NOT resolvable on the launchd plist PATH"* ]]
}

@test "P3: --restore-agents restores agent bodies from the agents-bak before-image (git-revert replacement)" {
  local cyc="2026-07-01_update-1.0.0"
  mkdir -p "${WORK}/agents-bak/${cyc}"
  printf 'BEFORE IMAGE BODY' >"${WORK}/agents-bak/${cyc}/dev-a.md.bak"
  seed_file "${INSTALL}" "agents/dev-a.md" "corrupted-by-a-bad-update"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    AUTOAGENT_BACKUP_DIR="${WORK}/agents-bak" \
    bash "${SKILL}" --restore-agents "${cyc}"

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "BEFORE IMAGE BODY" ]] # reverted to the before-image
  [[ "$output" == *"agents-bak restore complete"* ]]
  # the restore serializes via the same pause+lock; the trap unwinds both
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "P3: --restore-agents rejects a cycle-id with path separators / traversal (exit 10)" {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    AUTOAGENT_BACKUP_DIR="${WORK}/agents-bak" \
    bash "${SKILL}" --restore-agents "../etc/evil"
  [ "$status" -eq 10 ] # SECURITY: request-supplied id cannot escape the base dir
  [[ "$output" == *"invalid cycle-id"* ]]
}

@test "P3: --restore-agents loud-fails (exit 10) on a missing snapshot dir" {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    AUTOAGENT_BACKUP_DIR="${WORK}/agents-bak" \
    bash "${SKILL}" --restore-agents "2099-01-01_update-9.9.9"
  [ "$status" -eq 10 ]
  [[ "$output" == *"no agents-bak snapshot"* ]]
}

@test "P3: agents-bak retention prune drops before-image dirs past the 14-day window, keeps fresh ones" {
  mkdir -p "${WORK}/agents-bak/old_cycle" "${WORK}/agents-bak/fresh_cycle"
  printf 'x' >"${WORK}/agents-bak/old_cycle/dev-a.md.bak"
  printf 'x' >"${WORK}/agents-bak/fresh_cycle/dev-a.md.bak"
  # backdate the old dir 20 days (> the 14-day retention); fresh stays at now
  python3 -c 'import os,sys,time; t=time.time()-20*86400; os.utime(sys.argv[1],(t,t))' \
    "${WORK}/agents-bak/old_cycle"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export AUTOAGENT_BACKUP_DIR="'"${WORK}"'/agents-bak"
    update_prune_agents_bak
  '
  [ "$status" -eq 0 ]
  [[ ! -d "${WORK}/agents-bak/old_cycle" ]] # pruned (aged past 14d)
  [[ -d "${WORK}/agents-bak/fresh_cycle" ]] # kept (within retention)
}
