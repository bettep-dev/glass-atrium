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

# Open [COMPLETION] with NO [/COMPLETION] close (⇒ _T1 misses, _T2 matches ⇒ parse_tier=2) plus an
# INVALID/unparseable result value (⇒ HAS_STRUCTURED=false). This is the ultracode HARD-KILL shape
# the tier-2 relabel tags "truncated_completion" — the record-side signal the synthesis branch must
# NOT clobber. Emitted as the last_assistant_message so the Python parser reads it verbatim.
tier2_open_block() {
  printf '%s\n' '[COMPLETION]' 'result: partial' 'summary: killed mid-work, block left open with no close tag'
}

# Write a subagent transcript (NO [COMPLETION] anywhere, terminal successfully-consumed
# StructuredOutput) at the resolver's session+agent glob path under the test HOME, so
# detect_terminal_structuredoutput derives TERMINAL_SO=1 via the from_transcript path — the faithful
# CC 2.1.199+ schema-mode shape (no inline messages, no last_assistant_message).
write_so_transcript() {
  local tdir="${BT_TMP}/home/.claude/projects/proj/sess-bt/subagents"
  mkdir -p "${tdir}"
  python3 - "${tdir}/agent-${AGENT_ID}.jsonl" <<'PY'
import json, sys
path = sys.argv[1]
SO_ID = "toolu_bt_so01"
rows = [
    {"type": "user", "message": {"role": "user", "content": "do the schema work"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_bt_bash", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_bt_bash", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": SO_ID, "name": "StructuredOutput",
                     "input": {"done": True}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": SO_ID, "content": "ok"}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# Drive the hook with a transcript-only payload (no inline messages, no last_assistant_message) so
# the [COMPLETION] parse + tool-use scan + SO detection all resolve from the subagent transcript.
run_hook_transcript() {
  jq -nc --arg aid "${AGENT_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: "dev-shell",
    agent_id: $aid,
    session_id: "sess-bt",
    transcript_path: "/nonexistent/parent.jsonl"
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

# --- T6 monotonic attribution: truncated_completion (tier-2) is never clobbered by the synthesis ---
#
# The synthesis branch assigns structuredoutput-derived / budget-truncation / completion-synthesized
# only when NO earlier stage already claimed the row. A tier-2 open-no-close block already labelled
# truncated_completion is an EXISTING truncation signal that MUST survive (no existing label flips).
# Precedence pinned: structuredoutput-derived > budget-truncation > completion-synthesized, with the
# already-set truncated_completion beating every synthesis arm it can co-occur with (budget-truncation;
# structuredoutput-derived needs parse_tier=3 and is structurally exclusive with a parse_tier=2 block).
# The RED-first cases below fail against the pre-T6 clobber (they were recorded completion-synthesized
# / budget-truncation instead of truncated_completion).
#
# Assertions are &&-chained into a SINGLE final command on purpose: Bats fails a test only on the exit
# status of its LAST command, so separate assertion lines would leave the non-final ones un-enforced.

@test "tier-2 open-no-close + counter low ⇒ truncated_completion, NOT clobbered to completion-synthesized" {
  seed_counter 5
  run_hook "$(tier2_open_block)"
  [[ "${output}" == *"attribution=truncated_completion"* ]] \
    && [[ "${output}" != *"attribution=completion-synthesized"* ]]
}

@test "tier-2 open-no-close + counter absent ⇒ truncated_completion (monotonic, not completion-synthesized)" {
  seed_counter ""
  run_hook "$(tier2_open_block)"
  [[ "${output}" == *"attribution=truncated_completion"* ]] \
    && [[ "${output}" != *"attribution=completion-synthesized"* ]]
}

@test "tier-2 open-no-close + counter AT/OVER budget (52) ⇒ truncated_completion beats budget-truncation" {
  seed_counter 52
  run_hook "$(tier2_open_block)"
  # No existing label flips: the tier-2 truncation label wins over a co-occurring budget kill.
  [[ "${output}" == *"attribution=truncated_completion"* ]] \
    && [[ "${output}" != *"attribution=budget-truncation"* ]] \
    && [[ "${output}" != *"attribution=completion-synthesized"* ]]
}

# --- precedence arms: each of the three synthesis labels beats completion-synthesized ---

@test "arm 1 — structuredoutput-derived beats completion-synthesized (counter low, terminal consumed SO)" {
  seed_counter 5
  write_so_transcript
  run_hook_transcript
  [[ "${output}" == *"attribution=structuredoutput-derived"* ]] \
    && [[ "${output}" != *"attribution=completion-synthesized"* ]]
}

@test "arm 2 — budget-truncation beats completion-synthesized (counter at budget, no [COMPLETION], parse_tier=3)" {
  seed_counter 40
  run_hook
  [[ "${output}" == *"attribution=budget-truncation"* ]] \
    && [[ "${output}" != *"attribution=completion-synthesized"* ]]
}

@test "arm 3 — truncated_completion beats completion-synthesized (tier-2 open block, counter low)" {
  seed_counter 5
  run_hook "$(tier2_open_block)"
  [[ "${output}" == *"attribution=truncated_completion"* ]] \
    && [[ "${output}" != *"attribution=completion-synthesized"* ]]
}
