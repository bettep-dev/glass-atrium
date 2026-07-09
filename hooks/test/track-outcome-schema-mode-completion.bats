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
# T3 R2-positive → NO [COMPLETION] + terminal successfully-consumed StructuredOutput derives
#    done + structuredoutput-derived (low confidence, metric_pass false, own concerns line)
# T4 order flip → counter at budget + consumed StructuredOutput ⇒ structuredoutput-derived wins
#    (direct terminal evidence beats the cumulative >=40 heuristic)
# T5 fallback guard → NO StructuredOutput anywhere pins the old synthesis path
#    (done_with_concerns + completion-synthesized + '[synthesized]' concerns)
# T6 errored SO tool_result → falls through to completion-synthesized (predicate falsifiability)
# T7 rate-limit prose + consumed SO → done (keyword heuristic superseded by the consumed emit)
# T8 tool_use_id pairing → interleaved errored decoy tool_result does not defeat id-pairing
# T9 absent paired tool_result (kill mid-call) → no match, stays completion-synthesized
# T10 budget pin → counter at budget + errored SO ⇒ budget-truncation (heuristic still live)
#
# R2-positive cases (T3/T4/T7/T8) run the DB-free stderr rescue regression UNCONDITIONALLY —
# a terminal_so=1 event LANDS attribution=structuredoutput-derived on the stderr diagnostic
# channel (computed BEFORE the PG INSERT), so the regression holds even in a token-absent CHECK
# env. Only the DB-row assertions (which INSERT the 10th attribution token) are gated behind the
# live-CHECK probe → they self-skip until the live ALTER lands (orchestrator deploy step).
#
# Isolation: HOME is sandboxed so the transcript resolution (~/.claude/projects/...) and the
# diag log are redirected into the test temp dir. The PG helper is resolved by the hook as a
# SIBLING of the script (setup skips when absent). psycopg lives in the
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
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  TRANSCRIPT="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"

  BUDGET_DIR="${SM_TMP}/agent-tool-budget"
  mkdir -p "${BUDGET_DIR}"
  COUNTER_FILE="${BUDGET_DIR}/${AGENT_ID}"

  PAYLOAD_FILE="${SM_TMP}/payload.json"

  # DB-free inline-tolerance cases (T4/T5, tagged [inline]) fail-open PG and read the decision off
  # the stderr diagnostic channel — no live DB. They stop here so the psycopg/DB probe below never
  # skips them (mirrors track-outcome-budget-truncation.bats: runs without a live DB). The probe
  # moved AFTER the tmp setup so the [inline] early-return keeps SANDBOX_HOME/PAYLOAD_FILE/BUDGET_DIR.
  case "${BATS_TEST_DESCRIPTION}" in
    *"[inline]"*) return 0 ;;
  esac

  # DB-dependent cases: pin psycopg (HOME-dependent user install) for the sandboxed hook, then
  # require the live DB — the row assertions cannot run without it.
  PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  [[ -n "${PSYCOPG_PP}" ]] || skip "psycopg module not importable"
  PYTHONPATH="${PSYCOPG_PP}" python3 -c \
    'import psycopg; psycopg.connect("dbname=glass_atrium", connect_timeout=2).close()' \
    >/dev/null 2>&1 || skip "glass_atrium DB not reachable"
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
#   block-then-emit    — user → assistant tool_use Bash → tool_result → assistant TEXT carrying
#                        a full [COMPLETION] block → assistant tool_use StructuredOutput →
#                        tool_result success (the R3 contract shape)
#   trailing-text      — block-then-emit + a LATER assistant text WITHOUT a [COMPLETION] marker
#                        after the StructuredOutput tool_result (marker-preference stressor)
#   no-block           — NO [COMPLETION] anywhere; terminal consumed StructuredOutput (R2 shape)
#   no-block-no-so     — NO [COMPLETION] and NO StructuredOutput (true old-synthesis fallback)
#   no-block-so-error  — terminal StructuredOutput whose paired tool_result is is_error:true
#   no-block-ratelimit — rate-limit prose as the final assistant text + consumed terminal SO
#   no-block-decoy     — errored decoy tool_result (foreign tool_use_id) interleaved between the
#                        SO call and its real success result (adjacency-pairing would mis-read)
#   no-block-orphan    — SO call with NO paired tool_result at all (kill mid-call)
# The SO pair carries explicit id/tool_use_id — the hook pairs strictly by tool_use_id (never
# adjacency), so an id-less fixture would no-match and fall back to the old synthesis path.
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
SO_ID = "toolu_sm_so01"
structured_call = {"type": "assistant", "message": {"role": "assistant",
    "content": [{"type": "tool_use", "id": SO_ID, "name": "StructuredOutput",
                 "input": {"done": True, "notes": "schema deliverable"}}]}}
