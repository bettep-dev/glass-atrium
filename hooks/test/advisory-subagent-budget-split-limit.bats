#!/usr/bin/env bats
# advisory-subagent-budget-split-limit.bats — T1c fail-at-HEAD coverage for T5
# (No-progress brake: split advisory and block limits). This suite is the
# ACCEPTANCE SPEC the T5 DEV implements against.
#
# THE DEFECT (HEAD a627de7): the brake has ONE limit and one arming flag. The
# logic is `if repeat >= limit: if armed block(2) elif repeat == limit advise`,
# so ONCE ARMED THE ADVISORY NEVER FIRES — the two required behaviors cannot
# coexist. T5 splits it into two independent limits.
#
# CONTRACT DEFINED HERE (the T5 DEV conforms to these names):
#   SUBAGENT_NOPROGRESS_LIMIT        advisory limit (existing name, REUSED); a
#                                    one-shot stderr advisory fires at this streak.
#   SUBAGENT_NOPROGRESS_BLOCK_LIMIT  NEW block-limit env; exit 2 fires at this
#                                    streak; clamped to >= the advisory limit.
#   SUBAGENT_NOPROGRESS_DISARM=1     NEW disarm flag; disables blocking (exit 0 at
#                                    any depth). Block is DEFAULT-ARMED otherwise.
#   SUBAGENT_NOPROGRESS_BLOCK        OLD arming flag — now IGNORED (no effect).
#   coded error NOPROGRESS-001 carries the streak count in its structured data.
#
# FAIL-AT-HEAD (RED against a627de7, GREEN after T5):
#   * advisory fires and exits 0 at the advisory limit EVEN with the old flag set
#     (HEAD: old flag arms → exit 2 at the limit, advisory never fires).
#   * reaching the (higher, separate) block limit exits 2 with the streak count
#     (HEAD: has no separate block limit → exit 0 past the advisory limit).
#   * a block limit configured BELOW the advisory limit clamps up (HEAD: no clamp).
#   * the new disarm flag wins over the old arming flag (HEAD: old flag arms → 2).
# REGRESSION GUARDS (GREEN at HEAD and after):
#   * a varied signature resets the streak (a legitimate loop is never braked).
#   * an empty call signature skips the brake and exits 0 (fail-open).
#   * a main-session call (no agent_id) never brakes.
#
# Run via: bats hooks/test/advisory-subagent-budget-split-limit.bats
# Requires: bats, bash 3.2+, python3. Hermetic: SUBAGENT_TOOL_BUDGET_DIR redirects
# the per-agent streak state to a sandbox; no live DB is touched.

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-subagent-budget.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required for the call signature"
  SANDBOX="$(mktemp -d -t ga-split-limit-bats.XXXXXX)"
  BUDGET_DIR="${SANDBOX}/counters"
  mkdir -p "${BUDGET_DIR}"
  SAME='{"agent_id":"agent-a","tool_name":"Read","tool_input":{"file_path":"/x"}}'
  OTHER='{"agent_id":"agent-a","tool_name":"Read","tool_input":{"file_path":"/y"}}'
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Run the hook once. $1=input JSON; $2..=extra env assignments (advisory/block
# limits, disarm/arm flags). SUBAGENT_TOOL_BUDGET_DIR is always sandboxed.
run_hook() {
  printf '%s' "$1" >"${SANDBOX}/input.json"
  run env \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    "${@:2}" \
    "${HOOK_SH}" <"${SANDBOX}/input.json"
}

# --- FAIL-AT-HEAD: advisory still fires at the advisory limit while block armed ---

@test "advisory fires + exit 0 at the advisory limit even with the OLD arm flag set [FAIL-AT-HEAD: HEAD arms → exit 2, no advisory]" {
  # advisory=3, block=5. Reach exactly 3 with the OLD flag set. Post-T5 the old
  # flag is ignored, block-limit 5 is not reached → one-shot advisory + exit 0.
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=3 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=5 SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]] || { echo "call1 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=3 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=5 SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]] || { echo "call2 expected 0, got ${status}" >&2; return 1; }
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=3 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=5 SUBAGENT_NOPROGRESS_BLOCK=1
  [[ "${status}" -eq 0 ]] || { echo "call3 expected advisory + exit 0, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"NO-PROGRESS"* ]] || { echo "expected a NO-PROGRESS advisory at the advisory limit, got: ${output}" >&2; return 1; }
}

# --- FAIL-AT-HEAD: reaching the separate, higher block limit exits 2 ---

@test "reaching the block limit exits 2 with the streak count (default-armed) [FAIL-AT-HEAD: HEAD exits 0 past the advisory limit]" {
  # advisory=3, block=5, no disarm. Fifth identical call reaches the block limit.
  local i
  for i in 1 2 3 4; do
    run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=3 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=5
    [[ "${status}" -eq 0 ]] || { echo "call ${i} expected 0 (below block limit), got ${status}" >&2; return 1; }
  done
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=3 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=5
  [[ "${status}" -eq 2 ]] || { echo "call5 expected block exit 2, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"NOPROGRESS-001"* ]] || { echo "expected NOPROGRESS-001 coded error, got: ${output}" >&2; return 1; }
  [[ "${output}" == *"5"* ]] || { echo "expected the streak count 5 in the block error, got: ${output}" >&2; return 1; }
}

# --- FAIL-AT-HEAD: block limit below advisory limit clamps up ---

@test "a block limit configured below the advisory limit clamps up to it [FAIL-AT-HEAD]" {
  # advisory=4, block-limit=2 (invalid: below advisory). Clamp → block fires at 4,
  # NOT at 2. Reaching 3 must NOT block (proves the clamp); reaching 4 blocks.
  local i
  for i in 1 2 3; do
    run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=4 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=2
    [[ "${status}" -eq 0 ]] || { echo "call ${i} expected 0 (clamp keeps block at 4, not 2), got ${status}" >&2; return 1; }
  done
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=4 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=2
  [[ "${status}" -eq 2 ]] || { echo "call4 expected block exit 2 at the clamped limit, got ${status}: ${output}" >&2; return 1; }
}

# --- FAIL-AT-HEAD: the new disarm flag wins over the old arming flag ---

@test "the disarm flag disables blocking; the old arm flag has no effect [FAIL-AT-HEAD: HEAD old flag arms → exit 2]" {
  # DISARM=1 with the OLD flag also set + a low block limit. Post-T5: disarmed →
  # exit 0 at every depth, old flag ignored. HEAD: old flag arms → exit 2 at limit.
  local i
  for i in 1 2 3 4; do
    run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=2 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3 \
      SUBAGENT_NOPROGRESS_DISARM=1 SUBAGENT_NOPROGRESS_BLOCK=1
    [[ "${status}" -eq 0 ]] || { echo "call ${i} expected 0 (disarmed), got ${status}: ${output}" >&2; return 1; }
  done
}

# --- REGRESSION GUARDS (GREEN at HEAD and after) ---

@test "a varied signature resets the streak — a legitimate loop is never braked" {
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=2 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_LIMIT=2 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "${SAME}" SUBAGENT_NOPROGRESS_LIMIT=2 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "${OTHER}" SUBAGENT_NOPROGRESS_LIMIT=2 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
  [[ "${status}" -eq 0 ]] || return 1
}

@test "an empty call signature skips the brake and exits 0 (fail-open, python3 shim)" {
  # Shim python3 to emit nothing → compute_signature returns empty → brake skipped.
  mkdir -p "${SANDBOX}/bin"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"${SANDBOX}/bin/python3"
  chmod +x "${SANDBOX}/bin/python3"
  local i
  for i in 1 2 3 4; do
    run_hook "${SAME}" PATH="${SANDBOX}/bin:${PATH}" \
      SUBAGENT_NOPROGRESS_LIMIT=2 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=3
    [[ "${status}" -eq 0 ]] || { echo "call ${i} expected fail-open exit 0, got ${status}: ${output}" >&2; return 1; }
  done
}

@test "a main-session call (no agent_id) never brakes" {
  run_hook '{}' SUBAGENT_NOPROGRESS_LIMIT=1 SUBAGENT_NOPROGRESS_BLOCK_LIMIT=1
  [[ "${status}" -eq 0 ]] || return 1
}
