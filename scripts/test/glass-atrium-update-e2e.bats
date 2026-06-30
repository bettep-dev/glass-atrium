#!/usr/bin/env bats
# glass-atrium-update E2E suite (T23) — drives the FULL update flow ONCE in a
# hermetic sandbox, combining all four change kinds in a single release so the
# end-to-end orchestration (not just each piece in isolation) is pinned:
#   (a) a changed NON-AGENT file            -> deterministic spine sync (replace)
#   (b) an agent with an ONLY-VENDOR region -> E4 take-release (updated)
#   (c) an agent with a BOTH-CHANGED region -> E4 net-new diff3, Haiku-gated
#                                              (merged-OR-gated; here gated/rolled
#                                              back via a failing claude stub)
#   (d) a release-only agent (ROSTER ADD)   -> deferred to the agent_lifecycle
#                                              ceremony (never written in-band)
# and asserts the cross-cutting invariants: the pause flag is SET during the run
# then CLEARED on exit, and the daemon .apply-lock is released.
#
# Run via: bats scripts/test/glass-atrium-update-e2e.bats
# Requires: bats >= 1.5.0, jq, git, python3, diff, shasum/sha256sum
#
# Hermetic strategy (identical to glass-atrium-update.bats): a per-test mktemp
# sandbox with GA_ROOT / AUTOAGENT_REPORTS_DIR / ATRIUM_PAUSE_STATE_DIR /
# ATRIUM_UPDATE_STATE_DIR redirected into it; the libs source from the REAL
# install (REAL_LIB_ROOT). The gh download is bypassed via ATRIUM_UPDATE_SRC_DIR,
# the confirm is injected via ATRIUM_UPDATE_CONFIRM_ANSWER, and the both-changed
# Haiku improvement-verify is pointed at a hermetic claude STUB (AUTOAGENT_CLAUDE_BIN)
# that contacts no network — /dev/tty, gh, and the real claude CLI are never touched.
# The live install / daemon / monitor are never modified.

bats_require_minimum_version 1.5.0

export SKILL="${HOME}/.glass-atrium/skills/glass-atrium-update/update.sh"
export REAL_LIB_ROOT="${HOME}/.glass-atrium"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v git >/dev/null 2>&1 || skip "git required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t ga-update-e2e.XXXXXX)" && pwd -P)"
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

# Init a git repo at the INSTALL sandbox + commit whatever is already seeded, so
# the agent EDITABLE-region merge's git_txn_apply has a clean tracked worktree.
git_init_install() {
  git -C "${INSTALL}" init -q
  git -C "${INSTALL}" config user.email t@t.t
  git -C "${INSTALL}" config user.name t
  git -C "${INSTALL}" add -A
  git -C "${INSTALL}" commit -qm "seed" || true
}

# Seed the base@install body for agents/<name> into the base-content store
# (basename-keyed at <state>/update-state/base-agents/<name>) — the provenance the
# resolver reads via editable_merge.load_base_text for a true 3-way merge.
seed_base_store() {
  mkdir -p -- "${STATE}/update-state/base-agents"
  printf '%s' "$2" >"${STATE}/update-state/base-agents/$1"
}

# (b) ONLY-VENDOR agent fixture: the local EDITABLE region == base (the user never
# touched it) and the vendor changed it -> resolver TAKE_RELEASE (deterministic, no
# Haiku). base == local; release differs.
VENDOR_BASE='# dev-vendor
## Goal
<!-- EDITABLE:BEGIN -->
shared base goal
<!-- EDITABLE:END -->
## Rules
vendor rules v1'
VENDOR_RELEASE='# dev-vendor
## Goal
<!-- EDITABLE:BEGIN -->
vendor changed goal
<!-- EDITABLE:END -->
## Rules
vendor rules v2'

# (c) BOTH-CHANGED agent fixture: base, local, release all differ in the region ->
# net-new diff3 candidate, needs_llm=True (Haiku improvement-verify gate). With the
# failing claude stub the verify conservative-fails -> git_txn rolls it back (gated).
BOTH_BASE='# dev-both
## Goal
<!-- EDITABLE:BEGIN -->
base both goal
<!-- EDITABLE:END -->
## Rules
vendor base rules'
BOTH_LOCAL='# dev-both
## Goal
<!-- EDITABLE:BEGIN -->
LOCAL learned both goal
<!-- EDITABLE:END -->
## Rules
vendor base rules'
BOTH_RELEASE='# dev-both
## Goal
<!-- EDITABLE:BEGIN -->
VENDOR changed both goal
<!-- EDITABLE:END -->
## Rules
vendor NEW rules'

