#!/usr/bin/env bats
# track-outcome-schema-mode-completion.bats — parser guarantee for schema-mode (ultracode
# Workflow / StructuredOutput) agents (track-outcome.sh).
#
# Contract pinned (R3 "print-block-then-emit"): a schema-mode agent terminates its run on a
# StructuredOutput tool call — the engine consumes ONLY that tool call, so no terminal assistant
# text follows it. _last_assistant_text_from_transcript() scans the WHOLE transcript in reverse,
# PREFERRING the last assistant *text* entry containing '[COMPLETION]' over the last text of any
# kind — so a [COMPLETION] block printed as a dedicated assistant TEXT turn immediately BEFORE the
# StructuredOutput call is honored (the trailing tool_use entry does not shadow it).
#
# T1 block-then-emit → structured path (result/confidence from the writer, attribution hook-input)
# T2 marker-preference → a trailing non-marker assistant text after the StructuredOutput
#    tool_result must NOT shadow the [COMPLETION]-bearing turn
# T3 regression guard → NO [COMPLETION] anywhere + terminal StructuredOutput keeps the current
#    synthesis behavior (done_with_concerns + completion-synthesized + '[synthesized]' concerns)
#    — the hook must NOT silently start treating StructuredOutput as done
# T4 precedence guard → same as T3 with the per-agent tool-budget counter at budget ⇒
#    budget-truncation wins the discriminator (ordering intact)
#
# Isolation: HOME is sandboxed so the transcript resolution (~/.claude/projects/...), the diag
# log, and the PG helper path (${HOME}/.claude/hooks/_pg_outcome_dualwrite.py) are redirected
# into the test temp dir. A copy of the real PG helper is placed there. psycopg lives in the
# user site-packages (HOME-dependent), so PYTHONPATH is pinned to the real install and passed
# into the sandboxed hook env. A UNIQUE per-run agent name scopes the count assertion + the
# teardown DELETE so the shared glass_atrium DB is never polluted. The tool-budget counter dir
# is redirected into the temp dir (counter absent ⇒ fail-open, only T4 seeds it).

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"
PG_HELPER_SRC="${HOOKS_DIR}/_pg_outcome_dualwrite.py"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  [[ -f "${PG_HELPER_SRC}" ]] || skip "_pg_outcome_dualwrite.py not found: ${PG_HELPER_SRC}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  # psycopg site-packages dir (HOME-dependent user install) — pin it for the sandboxed hook.
  PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  [[ -n "${PSYCOPG_PP}" ]] || skip "psycopg module not importable"
  # DB must be reachable — otherwise the row assertions cannot run.
  PYTHONPATH="${PSYCOPG_PP}" python3 -c \
    'import psycopg; psycopg.connect("dbname=glass_atrium", connect_timeout=2).close()' \
    >/dev/null 2>&1 || skip "glass_atrium DB not reachable"

  SM_TMP="$(mktemp -d)"
  # Unique per-run agent + agent_id — scopes both the row assertions and the DELETE.
  UNIQUE_AGENT="smoke-sm-$$-${RANDOM}"
  # All chars path-safe ⇒ hook_path_safe_key is an identity transform ⇒ counter file basename.
  AGENT_ID="smagent${$}x${RANDOM}"
  SESSION_ID="sess-sm-$$-${RANDOM}"

  SANDBOX_HOME="${SM_TMP}/home"
  # Subagent transcript at the exact path _resolve_subagent_transcript() globs.
  # Project-dir slug derived from the runtime HOME (the resolver globs projects/*/,
  # so any slug works) — a hardcoded literal would be PII in the tracked tree (pii-scan gate).
  PROJ_SLUG="${HOME//\//-}"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/${PROJ_SLUG}/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs" "${SANDBOX_HOME}/.claude/hooks"
  TRANSCRIPT="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"

  # Copy the real PG helper into the sandbox HOME (the hook resolves it HOME-relative).
  cp "${PG_HELPER_SRC}" "${SANDBOX_HOME}/.claude/hooks/_pg_outcome_dualwrite.py"
  chmod +x "${SANDBOX_HOME}/.claude/hooks/_pg_outcome_dualwrite.py"

  BUDGET_DIR="${SM_TMP}/agent-tool-budget"
  mkdir -p "${BUDGET_DIR}"
  COUNTER_FILE="${BUDGET_DIR}/${AGENT_ID}"

  PAYLOAD_FILE="${SM_TMP}/payload.json"
}

