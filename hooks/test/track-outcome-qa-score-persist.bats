#!/usr/bin/env bats
# track-outcome-qa-score-persist.bats — pins the qa_score end-to-end persistence
# completed on top of the KNOWN_FIELDS fold-in fix. qa_score (shape
# cov=N,ins=N,instr=N,clar=N) was parse-only with no storage column; this suite
# proves it now travels: track-outcome.sh out()/extract → jq envelope →
# _pg_outcome_dualwrite.py INSERT → core.outcomes.qa_score column.
#
# Contracts pinned:
#   T1 direct envelope with qa_score → the column holds the exact value.
#   T2 envelope WITHOUT qa_score → column is NULL (legacy / non-QA rows stay NULL).
#   T3 UPSERT re-fire (same record_ts/agent/task_type) → qa_score = EXCLUDED.qa_score.
#   T4 end-to-end: a [COMPLETION] qa_score line driven through track-outcome.sh
#      lands in the column (proves the emit → envelope → persist chain).
#
# ISOLATION (non-negotiable): _pg_outcome_dualwrite.py connects host/port-less via
# psycopg.connect("dbname=glass_atrium"), so PGHOST/PGPORT redirect every write to
# an EPHEMERAL single-file cluster (private Unix socket, no TCP) — never the
# production /tmp glass_atrium. Every fixture agent is a unique "qs-..." literal
# (production agents are glass-atrium-*), and each test asserts ZERO fixture rows
# reached production. HOME is repointed to a temp dir so the hook's diag log and
# subagent-transcript resolution never touch the real ~/.claude; psycopg lives in
# the HOME-derived user site-packages, so PYTHONPATH carries the REAL install
# (captured before the override) to keep the helper's import alive.

# core.outcomes schema (5 enums + table + dedup index) mirrored from
# monitor/prisma/migrations/.../migration.sql, PLUS the new qa_score TEXT column
# (migration 20260713000000_add_qa_score_to_outcomes). Only the columns the
# _pg_outcome_dualwrite.py INSERT touches — signals/learning_log tables are omitted
# (the fixtures emit neither). Kept in sync by hand with the production DDL.
qs_outcomes_schema_sql() {
  cat <<'SQL'
CREATE SCHEMA IF NOT EXISTS core;
CREATE TYPE "core"."TaskType" AS ENUM ('bug-fix', 'feature', 'refactor', 'research', 'plan', 'review', 'diagnosis', 'doc', 'cleanup');
CREATE TYPE "core"."OutcomeResult" AS ENUM ('done', 'done_with_concerns', 'blocked', 'needs_context', 'fail');
CREATE TYPE "core"."Confidence" AS ENUM ('high', 'medium', 'low');
CREATE TYPE "core"."GraderVerdict" AS ENUM ('verified_pass', 'unverified', 'verified_fail');
CREATE TYPE "core"."DowngradeOrigin" AS ENUM ('writer_true_downgraded', 'writer_false', 'synthesized');
CREATE TABLE "core"."outcomes" (
  "id"                 BIGSERIAL NOT NULL,
  "record_ts"          TIMESTAMPTZ(6) NOT NULL,
  "agent"              VARCHAR(64) NOT NULL,
  "task_type"          "core"."TaskType" NOT NULL,
  "result"             "core"."OutcomeResult" NOT NULL,
  "confidence"         "core"."Confidence",
  "metric_pass"        BOOLEAN,
  "metric_type"        VARCHAR(32),
  "revision_count"     INTEGER NOT NULL DEFAULT 0,
  "evaluative_signal"  INTEGER,
  "directive_hint"     TEXT,
  "lesson"             TEXT,
  "concerns"           TEXT[] DEFAULT ARRAY[]::TEXT[],
  "qa_score"           TEXT,
  "files_modified"     TEXT[] DEFAULT ARRAY[]::TEXT[],
  "correlation_id"     VARCHAR(96),
  "cid"                VARCHAR(96),
  "summary"            TEXT NOT NULL,
  "review_flag"        BOOLEAN NOT NULL DEFAULT false,
  "body_md"            TEXT,
  "attribution_source" TEXT,
  "style_ref"          TEXT,
  "style_ref_verified" BOOLEAN,
  "grader_verdict"     "core"."GraderVerdict",
  "downgrade_origin"   "core"."DowngradeOrigin",
  "inserted_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outcomes_dedup" ON "core"."outcomes" ("record_ts", "agent", "task_type");
SQL
}

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  local bin
  for bin in initdb pg_ctl createdb psql python3 jq; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin} (PostgreSQL client/server + python3 + jq)"
      return 0
    fi
  done

  # Real user site-packages (psycopg, PEP 370) — captured BEFORE the HOME override
  # so the helper's import survives under the temp HOME.
  export QS_PSYCOPG_PP
  QS_PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  if [[ -z "${QS_PSYCOPG_PP}" ]]; then
    export EPH_SKIP="psycopg module not importable"
    return 0
  fi

  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"

  export EPH_DB="glass_atrium"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  # Socket-addressed cluster (listen_addresses='') → the port is only the socket
  # filename suffix, never a TCP bind, so this literal can never collide.
  export EPH_PORT="55440"
  export EPH_HOME="${BATS_FILE_TMPDIR}/home"
  mkdir -p "${EPH_HOME}/.glass-atrium/logs"

  export QS_HOOKS_DIR QS_PG_HELPER QS_HOOK_SH
  QS_HOOKS_DIR="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
  QS_PG_HELPER="${QS_HOOKS_DIR}/_pg_outcome_dualwrite.py"
  QS_HOOK_SH="${QS_HOOKS_DIR}/track-outcome.sh"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
  # Add core.outcomes (+ enums) on top of the lib's cost_events/agent_events schema.
  local ddl
  ddl="$(qs_outcomes_schema_sql)" || return 1
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q \
    <<<"${ddl}" || return 1
}

