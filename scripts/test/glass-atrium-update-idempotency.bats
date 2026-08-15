#!/usr/bin/env bats
# same-release idempotency — re-running the SAME release must no-op.
#
# The live defect: run 1 merged an EDITABLE region and the merged body was
# committed, but the base-content store stayed at the OLD anchor, so run 2
# re-diffed the already-merged region against a stale base and wrote literal git
# conflict markers into the live agent file. Three pins:
#   * the end-to-end second run (no markers, no content change);
#   * the capture ORDERING that keeps the base advancing even when the (fatal)
#     vendor sweep dies right after a landed merge;
#   * a conflicting region with the gap-policy kill switch OFF: it declines
#     durably and never lands markers.
#
# The default-policy counterpart — the same input resolving to the release side
# and LANDING — is deliberately NOT pinned here. merge-resolved-release sits in
# editable_merge._LLM_REQUIRED, so the in-transaction verify gates the candidate
# on a live Haiku call (MergeCandidate._haiku_pass) whose result is not
# reproducible; run_pre_verify is fail-safe, so an unreachable model rolls the
# landed body back to local. A test over that path is a coin flip, not a pin.
#
# Split out of glass-atrium-update.bats rather than appended to it: CI runs one
# GNU parallel job per *.bats file under a 240s per-file timeout, and that file
# already sits near the ceiling. A separate file gets its own slot and runs
# concurrently.
#
# Every assertion is gated `|| return 1` — this bats version fails a test only on
# the LAST command's status, so a bare mid-body `[[ ]]` would be silently ignored.
#
# Hermetic: per-test mktemp sandbox with GA_ROOT / AUTOAGENT_REPORTS_DIR /
# ATRIUM_PAUSE_STATE_DIR / ATRIUM_UPDATE_STATE_DIR redirected into it; the
# download is bypassed via ATRIUM_UPDATE_SRC_DIR, the confirm injected via
# ATRIUM_UPDATE_CONFIRM_ANSWER and the Haiku pre-verify gate stubbed via
# AUTOAGENT_CLAUDE_BIN, so /dev/tty, gh and the claude CLI are never touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export SKILL="${GA}/scripts/update.sh"
export REAL_LIB_ROOT="${GA}"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t ga-update-idem.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install" # sandbox GA_ROOT (the live install under test)
  NEWSRC="${WORK}/newsrc"   # the staged new-release tree (test seam source)
  STATE="${WORK}/state"     # reports / pause / baseline sandbox
  mkdir -p "${INSTALL}" "${NEWSRC}" "${STATE}"
  seed_pre_verify_stub
}

# A resolved conflicting gap is LLM-required (MERGE_RESOLVED_RELEASE sits in
# editable_merge._LLM_REQUIRED), so its landing runs the daemon's Haiku
# improvement-verify gate — and CLAUDE_BIN defaults to the literal `claude`,
# which on a developer box is the operator's REAL billed CLI. Unstubbed, the
# landing assertion would ride a live model verdict: billed per suite run,
# networked, and green or red by the weather. The stub emits the strict grid
# run_pre_verify parses (4 axes + the explicit VERDICT the dual gate demands),
# so the gate PASSES deterministically and the test measures the resolver.
seed_pre_verify_stub() {
  cat >"${WORK}/pre-verify-pass.sh" <<'STUB'
#!/usr/bin/env bash
printf 'C1: PASS\nC2: PASS\nC3: PASS\nC4: PASS\nVERDICT: verified\nRATIONALE: hermetic stub\n'
STUB
  chmod +x "${WORK}/pre-verify-pass.sh"
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

# Seed the base@install body for agents/<name>.md into the base-content store
# (basename-keyed at <state>/base-agents/<name>.md) — the provenance the resolver
# reads via editable_merge.load_base_text. $1 = name, $2 = body.
seed_base_store() {
  mkdir -p -- "${STATE}/update-state/base-agents"
  printf '%s' "$2" >"${STATE}/update-state/base-agents/$1"
}

# Three-anchor fixture: a Goal region the user learned locally + a Rules section
# the vendor owns. base region == release region, so the resolver keeps the local
# region and takes the new vendor structure.
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
    ATRIUM_UPDATE_MERGE_RESOLVE_GAPS="${ATRIUM_UPDATE_MERGE_RESOLVE_GAPS:-}" \
    AUTOAGENT_CLAUDE_BIN="${WORK}/pre-verify-pass.sh" \
    bash "${SKILL}"
}

