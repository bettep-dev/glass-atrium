#!/usr/bin/env bats
# track-outcome-dedup-collision.bats — pins the fix for silent outcome-row loss on a
# same-second dedup collision.
#
# ROOT CAUSE (reproduced live, then hermetically): track-outcome.sh stamped record_ts at
# SECOND precision, while core.outcomes has UNIQUE(record_ts, agent, task_type) with
# ON CONFLICT DO UPDATE. Two DISTINCT subagents of the same agent + task_type finishing in
# the same wall-clock second aliased to ONE dedup key: the later write's INSERT consumed a
# sequence id, hit the conflict, and DO-UPDATEd (silently overwrote) the earlier row. Last-
# writer-wins data loss, no error surfaced (no hook_failures row). The fix stamps record_ts
# at MILLISECOND precision so distinct concurrent subagents get distinct keys.
#
# Contracts pinned (production-matching NO_QA schema — the live core.outcomes has no qa_score
# column yet, so the legacy _OUTCOMES_INSERT_SQL_NO_QA variant runs; matched here):
#   C1 collision  — two DISTINCT outcomes sharing (record_ts, agent, task_type) collapse to
#                   ONE row (the LAST writer) + a consumed-and-gapped sequence id. This is the
#                   silent loss the fix prevents by never producing an identical record_ts.
#   C2 distinct   — the SAME two outcomes with DISTINCT (millisecond) record_ts BOTH survive:
#                   distinct dedup keys, no overwrite. This is WHY the ms-precision fix works.
#   C3 fix-source — track-outcome.sh stamps record_ts at sub-second (python %f) precision; the
#                   second-precision date form remains only as a guarded python-absent fallback.
#   C4 empty-hint — end-to-end: an evaluative_signal=-1 correction WITHOUT directive_hint driven
#                   through track-outcome.sh writes its outcomes row (review_flag=true) AND its
#                   core.correction_signals row. Pins T4's READ-ONLY correction-gap contract and
#                   permanently closes the original (disproven) F3A "hint-less loss" suspicion.
#   C5 two-agents — end-to-end: two distinct subagents of the same agent + task_type driven back-
#                   to-back through track-outcome.sh BOTH persist with DISTINCT record_ts.
#
# ISOLATION (non-negotiable): _pg_outcome_dualwrite.py connects host/port-less via
# psycopg.connect("dbname=glass_atrium"), so PGHOST/PGPORT redirect every write to an EPHEMERAL
# single-file cluster (private Unix socket, no TCP) — never the production /tmp glass_atrium.
# Every fixture agent is a unique "dc-..." literal (production agents are glass-atrium-* /
# general-purpose), and each test asserts ZERO fixture rows reached production. HOME is repointed
# to a temp dir; psycopg lives in the HOME-derived user site-packages, so PYTHONPATH carries the
# REAL install (captured before the override) to keep the helper's import alive.

# core.outcomes (NO qa_score → production NO_QA variant) + core.correction_signals, mirrored from
# monitor/prisma/migrations/.../migration.sql. Only the columns the _pg_outcome_dualwrite.py INSERTs
# touch. Kept in sync by hand with the production DDL.
dc_schema_sql() {
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
CREATE TABLE "core"."correction_signals" (
  "id"                   BIGSERIAL NOT NULL,
  "event_ts"             TIMESTAMPTZ(6) NOT NULL,
  "task_type"            VARCHAR(32) NOT NULL,
  "stage1_matched"       BOOLEAN NOT NULL,
  "stage2_matched"       BOOLEAN NOT NULL,
  "final_detected"       BOOLEAN NOT NULL,
  "revision_count_delta" INTEGER NOT NULL,
  "outcome_id"           BIGINT,
  CONSTRAINT "correction_signals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "correction_signals_dedup" ON "core"."correction_signals" ("event_ts", "task_type", "outcome_id");
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

  # Real user site-packages (psycopg, PEP 370) — captured BEFORE the HOME override.
  export DC_PSYCOPG_PP
  DC_PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  if [[ -z "${DC_PSYCOPG_PP}" ]]; then
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

  export DC_HOOKS_DIR DC_PG_HELPER DC_HOOK_SH
  DC_HOOKS_DIR="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
  DC_PG_HELPER="${DC_HOOKS_DIR}/_pg_outcome_dualwrite.py"
  DC_HOOK_SH="${DC_HOOKS_DIR}/track-outcome.sh"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
  local ddl
  ddl="$(dc_schema_sql)" || return 1
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
  if [[ -n "${EPH_SKIP:-}" ]]; then
    skip "${EPH_SKIP}"
  fi
}

# Query the EPHEMERAL cluster (explicit -h/-p override any ambient env).
_q() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -tAqc "${1}"
}

