#!/usr/bin/env bats
# track-outcome-so-completion-block.bats — P1 schema-mode WRITER recovery: the recorder pulls a
# valid [COMPLETION] block from the terminal StructuredOutput input's completion_block string
# property and records the run as WRITER-emitted (attribution structuredoutput-completion), not
# synthesized.
#
# Contract pinned (the fix, characterization-first):
#  VALID   — a terminal consumed StructuredOutput whose input carries a completion_block string with
#            a well-formed multi-line [COMPLETION] block (>=1 core field + a whitelisted result) is
#            PROMOTED to parse_tier=1 → writer fields recorded verbatim + attribution
#            structuredoutput-completion (a healthy row, downgrade_origin NOT synthesized).
#  GARBAGE — a completion_block carrying prose with no core field does NOT promote → parse_tier stays
#            3 → structuredoutput-derived synthesis, byte-identical to the no-block path (today).
#  BADRESULT — a completion_block whose result token is NOT whitelisted (e.g. "finished") does NOT
#            promote → structuredoutput-derived (the same LLM-trust gate the inline tier applies).
#  ABSENT  — no completion_block on the SO input → structuredoutput-derived (the T3 control; the fix
#            changes NOTHING when the field is absent).
#
# The stderr-channel cases (tagged [stderr]) run DB-free: PG is fail-opened via PGHOST and the
# attribution decision is read off the diagnostic channel (computed BEFORE the PG INSERT), so the
# regression holds even where the live CHECK is not yet widened to the 11th token. Only the DB-row
# case (recovered VALUES reach core.outcomes) needs the live DB AND the widened CHECK → it self-skips
# until the ALTER lands (orchestrator deploy step), mirroring schema-mode-completion.bats.
#
# Isolation mirrors track-outcome-schema-mode-completion.bats exactly: HOME is sandboxed so the
# transcript resolution + diag log stay in the tmp dir; a UNIQUE per-run agent scopes the row
# assertions + the teardown DELETE so the shared glass_atrium DB is never polluted.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"
PG_HELPER_SRC="${HOOKS_DIR}/_pg_outcome_dualwrite.py"

setup_file() {
  command -v python3 >/dev/null 2>&1 || return 0
  PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  export PSYCOPG_PP
  DB_OK=0
  if [[ -n "${PSYCOPG_PP}" ]] && PYTHONPATH="${PSYCOPG_PP}" python3 -c \
      'import psycopg; psycopg.connect("dbname=glass_atrium", connect_timeout=2).close()' \
      >/dev/null 2>&1; then
    DB_OK=1
  fi
  export DB_OK
}

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  [[ -f "${PG_HELPER_SRC}" ]] || skip "_pg_outcome_dualwrite.py not found: ${PG_HELPER_SRC}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  CB_TMP="$(mktemp -d)"
  UNIQUE_AGENT="smoke-cb-$$-${RANDOM}"
  AGENT_ID="cbagent${$}x${RANDOM}"
  SESSION_ID="sess-cb-$$-${RANDOM}"

  SANDBOX_HOME="${CB_TMP}/home"
  # Project slug derived from the runtime HOME (the resolver globs projects/*/, any slug works) —
  # a hardcoded literal would be PII in the tracked tree (pii-scan gate).
  PROJ_SLUG="${HOME//\//-}"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/${PROJ_SLUG}/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.glass-atrium/logs"
  TRANSCRIPT="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"

  PAYLOAD_FILE="${CB_TMP}/payload.json"

  # DB-free stderr cases stop here so the psycopg/DB probe below never skips them (the decision
  # rides the stderr channel — no live DB). Mirrors the [inline] early-return in
  # track-outcome-schema-mode-completion.bats.
  case "${BATS_TEST_DESCRIPTION}" in
    *"[stderr]"*) return 0 ;;
  esac

  [[ -n "${PSYCOPG_PP}" ]] || skip "psycopg module not importable"
  [[ "${DB_OK}" == "1" ]] || skip "glass_atrium DB not reachable"
}

