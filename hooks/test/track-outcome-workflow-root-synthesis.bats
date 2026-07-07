#!/usr/bin/env bats
# track-outcome-workflow-root-synthesis.bats — Thread D (T12) RED-first guard for the
# workflow-controller/root SubagentStop synthesis-pollution fix (track-outcome.sh).
#
# Root cause (verified by direct read): an ultracode/workflow controller/root SubagentStop
# carries agent_id but no agent_type and has no leaf sidecar → recover_agent_type_from_sidecar
# returns None → agent_type='subagent_stop_missing'. Its OWN transcript (agent-<id>.jsonl) is
# unresolvable, so _resolve_subagent_transcript returns '' and _effective_transcript_path FALLS
# BACK to the PARENT workflow transcript. count_tool_use_current_turn then counts the PARENT's
# tool_uses (high) → parse_tier=3 + tool_use>=1 defeats the conversation-only skip; and the
# real_agent phantom-drop gate does NOT drop it because _pred_transcript reads the readable
# PARENT transcript_path → a polluted completion-synthesized / done_with_concerns row is
# synthesized under a phantom agent.
#
# Chosen fix direction (Plan Direction Verification gate): a_skip_synthesis — when the subagent's
# OWN transcript is unresolvable AND it is a workflow-controller/root spawn (agent_id present, no
# own transcript), do NOT fall back to the PARENT transcript for tool_use/summary; treat as
# unresolved so REAL_AGENT correctly = 0 and the QUIET phantom-drop (DATA-076) fires instead of a
# synthesized row or a false LOUD-FAIL (DATA-077).
#
# Isolation: the real track-outcome.sh is driven with a synthetic SubagentStop payload on stdin.
# HOME is sandboxed so the own-transcript glob (~/.claude/projects/...) resolves nothing and the
# diag log is redirected into the temp dir. PG is fail-opened via PGHOST → a nonexistent socket
# dir (no live DB). SUBAGENT_TOOL_BUDGET_OFF=1 pins the synthesis label to completion-synthesized
# (never budget-truncation) so the pollution-case RED assertion is deterministic. Decision channel
# = the '[outcome-record] ...' diagnostics on stderr (captured via 2>&1). No live hook input.
#
# Assertion helpers (NOT bare [[ ]]): bats 1.x runs the body under errexit, but bash exempts a
# standalone [[ ]] / [ ] from errexit, so a failed bare conditional mid-body is SILENTLY MASKED
# (only the last command's status decides pass/fail). The helpers below are simple commands whose
# non-zero return DOES trip errexit → every assertion is enforced regardless of position.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

assert_contains() {
  # $1 = needle · $2 = haystack. Non-zero (errexit-tripping) return when absent.
  case "$2" in
    *"$1"*) return 0 ;;
    *)
      printf 'assert_contains FAILED — missing: [%s]\n' "$1" >&2
      return 1
      ;;
  esac
}

assert_absent() {
  # $1 = needle · $2 = haystack. Non-zero return when present.
  case "$2" in
    *"$1"*)
      printf 'assert_absent FAILED — present: [%s]\n' "$1" >&2
      return 1
      ;;
    *) return 0 ;;
  esac
}

assert_status() {
  # $1 = observed status · $2 = expected. Non-zero return on mismatch.
  if [ "$1" -eq "$2" ]; then
    return 0
  fi
  printf 'assert_status FAILED — got %s want %s\n' "$1" "$2" >&2
  return 1
}

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  WR_TMP="$(mktemp -d)"
  SANDBOX_HOME="${WR_TMP}/home"
  mkdir -p "${SANDBOX_HOME}/.claude/logs"

  # A workflow-controller identity: agent_id present, but no leaf sidecar and (deliberately) no
  # own transcript created — so _resolve_subagent_transcript() globs nothing under the sandbox HOME.
  AGENT_ID="wf-controller-$$-${RANDOM}"
  SESSION_ID="sess-wr-$$-${RANDOM}"

  # A REAL parent workflow transcript with high tool_use — the polluting fallback source. Placed
  # in the temp dir (read directly by transcript_path, no glob) so it exists + is readable.
  PARENT_TRANSCRIPT="${WR_TMP}/parent-workflow.jsonl"
  PAYLOAD_FILE="${WR_TMP}/payload.json"
}

teardown() {
  if [[ -n "${WR_TMP:-}" && -d "${WR_TMP}" ]]; then
    rm -rf "${WR_TMP}"
  fi
}

