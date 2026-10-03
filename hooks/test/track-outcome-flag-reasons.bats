#!/usr/bin/env bats
# track-outcome-flag-reasons.bats — W2-B of clauded-docs/1461: every recorder-side review-flag
# setter stamps a concrete reason token, so a flagged row names its own trigger.
#
# Reason derivation used to run at READ time against a taxonomy naming four of the real triggers,
# sending the majority of flagged rows to a catch-all. The setter knows its own trigger; these pins
# hold each one to a distinct token and hold the carrier empty whenever the flag ends false.
#
# Isolation: same sandboxed harness as the sibling recorder corpus — HOME sandboxed, dual-write
# stubbed by a PATH python3 shim that exits non-zero, spooled envelope as the assertion surface.
#
# CID: 2026-08-13T1230_grader-attribution-impl_r9m5

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"
REASONS_LIB="${BATS_TEST_DIRNAME}/../lib/review-flag-reasons.sh"

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  FR_TMP="$(mktemp -d -t track-fr.XXXXXX)"
  AGENT_TYPE="glass-atrium-dev-shell"
  AGENT_ID="fraid${$}x${RANDOM}"
  SESSION_ID="sess-fr-$$-${RANDOM}"

  SANDBOX_HOME="${FR_TMP}/home"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/proj/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  SPOOL_DIR="${SANDBOX_HOME}/.claude/data/outcome-spool"
  PAYLOAD_FILE="${FR_TMP}/payload.json"

  SHIM_DIR="${FR_TMP}/bin"
  mkdir -p "${SHIM_DIR}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'for _a in "$@"; do'
    printf '%s\n' '  case "${_a}" in'
    printf '%s\n' '    *_pg_outcome_dualwrite.py) cat >/dev/null; exit 6 ;;'
    printf '%s\n' '  esac'
    printf '%s\n' 'done'
    printf '%s\n' "exec \"${REAL_PY3}\" \"\$@\""
  } >"${SHIM_DIR}/python3"
  chmod +x "${SHIM_DIR}/python3"
}

teardown() {
  if ga_guard_path "${FR_TMP:-}"; then rm -rf -- "${FR_TMP:?}"; fi
}

write_inline_payload() {
  jq -nc --arg m "${1}" --arg aid "${AGENT_ID}" --arg agent "${AGENT_TYPE}" --arg sess "${SESSION_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: $agent,
    agent_id: $aid,
    session_id: $sess,
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "do the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
}

write_transcript_payload() {
  jq -nc --arg aid "${AGENT_ID}" --arg agent "${AGENT_TYPE}" --arg sess "${SESSION_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: $agent,
    agent_id: $aid,
    session_id: $sess,
    transcript_path: "/nonexistent/parent.jsonl"
  }' >"${PAYLOAD_FILE}"
}

# Schema-mode shape: no [COMPLETION], terminal consumed StructuredOutput; $1, when given, is its
# completion_block property.
write_so_transcript() {
  "${REAL_PY3}" - "${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl" "${1:-}" <<'PY'
import json, sys
so_id = "toolu_fr_so01"
so_input = {"done": True}
if sys.argv[2]:
    so_input["completion_block"] = sys.argv[2]
rows = [
    {"type": "user", "message": {"role": "user", "content": "do the schema work"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_fr_bash", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_fr_bash", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": so_id, "name": "StructuredOutput",
                     "input": so_input}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": so_id, "content": "ok"}]}},
]
with open(sys.argv[1], "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

spooled_field() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || return 1
  jq -r ".outcome.${1} // \"\"" "${f}"
}

completion_block() {
  printf '%s\n' '[COMPLETION]'
  printf '%s\n' "$@"
  printf '%s\n' '[/COMPLETION]'
}

# ---------------------------------------------------------------------------
# AC-4.1 — one distinct token per recorder-side trigger
# ---------------------------------------------------------------------------

@test "overconfidence — high confidence against a failed code-row metric" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: bug-fix' 'metric_pass: false' \
    'confidence: high' 'style_ref: hooks/track-outcome.sh' 'summary: overconfident code row')"
  run_hook
  [[ "$(spooled_field review_flag)" == "true" ]] \
    && [[ "$(spooled_field review_flag_reasons)" == "overconfidence" ]]
}

@test "underconfidence — low confidence against a passing metric" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' \
    'confidence: low' 'summary: underconfident row')"
  run_hook
  [[ "$(spooled_field review_flag_reasons)" == "underconfidence" ]]
}

@test "empty-metric — a writer row that omitted metric_pass" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' \
    'confidence: medium' 'summary: writer omitted metric_pass')"
  run_hook
  [[ "$(spooled_field review_flag_reasons)" == "empty-metric" ]]
}

@test "degraded-attribution-synthesized — no writer block at all" {
  write_inline_payload "delivered the work; no completion block emitted"
  run_hook
  [[ "$(spooled_field attribution_source)" == "completion-synthesized" ]] \
    && [[ "$(spooled_field review_flag_reasons)" == *"degraded-attribution-synthesized"* ]]
}

