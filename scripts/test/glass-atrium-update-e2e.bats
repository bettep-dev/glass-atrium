#!/usr/bin/env bats
# glass-atrium-update E2E suite (T23) — drives the FULL update flow ONCE in a
# hermetic sandbox, combining all four change kinds in one release so the end-to-end
# orchestration (not just each piece) is pinned:
#   (a) changed NON-AGENT file      -> deterministic spine sync (replace)
#   (b) agent, ONLY-VENDOR region   -> E4 take-release (updated, no Haiku)
#   (c) agent, BOTH-CHANGED region, NON-CONFLICTING (the two sides edit different
#                                      lines) -> E4 net-new diff3 merges cleanly and
#                                      the updater APPLIES it without the daemon
#                                      pre-verify (CI-verified release tree)
#   (d) release-only agent (ROSTER ADD) -> deferred to the agent_lifecycle ceremony,
#                                      never written in-band
#   (e) agent, BOTH-CHANGED region, CONTESTED (both sides rewrite the SAME line)
#                                   -> the arbiter answers nothing -> declined,
#                                      local body kept, loudly reported
# plus the cross-cutting invariant: the daemon .apply-lock is HELD during the run
# then released on exit. git is NOT required — the whole
# flow (spine sync + git-free git_txn_apply merge) runs without any git invocation
# (no-.git consumer install, P2-T2).
# Hermetic (as glass-atrium-update.bats): a per-test mktemp sandbox with GA_ROOT /
# AUTOAGENT_REPORTS_DIR / ATRIUM_UPDATE_STATE_DIR redirected
# into it; libs source from the REAL install. gh download bypassed via
# ATRIUM_UPDATE_SRC_DIR, the both-changed Haiku verify pointed at a hermetic claude
# STUB (AUTOAGENT_CLAUDE_BIN) that contacts no network — gh, the real claude CLI, and
# the live install / daemon / monitor are never touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export SKILL="${GA}/scripts/update.sh"
export REAL_LIB_ROOT="${GA}"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t ga-update-e2e.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install" # sandbox GA_ROOT (the live install under test)
  NEWSRC="${WORK}/newsrc"   # the staged new-release tree (test seam source)
  STATE="${WORK}/state"     # reports / baseline sandbox
  mkdir -p "${INSTALL}" "${NEWSRC}" "${STATE}"
}