# A full outcome envelope for a research-agent correction. $1=agent $2=record_ts $3=cid
# $4=summary $5=directive_hint ("" → omitted-hint shape) $6=review_flag. Field STRINGS mirror
# the real track-outcome.sh jq envelope (metric_pass/review_flag are text). No signals[] here —
# these tests isolate the outcomes-dedup behavior.
_mk_envelope() {
  jq -nc --arg agent "${1}" --arg ts "${2}" --arg cid "${3}" --arg s "${4}" \
    --arg hint "${5}" --arg review "${6}" '{
    outcome: {
      timestamp: $ts, agent: $agent, task_type: "research", result: "done",
      confidence: "medium", metric_pass: "true", review_flag: $review,
      revision_count: "1", evaluative_signal: "-1", directive_hint: $hint,
      correlation_id: $cid, cid: $cid, summary: $s, attribution_source: "hook-input",
      grader_verdict: "unverified"
    },
    signals: [], learning_hint: null
  }'
}

# Feed one envelope directly to the dual-write helper, redirected to the ephemeral cluster.
_run_helper() {
  run env HOME="${EPH_HOME}" PYTHONPATH="${DC_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    bash -c 'printf "%s" "$1" | python3 "$2" 2>&1' _ "${1}" "${DC_PG_HELPER}"
}

# Definitive isolation gate: the fixture agent must have ZERO rows in production.
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