teardown() {
  if [[ -n "${UNIQUE_AGENT:-}" && -n "${PSYCOPG_PP:-}" ]]; then
    CB_AGENT="${UNIQUE_AGENT}" CB_CTL="${UNIQUE_AGENT}-ctl" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY' >/dev/null 2>&1 || true
import os, psycopg
agent = os.environ.get("CB_AGENT", "")
ctl = os.environ.get("CB_CTL", "")
if agent:
    with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM core.correction_signals WHERE outcome_id IN "
                "(SELECT id FROM core.outcomes WHERE agent=%s)", (agent,))
            cur.execute("DELETE FROM core.outcomes WHERE agent=%s", (agent,))
            # Secondary loud-fail artifact: when the primary core.outcomes INSERT fails (e.g. the
            # structuredoutput-completion CHECK rejection on a live DB whose constraint is not yet
            # widened), _pg_outcome_dualwrite.py stamps a core.hook_failures row tagged with the
            # outcome payload_ref (cid → agent fallback = UNIQUE_AGENT here, the transcripts carry no
            # cid). Untended those rows accumulate into the 24h Hook Chain WARN. Scope the DELETE to
            # THIS run's payload tag only — never hook-name- or time-window-scoped, which would mask
            # a live fault. Regenerable artifacts, mirroring the outcomes scoped-DELETE above.
            cur.execute("DELETE FROM core.hook_failures WHERE payload_ref=%s", (agent,))
            # The scoped-self-cleanup test seeds a distinctly-tagged CONTROL row (UNIQUE_AGENT-ctl)
            # to prove the suite cleanup is payload-tag-scoped. It is deleted only here, never by the
            # cleanup-under-test — so an interrupted run (before the test's own hf_delete) would
            # orphan it, the exact artifact class this suite eliminates. Sweep it with the same
            # payload-tag-scoped shape as the main DELETE; distinct exact tag, so no collateral hit.
            if ctl:
                cur.execute("DELETE FROM core.hook_failures WHERE payload_ref=%s", (ctl,))
        conn.commit()
PY
  fi
  if [[ -n "${CB_TMP:-}" && -d "${CB_TMP}" ]]; then
    rm -rf "${CB_TMP}"
  fi
}

# Write the synthetic schema-mode subagent transcript. The terminal StructuredOutput carries a
# completion_block variant per mode:
#   valid     — a full well-formed multi-line [COMPLETION] block (promotes → structuredoutput-completion)
#   garbage   — prose, no core field (no promotion → structuredoutput-derived)
#   badresult — a [COMPLETION] block whose result token is not whitelisted (no promotion)
#   absent    — no completion_block key on the SO input (the T3 control)
# The SO pair carries explicit id/tool_use_id — the hook pairs strictly by tool_use_id.
write_transcript_cb() {
  python3 - "${TRANSCRIPT}" "${UNIQUE_AGENT}" "${1}" <<'PY'
import json, sys
path, agent, mode = sys.argv[1], sys.argv[2], sys.argv[3]
valid_block = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: research\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: schema-mode completion_block recovery for {agent}\n"
    "lesson: put the [COMPLETION] block in the SO completion_block field\n"
    "[/COMPLETION]"
)
# concerns-last: the trailing field is `concerns`, so the sentinel-bleed defect (pre-fix) would
# glue ' [/COMPLETION]' onto the concerns VALUE. result done_with_concerns is realistic here.
concerns_last_block = (
    "[COMPLETION]\n"
    "result: done_with_concerns\n"
    "task_type: review\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: concerns-last recovery for {agent}\n"
    "concerns: probe-only synthetic concern for recovery verification\n"
    "[/COMPLETION]"
)
# truncated: writer stopped BEFORE the closing [/COMPLETION] — the last line is a real field.
# The block must still PROMOTE and the last field stay clean (nothing to strip on the tail).
truncated_block = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: research\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: truncated-writer recovery for {agent}\n"
    "lesson: writer truncated before the closing sentinel"
)
SO_ID = "toolu_cb_so01"
so_input = {"done": True, "notes": "schema deliverable"}
if mode == "valid":
    so_input["completion_block"] = valid_block
elif mode == "concerns_last":
    so_input["completion_block"] = concerns_last_block
elif mode == "truncated":
    so_input["completion_block"] = truncated_block
elif mode == "garbage":
    so_input["completion_block"] = "just prose about the run, no [COMPLETION] fields present at all"
elif mode == "badresult":
    so_input["completion_block"] = "[COMPLETION]\nresult: finished\ntask_type: research\n[/COMPLETION]"
# mode == "absent": leave so_input without a completion_block key
structured_call = {"type": "assistant", "message": {"role": "assistant",
    "content": [{"type": "tool_use", "id": SO_ID, "name": "StructuredOutput", "input": so_input}]}}