@test "a SECOND run of the SAME release no-ops (no markers, no content change)" {
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ] || return 1
  local merged
  merged="$(cat "${INSTALL}/agents/dev-a.md")"
  [[ "${merged}" == *"local learned goal"* ]] || return 1
  [[ "${merged}" == *"NEW vendor rules"* ]] || return 1
  # the base advanced to the RELEASE body — the anchor that makes run 2 a no-op
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "${GOAL_RELEASE}" ]] || return 1

  run_update y
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"no net change"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${merged}" ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" != *"<<<<<<< LOCAL (learned)"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" != *">>>>>>> RELEASE (vendor)"* ]] || return 1
  # Neither run declined anything, so the decline record must not exist at all —
  # an always-created empty file would make "no declines" and "never recorded"
  # indistinguishable at exactly the moment an operator is asking which it was.
  [[ ! -e "${INSTALL}/update-declines/conflict-declines.log" ]] || return 1
}

@test "base-content capture survives a FATAL vendor sweep (ordering pin)" {
  # update_sweep_removed_files hard-dies (update_die_code 13). With the capture
  # sequenced AFTER it, that death strands a LANDED merge at the old base — the
  # stale anchor that re-conflicts on the next same-release run. The capture must
  # therefore run IMMEDIATELY after the merge, before any fatal step.
  mkdir -p "${NEWSRC}/agents" "${STATE}/update-state/base-agents"
  printf 'RELEASE body' >"${NEWSRC}/agents/dev-a.md"
  printf 'BASE v0' >"${STATE}/update-state/base-agents/dev-a.md"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    bash -c '
      source "'"${SKILL}"'"
      source "'"${REAL_LIB_ROOT}"'/scripts/lib/apply-spine.sh"
      # a merge that LANDED dev-a.md — the outcome ledger is the carrier the
      # capture reads to decide which files may advance.
      update_merge_agent_editable_regions() {
        _update_agent_outcomes_file="'"${WORK}"'/agent-outcomes.ledger"
        printf "dev-a.md\n" >"${_update_agent_outcomes_file}"
      }
      update_sweep_removed_files() { exit 13; }  # the fatal-sweep crash window
      update_capture_baseline() { :; }
      update_finalize_merge_and_anchors \
        "'"${NEWSRC}"'" "/dev/null" "'"${INSTALL}"'" "/dev/null"
    '

  [ "$status" -eq 13 ] || return 1  # the sweep still hard-fails, loudly (unchanged)
  # … yet the landed merge already advanced past the stale anchor.
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "RELEASE body" ]] || return 1
}

@test "with the gap policy OFF a conflict verdict declines durably, names the working repair pair, and NEVER writes markers into the live body" {
  # The kill switch is what this test now buys: under the default policy this same
  # input resolves to the release side and lands (the sibling test below), so the
  # decline path is reachable only with the switch set. It still has to WORK when
  # it is — a rollback of the gap policy must land on a decline that behaves, and
  # an untested switch is a rollback nobody can take.
  ATRIUM_UPDATE_MERGE_RESOLVE_GAPS=0
  export ATRIUM_UPDATE_MERGE_RESOLVE_GAPS
  # Overlapping both-changed region: the merged candidate carries conflict markers,
  # which in a live agent body is corruption. It must be reported + skipped, with
  # the local body byte-identical and its base entry left at the prior anchor.
  # The decline also has to OUTLIVE the run that produced it — the stderr line is
  # gone the moment the deploy transcript scrolls — and it must not send the reader
  # to the agent_lifecycle ceremony, whose subcommand set cannot reconcile a region.
  local conflict_local='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
LOCAL rewrite
<!-- EDITABLE:END -->
## Rules
old vendor rules'
  local conflict_release='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
VENDOR rewrite
<!-- EDITABLE:END -->
## Rules
NEW vendor rules'
  seed_file "${INSTALL}" "agents/dev-a.md" "${conflict_local}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${conflict_release}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update y
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"CONFLICT (merge-conflict)"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${conflict_local}" ]] || return 1
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "${GOAL_BASE}" ]] || return 1

  # The emitted line names the repair that works and routes nobody to the ceremony.
  local conflict_line
  conflict_line="$(printf '%s\n' "$output" | grep 'CONFLICT (merge-conflict)')"
  [[ "${conflict_line}" != *"ceremony"* ]] || return 1
  [[ "${conflict_line}" == *"capture a pre-change image"* ]] || return 1
  [[ "${conflict_line}" == *"sync the base store"* ]] || return 1

  # Durable: the record sits beside the agents-bak store, so it is still readable
  # after the run that wrote it has exited and its workdir has been torn down.
  local declines="${INSTALL}/update-declines/conflict-declines.log"
  [[ -f "${declines}" ]] || return 1
  [[ "$(wc -l <"${declines}" | tr -d ' ')" == "1" ]] || return 1
  local entry
  entry="$(cat "${declines}")"
  [[ "${entry}" == *"merge-conflict"* ]] || return 1
  [[ "${entry}" == *"agents/dev-a.md"* ]] || return 1
  [[ "${entry}" == *"local-body-kept"* ]] || return 1
}