structured_ok = {"type": "user", "message": {"role": "user",
    "content": [{"type": "tool_result", "tool_use_id": SO_ID, "content": "ok"}]}}
structured_err = {"type": "user", "message": {"role": "user",
    "content": [{"type": "tool_result", "tool_use_id": SO_ID, "is_error": True,
                 "content": "schema validation failed"}]}}
decoy_result = {"type": "user", "message": {"role": "user",
    "content": [{"type": "tool_result", "tool_use_id": "toolu_sm_decoy", "is_error": True,
                 "content": "decoy error"}]}}
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the schema-mode research"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "Analyzing the corpus."}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_sm_bash01", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_sm_bash01",
                     "content": "ok"}]}},
]
if mode in ("block-then-emit", "trailing-text"):
    rows.append({"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}})
if mode == "no-block-ratelimit":
    rows.append({"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text",
                     "text": "Sources describe the API rate limit tiers in prose."}]}})
if mode == "no-block-no-so":
    pass  # ends on the Bash tool_result — no StructuredOutput anywhere
elif mode == "no-block-orphan":
    rows.append(structured_call)  # kill mid-call: paired tool_result never arrives
elif mode == "no-block-so-error":
    rows.append(structured_call)
    rows.append(structured_err)
elif mode == "no-block-decoy":
    rows.append(structured_call)
    rows.append(decoy_result)   # adjacency-pairing would read THIS errored foreign result
    rows.append(structured_ok)  # id-pairing finds the real success
else:
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

# Live-constraint skip-probe — R2-positive cases INSERT attribution_source =
# 'structuredoutput-derived' into the live-reachable DB; until the live CHECK is widened to the
# 10-value set (the ALTER is an orchestrator deploy step, not this suite's job) that INSERT
# violates the constraint → skip, mirroring the DB-unreachable skip in setup(). A missing
# constraint rejects nothing → run.
skip_unless_live_check_allows_r2_token() {
  local con_def
  con_def="$(PYTHONPATH="${PSYCOPG_PP}" python3 - 2>/dev/null <<'PY'
import psycopg
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'outcomes_attribution_source_check'")
        row = cur.fetchone()
        print("NO_CONSTRAINT" if row is None else row[0])
PY
)" || con_def=""
  case "${con_def}" in
    *structuredoutput-derived* | NO_CONSTRAINT) ;;
    *) skip "live CHECK not yet widened to structuredoutput-derived (orchestrator deploy pending)" ;;
  esac
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

