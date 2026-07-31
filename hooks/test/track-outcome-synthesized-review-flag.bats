#!/usr/bin/env bats
# track-outcome-synthesized-review-flag.bats — R7 of clauded-docs/760: a synthesized outcome row
# must be legible at a glance, and the widening must stay neutral on the loop's negative signal.
#
# A synthesized row carries confidence=low + metric_pass=false, so every pre-existing review_flag
# branch leaves it unset and the row reads as healthy. R7 sets the flag for the two writer-absent
# provenances (structuredoutput-derived, completion-synthesized) and carries the paired exclusions
# so the widened flag never converts a healthy row into a negative-signal hit.
#
# The exclusion is deliberately per-provenance, never "synthesized family minus budget-truncation":
# a FOURTH value (truncated_completion) rides the same path, and a negation-shaped condition would
# sweep both truncation values in — amplifying the very budget-overage family under remediation.
#
# Isolation: the hook is invoked DIRECTLY as a command (its shebang), never interpreter-prefixed.
# The DB dual-write is stubbed by a PATH python3 shim that exits non-zero, so the outcome envelope
# dead-letters into a sandboxed spool dir — that spooled JSON is the assertion surface and no live
# Postgres is touched. The two python predicate suites import their modules with a stubbed driver
# surface and assert over frozen in-test row dicts, so they are database-free as well.
#
# CID: 2026-07-31T1530_loopexec_a4f6

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"
HOOKS_DIR="${BATS_TEST_DIRNAME}/.."

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  RF_TMP="$(mktemp -d -t track-rf.XXXXXX)"
  AGENT_TYPE="glass-atrium-dev-shell"
  AGENT_ID="rfaid${$}x${RANDOM}"
  SESSION_ID="sess-rf-$$-${RANDOM}"

  SANDBOX_HOME="${RF_TMP}/home"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/proj/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  SPOOL_DIR="${SANDBOX_HOME}/.claude/data/outcome-spool"
  BUDGET_DIR="${RF_TMP}/agent-tool-budget"
  mkdir -p "${BUDGET_DIR}"
  COUNTER_FILE="${BUDGET_DIR}/${AGENT_ID}"
  PAYLOAD_FILE="${RF_TMP}/payload.json"

  # PATH python3 shim — stubs ONLY the outcome dual-write helper (forced non-zero ⇒ the envelope
  # spools), passing every other python3 call through to the real interpreter.
  SHIM_DIR="${RF_TMP}/bin"
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
  [[ -n "${RF_TMP:-}" && -d "${RF_TMP}" ]] && rm -rf -- "${RF_TMP}" || true
}

# ---------------------------------------------------------------------------
# hook drivers
# ---------------------------------------------------------------------------

# Inline-message payload: $1 = last_assistant_message, plus one tool_use ⇒ deliverable-producing.
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

# Transcript-only payload — the [COMPLETION] parse, tool-use scan and terminal-StructuredOutput
# detection all resolve from the sandboxed subagent transcript.
write_transcript_payload() {
  jq -nc --arg aid "${AGENT_ID}" --arg agent "${AGENT_TYPE}" --arg sess "${SESSION_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: $agent,
    agent_id: $aid,
    session_id: $sess,
    transcript_path: "/nonexistent/parent.jsonl"
  }' >"${PAYLOAD_FILE}"
}

# Subagent transcript with NO [COMPLETION] and a terminal successfully-consumed StructuredOutput
# ⇒ the schema-mode shape that stamps attribution_source=structuredoutput-derived.
write_so_transcript() {
  "${REAL_PY3}" - "${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl" <<'PY'
import json, sys
path = sys.argv[1]
so_id = "toolu_rf_so01"
rows = [
    {"type": "user", "message": {"role": "user", "content": "do the schema work"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_rf_bash", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_rf_bash", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": so_id, "name": "StructuredOutput",
                     "input": {"done": True}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": so_id, "content": "ok"}]}},
]
with open(path, "w", encoding="utf-8") as f:
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
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_TOOL_BUDGET="40" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# Field of the single dead-lettered outcome envelope — the DB-free assertion surface.
spooled_field() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || return 1
  jq -r ".outcome.${1} // \"\"" "${f}"
}

# A [COMPLETION] block from key: value pairs, one per argument.
completion_block() {
  printf '%s\n' '[COMPLETION]'
  printf '%s\n' "$@"
  printf '%s\n' '[/COMPLETION]'
}

# ---------------------------------------------------------------------------
# provenance arms — which synthesized rows carry the flag
# ---------------------------------------------------------------------------

@test "schema-derived row records review_flag=true (the paradigm degraded row)" {
  write_so_transcript
  write_transcript_payload
  run_hook
  [[ "${output}" == *"attribution=structuredoutput-derived"* ]] \
    && [[ "$(spooled_field attribution_source)" == "structuredoutput-derived" ]] \
    && [[ "$(spooled_field review_flag)" == "true" ]]
}

@test "completion-absent row records review_flag=true" {
  write_inline_payload "delivered the work; no completion block emitted"
  run_hook
  [[ "${output}" == *"attribution=completion-synthesized"* ]] \
    && [[ "$(spooled_field review_flag)" == "true" ]]
}

@test "budget-truncated row records review_flag=false (family under remediation, deliberately excluded)" {
  printf '%s\n' 52 >"${COUNTER_FILE}"
  write_inline_payload "killed at the budget ceiling"
  run_hook
  [[ "${output}" == *"attribution=budget-truncation"* ]] \
    && [[ "$(spooled_field review_flag)" == "false" ]]
}

@test "truncated_completion row records review_flag=false (two-literal allowlist, not a negation)" {
  write_inline_payload "$(printf '%s\n' '[COMPLETION]' 'result: partial' 'summary: killed mid-block')"
  run_hook
  [[ "${output}" == *"attribution=truncated_completion"* ]] \
    && [[ "$(spooled_field review_flag)" == "false" ]]
}

@test "healthy writer-emitted row still records review_flag=false" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' \
    'confidence: high' 'summary: tidied the imports')"
  run_hook
  [[ "$(spooled_field attribution_source)" == "hook-input" ]] \
    && [[ "$(spooled_field review_flag)" == "false" ]]
}

# ---------------------------------------------------------------------------
# regression pins — the pre-existing branches keep their semantics
# ---------------------------------------------------------------------------

@test "polar mismatch high+false on a code row still records review_flag=true" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: bug-fix' 'metric_pass: false' \
    'confidence: high' 'style_ref: hooks/track-outcome.sh' 'summary: overconfident code row')"
  run_hook
  [[ "$(spooled_field review_flag)" == "true" ]]
}

