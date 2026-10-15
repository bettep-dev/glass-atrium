#!/usr/bin/env bats
# track-outcome-provenance-persist.bats — the recorder's spawn provenance on core.outcomes.
#
# Relationship: a recorded stop stores the envelope's own agent_id and session_id (a placeholder
# label stores NULL) and the transcript detector's verdict (no verdict stores NULL); the agent's
# emitted correction fields persist whatever the verdict says; a schema without the three columns
# still writes the row. The columns come from the real migration chain.
#
# Isolation: the recorder and its real dual-write helper run against a throwaway socket-only
# cluster (hooks/test/lib/ephemeral-pg.bash) with the N36 names unset; HOME, GA_DATA_ROOT, TMPDIR
# and the outcome spool are sandboxed; the live database is never contacted.

# BATS_TEST_DIRNAME / BATS_FILE_TMPDIR / BATS_TEST_TMPDIR are assigned by the bats runtime.
# shellcheck disable=SC2154
HOOK_SH="${BATS_TEST_DIRNAME}/../track-outcome.sh"
MIGRATION_SQL="${BATS_TEST_DIRNAME}/../../monitor/prisma/migrations/20261005000000_add_pattern_evidence_provenance/migration.sql"

setup_file() {
  export BATS_NO_PARALLELIZE_WITHIN_FILE=true
  unset PGPORT PGHOSTADDR PGSERVICE PGDATABASE PGPASSFILE
  local bin
  for bin in initdb pg_ctl createdb psql python3 jq; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin}"
      return 0
    fi
  done
  export PV_PSYCOPG_PP
  PV_PSYCOPG_PP="$(python3 -c 'import psycopg,os;print(os.path.dirname(os.path.dirname(psycopg.__file__)))' 2>/dev/null || true)"
  if [[ -z "${PV_PSYCOPG_PP}" ]]; then
    export EPH_SKIP="psycopg module not importable"
    return 0
  fi

  # shellcheck source-path=SCRIPTDIR source=lib/ephemeral-pg.bash
  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"
  export EPH_DB="glass_atrium"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55457"
  # eph_pg_start's hand DDL lands on the bootstrap DB; the helper's DB gets the real migrations.
  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "eph_boot" || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
  export PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}"
  [[ "$(psql -d "${EPH_DB}" -tAqc 'SHOW unix_socket_directories;')" == "${EPH_SOCKDIR}" ]] || {
    echo "PGHOST does not reach the ephemeral cluster: ${PGHOST}" >&2
    return 1
  }
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
  PV_TMP="${BATS_TEST_TMPDIR}/pv"
  SANDBOX_HOME="${PV_TMP}/home"
  SPOOL_DIR="${PV_TMP}/spool"
  PAYLOAD_FILE="${PV_TMP}/payload.json"
  TRANSCRIPT="${PV_TMP}/parent.jsonl"
  mkdir -p "${SANDBOX_HOME}/.claude/logs" "${PV_TMP}/cache"
}

_q() {
  psql -d "${EPH_DB}" -tAqc "${1}"
}

