#!/usr/bin/env bats
# track-outcome-db-only-no-md.bats — pins the DB-ONLY outcome-record contract.
#
# Outcome records are now written EXCLUSIVELY to PG core.outcomes via
# _pg_outcome_dualwrite.py; per-outcome .md files under ~/.claude/data/outcomes
# (and cwd-local memory/outcomes) are RETIRED — the recorder must never create
# one. This suite drives the REAL hook with a synthetic SubagentStop and asserts:
#   T1 the DB dual-write helper IS invoked with a well-formed envelope for the run
#      (stub-observed — the helper is shimmed, so no live DB is required), AND
#      NO .md file is created under any historical outcome-record location.
#
# ISOLATION (hermetic, no PostgreSQL): a PATH `python3` shim intercepts ONLY the
# _pg_outcome_dualwrite.py call — capturing its stdin envelope to a marker file
# and exiting 0 — while passing EVERY other python3 call (transcript parse,
# field extraction) through to the real interpreter. HOME is sandboxed so the
# transcript resolver + diag log stay inside the temp dir, and cwd points at the
# sandbox so any cwd-relative write would also land there. T9 correction
# detection is disabled so the run never reaches the DB-backed prior lookup.
#
#   T2 find_prior_revision_count (T9 embedded-python) is a DB-FREE return-0 stub:
#      the extracted function references no psycopg, contains ZERO call nodes (so
#      it cannot reach a DB), and returns 0 for every input. Pins the DB-only
#      contract that the cross-project-unsafe prior lookup was removed — the
#      cross-outcome revision delta now rides the agent-emitted `revision_count`.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"
PG_HELPER_SRC="${HOOKS_DIR}/_pg_outcome_dualwrite.py"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  [[ -x "${PG_HELPER_SRC}" ]] || skip "_pg_outcome_dualwrite.py not executable: ${PG_HELPER_SRC}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  DB_TMP="$(mktemp -d)"
  UNIQUE_AGENT="dbonly-$$-${RANDOM}"
  AGENT_ID="dbaid${$}x${RANDOM}"
  SESSION_ID="sess-db-$$-${RANDOM}"

  SANDBOX_HOME="${DB_TMP}/home"
  # Subagent transcript at the exact path _resolve_subagent_transcript() globs.
  PROJ_SLUG="${SANDBOX_HOME//\//-}"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/${PROJ_SLUG}/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  TRANSCRIPT="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"
  PAYLOAD_FILE="${DB_TMP}/payload.json"

  # DB-write stub marker: the shim writes the helper's stdin envelope here.
  STUB_MARKER="${DB_TMP}/pg_envelope.json"

  # PATH python3 shim — stubs ONLY the dual-write helper, passes all else through.
  SHIM_DIR="${DB_TMP}/bin"
  mkdir -p "${SHIM_DIR}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'for _a in "$@"; do'
    printf '%s\n' '  case "${_a}" in'
    printf '%s\n' "    *_pg_outcome_dualwrite.py) cat >\"${STUB_MARKER}\"; exit 0 ;;"
    printf '%s\n' '  esac'
    printf '%s\n' 'done'
    printf '%s\n' "exec \"${REAL_PY3}\" \"\$@\""
  } >"${SHIM_DIR}/python3"
  chmod +x "${SHIM_DIR}/python3"
}

teardown() {
  if [[ -n "${DB_TMP:-}" && -d "${DB_TMP}" ]]; then
    rm -rf "${DB_TMP}"
  fi
}

# Synthetic subagent transcript ending in a terminal [COMPLETION] block, preceded
# by a tool_use so the turn is not conversation-only. The user text carries NO
# correction keyword (keeps T9 quiescent alongside the explicit disable).
write_transcript() {
  "${REAL_PY3}" - "${TRANSCRIPT}" "${UNIQUE_AGENT}" <<'PY'
import json, sys
path, agent = sys.argv[1], sys.argv[2]
completion = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: review\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: db-only outcome record for {agent}\n"
    "lesson: outcome records are DB-only; no per-outcome .md is written\n"
    "[/COMPLETION]"
)
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the review"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Read", "input": {}}]}},
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