@test "T3 R2-positive: no [COMPLETION] + terminal consumed StructuredOutput derives done (structuredoutput-derived)" {
  write_transcript no-block
  write_payload

  run_hook
  [ "${status}" -eq 0 ] || return 1
  # DB-free rescue regression (unconditional — survives a token-absent CHECK): the attribution
  # decision rides the stderr diagnostic channel, computed BEFORE the PG INSERT, so a terminal_so=1
  # event LANDS structuredoutput-derived even where the widened token would be rejected by the row
  # INSERT below. This is the portable proof; the DB-row assertions are the extra confirmation.
  # Routed through oc/no (|| return 1) so each is load-bearing regardless of position — a bare
  # intermediate [[ ]] is silently ignored (only the last command sets status), and these run BEFORE
  # the skip gate, so the regression stays enforced even when the live CHECK/token is absent.
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "attribution=structuredoutput-derived" "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
  no "attribution=budget-truncation" "${output}" || return 1

  # Gate ONLY the DB-row assertions on the live CHECK — the INSERT writes the widened token.
  skip_unless_live_check_allows_r2_token
  run count_rows
  [ "${output}" = "1" ]
  # done, but writer-unverified: confidence stays low + the R2 arm's OWN concerns line.
  run fetch_col result
  [ "${output}" = "done" ]
  run fetch_col confidence
  [ "${output}" = "low" ]
  run fetch_col attribution_source
  [ "${output}" = "structuredoutput-derived" ]
  run fetch_col downgrade_origin
  [ "${output}" = "synthesized" ]
  run fetch_col concerns
  [[ "${output}" == *"[synthesized] deliverable was a StructuredOutput tool call"* ]]
  run fetch_col summary
  [[ "${output}" == "[synthesized]"* ]]
}

@test "T4 order flip: counter at budget (40) + consumed StructuredOutput ⇒ structuredoutput-derived wins" {
  write_transcript no-block
  write_payload
  printf '%s\n' "40" >"${COUNTER_FILE}"

  run_hook
  [ "${status}" -eq 0 ] || return 1
  # DB-free rescue regression (unconditional): direct terminal evidence beats the cumulative >=40
  # heuristic on the stderr channel, computed BEFORE the PG INSERT — a hard-kill cannot leave a
  # paired non-error tool_result in terminal position, and successful schema runs routinely sit
  # at/over 40 (the 40-52 band), so structuredoutput-derived (not budget-truncation) must win.
  # Routed through oc/no (|| return 1) so each is load-bearing before the skip gate (bare
  # intermediate [[ ]] is silently ignored — only the last command sets status).
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "attribution=structuredoutput-derived" "${output}" || return 1
  no "attribution=budget-truncation" "${output}" || return 1

  # Gate ONLY the DB-row assertions on the live CHECK — the INSERT writes the widened token.
  skip_unless_live_check_allows_r2_token
  run count_rows
  [ "${output}" = "1" ]
  run fetch_col attribution_source
  [ "${output}" = "structuredoutput-derived" ]
  run fetch_col result
  [ "${output}" = "done" ]
}