teardown() {
  # Reap a straggler updater from the SIGTERM test if an assertion aborted that
  # test between spawn and its bounded reap (best-effort; pid is our own child).
  [[ -n "${UPDATE_PID:-}" ]] && kill -9 "${UPDATE_PID}" 2>/dev/null || true
  UPDATE_PID=""
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

# (c) BOTH-CHANGED, NON-CONFLICTING agent fixture: base, local and release all differ
# in the region, but the two sides edit DIFFERENT lines of it — local rewrites the
# first line, the vendor appends a third. The resolver therefore produces a CLEAN
# diff3 candidate (verdict merge-clean) that carries BOTH edits. The updater applies
# it with skip_pre_verify=True: its input is a CI-verified release tree, so the
# daemon's Haiku improvement-verify gate is OFF on this path and no model is consulted
# for this body at all. The OVERLAPPING shape is a separate fixture (GAP_*) with its
# own outcome, so neither assertion below depends on which shape the resolver saw.
BOTH_BASE='# dev-both
## Goal
<!-- EDITABLE:BEGIN -->
base both goal
shared tail line
<!-- EDITABLE:END -->
## Rules
vendor base rules'
BOTH_LOCAL='# dev-both
## Goal
<!-- EDITABLE:BEGIN -->
LOCAL learned both goal
shared tail line
<!-- EDITABLE:END -->
## Rules
vendor base rules'
BOTH_RELEASE='# dev-both
## Goal
<!-- EDITABLE:BEGIN -->
base both goal
shared tail line
VENDOR changed both goal
<!-- EDITABLE:END -->
## Rules
vendor NEW rules'
# The ONE outcome the merge above may produce: the local first-line rewrite survives
# byte-for-byte AND the vendor's appended line lands, with the vendor's out-of-region
# structure taken wholesale. Pinned as a whole-body equality so a resolver that
# dropped either side (or reordered the region) cannot pass.
BOTH_MERGED='# dev-both
## Goal
<!-- EDITABLE:BEGIN -->
LOCAL learned both goal
shared tail line
VENDOR changed both goal
<!-- EDITABLE:END -->
## Rules
vendor NEW rules'

# CONTESTED fixture: both sides rewrite the SAME region line, so the resolver cannot
# prefer a side and hands the gap to the ARBITER — a model call made from the `plan`
# process, inside the merge and under the .apply-lock. That is the mid-merge
# handshake the SIGTERM test needs now that the updater no longer runs the daemon's
# pre-verify gate (the seam it used to block on). Distinct from BOTH_*, whose edits
# fall on different lines and merge cleanly with no model call at all.
GAP_BASE='# dev-gap
## Goal
<!-- EDITABLE:BEGIN -->
base gap goal
shared tail line
<!-- EDITABLE:END -->
## Rules
vendor base rules'
GAP_LOCAL='# dev-gap
## Goal
<!-- EDITABLE:BEGIN -->
LOCAL rewritten gap goal
shared tail line
<!-- EDITABLE:END -->
## Rules
vendor base rules'
GAP_RELEASE='# dev-gap
## Goal
<!-- EDITABLE:BEGIN -->
VENDOR rewritten gap goal
shared tail line
<!-- EDITABLE:END -->
## Rules
vendor NEW rules'

@test "E2E (T23): one release combining a non-agent change, an only-vendor merge, a NON-CONFLICTING both-changed merge, a CONTESTED both-changed decline, and a roster add" {
  # install (the live tree being updated)
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool content"    # (a)
  seed_file "${INSTALL}" "agents/dev-vendor.md" "${VENDOR_BASE}" # (b) local == base
  seed_file "${INSTALL}" "agents/dev-both.md" "${BOTH_LOCAL}"    # (c) local learned
  seed_file "${INSTALL}" "agents/dev-gap.md" "${GAP_LOCAL}"      # (e) local rewrote
  seed_base_store "dev-vendor.md" "${VENDOR_BASE}"               # (b) base anchor
  seed_base_store "dev-both.md" "${BOTH_BASE}"                   # (c) base anchor
  seed_base_store "dev-gap.md" "${GAP_BASE}"                     # (e) base anchor

  # new release tree (the test-seam source)
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool content"       # (a)
  seed_file "${NEWSRC}" "agents/dev-vendor.md" "${VENDOR_RELEASE}" # (b)
  seed_file "${NEWSRC}" "agents/dev-both.md" "${BOTH_RELEASE}"     # (c)
  seed_file "${NEWSRC}" "agents/dev-gap.md" "${GAP_RELEASE}"       # (e)
  seed_file "${NEWSRC}" "agents/dev-new.md" "# dev-new
brand new vendor agent" # (d) roster ADD
  write_manifest "${WORK}/manifest.json" \
    "scripts/tool.sh" "agents/dev-vendor.md" "agents/dev-both.md" \
    "agents/dev-gap.md" "agents/dev-new.md"

  # Hermetic claude stub for the CONTESTED region's arbiter call — the one model seam
  # this release still reaches, now that the updater applies CI-verified release
  # content without the daemon pre-verify. It records that the apply-lock is HELD at
  # invocation (proving the writer stays serialized for the whole run) then exits
  # non-zero, so the contested gap is answered by neither side and (e) declines. It
  # never contacts the network.
  cat >"${WORK}/fake-claude.sh" <<'STUB'
#!/usr/bin/env bash
[[ -d "${GA_LOCK_DIR}" ]] && : >"${GA_LOCK_WITNESS}"
exit 1
STUB
  chmod +x "${WORK}/fake-claude.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_ALLOW_ROSTER="1" \
    AUTOAGENT_CLAUDE_BIN="${WORK}/fake-claude.sh" \
    GA_LOCK_DIR="${STATE}/daemon-reports/.apply-lock" \
    GA_LOCK_WITNESS="${WORK}/lock-witness" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]

  # (a) the non-agent file was deterministically replaced by the spine sync
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool content" ]]

  # (b) the only-vendor agent was UPDATED to the vendor region + structure (E4
  #     take-release, no Haiku call)
  [[ "$(cat "${INSTALL}/agents/dev-vendor.md")" == *"vendor changed goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-vendor.md")" == *"vendor rules v2"* ]]

  # (c) the NON-CONFLICTING both-changed agent was MERGED and APPLIED: the vendor's
  #     added line landed AND the local rewrite survived byte-for-byte (whole-body
  #     equality, so neither side may be dropped). No model was consulted for it —
  #     the updater's skip_pre_verify path is announced on its own INFO line.
  [[ "$(cat "${INSTALL}/agents/dev-both.md")" == "${BOTH_MERGED}" ]]
  [[ "$output" == *"agent merged + applied: agents/dev-both.md"* ]]
  [[ "$output" == *"release content applied without the daemon pre-verify"* ]]

  # (e) the CONTESTED both-changed agent was DECLINED: both sides rewrote the SAME
  #     region line, so the resolver handed the gap to the arbiter, whose (failing)
  #     model call answered nothing -> merge-pending-arbitration -> the local body is
  #     kept whole, loudly reported, never silently overwritten with the vendor text.
  [[ "$(cat "${INSTALL}/agents/dev-gap.md")" == "${GAP_LOCAL}" ]]
  [[ "$output" == *"CONFLICT (merge-pending-arbitration) in agents/dev-gap.md"* ]]
  [[ "$output" == *"local body kept"* ]]

  # (d) the roster ADD is reported and then INSTALLED in-band through the create
  #     path: an add-only release returns from the gate before the override is
  #     read, so the opt-in this run happens to set is announced nowhere
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"add dev-new"* ]]
  [[ "$output" == *"roster ADD only"* ]]
  [[ "$output" != *"ATRIUM_UPDATE_ALLOW_ROSTER set"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-new.md")" == *"brand new vendor agent"* ]]

  # cross-cutting: the daemon .apply-lock was HELD during the run (the claude stub
  # observed it) and released on exit
  [[ -e "${WORK}/lock-witness" ]]                  # held-during-run
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]] # lock released

  # the successful non-agent sync anchored the next update's base (baseline +
  # base-content store both captured)
  [[ -f "${STATE}/update-state/baseline-manifest.json" ]]
  [[ -f "${STATE}/update-state/base-agents/dev-vendor.md" ]]
}

