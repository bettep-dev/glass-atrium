#!/usr/bin/env bats
# track-outcome-transcript-source.bats — T3 regression/smoke test for the transcript-source
# [COMPLETION] parse (track-outcome.sh).
#
# Root cause pinned: recent Claude Code (2.1.199+) dropped `last_assistant_message` from the
# SubagentStop payload. track-outcome.sh previously sourced the [COMPLETION] block ONLY from
# that field, so every completion fell through to parse_tier=3 → conversation-only skip → 0
# core.outcomes rows. The fix sources the block + the tool_use count from the subagent's OWN
# transcript (agent-<id>.jsonl) via _resolve_subagent_transcript().
#
# This suite drives the REAL hook with a synthetic SubagentStop whose payload LACKS
# last_assistant_message but whose subagent transcript ends with a real [COMPLETION] block,
# and asserts EXACTLY ONE core.outcomes row is written — proving the transcript-source path and
# catching future payload-contract drift.
#
# Isolation: HOME is sandboxed so the transcript resolution (~/.claude/projects/...), the diag
# log, and the PG helper path (${HOME}/.claude/hooks/_pg_outcome_dualwrite.py) are redirected
# into the test temp dir. A copy of the real PG helper is placed there. psycopg lives in the
# user site-packages (HOME-dependent), so PYTHONPATH is pinned to the real install and passed
# into the sandboxed hook env. A UNIQUE per-run agent name scopes the count assertion + the
# teardown DELETE so the shared glass_atrium DB is never polluted.

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
  # DB must be reachable — otherwise the smoke assertion cannot run.
  PYTHONPATH="${PSYCOPG_PP}" python3 -c \
    'import psycopg; psycopg.connect("dbname=glass_atrium", connect_timeout=2).close()' \
    >/dev/null 2>&1 || skip "glass_atrium DB not reachable"

  TS_TMP="$(mktemp -d)"
  # Unique per-run agent + agent_id — scopes both the row-count assertion and the DELETE.
  UNIQUE_AGENT="smoke-ts-$$-${RANDOM}"
  AGENT_ID="tsagent${$}x${RANDOM}"
  SESSION_ID="sess-ts-$$-${RANDOM}"

  SANDBOX_HOME="${TS_TMP}/home"
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

  PAYLOAD_FILE="${TS_TMP}/payload.json"
}

teardown() {
  # Delete the test row(s) + any FK signals for the unique agent, then drop the temp dir.
  if [[ -n "${UNIQUE_AGENT:-}" && -n "${PSYCOPG_PP:-}" ]]; then
    TS_AGENT="${UNIQUE_AGENT}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY' >/dev/null 2>&1 || true
import os, psycopg
agent = os.environ.get("TS_AGENT", "")
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
  # (TS_TMP unset) makes this final statement teardown's non-zero exit → bats turns
  # the clean skip into `not ok`.
  if [[ -n "${TS_TMP:-}" && -d "${TS_TMP}" ]]; then
    rm -rf "${TS_TMP}"
  fi
}

# Write the synthetic subagent transcript: delegation(user) → assistant text → assistant
# tool_use → user tool_result → terminal assistant text carrying a REAL [COMPLETION] block.
write_transcript() {
  python3 - "${TRANSCRIPT}" "${UNIQUE_AGENT}" <<'PY'
import json, sys
path, agent = sys.argv[1], sys.argv[2]
completion = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: bug-fix\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: transcript-source smoke for {agent}\n"
    "lesson: source [COMPLETION] from the subagent transcript, not last_assistant_message\n"
    "files: /tmp/x/y.sh\n"
    "[/COMPLETION]"
)
rows = [
    {"type": "user", "message": {"role": "user", "content": "do the outcome fix"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "Working on it."}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "/tmp/x/y.sh"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# SubagentStop payload WITHOUT last_assistant_message and WITHOUT inline messages — the exact
# CC 2.1.199+ shape that regressed. transcript_path points at a (nonexistent) PARENT.
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
  TS_AGENT="${UNIQUE_AGENT}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
agent = os.environ["TS_AGENT"]
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.outcomes WHERE agent=%s", (agent,))
        print(cur.fetchone()[0])
PY
}

# Fetch a single scalar column for the (single) row of the unique agent.
fetch_col() {
  TS_AGENT="${UNIQUE_AGENT}" TS_COL="${1}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
agent, col = os.environ["TS_AGENT"], os.environ["TS_COL"]
allowed = {"result", "task_type", "attribution_source", "metric_pass", "confidence"}
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
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "SubagentStop without last_assistant_message: transcript-source parse writes EXACTLY ONE core.outcomes row" {
  write_transcript
  write_payload

  # Pre-condition: no pre-existing row for this unique agent.
  run count_rows
  [ "${status}" -eq 0 ]
  [ "${output}" = "0" ]

  run_hook
  [ "${status}" -eq 0 ]
  # The transcript-source fallback must have fired and the block parsed as tier 1.
  [[ "${output}" == *"msg sourced from transcript fallback"* ]]
  [[ "${output}" == *"parse_tier=1"* ]]
  # It must NOT have hit the conversation-only skip / loud-fail path.
  [[ "${output}" != *"conversation-only"* ]]
  [[ "${output}" != *"LOUD-FAIL"* ]]
  # The PG helper must report a successful insert.
  [[ "${output}" == *"pg_insert=ok"* ]]

  # Exactly one row landed.
  run count_rows
  [ "${status}" -eq 0 ]
  [ "${output}" = "1" ]

  # And it carries the [COMPLETION]-sourced fields (not a synthesized fallback).
  run fetch_col result
  [ "${output}" = "done" ]
  run fetch_col task_type
  [ "${output}" = "bug-fix" ]
  run fetch_col attribution_source
  [ "${output}" = "hook-input" ]
}