@test "degraded-attribution-derived — schema-mode row synthesized from StructuredOutput" {
  write_so_transcript
  write_transcript_payload
  run_hook
  [[ "$(spooled_field attribution_source)" == "structuredoutput-derived" ]] \
    && [[ "$(spooled_field review_flag_reasons)" == *"degraded-attribution-derived"* ]]
}

@test "the two degraded provenances never collapse into one label" {
  write_inline_payload "delivered the work; no completion block emitted"
  run_hook
  [[ "$(spooled_field review_flag_reasons)" != *"degraded-attribution-derived"* ]]
}

@test "correction-gap — a -1 correction emitted without a directive hint" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' \
    'confidence: high' 'evaluative_signal: -1' 'summary: correction without a directive hint')"
  run_hook
  [[ "$(spooled_field review_flag_reasons)" == *"correction-gap"* ]]
}

# ---------------------------------------------------------------------------
# AC-4.2 — carrier emptiness whenever the flag ends false
# ---------------------------------------------------------------------------

@test "clean row carries an empty reason set" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' \
    'confidence: high' 'summary: tidied the imports')"
  run_hook
  [[ "$(spooled_field review_flag)" == "false" ]] \
    && [[ "$(spooled_field review_flag_reasons)" == "" ]]
}

@test "structural high+false row carries an empty reason set (flag stays false)" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: false' \
    'confidence: high' 'summary: no-test-bar row')"
  run_hook
  [[ "$(spooled_field review_flag)" == "false" ]] \
    && [[ "$(spooled_field review_flag_reasons)" == "" ]]
}

@test "budget-truncated row keeps flag false and an empty carrier" {
  BUDGET_DIR="${FR_TMP}/agent-tool-budget"
  mkdir -p "${BUDGET_DIR}"
  printf '%s\n' 52 >"${BUDGET_DIR}/${AGENT_ID}"
  write_inline_payload "killed at the budget ceiling"
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_TOOL_BUDGET="40" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
  [[ "$(spooled_field review_flag)" == "false" ]] \
    && [[ "$(spooled_field review_flag_reasons)" == "" ]]
}

# qa-score-malformed — a present qa_score against cov=N,ins=N,instr=N,clar=N[,d8=N], each N 1-5

# Rows: name, value written, value stored, expected reasons, expected flag — \x1f-separated.
# The parser trims a value's ends, so surrounding whitespace is the only tolerated deviation.
@test "a qa_score off the cov=N,ins=N,instr=N,clar=N shape, optional d8=N tail, stamps qa-score-malformed and keeps its value" {
  local row name written stored reasons flag n=0 got_stored got_reasons got_flag
  AGENT_TYPE="glass-atrium-qa-code-reviewer"
  for row in \
    $'both range ends\x1fcov=1,ins=5,instr=1,clar=5\x1fcov=1,ins=5,instr=1,clar=5\x1f\x1ffalse' \
    $'surrounding whitespace\x1f  cov=4,ins=3,instr=5,clar=4  \x1fcov=4,ins=3,instr=5,clar=4\x1f\x1ffalse' \
    $'d8 tail\x1fcov=4,ins=3,instr=5,clar=4,d8=4\x1fcov=4,ins=3,instr=5,clar=4,d8=4\x1f\x1ffalse' \
    $'score below range\x1fcov=0,ins=3,instr=5,clar=4\x1fcov=0,ins=3,instr=5,clar=4\x1fqa-score-malformed\x1ftrue' \
    $'score above range\x1fcov=4,ins=3,instr=5,clar=6\x1fcov=4,ins=3,instr=5,clar=6\x1fqa-score-malformed\x1ftrue' \
    $'missing key\x1fcov=4,ins=3,instr=5\x1fcov=4,ins=3,instr=5\x1fqa-score-malformed\x1ftrue' \
    $'keys out of template order\x1fins=3,cov=4,instr=5,clar=4\x1fins=3,cov=4,instr=5,clar=4\x1fqa-score-malformed\x1ftrue' \
    $'extra trailing key\x1fcov=4,ins=3,instr=5,clar=4,extra=1\x1fcov=4,ins=3,instr=5,clar=4,extra=1\x1fqa-score-malformed\x1ftrue' \
    $'d8 tail below range\x1fcov=4,ins=3,instr=5,clar=4,d8=0\x1fcov=4,ins=3,instr=5,clar=4,d8=0\x1fqa-score-malformed\x1ftrue' \
    $'d8 tail above range\x1fcov=4,ins=3,instr=5,clar=4,d8=6\x1fcov=4,ins=3,instr=5,clar=4,d8=6\x1fqa-score-malformed\x1ftrue' \
    $'space after a separator\x1fcov=4, ins=3, instr=5, clar=4\x1fcov=4, ins=3, instr=5, clar=4\x1fqa-score-malformed\x1ftrue' \
    $'free text\x1fstrong review\x1fstrong review\x1fqa-score-malformed\x1ftrue'; do
    IFS=$'\x1f' read -r name written stored reasons flag <<<"${row}"
    n=$((n + 1))
    AGENT_ID="fraid${$}q${n}"
    SPOOL_DIR="${FR_TMP}/spool-qa-${n}"
    write_inline_payload "$(completion_block 'result: done' 'task_type: review' 'metric_pass: true' \
      'confidence: high' 'summary: review verdict' "qa_score: ${written}")"
    run_hook
    got_stored="$(spooled_field qa_score)" || true
    got_reasons="$(spooled_field review_flag_reasons)" || true
    got_flag="$(spooled_field review_flag)" || true
    [[ "${got_stored}" == "${stored}" && "${got_reasons}" == "${reasons}" && "${got_flag}" == "${flag}" ]] \
      || {
        echo "row '${name}': qa_score='${got_stored}' reasons='${got_reasons}' flag='${got_flag}'"
        echo "${output}"
        return 1
      }
  done
}