structured_ok = {"type": "user", "message": {"role": "user",
    "content": [{"type": "tool_result", "tool_use_id": SO_ID, "content": "ok"}]}}
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the schema-mode research"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_cb_bash01", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_cb_bash01", "content": "ok"}]}},
    structured_call,
    structured_ok,
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# RACE fixture: the transcript initially ends with a PARTIAL (unparseable) terminal StructuredOutput
# line — the flush-in-flight shape the up-front parse memoizes (tail_partial=True + NO terminal SO
# visible). It writes a sibling ${TRANSCRIPT}.tail carrying the SO line's suffix + the paired
# tool_result; a caller cats that tail onto the transcript DURING the hook's bounded re-read window,
# reproducing the SubagentStop flush lag. The completion_block rides the SO tool_use INPUT, so the
# recovery hinges on the extraction path consuming the FRESH-read verdict-time block — NOT the stale
# (partial) memo the pre-fix path re-scanned (silent miss). SO_ID matches write_transcript_cb.
write_transcript_cb_race() {
  python3 - "${TRANSCRIPT}" "${TRANSCRIPT}.tail" "${UNIQUE_AGENT}" <<'PY'
import json, sys
path, tail_path, agent = sys.argv[1], sys.argv[2], sys.argv[3]
valid_block = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: research\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: schema-mode completion_block recovery for {agent}\n"
    "lesson: put the [COMPLETION] block in the SO completion_block field\n"
    "[/COMPLETION]"
)
SO_ID = "toolu_cb_so01"
so_input = {"completion_block": valid_block, "done": True, "notes": "schema deliverable"}
structured_call = {"type": "assistant", "message": {"role": "assistant",
    "content": [{"type": "tool_use", "id": SO_ID, "name": "StructuredOutput", "input": so_input}]}}
structured_ok = {"type": "user", "message": {"role": "user",
    "content": [{"type": "tool_result", "tool_use_id": SO_ID, "content": "ok"}]}}
head_rows = [
    {"type": "user", "message": {"role": "user", "content": "run the schema-mode research"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_cb_bash01", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_cb_bash01", "content": "ok"}]}},
]
# The SO call serializes to ONE physical JSON line; split it so the on-disk file initially ends with
# an unparseable partial (no newline) → the fresh re-read must reunite the halves for the block to land.
so_line = json.dumps(structured_call)
split = len(so_line) // 2
with open(path, "w", encoding="utf-8") as f:
    for r in head_rows:
        f.write(json.dumps(r) + "\n")
    f.write(so_line[:split])  # partial trailing line — NO newline
with open(tail_path, "w", encoding="utf-8") as f:
    f.write(so_line[split:] + "\n")            # completes the SO line
    f.write(json.dumps(structured_ok) + "\n")  # + the paired success result
PY
}

# SubagentStop payload WITHOUT last_assistant_message and WITHOUT inline messages — the CC 2.1.199+
# shape. transcript_path points at a nonexistent PARENT so the subagent-transcript resolver is the
# only viable source.
write_payload() {
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

count_rows() {
  CB_AGENT="${UNIQUE_AGENT}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
agent = os.environ["CB_AGENT"]
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.outcomes WHERE agent=%s", (agent,))
        print(cur.fetchone()[0])
PY
}

# core.hook_failures helpers — the secondary loud-fail row carries the outcome payload_ref
# (cid → agent fallback), so this suite's rows are tagged with UNIQUE_AGENT. hf_seed writes a row
# shape-identical to the writer's INSERT so the scoped-DELETE hygiene is pinned without depending
# on the live CHECK-constraint state (which decides whether a real run generates one).
hf_count() {
  CB_REF="${1}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
ref = os.environ["CB_REF"]
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.hook_failures WHERE payload_ref=%s", (ref,))
        print(cur.fetchone()[0])
PY
}

hf_seed() {
  CB_REF="${1}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
ref = os.environ["CB_REF"]
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO core.hook_failures "
            "(failure_ts, hook_name, target_table, error_kind, payload_ref, retry_attempted) "
            "VALUES (now(), 'outcome-record', 'core.outcomes', 'constraint_violation', %s, false)",
            (ref,))
    conn.commit()
PY
}

hf_delete() {
  CB_REF="${1}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
ref = os.environ["CB_REF"]
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM core.hook_failures WHERE payload_ref=%s", (ref,))
    conn.commit()
PY
}