# SIGTERM mid-run → update_cleanup (the EXIT INT TERM trap) releases the
# .apply-lock — no stranded writer-serialization

@test "SIGTERM mid-merge releases the .apply-lock (trap path)" {
  # Minimal fixture that reaches a model call INSIDE the merge: one non-agent
  # change (drives the spine sync) + a CONTESTED agent region, whose gap the
  # arbiter must ask the model about — the updater is inside the merge, lock held.
  # It was the pre-verify gate that blocked here until the updater stopped judging
  # CI-verified release content; the arbiter is the seam that remains.
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool content"
  seed_file "${INSTALL}" "agents/dev-gap.md" "${GAP_LOCAL}"
  seed_base_store "dev-gap.md" "${GAP_BASE}"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool content"
  seed_file "${NEWSRC}" "agents/dev-gap.md" "${GAP_RELEASE}"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh" "agents/dev-gap.md"

  # Handshake claude stub: READY appears once update.sh is INSIDE the merge
  # (mid-run, lock + flag held); RESUME lets it finish, because bash
  # DEFERS a trapped signal until the foreground child tree exits. The RESUME
  # wait is BOUNDED so an aborted test can never strand a spinning stub.
  cat >"${WORK}/fake-claude.sh" <<'STUB'
#!/usr/bin/env bash
[[ -n "${UPD_CLAUDE_READY:-}" ]] && : >"${UPD_CLAUDE_READY}"
j=0
while [[ ! -e "${UPD_CLAUDE_RESUME:-}" && "${j}" -lt 100 ]]; do
  sleep 0.1
  j=$((j + 1))
done
exit 1
STUB
  chmod +x "${WORK}/fake-claude.sh"

  env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    AUTOAGENT_CLAUDE_BIN="${WORK}/fake-claude.sh" \
    UPD_CLAUDE_READY="${WORK}/claude.ready" \
    UPD_CLAUDE_RESUME="${WORK}/claude.resume" \
    bash "${SKILL}" </dev/null >"${WORK}/update.log" 2>&1 3>&- &
  UPDATE_PID=$!

  # Bounded wait for the mid-merge handshake (≤10s), then pin the mid-run state.
  local i=0
  while [[ ! -e "${WORK}/claude.ready" && "${i}" -lt 100 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  [[ -e "${WORK}/claude.ready" ]]                # updater reached the verify
  [[ -d "${STATE}/daemon-reports/.apply-lock" ]] # lock held mid-run

  kill -TERM "${UPDATE_PID}" # delivered NOW, pending while the stub is in flight
  : >"${WORK}/claude.resume" # unblock the verify so the deferred trap can fire

  # Bounded reap. Regression pin: if TERM ever drops out of the trap list the
  # updater dies trap-LESS (EXIT traps do NOT run on an untrapped fatal signal),
  # stranding the lock dir asserted gone below.
  i=0
  while kill -0 "${UPDATE_PID}" 2>/dev/null && [[ "${i}" -lt 100 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  if kill -0 "${UPDATE_PID}" 2>/dev/null; then
    kill -9 "${UPDATE_PID}" 2>/dev/null || true
    wait "${UPDATE_PID}" 2>/dev/null || true
    UPDATE_PID=""
    false # updater failed to exit after SIGTERM + resume
  fi
  wait "${UPDATE_PID}" 2>/dev/null || true
  UPDATE_PID=""

  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]] # lock released by the trap
}
