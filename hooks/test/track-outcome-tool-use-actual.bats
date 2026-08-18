#!/usr/bin/env bats
# track-outcome-tool-use-actual.bats — pins the estimate-vs-actual capture in track-outcome.sh.
#
# The recorder reads the per-agent_id tool_use counter advisory-subagent-budget.sh writes per call
# (the MEASURED side) and the parent's `[SIZE-EST] … tool_uses~=N` claim off record 0 of the
# subagent's own transcript (the DECLARED side), then records both on one body_md line. What this
# suite pins:
#   - the line appears, with both fields, when both signals exist
#   - the declared half is omitted (never zero-filled) when the prompt carries no token
#   - the whole line is ABSENT when no counter exists — an unmeasured row must not read as
#     "measured at zero", which would enter the aggregator's rate as a non-overrun
#   - kill-switch parity with the advisory that maintains the counter
#
# Isolation mirrors track-outcome-budget-truncation.bats: the real hook is driven with a synthesized
# SubagentStop payload, PG is fail-opened via PGHOST at a nonexistent socket, and the counter dir +
# HOME are redirected into the temp dir. Two decision channels are asserted — the stderr diagnostic,
# and the spooled dual-write envelope (PG unreachable ⇒ the envelope is spooled to disk, which is
# where the body_md the aggregator later reads can be inspected without a live DB).

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  TU_TMP="$(mktemp -d)"
  BUDGET_DIR="${TU_TMP}/agent-tool-budget"
  SPOOL_DIR="${TU_TMP}/outcome-spool"
  mkdir -p "${BUDGET_DIR}" "${TU_TMP}/home"
  # All chars are path-safe ⇒ hook_path_safe_key is an identity transform ⇒ counter file basename.
  AGENT_ID="tu-agent-abc123"
  COUNTER_FILE="${BUDGET_DIR}/${AGENT_ID}"
  PAYLOAD_FILE="${TU_TMP}/payload.json"
}

teardown() {
  [[ -n "${TU_TMP:-}" && -d "${TU_TMP}" ]] && rm -rf "${TU_TMP}"
}

# Seed the per-agent tool_use counter (empty arg ⇒ leave it absent).
seed_counter() {
  local value="${1:-}"
  [[ -z "${value}" ]] && return 0
  printf '%s\n' "${value}" >"${COUNTER_FILE}"
}

# Write the subagent's own transcript at the resolver's session+agent glob path. $1 = the delegation
# prompt text of record 0 (the parent-authored message the [SIZE-EST] token rides in). The terminal
# assistant record carries a complete [COMPLETION] block so the row records as a writer-emitted
# outcome rather than a synthesis.
write_transcript() {
  local prompt="${1}"
  local tdir="${TU_TMP}/home/.claude/projects/proj/sess-tu/subagents"
  mkdir -p "${tdir}"
  python3 - "${tdir}/agent-${AGENT_ID}.jsonl" "${prompt}" <<'PY'
import json, sys
path, prompt = sys.argv[1], sys.argv[2]
completion = "\n".join([
    "[COMPLETION]",
    "result: done",
    "task_type: refactor",
    "metric_pass: true",
    "confidence: high",
    "summary: did the work",
    "[/COMPLETION]",
])
rows = [
    {"type": "user", "message": {"role": "user", "content": prompt}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_tu_1", "name": "Edit", "input": {}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_tu_1", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# Drive the real hook: PG fail-opened, counter dir + spool dir redirected, stderr merged into stdout.
run_hook() {
  jq -nc --arg aid "${AGENT_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: "dev-shell",
    agent_id: $aid,
    session_id: "sess-tu",
    transcript_path: "/nonexistent/parent.jsonl"
  }' >"${PAYLOAD_FILE}"
  run env \
    HOME="${TU_TMP}/home" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    SUBAGENT_TOOL_BUDGET_OFF="${SUBAGENT_TOOL_BUDGET_OFF:-}" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# The body_md the dual-write carried, recovered from the spooled envelope (PG is unreachable here).
spooled_body() {
  cat "${SPOOL_DIR}"/* 2>/dev/null | jq -r '.outcome.body_md // empty' 2>/dev/null
}

@test "counter + declared token ⇒ both halves recorded on the body line" {
  seed_counter 48
  write_transcript '[SIZE-EST] bundles=1 tool_uses~=22 — one file group'
  run_hook
  # `run` overwrites $output, so the first channel is captured before the second runs and both are
  # asserted in one trailing && chain — the test's verdict is its LAST command.
  local diag="${output}"
  run spooled_body
  [[ "${diag}" == *"tool_use actual=48 declared=22"* ]] \
    && [[ "${output}" == *"- **Tool use**: actual=48 declared=22"* ]]
}

@test "counter without a declared token ⇒ actual recorded, declared omitted (never zero-filled)" {
  seed_counter 12
  write_transcript 'do the work; no size attestation in this prompt'
  run_hook
  local diag="${output}"
  run spooled_body
  [[ "${diag}" == *"tool_use actual=12 declared=none"* ]] \
    && [[ "${output}" == *"- **Tool use**: actual=12"* ]] \
    && [[ "${output}" != *"declared="* ]]
}

@test "counter absent ⇒ no measurement recorded at all (silent, not zero)" {
  seed_counter ""
  write_transcript '[SIZE-EST] bundles=1 tool_uses~=22 — one file group'
  run_hook
  local diag="${output}"
  run spooled_body
  [[ "${diag}" != *"tool_use actual="* ]] && [[ "${output}" != *"Tool use"* ]]
}

@test "SUBAGENT_TOOL_BUDGET_OFF ⇒ silent even with a live counter (kill-switch parity)" {
  seed_counter 48
  write_transcript '[SIZE-EST] bundles=1 tool_uses~=22 — one file group'
  SUBAGENT_TOOL_BUDGET_OFF=1 run_hook
  [[ "${output}" != *"tool_use actual="* ]]
}

@test "analysis-mode token (reads~=) declares no tool_use claim ⇒ actual alone" {
  seed_counter 31
  write_transcript '[SIZE-EST] reads~=14 fields=2 effort=medium scope=allowlist — bounded audit'
  run_hook
  [[ "${output}" == *"tool_use actual=31 declared=none"* ]]
}
