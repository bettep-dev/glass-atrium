#!/usr/bin/env bats
# same-release idempotency — re-running the SAME release must no-op.
#
# The live defect: run 1 merged an EDITABLE region and the merged body was
# committed, but the base-content store stayed at the OLD anchor, so run 2
# re-diffed the already-merged region against a stale base and wrote literal git
# conflict markers into the live agent file. Three pins:
#   * the end-to-end second run (no markers, no content change);
#   * a declined body followed by a mergeable one: the decline reason is per-file
#     state, and a leaked one declines a body that had no conflict at all;
#   * a conflicting region, both ways round the gap-policy kill switch: with the
#     switch OFF it declines durably and never lands markers; with the switch at
#     its default it resolves to the release side and lands, declining nothing —
#     and lands with the Haiku gate UNREACHABLE, which is the property the policy
#     was chosen for (merge-resolved-release is deliberately out of
#     editable_merge._LLM_REQUIRED, so no model stands between a resolved gap and
#     the disk; an outage or an exhausted quota cannot drop it back to declining).
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
# ATRIUM_UPDATE_STATE_DIR redirected into it; the
# download is bypassed via ATRIUM_UPDATE_SRC_DIR and AUTOAGENT_CLAUDE_BIN points at
# a path that is never created, so gh and the claude CLI are never touched.

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
}

# No gate stub exists, deliberately. run_update points AUTOAGENT_CLAUDE_BIN at a
# path under the sandbox that is never created, so the Haiku improvement-verify
# gate is not slow or erroring but ABSENT — run_pre_verify takes its
# FileNotFoundError branch and conservative-fails. A stub would make the
# unreachability incidental; a missing binary makes it real, and it is the same
# condition CI and any offline deploy run under. It also keeps the suite
# hermetic: CLAUDE_BIN defaults to the literal `claude`, so an unpinned run would
# reach the operator's REAL billed CLI and go green or red by the weather.

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

# $1 = gap-policy kill switch (empty = the default policy).
# The switch is passed EXPLICITLY rather than forwarded from the ambient environment:
# a `${VAR:-}` forward reads as a hermeticity pin while actually letting an operator's
# exported value decide which policy the run under test exercises.
run_update() {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_MERGE_RESOLVE_GAPS="${1-}" \
    AUTOAGENT_CLAUDE_BIN="${WORK}/no-such-claude" \
    bash "${SKILL}"
}

@test "a SECOND run of the SAME release no-ops (no markers, no content change)" {
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ] || return 1
  local merged
  merged="$(cat "${INSTALL}/agents/dev-a.md")"
  [[ "${merged}" == *"local learned goal"* ]] || return 1
  [[ "${merged}" == *"NEW vendor rules"* ]] || return 1
  # the base advanced to the RELEASE body — the anchor that makes run 2 a no-op
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "${GOAL_RELEASE}" ]] || return 1

  run_update
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

