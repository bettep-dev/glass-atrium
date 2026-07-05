#!/usr/bin/env bats
# track-outcome-budget-truncation.bats — pins the "budget-truncation" attribution value in the
# SubagentStop completion-synthesized synthesis path (track-outcome.sh).
#
# A [COMPLETION]-absent, tool_use>=1 turn is normally recorded as attribution_source
# "completion-synthesized" (agent delivered work but forgot the block). A budget/turn HARD-KILL
# looks identical on the surface, so it was previously recorded the same way. This suite pins the
# discriminator: when the on-disk cumulative per-agent_id tool_use counter (persisted by
# advisory-subagent-budget.sh) sits at/over the SUBAGENT_TOOL_BUDGET threshold, the record must be
# labelled "budget-truncation" instead — and that label must survive the L905-style relabel guard.
#
# Isolation: the real track-outcome.sh is driven with a synthesized SubagentStop payload on stdin
# (no [COMPLETION] block + one inline tool_use ⇒ the synthesis branch). The hook resolves the PG
# dual-write helper as a SIBLING of the script (repo copy exists), so PG is fail-opened via
# PGHOST pointing at a nonexistent socket dir (same technique as the cost-tracker suite) — no
# live DB write; the tool-budget counter dir is redirected into the test temp dir. Decision
# channel = the '[outcome-record] synthesize: ... attribution=<value> ...' diagnostic on stderr
# (captured via 2>&1). No live hook input is consumed.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  BT_TMP="$(mktemp -d)"
  BUDGET_DIR="${BT_TMP}/agent-tool-budget"
  mkdir -p "${BUDGET_DIR}" "${BT_TMP}/home"
  # All chars are path-safe ⇒ hook_path_safe_key is an identity transform ⇒ counter file basename.
  AGENT_ID="bt-agent-abc123"
  COUNTER_FILE="${BUDGET_DIR}/${AGENT_ID}"
  PAYLOAD_FILE="${BT_TMP}/payload.json"
}

teardown() {
  [[ -n "${BT_TMP:-}" && -d "${BT_TMP}" ]] && rm -rf "${BT_TMP}"
}

# Seed the per-agent tool_use counter with an arbitrary value (empty arg ⇒ leave it absent).
seed_counter() {
  local value="${1:-}"
  [[ -z "${value}" ]] && return 0
  printf '%s\n' "${value}" >"${COUNTER_FILE}"
}

# Drive the real hook. Args: $1 = last_assistant_message text (default: no-completion filler).
#   Reads SUBAGENT_TOOL_BUDGET / SUBAGENT_TOOL_BUDGET_OFF from the caller's env (default unset).
# Merges the hook's stderr into stdout so the synthesize diagnostic lands in $output.
run_hook() {
  local msg="${1:-worked on it; no completion block emitted}"
  jq -nc --arg m "${msg}" --arg aid "${AGENT_ID}" '{
    agent_type: "dev-shell",
    agent_id: $aid,
    session_id: "sess-bt",
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "do the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
  run env \
    HOME="${BT_TMP}/home" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_TOOL_BUDGET="${SUBAGENT_TOOL_BUDGET:-40}" \
    SUBAGENT_TOOL_BUDGET_OFF="${SUBAGENT_TOOL_BUDGET_OFF:-}" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# --- budget-truncation: counter AT/OVER budget ---

@test "counter == budget (40) ⇒ attribution=budget-truncation (boundary)" {
  seed_counter 40
  run_hook
  [[ "${output}" == *"attribution=budget-truncation"* ]]
}

@test "counter > budget (52, in the 40-52 band) ⇒ budget-truncation, NOT clobbered to completion-synthesized" {
  seed_counter 52
  run_hook
  # The clobber-trap guard must hold: budget-truncation present AND completion-synthesized absent.
  [[ "${output}" == *"attribution=budget-truncation"* ]]
  [[ "${output}" != *"attribution=completion-synthesized"* ]]
}

@test "custom SUBAGENT_TOOL_BUDGET honored: counter 10 with budget 10 ⇒ budget-truncation" {
  seed_counter 10
  SUBAGENT_TOOL_BUDGET=10 run_hook
  [[ "${output}" == *"attribution=budget-truncation"* ]]
}

# --- completion-synthesized: fail-open cases (counter low / absent / disabled) ---

@test "counter below budget (5) ⇒ attribution=completion-synthesized (not a budget kill)" {
  seed_counter 5
  run_hook
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=budget-truncation"* ]]
}

@test "counter absent ⇒ fail-open to attribution=completion-synthesized" {
  seed_counter ""
  run_hook
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=budget-truncation"* ]]
}

@test "SUBAGENT_TOOL_BUDGET_OFF disables detection even at/over budget ⇒ completion-synthesized" {
  seed_counter 99
  SUBAGENT_TOOL_BUDGET_OFF=1 run_hook
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=budget-truncation"* ]]
}

@test "corrupt (non-numeric) counter ⇒ fail-open to completion-synthesized" {
  printf '%s\n' "not-a-number" >"${COUNTER_FILE}"
  run_hook
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=budget-truncation"* ]]
}

# --- seven-phrase blocked branch still fires (complementary, unchanged) ---

@test "rate-limit phrase ⇒ result=blocked still synthesized (counter low, seven-phrase intact)" {
  seed_counter 3
  run_hook "the run hit rate limit before finishing"
  # completion-synthesized (low counter) AND the blocked result from the seven-phrase list.
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" == *'"result":"blocked"'* ]]
}