# A parent workflow transcript: several assistant tool_use entries (high tool_use) + a terminal
# assistant text that is the PARENT's work, NOT this spawn's — the mislabel source.
write_parent_transcript() {
  python3 - "${PARENT_TRANSCRIPT}" <<'PY'
import json, sys
path = sys.argv[1]
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the workflow"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Agent", "input": {"agentType": "dev-shell"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "spawned"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Agent", "input": {"agentType": "qa-code-reviewer"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "reviewed"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "echo done"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "done"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "continue the workflow"}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# A real-continuation OWN transcript at the exact path _resolve_subagent_transcript() globs
# (~/.claude/projects/*/<session>/subagents/agent-<id>.jsonl under the sandbox HOME). Carries
# real tool_use but NO [COMPLETION] block → parse_tier=3, subagent_stop_missing, exercising the
# real_agent predicate. The resolver globs projects/*/ so any project-dir slug works.
write_own_transcript() {
  local own_dir="${SANDBOX_HOME}/.claude/projects/proj/${SESSION_ID}/subagents"
  mkdir -p "${own_dir}"
  OWN_TRANSCRIPT="${own_dir}/agent-${AGENT_ID}.jsonl"
  python3 - "${OWN_TRANSCRIPT}" <<'PY'
import json, sys
path = sys.argv[1]
rows = [
    {"type": "user", "message": {"role": "user", "content": "do the shell fix"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "/tmp/a.sh"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "edited"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "the fix is applied and verified"}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# The regressing SubagentStop shape: agent_id present, NO agent_type, NO last_assistant_message,
# NO inline messages, transcript_path → the readable PARENT workflow transcript.
write_controller_payload() {
  jq -nc \
    --arg aid "${AGENT_ID}" \
    --arg sess "${SESSION_ID}" \
    --arg tpath "${PARENT_TRANSCRIPT}" \
    --arg cwd "${SANDBOX_HOME}" \
    '{
      hook_event_name: "SubagentStop",
      agent_id: $aid,
      session_id: $sess,
      cwd: $cwd,
      transcript_path: $tpath
    }' >"${PAYLOAD_FILE}"
}

# A real leaf subagent completion: agent_type present + an inline [COMPLETION] block +
# one inline tool_use → parse_tier=1, hook-input. Must stay untouched by the fix.
write_leaf_payload() {
  local completion
  completion="$(printf '%s\n' \
    "[COMPLETION]" \
    "result: done" \
    "task_type: bug-fix" \
    "metric_pass: true" \
    "confidence: high" \
    "summary: leaf happy-path stays hook-input" \
    "[/COMPLETION]")"
  jq -nc \
    --arg aid "leaf-$$-${RANDOM}" \
    --arg sess "${SESSION_ID}" \
    --arg m "${completion}" \
    '{
      hook_event_name: "SubagentStop",
      agent_type: "dev-shell",
      agent_id: $aid,
      session_id: $sess,
      last_assistant_message: $m,
      transcript_path: "/nonexistent/parent.jsonl",
      messages: [
        {role: "user", content: "do the work"},
        {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
      ]
    }' >"${PAYLOAD_FILE}"
}

run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PGHOST="/nonexistent-socket-wr" \
    CLAUDE_GATE_INFLIGHT="" \
    SUBAGENT_TOOL_BUDGET_OFF="1" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "workflow-root SubagentStop (own transcript unresolvable, readable parent) does NOT synthesize a polluted row" {
  write_parent_transcript
  write_controller_payload

  run_hook
  assert_status "${status}" 0

  # Chosen direction a_skip_synthesis: the QUIET phantom-drop (DATA-076) fires — the parent
  # fallback is suppressed so REAL_AGENT=0.
  assert_contains "skip: phantom subagent-stop" "${output}"

  # It must NOT synthesize a completion-synthesized / done_with_concerns row from the PARENT.
  assert_absent "synthesize:" "${output}"
  assert_absent "attribution=completion-synthesized" "${output}"

  # And it must NOT emit the false LOUD-FAIL (DATA-077) — the parent-keyed _pred_transcript would
  # otherwise leave REAL_AGENT=1, skip the phantom-drop, and hit the tool_use=0 loud-fail branch.
  assert_absent "LOUD-FAIL" "${output}"
}

@test "real continuation (subagent_stop_missing WITH resolvable own transcript) is NOT phantom-dropped — no regression" {
  # Same missing-agent_type shape, but the spawn's OWN transcript IS resolvable (predicate ii
  # holds via _resolve_subagent_transcript, not the parent). The verify gate's non-regression
  # guarantee: a real continuation still resolves its own transcript so REAL_AGENT=1 and the row
  # is recorded (synthesized from the OWN transcript), never phantom-dropped.
  write_own_transcript
  write_parent_transcript
  write_controller_payload

  run_hook
  assert_status "${status}" 0

  # Recorded (legitimately synthesized from the OWN transcript), NOT phantom-dropped.
  assert_absent "skip: phantom subagent-stop" "${output}"
  assert_contains "synthesize:" "${output}"
  assert_absent "LOUD-FAIL" "${output}"
}

@test "leaf subagent completion (agent_type + inline [COMPLETION]) stays hook-input, parse_tier=1 — unchanged by the fix" {
  write_leaf_payload

  run_hook
  assert_status "${status}" 0

  # The leaf happy-path parses the inline [COMPLETION] as tier 1 and is never touched by the
  # workflow-root suppression.
  assert_contains "parse_tier=1" "${output}"
  assert_absent "skip: phantom subagent-stop" "${output}"
  assert_absent "synthesize:" "${output}"
}