@test "E2E (T23): one release combining a non-agent change, an only-vendor merge, a both-changed merge, and a roster add" {
  # --- install (the live tree being updated) -------------------------------
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool content"         # (a)
  seed_file "${INSTALL}" "agents/dev-vendor.md" "${VENDOR_BASE}"      # (b) local == base
  seed_file "${INSTALL}" "agents/dev-both.md" "${BOTH_LOCAL}"         # (c) local learned
  seed_base_store "dev-vendor.md" "${VENDOR_BASE}"                     # (b) base anchor
  seed_base_store "dev-both.md" "${BOTH_BASE}"                         # (c) base anchor
  git_init_install # the agent merge transaction requires a git worktree

  # --- new release tree (the test-seam source) -----------------------------
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool content"          # (a)
  seed_file "${NEWSRC}" "agents/dev-vendor.md" "${VENDOR_RELEASE}"    # (b)
  seed_file "${NEWSRC}" "agents/dev-both.md" "${BOTH_RELEASE}"        # (c)
  seed_file "${NEWSRC}" "agents/dev-new.md" "# dev-new
brand new vendor agent"                                                # (d) roster ADD
  write_manifest "${WORK}/manifest.json" \
    "scripts/tool.sh" "agents/dev-vendor.md" "agents/dev-both.md" "agents/dev-new.md"

  # Hermetic claude stub for the both-changed Haiku verify: it records that the
  # pause flag is HELD at invocation (proving "set during the run") then exits
  # non-zero so run_pre_verify conservative-fails -> the both-changed merge is
  # gated (git_txn rolls it back). It never contacts the network.
  cat >"${WORK}/fake-claude.sh" <<'STUB'
#!/usr/bin/env bash
[[ -e "${GA_PAUSE_FLAG}" ]] && : >"${GA_PAUSE_WITNESS}"
exit 1
STUB
  chmod +x "${WORK}/fake-claude.sh"

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
    AUTOAGENT_CLAUDE_BIN="${WORK}/fake-claude.sh" \
    GA_PAUSE_FLAG="${STATE}/update-state/autoagent-pause.flag" \
    GA_PAUSE_WITNESS="${WORK}/pause-witness" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]

  # (a) the non-agent file was deterministically replaced by the spine sync
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool content" ]]

  # (b) the only-vendor agent was UPDATED to the vendor region + structure (E4
  #     take-release, no Haiku call)
  [[ "$(cat "${INSTALL}/agents/dev-vendor.md")" == *"vendor changed goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-vendor.md")" == *"vendor rules v2"* ]]

  # (c) the both-changed agent was GATED (Haiku verify failed -> git_txn rollback)
  #     -> left at the local learned version, loudly reported, never silently
  #     overwritten with the vendor text
  [[ "$(cat "${INSTALL}/agents/dev-both.md")" == *"LOCAL learned both goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-both.md")" != *"VENDOR changed both goal"* ]]
  [[ "$output" == *"agents/dev-both.md"* ]]

  # (d) the roster ADD was DEFERRED to the agent_lifecycle ceremony: detected +
  #     overridden by the explicit opt-in, but the new agent file is NEVER written
  #     in-band (it belongs to the ceremony)
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"add dev-new"* ]]
  [[ "$output" == *"ATRIUM_UPDATE_ALLOW_ROSTER set"* ]]
  [[ "$output" == *"agent_lifecycle"* ]]
  [[ ! -f "${INSTALL}/agents/dev-new.md" ]]

  # cross-cutting: the pause flag was SET during the run (the claude stub observed
  # it held) THEN CLEARED on exit; the daemon .apply-lock was released
  [[ -e "${WORK}/pause-witness" ]]                                     # set-during-run
  [[ ! -e "${STATE}/update-state/autoagent-pause.flag" ]]             # cleared on exit
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]                    # lock released

  # the successful non-agent sync anchored the next update's base (baseline +
  # base-content store both captured)
  [[ -f "${STATE}/update-state/baseline-manifest.json" ]]
  [[ -f "${STATE}/update-state/base-agents/dev-vendor.md" ]]
}