@test "T5 fallback guard: no [COMPLETION] + NO StructuredOutput keeps the old synthesis path" {
  write_transcript no-block-no-so
  write_payload

  run_hook
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=structuredoutput-derived"* ]]
  [[ "${output}" != *"attribution=budget-truncation"* ]]

  run count_rows
  [ "${output}" = "1" ]
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

@test "T6 errored StructuredOutput tool_result falls through to completion-synthesized" {
  write_transcript no-block-so-error
  write_payload

  run_hook
  [ "${status}" -eq 0 ]
  # is_error:true = NOT consumed — the predicate must not fire on an errored emit.
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=structuredoutput-derived"* ]]

  run count_rows
  [ "${output}" = "1" ]
  run fetch_col result
  [ "${output}" = "done_with_concerns" ]
}

@test "T7 rate-limit prose + consumed StructuredOutput records done (keyword heuristic superseded)" {
  write_transcript no-block-ratelimit
  write_payload

  run_hook
  [ "${status}" -eq 0 ] || return 1
  # DB-free rescue regression (unconditional): the consumed emit supersedes the rate-limit keyword
  # heuristic on the stderr channel, computed BEFORE the PG INSERT — terminal_so=1 LANDS
  # structuredoutput-derived even in a token-absent CHECK env where the row INSERT below is rejected.
  # Routed through oc (|| return 1) so each is load-bearing before the skip gate (bare intermediate
  # [[ ]] is silently ignored — only the last command sets status).
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "attribution=structuredoutput-derived" "${output}" || return 1

  # Gate ONLY the DB-row assertions on the live CHECK — the INSERT writes the widened token.
  skip_unless_live_check_allows_r2_token
  run count_rows
  [ "${output}" = "1" ]
  # NOT blocked — a successfully consumed emit refutes the rate-limit-cut hypothesis even
  # though the final assistant prose contains 'rate limit'.
  run fetch_col result
  [ "${output}" = "done" ]
}

@test "T8 tool_use_id pairing: interleaved errored decoy tool_result does not defeat id-pairing" {
  write_transcript no-block-decoy
  write_payload

  run_hook
  [ "${status}" -eq 0 ] || return 1
  # DB-free rescue regression (unconditional): adjacency-pairing would read the errored foreign-id
  # decoy → completion-synthesized; strict tool_use_id pairing finds the real success result. This
  # rides the stderr channel, computed BEFORE the PG INSERT, so it survives a token-absent CHECK.
  # Routed through oc (|| return 1) so each is load-bearing before the skip gate (bare intermediate
  # [[ ]] is silently ignored — only the last command sets status).
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "attribution=structuredoutput-derived" "${output}" || return 1

  # Gate ONLY the DB-row assertions on the live CHECK — the INSERT writes the widened token.
  skip_unless_live_check_allows_r2_token
  run count_rows
  [ "${output}" = "1" ]
  run fetch_col result
  [ "${output}" = "done" ]
}

@test "T9 absent paired tool_result (kill mid-call) does not match — stays completion-synthesized" {
  write_transcript no-block-orphan
  write_payload

  run_hook
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"attribution=completion-synthesized"* ]]
  [[ "${output}" != *"attribution=structuredoutput-derived"* ]]

  run count_rows
  [ "${output}" = "1" ]
  run fetch_col result
  [ "${output}" = "done_with_concerns" ]
}

@test "T10 budget pin: counter at budget (40) + errored StructuredOutput ⇒ budget-truncation" {
  write_transcript no-block-so-error
  write_payload
  printf '%s\n' "40" >"${COUNTER_FILE}"

  run_hook
  [ "${status}" -eq 0 ]
  # The heuristic stays live for non-consumed terminals: errored emit + counter at budget.
  [[ "${output}" == *"attribution=budget-truncation"* ]]
  [[ "${output}" != *"attribution=structuredoutput-derived"* ]]
  [[ "${output}" != *"attribution=completion-synthesized"* ]]

  run count_rows
  [ "${output}" = "1" ]
  run fetch_col attribution_source
  [ "${output}" = "budget-truncation" ]
  run fetch_col result
  [ "${output}" = "done_with_concerns" ]
}

# Inline single-line [COMPLETION] tolerance (T4/T5)
#
# Ultracode/workflow schema-mode subagents emit the whole [COMPLETION] block as ONE line —
# tag + delimiter-joined fields, NO newline after the tag, NO [/COMPLETION] close — so _T1/_T2
# (both require a newline right after the tag) miss it → the structured fields would be discarded
# → synthesized done_with_concerns/low/false. The inline matcher runs ONLY after _T1/_T2 miss
# (multi-line precedence unchanged) and recovers the fields into the same field dict, giving the
# complete recovered block tier-1 semantics (so it is never re-labelled truncated_completion).
#
# These cases are DB-free (tagged [inline]): PG is fail-opened via PGHOST and the decision is read
# off the stderr diagnostic channel (the DIAG parse_tier line + the DATA-070 auto-generated record
# marker carrying "result"/"task_type"), mirroring track-outcome-budget-truncation.bats. The closed
# delimiter set is emitted as explicit UTF-8 bytes so the exact codepoint is unambiguous regardless
# of editor encoding. result=done is the distinguishing recovery signal — the synthesis branch can
# only ever produce done_with_concerns (or blocked), never done.