teardown_file() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    return 0
  fi
  eph_pg_stop "${EPH_DATADIR}"
}

setup() {
  # Explicit if — a trailing `[[ ... ]] && skip` returns the failing test's exit
  # when EPH_SKIP is empty (bats reads setup()'s status), spuriously failing.
  if [[ -n "${EPH_SKIP:-}" ]]; then
    skip "${EPH_SKIP}"
  fi
}

# Query the EPHEMERAL cluster (explicit -h/-p override any ambient env).
_q() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -tAqc "${1}"
}

# Build a minimal outcome envelope. $1=agent $2=record_ts $3=qa_score
# ("__OMIT__" drops the key entirely — the legacy / non-QA shape). Field STRINGS
# mirror the real track-outcome.sh jq envelope (metric_pass/review_flag are text).
_mk_envelope() {
  local agent="${1}" ts="${2}" qa="${3}"
  if [[ "${qa}" == "__OMIT__" ]]; then
    jq -nc --arg agent "${agent}" --arg ts "${ts}" '{
      outcome: {
        timestamp: $ts, agent: $agent, task_type: "review", result: "done",
        confidence: "high", metric_pass: "true", review_flag: "false",
        revision_count: "0", summary: "qa review"
      },
      signals: [], learning_hint: null
    }'
  else
    jq -nc --arg agent "${agent}" --arg ts "${ts}" --arg qa "${qa}" '{
      outcome: {
        timestamp: $ts, agent: $agent, task_type: "review", result: "done",
        confidence: "high", metric_pass: "true", review_flag: "false",
        revision_count: "0", summary: "qa review", qa_score: $qa
      },
      signals: [], learning_hint: null
    }'
  fi
}

# Feed one envelope directly to the dual-write helper, redirected to the ephemeral
# cluster. Positional args into `bash -c` avoid interpolation injection; stderr is
# merged so a failure surfaces in ${output}.
_run_helper() {
  run env HOME="${EPH_HOME}" PYTHONPATH="${QS_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    bash -c 'printf "%s" "$1" | python3 "$2" 2>&1' _ "${1}" "${QS_PG_HELPER}"
}