write_payload() {
  jq -nc \
    --arg aid "${AGENT_ID}" \
    --arg sess "${SESSION_ID}" \
    --arg agent "${UNIQUE_AGENT}" \
    --arg cwd "${SANDBOX_HOME}" \
    '{
      hook_event_name: "SubagentStop",
      agent_type: $agent,
      agent_id: $aid,
      session_id: $sess,
      cwd: $cwd,
      transcript_path: "/nonexistent/parent.jsonl"
    }' >"${PAYLOAD_FILE}"
}

run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "DB-only: dual-write helper invoked with a valid envelope AND no .md record is written" {
  write_transcript
  write_payload

  run_hook
  [ "${status}" -eq 0 ] || {
    echo "hook exit ${status}: ${output}"
    return 1
  }

  # The DB dual-write MUST have been invoked (stub captured its stdin envelope).
  [ -s "${STUB_MARKER}" ] || {
    echo "dual-write helper not invoked (no envelope marker)"
    return 1
  }
  # And the envelope must be well-formed JSON carrying THIS run's outcome.
  local got_agent
  got_agent="$("${REAL_PY3}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["outcome"]["agent"])' "${STUB_MARKER}" 2>/dev/null)" || {
    echo "envelope not valid JSON / missing outcome.agent"
    return 1
  }
  [ "${got_agent}" = "${UNIQUE_AGENT}" ] || {
    echo "envelope agent='${got_agent}' != '${UNIQUE_AGENT}'"
    return 1
  }

  # DB-ONLY invariant: the recorder must create ZERO .md files under any historical
  # outcome-record location (sandboxed HOME data/outcomes + cwd memory/outcomes).
  local md_hits
  md_hits="$(find "${SANDBOX_HOME}" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  [ "${md_hits}" = "0" ] || {
    echo "unexpected .md file(s) created under sandbox:"
    find "${SANDBOX_HOME}" -type f -name '*.md'
    return 1
  }
}

@test "find_prior_revision_count is a DB-free return-0 stub (no psycopg, no DB call)" {
  local t9_body driver
  t9_body="${DB_TMP}/t9_body.py"
  driver="${DB_TMP}/pin_stub.py"

  # Extract the T9 embedded-python heredoc body — between the `$T9_PY_FILE` PYEOF
  # markers (the parser heredoc uses PY_SCRIPT_FILE, so it never matches the start).
  awk '
    /T9_PY_FILE.*PYEOF/ { f = 1; next }
    f && /^PYEOF$/       { f = 0; next }
    f                    { print }
  ' "${HOOK_SH}" >"${t9_body}"
  [ -s "${t9_body}" ] || {
    echo "failed to extract T9 embedded-python body"
    return 1
  }

  cat >"${driver}" <<'PY'
import ast, sys
src = open(sys.argv[1], encoding="utf-8").read()
fn = next((n for n in ast.walk(ast.parse(src))
           if isinstance(n, ast.FunctionDef) and n.name == "find_prior_revision_count"), None)
if fn is None:
    print("MISSING_FUNC"); sys.exit(1)
for n in ast.walk(fn):
    if isinstance(n, ast.Import) and any("psycopg" in a.name for a in n.names):
        print("IMPORTS_PSYCOPG"); sys.exit(1)
    if isinstance(n, ast.ImportFrom) and (n.module or "").startswith("psycopg"):
        print("IMPORTS_PSYCOPG"); sys.exit(1)
    if isinstance(n, ast.Name) and n.id == "psycopg":
        print("REFS_PSYCOPG"); sys.exit(1)
    if isinstance(n, ast.Call):  # a return-0 stub cannot call a DB — zero call nodes
        print("HAS_CALL"); sys.exit(1)
seg = ast.get_source_segment(src, fn)
if seg is None:
    print("NO_SEGMENT"); sys.exit(1)
ns = {}
exec(seg, ns)
got = (ns["find_prior_revision_count"]("review"),
       ns["find_prior_revision_count"](""),
       ns["find_prior_revision_count"]("feature", 60))
if got != (0, 0, 0):
    print("NONZERO_RETURN", got); sys.exit(1)
print("OK")
PY

  run "${REAL_PY3}" "${driver}" "${t9_body}"
  [ "${status}" -eq 0 ] || {
    echo "stub pin failed (status ${status}): ${output}"
    return 1
  }
  [ "${output}" = "OK" ] || {
    echo "unexpected pin output: ${output}"
    return 1
  }
}