# $1 = last user message text — the detector reads the newest human utterance.
_write_transcript() {
  python3 - "${TRANSCRIPT}" "${1}" <<'PY'
import json, sys
from datetime import datetime, timezone
path, text = sys.argv[1], sys.argv[2]
ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
rows = [
    {"type": "user", "message": {"role": "user", "content": "the original delegation"},
     "timestamp": ts},
    {"type": "assistant", "message": {"role": "assistant",
                                      "content": [{"type": "text", "text": "working on it"}]}},
    {"type": "user", "message": {"role": "user", "content": text}, "timestamp": ts},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# $1 = summary marker (the row key) · $2 = extra [COMPLETION] lines, '|'-joined ('' = none)
_completion() {
  local line
  printf '%s\n' '[COMPLETION]' 'result: done' 'task_type: cleanup' 'metric_pass: true' \
    'confidence: high' "summary: ${1}"
  if [[ -n "${2}" ]]; then
    while IFS= read -r line; do
      printf '%s\n' "${line}"
    done <<<"${2//|/$'\n'}"
  fi
  printf '%s\n' '[/COMPLETION]'
}

# $1 hook event · $2 agent_type · $3 agent_id · $4 session_id · $5 completion text ·
# $6 transcript path. An empty value omits that key.
_write_payload() {
  jq -nc --arg ev "${1}" --arg agent "${2}" --arg aid "${3}" --arg sess "${4}" \
    --arg m "${5}" --arg tp "${6}" '{
    hook_event_name: $ev,
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "do the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }
  + (if $agent == "" then {} else {agent_type: $agent} end)
  + (if $aid == "" then {} else {agent_id: $aid} end)
  + (if $sess == "" then {} else {session_id: $sess} end)
  + (if $tp == "" then {} else {transcript_path: $tp} end)' >"${PAYLOAD_FILE}"
}

_run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    GA_DATA_ROOT="${SANDBOX_HOME}/.glass-atrium" \
    TMPDIR="${PV_TMP}/cache" \
    PYTHONPATH="${PV_PSYCOPG_PP}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    CLAUDE_GATE_INFLIGHT="" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# The recorder exits 0 whatever happens, so a write is proven by the row plus an empty dead-letter
# spool. $1 = row name for the failure message.
_assert_written() {
  local spooled
  spooled="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ "${status}" -eq 0 && -z "${spooled}" ]] || {
    echo "${1}: hook exit ${status}, spooled='${spooled}': ${output}"
    return 1
  }
}

# Prints `agent_id|session_id|user_correction_detected` for the row, NULL rendered as `null`.
_stored_provenance() {
  _q "SELECT coalesce(agent_id, 'null') || '|' || coalesce(session_id, 'null') || '|'
             || coalesce(user_correction_detected::text, 'null')
      FROM core.outcomes WHERE summary = '${1}';"
}

@test "a recorded stop stores the envelope agent_id, session_id and the detector verdict" {
  local rows row name utterance want marker aid sess tp got i=0
  rows=(
    "detector matched|다시 해줘 please redo this|true"
    "detector evaluated without a match|이어서 진행해|false"
    "no transcript, so no verdict||null"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name utterance want <<<"${row}"
    i=$((i + 1))
    marker="pv-$$-stored-${i}"
    aid="a${$}b${i}c"
    sess="sess-pv-$$-${i}"
    tp=""
    if [[ -n "${utterance}" ]]; then
      _write_transcript "${utterance}"
      tp="${TRANSCRIPT}"
    fi
    _write_payload "SubagentStop" "glass-atrium-dev-shell" "${aid}" "${sess}" \
      "$(_completion "${marker}" '')" "${tp}"
    _run_hook
    _assert_written "${name}" || return 1
    got="$(_stored_provenance "${marker}")"
    [[ "${got}" == "${aid}|${sess}|${want}" ]] || {
      echo "${name}: want '${aid}|${sess}|${want}', got '${got}'"
      return 1
    }
  done
}

@test "a placeholder agent label stores a NULL agent_id, never the label" {
  local rows row name agent want_agent marker got i=0
  rows=(
    "subagent stop with neither id nor type||agent_id_missing"
    "subagent stop with a type but no id|glass-atrium-dev-shell|glass-atrium-dev-shell"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name agent want_agent <<<"${row}"
    i=$((i + 1))
    marker="pv-$$-placeholder-${i}"
    _write_payload "SubagentStop" "${agent}" "" "sess-pv-$$-p${i}" \
      "$(_completion "${marker}" '')" ""
    _run_hook
    _assert_written "${name}" || return 1
    got="$(_q "SELECT agent || '|' || coalesce(agent_id, 'null')
               FROM core.outcomes WHERE summary = '${marker}';")"
    [[ "${got}" == "${want_agent}|null" ]] || {
      echo "${name}: want '${want_agent}|null', got '${got}'"
      return 1
    }
  done
}

@test "emitted correction fields persist unchanged beside an independent detector verdict" {
  # Columns per row: name · emits the correction? · last user utterance · stored
  # revision_count|evaluative_signal|directive_hint|user_correction_detected
  local rows row name emits utterance want emitted marker got i=0
  local correction='revision_count: 2|evaluative_signal: -1|directive_hint: User wanted the gate moved'
  rows=(
    "emitted correction, detector disagrees;yes;진행해;2|-1|User wanted the gate moved|false"
    "emitted correction, detector agrees;yes;다시 해줘 please redo this;2|-1|User wanted the gate moved|true"
    "nothing emitted, detector matches;no;다시 해줘 please redo this;1|-1|null|true"
  )
  for row in "${rows[@]}"; do
    IFS=';' read -r name emits utterance want <<<"${row}"
    emitted=""
    [[ "${emits}" == "no" ]] || emitted="${correction}"
    i=$((i + 1))
    marker="pv-$$-correction-${i}"
    _write_transcript "${utterance}"
    _write_payload "SubagentStop" "glass-atrium-dev-shell" "a${$}corr${i}" "sess-pv-$$-c${i}" \
      "$(_completion "${marker}" "${emitted}")" "${TRANSCRIPT}"
    _run_hook
    _assert_written "${name}" || return 1
    got="$(_q "SELECT revision_count || '|' || coalesce(evaluative_signal::text, 'null') || '|'
                      || coalesce(directive_hint, 'null') || '|'
                      || coalesce(user_correction_detected::text, 'null')
               FROM core.outcomes WHERE summary = '${marker}';")"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: want '${want}', got '${got}'"
      return 1
    }
  done
}

@test "a schema without the provenance columns still writes the row" {
  local marker="pv-$$-premigration" st out n spooled
  _q "ALTER TABLE core.outcomes DROP COLUMN agent_id, DROP COLUMN session_id,
        DROP COLUMN user_correction_detected;" || return 1
  _write_transcript "다시 해줘 please redo this"
  _write_payload "SubagentStop" "glass-atrium-dev-shell" "a${$}pre" "sess-pv-$$-pre" \
    "$(_completion "${marker}" '')" "${TRANSCRIPT}"
  _run_hook
  st="${status}" out="${output}"
  spooled="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  n="$(_q "SELECT count(*) FROM core.outcomes WHERE summary = '${marker}';")"
  psql -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q -f "${MIGRATION_SQL}" || return 1

  [[ "${st}" -eq 0 && -z "${spooled}" && "${n}" == "1" ]] || {
    echo "hook exit ${st}, spooled='${spooled}', rows=${n}: ${out}"
    return 1
  }
}