@test "the polar gate's flag reset does not erase a malformed qa_score flag" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: false' \
    'confidence: high' 'qa_score: strong review' 'summary: no-test-bar row')"
  run_hook
  local got_flag got_reasons
  got_flag="$(spooled_field review_flag)" || true
  got_reasons="$(spooled_field review_flag_reasons)" || true
  [[ "${got_flag}" == "true" && "${got_reasons}" == "qa-score-malformed" ]] || {
    echo "flag='${got_flag}' reasons='${got_reasons}'"
    echo "${output}"
    return 1
  }
}

# Protects the fold decision: the value is checked as stored, never trimmed back to its first token.
@test "a non-template line folded into qa_score is flagged on the stored value" {
  AGENT_TYPE="glass-atrium-qa-code-reviewer"
  write_inline_payload "$(completion_block 'result: done' 'task_type: review' 'metric_pass: true' \
    'confidence: high' 'summary: review verdict' 'qa_score: cov=4,ins=3,instr=5,clar=4' \
    'reviewer_note: see thread')"
  run_hook
  local got_stored got_reasons
  got_stored="$(spooled_field qa_score)" || true
  got_reasons="$(spooled_field review_flag_reasons)" || true
  [[ "${got_stored}" == "cov=4,ins=3,instr=5,clar=4 reviewer_note: see thread" &&
    "${got_reasons}" == "qa-score-malformed" ]] || {
    echo "qa_score='${got_stored}' reasons='${got_reasons}'"
    echo "${output}"
    return 1
  }
}

# Protects the schema-mode channel: prose after the block's closer is not part of the qa_score value.
@test "a well-formed qa_score in a schema-mode block followed by prose raises no flag" {
  AGENT_TYPE="glass-atrium-qa-code-reviewer"
  local block got_stored got_reasons got_flag
  block="$(completion_block 'result: done' 'task_type: review' 'metric_pass: true' \
    'confidence: high' 'summary: review verdict' 'qa_score: cov=5,ins=4,instr=4,clar=4')"
  write_so_transcript "${block}"$'\n\n## Review Summary\n- **Overall**: pass'
  write_transcript_payload
  run_hook
  got_stored="$(spooled_field qa_score)" || true
  got_reasons="$(spooled_field review_flag_reasons)" || true
  got_flag="$(spooled_field review_flag)" || true
  [[ "${got_stored}" == "cov=5,ins=4,instr=4,clar=4" && "${got_reasons}" == "" && "${got_flag}" == "false" ]] || {
    echo "qa_score='${got_stored}' reasons='${got_reasons}' flag='${got_flag}'"
    echo "${output}"
    return 1
  }
}

# ---------------------------------------------------------------------------
# Vocabulary — one declaration, and every recorder-side token stamped somewhere
# ---------------------------------------------------------------------------

@test "every recorder-side token is stamped by the recorder and declared in the shared registry" {
  local token
  for token in overconfidence underconfidence empty-metric degraded-attribution-derived \
    degraded-attribution-synthesized grader-contradiction correction-gap correction-disagreement \
    scope-excess qa-score-malformed; do
    grep -qF "review_flag_add_reason \"${token}\"" "${HOOK_SH}" \
      || {
        echo "token '${token}': no review_flag_add_reason stamp in the recorder"
        return 1
      }
    grep -qF "${token}" "${REASONS_LIB}" \
      || {
        echo "token '${token}': not declared in the shared registry"
        return 1
      }
  done
}

@test "the reason vocabulary has exactly one declaration" {
  local declarations
  declarations="$(grep -lF 'REVIEW_FLAG_REASON_TOKENS=' "${BATS_TEST_DIRNAME}/.."/*.sh \
    "${BATS_TEST_DIRNAME}/../lib"/*.sh 2>/dev/null | wc -l | tr -d ' ')"
  [[ "${declarations}" == "1" ]]
}