@test "with the gap policy OFF a conflict verdict declines durably, names the working repair pair, and NEVER writes markers into the live body" {
  # The kill switch is what this test now buys: under the default policy this same
  # input resolves to the release side and lands (the sibling test below), so the
  # decline path is reachable only with the switch set. It still has to WORK when
  # it is — a rollback of the gap policy must land on a decline that behaves, and
  # an untested switch is a rollback nobody can take.
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

  run_update 0
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

@test "with the gap policy ON the same conflicting body LANDS the release side with the Haiku gate unreachable" {
  # The shell-side pin on the property the policy was chosen for. The input that
  # declines above is the shape the stuck agents present every release; under the
  # DEFAULT policy the resolver emits merge-resolved-release, the candidate joins
  # the normal records queue, clears the confirm gate and lands.
  #
  # It lands with the gate ABSENT. run_update points AUTOAGENT_CLAUDE_BIN at a
  # path that does not exist, which is what CI and an offline deploy look like to
  # fail-safe run_pre_verify. Were merge-resolved-release still LLM-required, that
  # refusal would roll the body back and this test would red — so this is the
  # assertion standing between the deterministic policy and a silent regression to
  # the mediator's availability profile, where the feature lands NOTHING on a host
  # that cannot reach the model while reporting success at plan time.
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

  run_update
  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"CONFLICT (merge-conflict)"* ]] || return 1

  local landed
  landed="$(cat "${INSTALL}/agents/dev-a.md")"
  # The tripwire never had to fire: resolution replaces markers, it does not emit them.
  [[ "${landed}" != *"<<<<<<< LOCAL (learned)"* ]] || return 1
  [[ "${landed}" != *">>>>>>> RELEASE (vendor)"* ]] || return 1
  # The conflicting region took the release side, and the vendor structure came with it.
  [[ "${landed}" == *"VENDOR rewrite"* ]] || return 1
  [[ "${landed}" == *"NEW vendor rules"* ]] || return 1
  [[ "${landed}" != *"LOCAL rewrite"* ]] || return 1

  # The gate was never CONSULTED, not merely overruled. run_pre_verify resolves a
  # verifier model before it shells out, and that resolution is the only source of
  # a [daemon-cycle] line in this run — its absence is the positive fingerprint
  # that no model was invoked, separating "no model in the path" from "a model
  # that happened to agree". Only the former survives an outage.
  [[ "$output" != *"[daemon-cycle]"* ]] || return 1

  # The base advanced to the landed body — the anchor that keeps the next same-release
  # run a no-op instead of re-diffing against a stale base.
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "${conflict_release}" ]] || return 1

  # Nothing declined, so no durable record should exist. Asserting absence of the FILE
  # (not an empty one) keeps "no declines" distinguishable from "never recorded".
  [[ ! -e "${INSTALL}/update-declines/conflict-declines.log" ]] || return 1
}

@test "a declined body does not leak its conflict reason onto the NEXT mergeable body" {
  # The decline reason is per-file state read at the top of the loop's gate. Without
  # a per-file reset the second file inherits the first file's reason and is declined
  # as a conflict it never had — a silent one, since its own verdict is mergeable and
  # nothing else in the run reports a problem.
  #
  # dev-a declines through the two-way gate: seeding no base entry leaves the resolver
  # no anchor, so it prefers neither side under the DEFAULT policy and the kill switch
  # stays out of the picture. dev-b sorts after it and merges cleanly.
  local twoway_local='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
LOCAL rewrite
<!-- EDITABLE:END -->
## Rules
old vendor rules'
  local twoway_release='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
VENDOR rewrite
<!-- EDITABLE:END -->
## Rules
NEW vendor rules'
  seed_file "${INSTALL}" "agents/dev-a.md" "${twoway_local}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${twoway_release}"
  seed_file "${INSTALL}" "agents/dev-b.md" "${GOAL_LOCAL//dev-a/dev-b}"
  seed_base_store "dev-b.md" "${GOAL_BASE//dev-a/dev-b}"
  seed_file "${NEWSRC}" "agents/dev-b.md" "${GOAL_RELEASE//dev-a/dev-b}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "agents/dev-b.md"

  run_update
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"CONFLICT (gated-2way-present-both) in agents/dev-a.md"* ]] || return 1

  # dev-b is named by NO conflict line, and it LANDED: kept its learned region and
  # took the new vendor structure.
  local conflict_lines merged_b
  conflict_lines="$(printf '%s\n' "$output" | grep 'CONFLICT (' || true)"
  [[ "${conflict_lines}" != *"dev-b"* ]] || return 1
  merged_b="$(cat "${INSTALL}/agents/dev-b.md")"
  [[ "${merged_b}" == *"local learned goal"* ]] || return 1
  [[ "${merged_b}" == *"NEW vendor rules"* ]] || return 1

  # One decline recorded, dev-a's — a leaked reason persists a second entry.
  local declines="${INSTALL}/update-declines/conflict-declines.log"
  [[ "$(wc -l <"${declines}" | tr -d ' ')" == "1" ]] || return 1
  [[ "$(cat "${declines}")" == *"agents/dev-a.md"* ]] || return 1
}