# bats 1.13 checks only the LAST command's status, so a bare intermediate `[[ ]]` assertion is
# silently ignored (a false one never fails the test). oc/no echo a diagnostic + return non-zero
# so each caller's `|| return 1` aborts the test AT the failing assertion. Explicit output arg
# keeps them independent of the `run`-set global.
oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# Emit one inline delimiter by codepoint token (explicit UTF-8 bytes — the closed set from T4/R2).
il_delim() {
  case "${1}" in
    pipe) printf '|' ;;              # U+007C VERTICAL LINE
    middot) printf '\xc2\xb7' ;;     # U+00B7 MIDDLE DOT
    bullet) printf '\xe2\x80\xa2' ;; # U+2022 BULLET
    dotop) printf '\xe2\x8b\x85' ;;  # U+22C5 DOT OPERATOR
  esac
}

# A full inline [COMPLETION] line delimited by the given codepoint token.
il_message() {
  local d
  d="$(il_delim "${1}")"
  printf '[COMPLETION] result: done %s task_type: diagnosis %s metric_pass: true %s confidence: high %s summary: recovered inline block' \
    "${d}" "${d}" "${d}" "${d}"
}

# Build the inline-tolerance SubagentStop payload shared by the two il_run_hook* drivers below.
# $1 = message (last_assistant_message); $2 = agent_type (default qa-debugger, for which
# task_type=diagnosis is on-role so no reclassification masks the recovered value).
il_write_payload() {
  local msg="${1}" agent="${2:-glass-atrium-qa-debugger}"
  jq -nc --arg m "${msg}" --arg agent "${agent}" --arg aid "${AGENT_ID}" --arg sess "${SESSION_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: $agent,
    agent_id: $aid,
    session_id: $sess,
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "run the inline schema-mode work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
}