teardown() {
  # Delete the test row(s) + any FK signals for the unique agent, then drop the temp dir.
  if [[ -n "${UNIQUE_AGENT:-}" && -n "${PSYCOPG_PP:-}" ]]; then
    SM_AGENT="${UNIQUE_AGENT}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY' >/dev/null 2>&1 || true
import os, psycopg
agent = os.environ.get("SM_AGENT", "")
if agent:
    with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM core.correction_signals WHERE outcome_id IN "
                "(SELECT id FROM core.outcomes WHERE agent=%s)", (agent,))
            cur.execute("DELETE FROM core.outcomes WHERE agent=%s", (agent,))
        conn.commit()
PY
  fi
  # `if` (not `[[ ]] && cmd`) so a false guard returns 0 — otherwise a setup-skip
  # (SM_TMP unset) makes this final statement teardown's non-zero exit → bats turns
  # the clean skip into `not ok`.
  if [[ -n "${SM_TMP:-}" && -d "${SM_TMP}" ]]; then
    rm -rf "${SM_TMP}"
  fi
}

# Write the synthetic schema-mode subagent transcript. Mode selects the fixture shape:
#   block-then-emit — user → assistant tool_use Bash → tool_result → assistant TEXT carrying a
#                     full [COMPLETION] block → assistant tool_use StructuredOutput →
#                     tool_result success (the R3 contract shape)
#   trailing-text   — block-then-emit + a LATER assistant text WITHOUT a [COMPLETION] marker
#                     after the StructuredOutput tool_result (marker-preference stressor)
#   no-block        — NO [COMPLETION] anywhere; terminal StructuredOutput (regression fixture)
write_transcript() {
  python3 - "${TRANSCRIPT}" "${UNIQUE_AGENT}" "${1}" <<'PY'
import json, sys
path, agent, mode = sys.argv[1], sys.argv[2], sys.argv[3]
completion = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: research\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: schema-mode block-then-emit for {agent}\n"
    "lesson: print the [COMPLETION] text turn BEFORE the StructuredOutput call\n"
    "[/COMPLETION]"
)
structured_call = {"type": "assistant", "message": {"role": "assistant",
    "content": [{"type": "tool_use", "name": "StructuredOutput",
                 "input": {"done": True, "notes": "schema deliverable"}}]}}