@test "polar mismatch low+true still records review_flag=true" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' \
    'confidence: low' 'summary: underconfident row')"
  run_hook
  [[ "$(spooled_field review_flag)" == "true" ]]
}

@test "EMPTY metric_pass on a writer row still records review_flag=true" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' \
    'confidence: medium' 'summary: writer omitted metric_pass')"
  run_hook
  [[ "$(spooled_field metric_pass)" == "" ]] \
    && [[ "$(spooled_field review_flag)" == "true" ]]
}

@test "structural row high+false still records review_flag=false (D1 gate untouched)" {
  write_inline_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: false' \
    'confidence: high' 'summary: no-test-bar row')"
  run_hook
  [[ "$(spooled_field review_flag)" == "false" ]]
}

# ---------------------------------------------------------------------------
# neutrality — the shared negative-hit predicate
# ---------------------------------------------------------------------------

@test "flagged synthesized rows are neutral on the shared negative-hit counter" {
  run env HOOKS_DIR="${HOOKS_DIR}" "${REAL_PY3}" - <<'PY'
import os, sys
sys.path.insert(0, os.environ["HOOKS_DIR"])
try:
    import _pg_learning_dualwrite as pg
except Exception as exc:  # psycopg absent ⇒ nothing to assert against
    print("SKIP %s" % exc)
    raise SystemExit(0)

def row(**kw):
    base = dict(agent="glass-atrium-dev-shell", task_type="feature", result="done",
                review_flag=False, revision_count=0, grader_verdict="",
                attribution_source="")
    base.update(kw)
    return base

# Code arm and structural arm, both provenances: setting the flag must not change the hit tuple.
for task_type in ("feature", "cleanup"):
    for source, result in (("structuredoutput-derived", "done"),
                           ("completion-synthesized", "done_with_concerns")):
        unflagged = pg.negative_signal_hits(
            row(task_type=task_type, attribution_source=source, result=result, review_flag=False))
        flagged = pg.negative_signal_hits(
            row(task_type=task_type, attribution_source=source, result=result, review_flag=True))
        assert unflagged == flagged == (), (task_type, source, unflagged, flagged)

# Narrowness: a genuine writer-flagged code row keeps its hit (no whole-agent signal suppression).
genuine = pg.negative_signal_hits(row(attribution_source="hook-input", review_flag=True))
assert "review_flag=true" in genuine, genuine

# A schema-derived row that genuinely failed still counts — the exclusion is flag-scoped only.
failed = pg.negative_signal_hits(row(attribution_source="structuredoutput-derived",
                                     result="fail", review_flag=True))
assert "result=fail" in failed, failed

# The excluded truncation family is untouched by the widening.
truncated = pg.negative_signal_hits(row(attribution_source="budget-truncation",
                                        result="done_with_concerns", review_flag=False))
assert "result=done_with_concerns" in truncated, truncated
PY
  [ "${status}" -eq 0 ]
}

# ---------------------------------------------------------------------------
# neutrality — the aggregator's database-independent mirror
# ---------------------------------------------------------------------------

@test "flagged schema-derived row stays out of the aggregator failure bucket" {
  run env HOOKS_DIR="${HOOKS_DIR}" "${REAL_PY3}" - <<'PY'
import importlib.util, os, sys
hooks = os.environ["HOOKS_DIR"]
sys.path.insert(0, hooks)
spec = importlib.util.spec_from_file_location(
    "learning_aggregator", os.path.join(hooks, "learning-aggregator.py"))
agg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agg)

def row(**kw):
    base = dict(agent="glass-atrium-dev-shell", task_type="feature", result="done",
                metric_pass=True, confidence="high", lesson="x", review_flag=False,
                revision_count=0, grader_verdict="", attribution_source="")
    base.update(kw)
    return base

schema_derived = row(attribution_source="structuredoutput-derived", review_flag=True)
assert agg._record_is_negative(schema_derived) is False, schema_derived
assert agg.classify_lesson_bucket(schema_derived) != "epm"

# Narrowness pin: a genuine writer-flagged row still routes to failure memory.
genuine = row(attribution_source="hook-input", review_flag=True)
assert agg._record_is_negative(genuine) is True, genuine
assert agg.classify_lesson_bucket(genuine) == "epm"
PY
  [ "${status}" -eq 0 ]
}