# Definitive isolation gate: the fixture agent must have ZERO rows in production.
# PGHOST/PGPORT are unset so this can ONLY reach the production default socket.
# Production unreachable (or the column not yet deployed) → isolation holds by
# construction (the hook only ever connects to the ephemeral PGHOST).
_assert_prod_isolated() {
  local agent="${1}" leaked
  leaked="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';" \
    2>/dev/null || echo "SKIP")"
  [[ "${leaked}" == "SKIP" ]] && return 0
  [[ "${leaked}" -eq 0 ]] || {
    echo "ISOLATION BREACH: ${leaked} fixture rows reached production" >&2
    return 1
  }
}

# Write the synthetic SubagentStop subagent transcript at the exact path the hook's
# subagent-transcript resolver globs (projects/*/<sess>/subagents/agent-<aid>.jsonl).
# A tool_use precedes the [COMPLETION] text turn so the turn is not conversation-only.
_e2e_write_transcript() {
  local agent="${1}" aid="${2}" sess="${3}"
  local slug="${EPH_HOME//\//-}"
  local tdir="${EPH_HOME}/.claude/projects/${slug}/${sess}/subagents"
  mkdir -p "${tdir}"
  python3 - "${tdir}/agent-${aid}.jsonl" "${agent}" <<'PY'
import json, sys
tx, agent = sys.argv[1], sys.argv[2]
completion = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: review\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: qa review for {agent}\n"
    "qa_score: cov=4,ins=5,instr=3,clar=4\n"
    "lesson: qa_score persists end-to-end through the dual-write\n"
    "[/COMPLETION]"
)
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the qa review"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "tu_qs01", "name": "Read", "input": {}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "tu_qs01", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}},
]
with open(tx, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# Drive track-outcome.sh with a SubagentStop payload → ephemeral PG. transcript_path
# points at a nonexistent PARENT so the subagent-transcript resolver is the only source.
_e2e_run_hook() {
  local agent="${1}" aid="${2}" sess="${3}" payload
  payload="$(jq -nc --arg agent "${agent}" --arg aid "${aid}" --arg sess "${sess}" \
    --arg cwd "${EPH_HOME}" '{
      hook_event_name: "SubagentStop", agent_type: $agent, agent_id: $aid,
      session_id: $sess, cwd: $cwd, transcript_path: "/nonexistent/parent.jsonl"
    }')"
  run env HOME="${EPH_HOME}" PYTHONPATH="${QS_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" CLAUDE_GATE_INFLIGHT="" \
    bash -c 'printf "%s" "$1" | bash "$2" 2>&1' _ "${payload}" "${QS_HOOK_SH}"
}