structured_ok = {"type": "user", "message": {"role": "user",
    "content": [{"type": "tool_result", "content": "ok"}]}}
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the schema-mode research"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "Analyzing the corpus."}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "ok"}]}},
]
if mode in ("block-then-emit", "trailing-text"):
    rows.append({"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}})
rows.append(structured_call)
rows.append(structured_ok)
if mode == "trailing-text":
    rows.append({"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "Emitted the structured result."}]}})
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# SubagentStop payload WITHOUT last_assistant_message and WITHOUT inline messages — the exact
# CC 2.1.199+ shape. transcript_path points at a (nonexistent) PARENT so the subagent-transcript
# resolver is the only viable source.
write_payload() {
  # cwd derived from the runtime HOME — a hardcoded path literal would be PII
  # in the tracked tree (pii-scan gate). The value only shapes the project-dir
  # slug the hook derives; any real absolute path is behavior-identical.
  jq -nc \
    --arg aid "${AGENT_ID}" \
    --arg sess "${SESSION_ID}" \
    --arg agent "${UNIQUE_AGENT}" \
    --arg cwd "${HOME}" \
    '{
      hook_event_name: "SubagentStop",
      agent_type: $agent,
      agent_id: $aid,
      session_id: $sess,
      cwd: $cwd,
      transcript_path: "/nonexistent/parent.jsonl"
    }' >"${PAYLOAD_FILE}"
}

# core.outcomes row count for the unique agent.
count_rows() {
  SM_AGENT="${UNIQUE_AGENT}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
agent = os.environ["SM_AGENT"]
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.outcomes WHERE agent=%s", (agent,))
        print(cur.fetchone()[0])
PY
}

# Fetch a single scalar column for the (single) row of the unique agent. NULL ⇒ ''.
fetch_col() {
  SM_AGENT="${UNIQUE_AGENT}" SM_COL="${1}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
agent, col = os.environ["SM_AGENT"], os.environ["SM_COL"]
allowed = {"result", "task_type", "attribution_source", "metric_pass", "confidence",
           "summary", "concerns", "downgrade_origin"}
assert col in allowed, col
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT %s FROM core.outcomes WHERE agent=%%s" % col, (agent,))
        row = cur.fetchone()
        print("" if row is None or row[0] is None else row[0])
PY
}

run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    CLAUDE_GATE_INFLIGHT="" \
    PYTHONPATH="${PSYCOPG_PP}" \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_TOOL_BUDGET="${SUBAGENT_TOOL_BUDGET:-40}" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "T1 block-then-emit: [COMPLETION] text turn before StructuredOutput is honored (structured path)" {
  write_transcript block-then-emit
  write_payload

  # Pre-condition: no pre-existing row for this unique agent.
  run count_rows
  [ "${status}" -eq 0 ]
  [ "${output}" = "0" ]

  run_hook
  [ "${status}" -eq 0 ]
  # Transcript-source fallback fired and the block parsed as tier 1 — NOT the synthesis branch.
  [[ "${output}" == *"msg sourced from transcript fallback"* ]]
  [[ "${output}" == *"parse_tier=1"* ]]
  [[ "${output}" != *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=budget-truncation"* ]]
  [[ "${output}" == *"pg_insert=ok"* ]]

  run count_rows
  [ "${status}" -eq 0 ]
  [ "${output}" = "1" ]

  # Writer-claimed fields recorded verbatim (the trailing StructuredOutput did not shadow them).
  run fetch_col result
  [ "${output}" = "done" ]
  run fetch_col confidence
  [ "${output}" = "high" ]
  run fetch_col task_type
  [ "${output}" = "research" ]
  run fetch_col attribution_source
  [ "${output}" = "hook-input" ]
  # Summary is the writer's own — no '[synthesized]' prefix.
  run fetch_col summary
  [[ "${output}" == *"schema-mode block-then-emit for ${UNIQUE_AGENT}"* ]]
  [[ "${output}" != "[synthesized]"* ]]
  # Structured row ⇒ downgrade provenance is NOT 'synthesized'.
  run fetch_col downgrade_origin
  [ "${output}" != "synthesized" ]
}

@test "T2 marker-preference: trailing non-marker assistant text after StructuredOutput does not shadow the block" {
  write_transcript trailing-text
  write_payload

  run_hook
  [ "${status}" -eq 0 ]
  # If the reverse scan had picked the LAST text ('Emitted the structured result.'), the parse
  # would miss the block and fall to synthesis — tier-1 + done pins the marker preference.
  [[ "${output}" == *"parse_tier=1"* ]]
  [[ "${output}" != *"attribution=completion-synthesized"* ]]

  run count_rows
  [ "${output}" = "1" ]
  run fetch_col result
  [ "${output}" = "done" ]
  run fetch_col confidence
  [ "${output}" = "high" ]
  run fetch_col attribution_source
  [ "${output}" = "hook-input" ]
  run fetch_col summary
  [[ "${output}" != "[synthesized]"* ]]
}

@test "T3 regression guard: no [COMPLETION] + terminal StructuredOutput stays synthesized (not silently done)" {
  write_transcript no-block
  write_payload

  run_hook
  [ "${status}" -eq 0 ]
  # Synthesis diagnostic fired with the default attribution (counter absent ⇒ fail-open).
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=budget-truncation"* ]]

  run count_rows
  [ "${output}" = "1" ]
  # The by-design conservatism holds: StructuredOutput alone is NOT a completion-equivalent.
  run fetch_col result
  [ "${output}" = "done_with_concerns" ]
  run fetch_col confidence
  [ "${output}" = "low" ]
  run fetch_col attribution_source
  [ "${output}" = "completion-synthesized" ]
  run fetch_col downgrade_origin
  [ "${output}" = "synthesized" ]
  run fetch_col concerns
  [[ "${output}" == *"[synthesized] completed without a [COMPLETION] block"* ]]
  run fetch_col summary
  [[ "${output}" == "[synthesized]"* ]]
}

@test "T4 precedence guard: counter at budget (40) ⇒ budget-truncation wins over completion-synthesized" {
  write_transcript no-block
  write_payload
  printf '%s\n' "40" >"${COUNTER_FILE}"

  run_hook
  [ "${status}" -eq 0 ]
  # Discriminator ordering intact: budget kill labels the row, never clobbered back.
  [[ "${output}" == *"attribution=budget-truncation"* ]]
  [[ "${output}" != *"attribution=completion-synthesized"* ]]

  run count_rows
  [ "${output}" = "1" ]
  run fetch_col attribution_source
  [ "${output}" = "budget-truncation" ]
  run fetch_col result
  [ "${output}" = "done_with_concerns" ]
}