fetch_col() {
  CB_AGENT="${UNIQUE_AGENT}" CB_COL="${1}" PYTHONPATH="${PSYCOPG_PP}" python3 - <<'PY'
import os, psycopg
agent, col = os.environ["CB_AGENT"], os.environ["CB_COL"]
allowed = {"result", "task_type", "attribution_source", "metric_pass", "confidence",
           "summary", "lesson", "concerns", "downgrade_origin"}
assert col in allowed, col
with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT %s FROM core.outcomes WHERE agent=%%s" % col, (agent,))
        row = cur.fetchone()
        print("" if row is None or row[0] is None else row[0])
PY
}

# DB-free stderr driver: PG fail-opened (PGHOST → nonexistent socket), stderr merged into stdout.
run_hook_stderr() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# DB-backed driver: real PG (PYTHONPATH pinned to psycopg) — proves recovered VALUES reach the row.
run_hook_db() {
  run env \
    HOME="${SANDBOX_HOME}" \
    CLAUDE_GATE_INFLIGHT="" \
    PYTHONPATH="${PSYCOPG_PP}" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# bats checks only the LAST command's status, so a bare intermediate [[ ]] is silently ignored.
# oc/no echo a diagnostic + return non-zero so each caller's `|| return 1` aborts AT the failure.
oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# Live-CHECK skip-probe — the VALID DB-row case INSERTs attribution_source =
# 'structuredoutput-completion'; until the live CHECK is widened to the 11-value set (the ALTER is an
# orchestrator deploy step) that INSERT violates the constraint → skip. A missing constraint rejects
# nothing → run.
skip_unless_live_check_allows_completion_token() {
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
    *structuredoutput-completion* | NO_CONSTRAINT) ;;
    *) skip "live CHECK not yet widened to structuredoutput-completion (orchestrator deploy pending)" ;;
  esac
}

@test "[stderr] VALID completion_block → tier-1 promotion + structuredoutput-completion (not synthesized)" {
  write_transcript_cb valid
  write_payload

  run_hook_stderr
  [ "${status}" -eq 0 ] || return 1
  # The writer block was recovered from the SO input and promoted — the run is writer-emitted, NOT
  # synthesized. Each assertion is load-bearing via || return 1 (bats gates only the last command).
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "completion_block recovered from terminal StructuredOutput input (tier-1 promotion)" "${output}" || return 1
  oc "attribution=structuredoutput-completion" "${output}" || return 1
  no "attribution=structuredoutput-derived" "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
  no "synthesize:" "${output}" || return 1
}

@test "[stderr] GARBAGE completion_block (no core field) → structuredoutput-derived (synthesized as today)" {
  write_transcript_cb garbage
  write_payload

  run_hook_stderr
  [ "${status}" -eq 0 ] || return 1
  # No core field → no promotion → byte-identical to the no-block path (structuredoutput-derived).
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "attribution=structuredoutput-derived" "${output}" || return 1
  no "attribution=structuredoutput-completion" "${output}" || return 1
  no "tier-1 promotion" "${output}" || return 1
}

@test "[stderr] BADRESULT completion_block (non-whitelisted result) → structuredoutput-derived" {
  write_transcript_cb badresult
  write_payload

  run_hook_stderr
  [ "${status}" -eq 0 ] || return 1
  # 'finished' is not a whitelisted result → the same LLM-trust gate the inline tier applies rejects
  # the promotion → structuredoutput-derived (no writer promotion on an invalid result token).
  oc "attribution=structuredoutput-derived" "${output}" || return 1
  no "attribution=structuredoutput-completion" "${output}" || return 1
  no "tier-1 promotion" "${output}" || return 1
}

@test "[stderr] ABSENT completion_block → structuredoutput-derived (control — fix changes nothing)" {
  write_transcript_cb absent
  write_payload

  run_hook_stderr
  [ "${status}" -eq 0 ] || return 1
  # The T3 control: no completion_block on the SO input → the pre-fix synthesis path is unchanged.
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "attribution=structuredoutput-derived" "${output}" || return 1
  no "attribution=structuredoutput-completion" "${output}" || return 1
  no "tier-1 promotion" "${output}" || return 1
}