@test "envelope qa_score persists verbatim into core.outcomes.qa_score" {
  _q "TRUNCATE core.outcomes;" || return 1
  local agent="qs-$$-present"
  _run_helper "$(_mk_envelope "${agent}" "2026-07-13T12:00:00.000Z" "cov=4,ins=5,instr=3,clar=4")"
  [ "${status}" -eq 0 ] || { echo "helper exit ${status}: ${output}"; return 1; }
  [[ "${output}" == *"pg_insert=ok"* ]] || { echo "no pg_insert=ok: ${output}"; return 1; }

  local got
  got="$(_q "SELECT qa_score FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${got}" = "cov=4,ins=5,instr=3,clar=4" ] || { echo "qa_score='${got}'"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}

@test "envelope WITHOUT qa_score persists NULL (legacy / non-QA rows stay NULL)" {
  local agent="qs-$$-absent"
  _run_helper "$(_mk_envelope "${agent}" "2026-07-13T12:01:00.000Z" "__OMIT__")"
  [ "${status}" -eq 0 ] || { echo "helper exit ${status}: ${output}"; return 1; }

  local isnull
  isnull="$(_q "SELECT qa_score IS NULL FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${isnull}" = "t" ] || { echo "qa_score not NULL (IS NULL = '${isnull}')"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}

@test "UPSERT re-fire updates qa_score (ON CONFLICT DO UPDATE SET qa_score = EXCLUDED.qa_score)" {
  local agent="qs-$$-upsert" ts="2026-07-13T09:00:00.000Z"
  _run_helper "$(_mk_envelope "${agent}" "${ts}" "cov=1,ins=1,instr=1,clar=1")"
  [ "${status}" -eq 0 ] || { echo "first insert failed: ${output}"; return 1; }
  _run_helper "$(_mk_envelope "${agent}" "${ts}" "cov=5,ins=5,instr=5,clar=5")"
  [ "${status}" -eq 0 ] || { echo "second (upsert) failed: ${output}"; return 1; }

  # Same (record_ts, agent, task_type) collapses to ONE row via the dedup arbiter.
  local n
  n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${n}" = "1" ] || { echo "row count ${n} != 1 (UPSERT did not fold)"; return 1; }

  # And the DO UPDATE arm carried the new qa_score, not the stale first value.
  local got
  got="$(_q "SELECT qa_score FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${got}" = "cov=5,ins=5,instr=5,clar=5" ] || { echo "qa_score='${got}' not updated"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}

@test "end-to-end: track-outcome.sh [COMPLETION] qa_score reaches the dual-write column" {
  _q "TRUNCATE core.outcomes;" || return 1
  local agent="qs-$$-e2e" aid="qsaid${$}x${RANDOM}" sess="qssess${$}x${RANDOM}"

  _e2e_write_transcript "${agent}" "${aid}" "${sess}"
  _e2e_run_hook "${agent}" "${aid}" "${sess}"
  [ "${status}" -eq 0 ] || { echo "hook exit ${status}: ${output}"; return 1; }
  # The whole emit chain must have reached the PG sink (not a synthesized fallback).
  [[ "${output}" == *"pg_insert=ok"* ]] || { echo "no pg_insert=ok: ${output}"; return 1; }
  [[ "${output}" != *"attribution=completion-synthesized"* ]] || { echo "synthesized: ${output}"; return 1; }

  local got
  got="$(_q "SELECT qa_score FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${got}" = "cov=4,ins=5,instr=3,clar=4" ] || { echo "qa_score='${got}'"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}

@test "column-absent (pre-migration) schema still writes via the legacy _OUTCOMES_INSERT_SQL_NO_QA shim" {
  # Pre-migration production: the qa_score column is not yet present. Drop it so the
  # per-process column probe (_outcomes_insert_sql) resolves absent and MUST pick the
  # derived legacy variant instead of _OUTCOMES_INSERT_SQL. Restored afterwards so the
  # shared fixture stays qa_score-bearing for any re-run / reordered execution.
  local agent="qs-$$-nocol"
  _q "ALTER TABLE core.outcomes DROP COLUMN qa_score;" || return 1

  # A qa_score-BEARING envelope is the shim's whole justification: a new hook emitting
  # qa_score against an un-migrated DB. If the qa_score variant were (wrongly) selected,
  # the INSERT would raise UndefinedColumn → pg_insert=ok is the fail-before proof that
  # _OUTCOMES_INSERT_SQL_NO_QA was chosen and is valid against the column-absent schema.
  _run_helper "$(_mk_envelope "${agent}" "2026-07-13T15:00:00.000Z" "cov=4,ins=5,instr=3,clar=4")"
  local st="${status}" out="${output}"

  # Restore the column BEFORE asserting so an early-return failure never leaves the
  # shared fixture missing qa_score.
  _q "ALTER TABLE core.outcomes ADD COLUMN qa_score TEXT;" || return 1

  [ "${st}" -eq 0 ] || { echo "helper exit ${st} (legacy branch errored): ${out}"; return 1; }
  [[ "${out}" == *"pg_insert=ok"* ]] || { echo "no pg_insert=ok (legacy branch not selected): ${out}"; return 1; }

  # The write landed despite the absent column — the qa_score value was silently dropped.
  local n
  n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${n}" = "1" ] || { echo "row count ${n} != 1 (legacy write did not land)"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}