# Write a synthetic SubagentStop subagent transcript at the path the hook's resolver globs
# (projects/*/<sess>/subagents/agent-<aid>.jsonl). A tool_use precedes the [COMPLETION] text
# turn so the turn is not conversation-only. $4 = directive_hint line ("" → omitted).
_e2e_write_transcript() {
  local agent="${1}" aid="${2}" sess="${3}" hint_line="${4}" cid="${5}"
  local slug="${EPH_HOME//\//-}"
  local tdir="${EPH_HOME}/.claude/projects/${slug}/${sess}/subagents"
  mkdir -p "${tdir}"
  python3 - "${tdir}/agent-${aid}.jsonl" "${agent}" "${hint_line}" "${cid}" <<'PY'
import json, sys
tx, agent, hint_line, cid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lines = [
    "[COMPLETION]",
    "result: done",
    "task_type: research",
    "metric_pass: true",
    "confidence: medium",
    "revision_count: 1",
    "evaluative_signal: -1",
    f"summary: correction probe for {agent}",
]
if hint_line:
    lines.append(hint_line)
lines.append(f"cid: {cid}")
lines.append("[/COMPLETION]")
completion = "\n".join(lines)
rows = [
    {"type": "user", "message": {"role": "user", "content": "do the research"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "tu_dc01", "name": "Read", "input": {}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "tu_dc01", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}},
]
with open(tx, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# Drive track-outcome.sh with a SubagentStop payload → ephemeral PG. transcript_path points at a
# nonexistent PARENT so the subagent-transcript resolver is the only source.
_e2e_run_hook() {
  local agent="${1}" aid="${2}" sess="${3}" payload
  payload="$(jq -nc --arg agent "${agent}" --arg aid "${aid}" --arg sess "${sess}" \
    --arg cwd "${EPH_HOME}" '{
      hook_event_name: "SubagentStop", agent_type: $agent, agent_id: $aid,
      session_id: $sess, cwd: $cwd, transcript_path: "/nonexistent/parent.jsonl"
    }')"
  run env HOME="${EPH_HOME}" PYTHONPATH="${DC_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" CLAUDE_GATE_INFLIGHT="" \
    bash -c 'printf "%s" "$1" | bash "$2" 2>&1' _ "${payload}" "${DC_HOOK_SH}"
}

@test "C1 same (record_ts,agent,task_type) collides → 1 survivor (last writer), sequence gapped" {
  _q "TRUNCATE core.outcomes RESTART IDENTITY;" || return 1
  local agent="dc-$$-collide" ts="2026-07-17T10:54:04.000Z"
  # Two DISTINCT outcomes (different cid/summary), identical dedup key = the same-second case.
  _run_helper "$(_mk_envelope "${agent}" "${ts}" "dc-cid-first" "first writer" "" "true")"
  [ "${status}" -eq 0 ] || { echo "first write failed: ${output}"; return 1; }
  _run_helper "$(_mk_envelope "${agent}" "${ts}" "dc-cid-second" "second writer" "distilled hint" "false")"
  [ "${status}" -eq 0 ] || { echo "second write failed: ${output}"; return 1; }

  # Exactly ONE row survives — the collision collapsed the two distinct outcomes.
  local n; n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${n}" = "1" ] || { echo "row count ${n} != 1 (expected the collision to collapse to 1)"; return 1; }
  # The survivor is the LAST writer (silent overwrite of the first).
  local cid; cid="$(_q "SELECT cid FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${cid}" = "dc-cid-second" ] || { echo "survivor cid='${cid}' (expected dc-cid-second)"; return 1; }
  # The first writer's data is GONE (this IS the silent data loss).
  local first; first="$(_q "SELECT count(*) FROM core.outcomes WHERE cid = 'dc-cid-first';")" || return 1
  [ "${first}" = "0" ] || { echo "first writer survived (${first}) — expected silent loss"; return 1; }
  # The 2nd INSERT consumed a sequence id before the conflict → last_value=2 while only 1 row
  # survives (the gap that shows as a missing outcomes id in production).
  local seq; seq="$(_q "SELECT last_value FROM core.outcomes_id_seq;")" || return 1
  [ "${seq}" = "2" ] || { echo "seq last_value='${seq}' (expected 2 = a consumed-and-gapped id)"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}

@test "C2 DISTINCT (millisecond) record_ts for the same agent+task_type → BOTH rows survive" {
  local agent="dc-$$-distinct"
  # Same agent+task_type but record_ts differs by 1ms — the post-fix shape. No collision.
  _run_helper "$(_mk_envelope "${agent}" "2026-07-17T10:54:04.001Z" "dc-ms-a" "writer A" "" "true")"
  [ "${status}" -eq 0 ] || { echo "write A failed: ${output}"; return 1; }
  _run_helper "$(_mk_envelope "${agent}" "2026-07-17T10:54:04.002Z" "dc-ms-b" "writer B" "hint b" "false")"
  [ "${status}" -eq 0 ] || { echo "write B failed: ${output}"; return 1; }

  local n; n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${n}" = "2" ] || { echo "row count ${n} != 2 (distinct ms keys must NOT collide)"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}

@test "C3 track-outcome.sh stamps record_ts at sub-second precision (python %f), date only as fallback" {
  # White-box source pin (deterministic, no timing). The record_ts stamp must derive sub-second
  # precision from python3 %f; the second-precision `date ...000Z` form may survive ONLY as the
  # guarded python-absent fallback, never as the primary stamp.
  local src; src="$(cat "${DC_HOOK_SH}")"
  [[ "${src}" == *'strftime("%Y-%m-%dT%H:%M:%S.%f")'* ]] \
    || { echo "record_ts is not stamped at sub-second (%f) precision"; return 1; }
  # The primary TIMESTAMP assignment is the python stamp (the date form is now inside the
  # `if [[ -z ]]` fallback only).
  local assign; assign="$(printf '%s\n' "${src}" | grep -n 'TIMESTAMP=' | grep -v 'S_TIMESTAMP')"
  [[ "${assign}" == *'python3 -c'* ]] \
    || { echo "primary TIMESTAMP= assignment is not the python sub-second stamp"; return 1; }
}

@test "C4 end-to-end: evaluative_signal=-1 WITHOUT directive_hint writes the row + review_flag=true + correction_signals" {
  _q "TRUNCATE core.outcomes RESTART IDENTITY;" || return 1
  _q "TRUNCATE core.correction_signals RESTART IDENTITY;" || return 1
  local agent="dc-$$-nohint" aid="dcaid${$}x${RANDOM}" sess="dcsess${$}x${RANDOM}"

  # F3A shape: correction (evaluative_signal=-1, revision_count=1) with NO directive_hint line.
  _e2e_write_transcript "${agent}" "${aid}" "${sess}" "" "2026-07-17T2200_repro-f3a_a1b2"
  _e2e_run_hook "${agent}" "${aid}" "${sess}"
  [ "${status}" -eq 0 ] || { echo "hook exit ${status}: ${output}"; return 1; }
  [[ "${output}" == *"pg_insert=ok"* ]] || { echo "no pg_insert=ok: ${output}"; return 1; }
  # The correction-gap READ-ONLY flag fired (T4 contract) — a loud stderr note, record still written.
  [[ "${output}" == *"correction-gap: evaluative_signal=-1 with empty directive_hint"* ]] \
    || { echo "correction-gap note absent: ${output}"; return 1; }

  # The outcomes row IS written (the disproven F3A "hint-less loss" can never regress here).
  local n; n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${n}" = "1" ] || { echo "outcomes rows ${n} != 1 (hint-less correction must still write)"; return 1; }
  # review_flag=true (the gap flag) + directive_hint NULL (the recorder never distills a hint).
  local rf; rf="$(_q "SELECT review_flag FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${rf}" = "t" ] || { echo "review_flag='${rf}' (expected t on the correction gap)"; return 1; }
  local hn; hn="$(_q "SELECT directive_hint IS NULL FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${hn}" = "t" ] || { echo "directive_hint not NULL (IS NULL='${hn}')"; return 1; }
  # The correction WRITE path is untouched: a core.correction_signals row landed for this outcome.
  local cs; cs="$(_q "SELECT count(*) FROM core.correction_signals cs JOIN core.outcomes o ON cs.outcome_id = o.id WHERE o.agent = '${agent}';")" || return 1
  [ "${cs}" = "1" ] || { echo "correction_signals rows ${cs} != 1 (correction WRITE path broke)"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}

@test "C5 end-to-end: two same-(agent,task_type) subagents both persist with DISTINCT record_ts" {
  _q "TRUNCATE core.outcomes RESTART IDENTITY;" || return 1
  local agent="dc-$$-two" a1="dca1${$}x${RANDOM}" s1="dcs1${$}x${RANDOM}"
  local a2="dca2${$}x${RANDOM}" s2="dcs2${$}x${RANDOM}"

  # Two DISTINCT subagents, SAME agent_type + task_type, driven back-to-back. Post-fix each gets a
  # distinct millisecond record_ts → both persist (pre-fix, a same-second pair silently collapsed).
  _e2e_write_transcript "${agent}" "${a1}" "${s1}" "" "dc-two-first"
  _e2e_run_hook "${agent}" "${a1}" "${s1}"
  [ "${status}" -eq 0 ] || { echo "run 1 exit ${status}: ${output}"; return 1; }
  _e2e_write_transcript "${agent}" "${a2}" "${s2}" "directive_hint: keep both" "dc-two-second"
  _e2e_run_hook "${agent}" "${a2}" "${s2}"
  [ "${status}" -eq 0 ] || { echo "run 2 exit ${status}: ${output}"; return 1; }

  local n; n="$(_q "SELECT count(*) FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${n}" = "2" ] || { echo "outcomes rows ${n} != 2 (both distinct subagents must persist)"; return 1; }
  local d; d="$(_q "SELECT count(DISTINCT record_ts) FROM core.outcomes WHERE agent = '${agent}';")" || return 1
  [ "${d}" = "2" ] || { echo "distinct record_ts ${d} != 2 (stamps must differ at sub-second)"; return 1; }

  _assert_prod_isolated "${agent}" || return 1
}