@test "VALID completion_block recovery lands writer VALUES in core.outcomes (structuredoutput-completion)" {
  # DB-backed — proves the recovered result/confidence/metric_pass/attribution reach the row (the
  # stderr channel exposes only the decision, not the persisted values). Gated on the live CHECK
  # carrying the 11th token (the INSERT writes it).
  write_transcript_cb valid
  write_payload

  run count_rows
  [ "${status}" -eq 0 ]
  [ "${output}" = "0" ]

  run_hook_db
  [ "${status}" -eq 0 ] || return 1
  oc "attribution=structuredoutput-completion" "${output}" || return 1

  skip_unless_live_check_allows_completion_token
  run count_rows
  [ "${output}" = "1" ]
  # Writer-claimed fields recorded verbatim from the recovered block.
  run fetch_col result
  [ "${output}" = "done" ]
  run fetch_col confidence
  [ "${output}" = "high" ]
  run fetch_col task_type
  [ "${output}" = "research" ]
  run fetch_col metric_pass
  [[ "${output}" == "True" || "${output}" == "t" ]]
  run fetch_col attribution_source
  [ "${output}" = "structuredoutput-completion" ]
  # Writer-emitted (recovered), so the provenance is NOT synthesized.
  run fetch_col downgrade_origin
  [ "${output}" != "synthesized" ]
  # The writer's own summary (no '[synthesized]' prefix) + lesson survive the recovery.
  run fetch_col summary
  [[ "${output}" == *"schema-mode completion_block recovery for ${UNIQUE_AGENT}"* ]]
  [[ "${output}" != "[synthesized]"* ]]
  # lesson is the LAST field before [/COMPLETION] — the sentinel-bleed regression: it must land
  # verbatim with NO trailing '[/COMPLETION]' and NO trailing whitespace (a loose *contains* check
  # would pass even while contaminated, so assert the exact recovered value).
  run fetch_col lesson
  [ "${output}" = "put the [COMPLETION] block in the SO completion_block field" ]
}

@test "lesson-last block: recovered lesson is clean — no trailing [/COMPLETION], no trailing whitespace" {
  # Regression for the SO-input sentinel bleed: the closing [/COMPLETION] (a colon-less line) used to
  # fold into the last field (lesson) as a continuation. The block-level strip removes it pre-parse.
  write_transcript_cb valid
  write_payload

  run_hook_db
  [ "${status}" -eq 0 ] || return 1
  oc "attribution=structuredoutput-completion" "${output}" || return 1

  skip_unless_live_check_allows_completion_token
  run fetch_col lesson
  # Exact match ⇒ no sentinel bleed AND no trailing whitespace.
  [ "${output}" = "put the [COMPLETION] block in the SO completion_block field" ] || return 1
  case "${output}" in *"[/COMPLETION]"*) return 1 ;; esac
}

@test "concerns-last block: recovered concerns is clean (field-agnostic strip, not lesson-only)" {
  # Proves the fix is BLOCK-level, not lesson-specific: when concerns is the trailing field, it too
  # must land without the sentinel. Pre-fix this recovered 'probe-only ... verification [/COMPLETION]'.
  write_transcript_cb concerns_last
  write_payload

  run_hook_db
  [ "${status}" -eq 0 ] || return 1
  oc "attribution=structuredoutput-completion" "${output}" || return 1
  oc "completion_block recovered from terminal StructuredOutput input (tier-1 promotion)" "${output}" || return 1

  skip_unless_live_check_allows_completion_token
  # concerns is a text[] column → fetch_col prints the psycopg list repr. An exact match pins the
  # single clean element (a bled ' [/COMPLETION]' would change the repr), and the case guard states
  # the sentinel-absence intent explicitly.
  run fetch_col concerns
  [ "${output}" = "['probe-only synthetic concern for recovery verification']" ] || return 1
  case "${output}" in *"[/COMPLETION]"*) return 1 ;; esac
  run fetch_col result
  [ "${output}" = "done_with_concerns" ] || return 1
}

@test "block WITHOUT closing sentinel (writer truncation): still promotes + last field clean" {
  # The strip tolerates a MISSING closer: the last line is a real field (lesson), so nothing is
  # stripped off the tail and the block still promotes to writer tier-1.
  write_transcript_cb truncated
  write_payload

  run_hook_db
  [ "${status}" -eq 0 ] || return 1
  # Still promotes (DB-free assertion): a missing [/COMPLETION] does not block recovery.
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "completion_block recovered from terminal StructuredOutput input (tier-1 promotion)" "${output}" || return 1
  oc "attribution=structuredoutput-completion" "${output}" || return 1
  no "attribution=structuredoutput-derived" "${output}" || return 1

  skip_unless_live_check_allows_completion_token
  run fetch_col lesson
  [ "${output}" = "writer truncated before the closing sentinel" ] || return 1
  case "${output}" in *"[/COMPLETION]"*) return 1 ;; esac
  run fetch_col result
  [ "${output}" = "done" ] || return 1
}

