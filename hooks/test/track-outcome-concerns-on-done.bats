#!/usr/bin/env bats
# track-outcome-concerns-on-done.bats — pins recorder result-agnosticism for the
# `concerns:` disclosure channel: a writer-emitted [COMPLETION] block carrying
# `result: done` AND a non-empty `concerns:` line keeps result=done and stores the
# concerns value. Locks the decoupling the rule text relies on, so "concerns are
# valid on done rows" cannot silently break into a forced downgrade or a dropped value.
#
# Contracts pinned:
#   T1 end-to-end: a [COMPLETION] `result: done` + `concerns:` block driven through
#      track-outcome.sh lands result=done with every concern item in the column
#      (writer-emitted path — not the inline tier, not the synthesis fallback).
#   T2 direct envelope: the dual-write helper stores concerns on a done row too, so
#      the persistence layer is proven result-agnostic independently of extraction.
#
# ISOLATION (non-negotiable): _pg_outcome_dualwrite.py connects host/port-less via
# psycopg.connect("dbname=glass_atrium"), so PGHOST/PGPORT redirect every write to
# an EPHEMERAL single-file cluster (private Unix socket, no TCP) — never the
# production /tmp glass_atrium. Every fixture agent is a unique "cd-..." literal
# (production agents are glass-atrium-*), and each test asserts ZERO fixture rows
# reached production. HOME is repointed to a temp dir so the hook's diag log and
# subagent-transcript resolution never touch the real ~/.claude; psycopg lives in
# the HOME-derived user site-packages, so PYTHONPATH carries the REAL install
# (captured before the override) to keep the helper's import alive.

# core.outcomes schema (5 enums + table + dedup index) mirrored from
# monitor/prisma/migrations/.../migration.sql. Only the columns the
# _pg_outcome_dualwrite.py INSERT touches — signals/learning_log tables are omitted
# (the fixtures emit neither). Kept in sync by hand with the production DDL.
cd_outcomes_schema_sql() {
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
  export CD_PSYCOPG_PP
  CD_PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  if [[ -z "${CD_PSYCOPG_PP}" ]]; then
    export EPH_SKIP="psycopg module not importable"
    return 0
  fi

  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"

  export EPH_DB="glass_atrium"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  # Socket-addressed cluster (listen_addresses='') → the port is only the socket
  # filename suffix, never a TCP bind, so this literal can never collide.
  export EPH_PORT="55441"
  export EPH_HOME="${BATS_FILE_TMPDIR}/home"
  mkdir -p "${EPH_HOME}/.glass-atrium/logs"

  export CD_HOOKS_DIR CD_PG_HELPER CD_HOOK_SH
  CD_HOOKS_DIR="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
  CD_PG_HELPER="${CD_HOOKS_DIR}/_pg_outcome_dualwrite.py"
  CD_HOOK_SH="${CD_HOOKS_DIR}/track-outcome.sh"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
  # Add core.outcomes (+ enums) on top of the lib's cost_events/agent_events schema.
  local ddl
  ddl="$(cd_outcomes_schema_sql)" || return 1
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

# Definitive isolation gate: the fixture agent must have ZERO rows in production.
# PGHOST/PGPORT are unset so this can ONLY reach the production default socket.
# Production unreachable → isolation holds by construction (the hook only ever
# connects to the ephemeral PGHOST).
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
# The block is the writer-emitted MULTI-LINE form (tag and sentinel each alone on
# their line) — the inline-tolerance tier and the synthesis fallback stay unexercised.
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
    f"summary: verdict delivered for {agent}\n"
    "concerns: static read only, no runtime execution, integration path unread\n"
    "lesson: concerns travel on a done row without downgrading the result\n"
    "[/COMPLETION]"
)
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the review"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "tu_cd01", "name": "Read", "input": {}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "tu_cd01", "content": "ok"}]}},
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
  run env HOME="${EPH_HOME}" PYTHONPATH="${CD_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" CLAUDE_GATE_INFLIGHT="" \
    bash -c 'printf "%s" "$1" | bash "$2" 2>&1' _ "${payload}" "${CD_HOOK_SH}"
}

@test "end-to-end: [COMPLETION] result:done + concerns keeps result=done and stores the concerns" {
  _q "TRUNCATE core.outcomes;" || return 1
  local agent="cd-$$-e2e" aid="cdaid${$}x${RANDOM}" sess="cdsess${$}x${RANDOM}"

  _e2e_write_transcript "${agent}" "${aid}" "${sess}"
  _e2e_run_hook "${agent}" "${aid}" "${sess}"
  [ "${status}" -eq 0 ] || { echo "hook exit ${status}: ${output}"; return 1; }
  # The whole emit chain must have reached the PG sink (not a synthesized fallback).
  [[ "${output}" == *"pg_insert=ok"* ]] || { echo "no pg_insert=ok: ${output}"; return 1; }
  [[ "${output}" != *"attribution=completion-synthesized"* ]] || { echo "synthesized: ${output}"; return 1; }

  # No forced downgrade: the writer's chosen result value survives verbatim.
  local got_result
  got_result="$(_q "SELECT result FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${got_result}" = "done" ] || { echo "result='${got_result}' (downgraded)"; return 1; }

  # No dropped value: every comma-separated item reached the text[] column.
  local got_concerns
  got_concerns="$(_q "SELECT array_to_string(concerns, '|') FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${got_concerns}" = "static read only|no runtime execution|integration path unread" ] || {
    echo "concerns='${got_concerns}'"
    return 1
  }

  _assert_prod_isolated "${agent}" || return 1
}

@test "envelope result:done + concerns persists the array (dual-write is result-agnostic)" {
  local agent="cd-$$-envelope" envelope
  envelope="$(jq -nc --arg agent "${agent}" '{
    outcome: {
      timestamp: "2026-08-09T12:00:00.000Z", agent: $agent, task_type: "review",
      result: "done", confidence: "high", metric_pass: "true", review_flag: "false",
      revision_count: "0", summary: "verdict delivered",
      concerns: "role-inherent limit, scope-external note"
    },
    signals: [], learning_hint: null
  }')"

  run env HOME="${EPH_HOME}" PYTHONPATH="${CD_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    bash -c 'printf "%s" "$1" | python3 "$2" 2>&1' _ "${envelope}" "${CD_PG_HELPER}"
  [ "${status}" -eq 0 ] || { echo "helper exit ${status}: ${output}"; return 1; }
  [[ "${output}" == *"pg_insert=ok"* ]] || { echo "no pg_insert=ok: ${output}"; return 1; }

  local got
  got="$(_q "SELECT result || ' :: ' || array_to_string(concerns, '|') FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${got}" = "done :: role-inherent limit|scope-external note" ] || { echo "row='${got}'"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}