# DB-free hook driver: inline block in last_assistant_message, PG fail-opened (PGHOST → nonexistent
# socket), stderr merged into stdout. Args forwarded to il_write_payload. The helper does the `run`,
# so callers invoke it directly (not `run il_run_hook`).
il_run_hook() {
  il_write_payload "$@"
  run env \
    HOME="${SANDBOX_HOME}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# DB-backed variant: real PG (no PGHOST override, PYTHONPATH pinned to psycopg) — proves the
# recovered VALUES (metric_pass/confidence) reach the row, which the stderr channel does not expose.
il_run_hook_db() {
  il_write_payload "$@"
  run env \
    HOME="${SANDBOX_HOME}" \
    CLAUDE_GATE_INFLIGHT="" \
    PYTHONPATH="${PSYCOPG_PP}" \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "[inline] pipe (U+007C) delimited real example parses tier-1 (result/task_type recovered, not synthesized)" {
  il_run_hook "$(il_message pipe)"
  [ "${status}" -eq 0 ] || return 1
  # Recovered as a COMPLETE block (tier-1), NOT fallen through to tier-3 keyword inference.
  oc "parse_tier=1" "${output}" || return 1
  no "parse_tier=3" "${output}" || return 1
  # Structured path — the synthesis branch never ran, so it was not relabeled truncated/synthesized.
  no "synthesize:" "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
  # Writer fields recovered: result=done (synthesis would force done_with_concerns) + task_type.
  oc '"result":"done"' "${output}" || return 1
  oc '"task_type":"diagnosis"' "${output}" || return 1
}

@test "[inline] middot (U+00B7) delimiter parses tier-1 (result recovered)" {
  il_run_hook "$(il_message middot)"
  [ "${status}" -eq 0 ] || return 1
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "[inline] bullet (U+2022) delimiter parses tier-1 (result recovered)" {
  il_run_hook "$(il_message bullet)"
  [ "${status}" -eq 0 ] || return 1
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "[inline] dot-operator (U+22C5) delimiter parses tier-1 (result recovered)" {
  il_run_hook "$(il_message dotop)"
  [ "${status}" -eq 0 ] || return 1
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "[inline] summary containing a literal pipe still binds the leading known fields" {
  local d
  d="$(il_delim pipe)"
  local msg
  msg="$(printf '[COMPLETION] result: done %s task_type: diagnosis %s metric_pass: true %s confidence: high %s summary: fixed the parser %s and added a guard' \
    "${d}" "${d}" "${d}" "${d}" "${d}")"
  il_run_hook "${msg}"
  [ "${status}" -eq 0 ] || return 1
  # Greedy left-to-right: the delimiter inside summary does not steal the leading known fields.
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  oc '"task_type":"diagnosis"' "${output}" || return 1
}

@test "[inline] prose mentioning [COMPLETION] off line-start with a stray pipe does NOT match (stays tier-3)" {
  il_run_hook "see [COMPLETION] below | foo"
  [ "${status}" -eq 0 ] || return 1
  # Line-anchor rejects the non-line-start tag → keyword-inference fallback.
  oc "parse_tier=3" "${output}" || return 1
  no "parse_tier=1" "${output}" || return 1
}

@test "[inline] line-anchored [COMPLETION] with NO known field does NOT match (KNOWN_FIELD guard, stays tier-3)" {
  il_run_hook "[COMPLETION] just some prose here | more prose without fields"
  [ "${status}" -eq 0 ] || return 1
  # The line-anchor passes but the >=1-core-field guard rejects prose → tier-3.
  oc "parse_tier=3" "${output}" || return 1
  no "parse_tier=1" "${output}" || return 1
}

@test "[inline] multi-line closed block still parses tier-1 via _T1 (no regression from the inline matcher)" {
  local msg
  msg="$(printf '[COMPLETION]\nresult: done\ntask_type: diagnosis\nmetric_pass: true\nconfidence: high\nsummary: multi-line still wins\n[/COMPLETION]')"
  il_run_hook "${msg}"
  [ "${status}" -eq 0 ] || return 1
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "inline single-line [COMPLETION] full-field recovery lands in core.outcomes (metric_pass/confidence)" {
  # DB-backed (NOT [inline]) — proves the recovered metric_pass=true + confidence=high VALUES reach
  # the row (the stderr channel exposes only result/task_type). attribution stays hook-input
  # (agent_type present) so the row inserts under the original CHECK (no widened-token dependency).
  local d
  d="$(il_delim pipe)"
  local msg
  msg="$(printf '[COMPLETION] result: done %s task_type: diagnosis %s metric_pass: true %s confidence: high %s summary: db-backed inline recovery for %s' \
    "${d}" "${d}" "${d}" "${d}" "${UNIQUE_AGENT}")"

  run count_rows
  [ "${status}" -eq 0 ] || return 1
  [ "${output}" = "0" ] || return 1

  # agent_type = UNIQUE_AGENT so the row lands under the name count_rows/fetch_col query (an unknown
  # agent has the broad dev-style allowlist → task_type=diagnosis stays on-role, not reclassified).
  il_run_hook_db "${msg}" "${UNIQUE_AGENT}"
  [ "${status}" -eq 0 ] || return 1
  oc "parse_tier=1" "${output}" || return 1
  oc "pg_insert=ok" "${output}" || return 1

  run count_rows
  [ "${output}" = "1" ] || return 1
  run fetch_col result
  [ "${output}" = "done" ] || return 1
  run fetch_col task_type
  [ "${output}" = "diagnosis" ] || return 1
  run fetch_col confidence
  [ "${output}" = "high" ] || return 1
  run fetch_col metric_pass
  [[ "${output}" == "True" || "${output}" == "t" ]] || return 1
  run fetch_col attribution_source
  [ "${output}" = "hook-input" ] || return 1
}