@test "RACE: terminal SO partial in the memo read, settles on the fresh re-read ⇒ completion_block recovery still lands" {
  # The transcript starts with a PARTIAL terminal SO line on disk (flush in flight) — the up-front
  # parse memoizes tail_partial=True + NO terminal SO. A background writer completes the SO line +
  # appends the paired result ~250ms in, INSIDE the hook's 3×200ms re-read window. Pre-fix the
  # extraction path re-read the STALE (partial) memo → the block was absent there → silent miss →
  # structuredoutput-derived. The fix captures the block on the SAME fresh snapshot the verdict
  # settles on, so the recovery lands (structuredoutput-completion + writer values).
  write_transcript_cb_race
  write_payload
  (
    sleep 0.25
    cat "${TRANSCRIPT}.tail" >>"${TRANSCRIPT}"
  ) &
  local appender_pid=$!

  run_hook_db
  wait "${appender_pid}" 2>/dev/null || true
  [ "${status}" -eq 0 ] || return 1
  # DB-free rescue regression (unconditional — computed BEFORE the PG INSERT): the fresh re-read
  # settled the terminal SO AND its completion_block, so the writer block is promoted, not synthesized.
  oc "terminal_structuredoutput=1" "${output}" || return 1
  oc "completion_block recovered from terminal StructuredOutput input (tier-1 promotion)" "${output}" || return 1
  oc "attribution=structuredoutput-completion" "${output}" || return 1
  no "attribution=structuredoutput-derived" "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1

  # Gate the DB-row value assertions on the live CHECK (the INSERT writes the 11th token).
  skip_unless_live_check_allows_completion_token
  run count_rows
  [ "${output}" = "1" ] || return 1
  # Writer-claimed fields recovered through the race land verbatim.
  run fetch_col result
  [ "${output}" = "done" ] || return 1
  run fetch_col confidence
  [ "${output}" = "high" ] || return 1
  run fetch_col task_type
  [ "${output}" = "research" ] || return 1
  run fetch_col attribution_source
  [ "${output}" = "structuredoutput-completion" ] || return 1
  run fetch_col downgrade_origin
  [ "${output}" != "synthesized" ] || return 1
}

@test "hook_failures secondary rows: scoped self-cleanup deletes ONLY the suite's payload tag" {
  # Root cause of the 24h Hook Chain WARN: the loud-fail dual-write writer stamps a core.hook_failures
  # row on a primary core.outcomes INSERT failure (the structuredoutput-completion CHECK rejection when
  # the live constraint is not yet widened), tagged with the outcome payload_ref (cid → agent). Those
  # rows share UNIQUE_AGENT and, untended by the pre-fix teardown (outcomes/correction_signals only),
  # accumulated into the WARN aggregate. Pin the scoped-DELETE hygiene deterministically (no dependence
  # on the live CHECK state): a tagged row + a distinctly-tagged control row → the scoped cleanup zeroes
  # ONLY the suite's tag and leaves the control intact (never hook-name- or time-window-scoped).
  # The control tag is derived from UNIQUE_AGENT (a distinct exact tag, not a prefix of it) so
  # teardown() sweeps it on an interrupted run — the cleanup-under-test (exact WHERE payload_ref =
  # UNIQUE_AGENT) still never touches it, preserving the "other tags survive" proof.
  local control_ref="${UNIQUE_AGENT}-ctl"

  hf_seed "${UNIQUE_AGENT}"
  hf_seed "${control_ref}"

  run hf_count "${UNIQUE_AGENT}"
  [ "${output}" = "1" ] || { echo "seed failed: own tag count ${output} != 1"; hf_delete "${control_ref}"; return 1; }

  # The exact scoped DELETE the teardown runs (WHERE payload_ref = UNIQUE_AGENT).
  hf_delete "${UNIQUE_AGENT}"

  run hf_count "${UNIQUE_AGENT}"
  [ "${output}" = "0" ] || { echo "own tag not zeroed post-cleanup: ${output}"; hf_delete "${control_ref}"; return 1; }
  # Other rows untouched — proves the cleanup is payload-tag-scoped, not a blanket smoke-cb/time purge.
  run hf_count "${control_ref}"
  [ "${output}" = "1" ] || { echo "control row collaterally deleted (scope too broad): ${output}"; hf_delete "${control_ref}"; return 1; }

  hf_delete "${control_ref}"
}
