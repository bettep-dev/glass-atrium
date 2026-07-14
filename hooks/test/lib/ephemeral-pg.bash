#!/usr/bin/env bash
# ephemeral-pg.bash — throwaway single-file Postgres cluster + cost-tracker /
# agent-tracker fixture for the dual-write characterization suites.
#
# WHY an ephemeral cluster: _pg_dual_write.py connects host/port-less via
# psycopg.connect("dbname=glass_atrium"), which libpq resolves through the
# PGHOST/PGPORT environment. The production glass_atrium (22k+ live cost_events
# rows) sits on the default /tmp socket, so a test that let the hook write there
# would corrupt production. This stands up an isolated cluster on a PRIVATE Unix
# socket with TCP disabled (listen_addresses=''); the caller points PGHOST/PGPORT
# at it, redirecting every psycopg connection in the hook chain to this cluster.
# No test row can reach production.
#
# Bash 3.2+ (macOS stock). Callers source this and use the eph_* functions.

# Expected fixture totals — SINGLE SOURCE OF TRUTH shared with the .bats asserts.
# Derived from the token values eph_build_fixture writes below:
#   main turn : 1000 + 500 + 100 + 200 = 1800
#   subagent 1:  300 + 150 +   0 +   0 =  450
#   subagent 2:  200 + 100 +  50 +   0 =  350
#   total tokens = 2600 · row count = 1 turn + 2 subagent = 3
# Exported: consumed by the .bats asserts (external use — not referenced here).
export EPH_EXPECT_TOKENS=2600
export EPH_EXPECT_ROWS=3

# core.cost_events + core.agent_events DDL mirrored from production
# (monitor/prisma/migrations/.../migration.sql).
#   cost_events  — verified column set + the cost_events_session_dedup_key
#                  UNIQUE(session_id, dedup_key) ON CONFLICT arbiter. id/inserted_at
#                  are auto-assigned exactly as in production.
#   agent_events — exact 4-column set _pg_dual_write.py writes (event_ts, event_name,
#                  agent_id, agent_type) + the agent_events_dedup UNIQUE(event_ts,
#                  agent_id, event_name) index that is the ON CONFLICT DO NOTHING
#                  arbiter for agent-tracker's single-row UPSERT. id BIGSERIAL PK
#                  matches production; there is NO inserted_at column on this table.
eph_pg_schema_sql() {
  cat <<'SQL'
CREATE SCHEMA IF NOT EXISTS core;
CREATE TABLE core.cost_events (
  id                    bigserial PRIMARY KEY,
  event_date            date NOT NULL,
  event_time            time(6) NOT NULL,
  session_id            text NOT NULL,
  kind                  varchar(16) NOT NULL DEFAULT 'turn',
  dedup_key             text,
  input_tokens          bigint NOT NULL,
  output_tokens         bigint NOT NULL,
  cache_read_tokens     bigint NOT NULL,
  cache_creation_tokens bigint NOT NULL,
  cost_usd              numeric(12,6) NOT NULL,
  duration_ms           bigint NOT NULL,
  num_turns             integer NOT NULL,
  stop_reason           varchar(64),
  model                 varchar(128),
  parse_error           boolean NOT NULL,
  raw_input             varchar(500),
  inserted_at           timestamptz NOT NULL DEFAULT current_timestamp
);
CREATE UNIQUE INDEX cost_events_session_dedup_key
  ON core.cost_events (session_id, dedup_key);
CREATE TABLE core.agent_events (
  id         bigserial PRIMARY KEY,
  event_ts   timestamptz(6) NOT NULL,
  event_name varchar(64) NOT NULL,
  agent_id   text NOT NULL,
  agent_type varchar(64) NOT NULL
);
CREATE UNIQUE INDEX agent_events_dedup
  ON core.agent_events (event_ts, agent_id, event_name);
SQL
}

# Stand up + initialize the cluster. Args: $1=datadir $2=sockdir $3=port $4=dbname
# Each step is guarded so setup_file fails LOUDLY (never a half-up cluster).
eph_pg_start() {
  local datadir="${1}" sockdir="${2}" port="${3}" dbname="${4}"
  local osuser schema
  osuser="$(id -un)" || return 1
  mkdir -p "${sockdir}" || return 1
  initdb -D "${datadir}" -A trust -U "${osuser}" -E UTF8 >/dev/null 2>&1 || return 1
  # listen_addresses='' → no TCP bind (zero port-collision risk); the socket
  # lives at ${sockdir}/.s.PGSQL.${port}, addressed by PGHOST/PGPORT.
  pg_ctl -D "${datadir}" \
    -o "-p ${port} -k ${sockdir} -c listen_addresses=''" \
    -w -t 30 start >/dev/null 2>&1 || return 1
  createdb -h "${sockdir}" -p "${port}" "${dbname}" || return 1
  # Capture the DDL first (assignment preserves the generator's exit) so the
  # psql exit is the checked one — no pipe masking.
  schema="$(eph_pg_schema_sql)" || return 1
  psql -h "${sockdir}" -p "${port}" -d "${dbname}" -v ON_ERROR_STOP=1 -q \
    <<<"${schema}" || return 1
}

# Stop + reap the cluster. Arg: $1=datadir. Immediate mode — no graceful drain
# needed for a throwaway cluster. Absent datadir is a no-op.
eph_pg_stop() {
  local datadir="${1}"
  [[ -d "${datadir}" ]] || return 0
  pg_ctl -D "${datadir}" -m immediate -w stop >/dev/null 2>&1 || true
}

# Build the fixture session tree under $1. The hook derives the session dir as
# transcript_path minus ".jsonl", so the subagent files sit at
# <sessdir>/transcript/subagents/agent-*.jsonl (recursive-glob target). Token
# values here are the SoT for EPH_EXPECT_TOKENS/EPH_EXPECT_ROWS above.
eph_build_fixture() {
  local sessdir="${1}"
  mkdir -p "${sessdir}/transcript/subagents" || return 1
  # Main turn: a real-user boundary (top-level uuid → stable dedup_key) followed
  # by one assistant usage record (1000/500/100/200).
  {
    printf '%s\n' '{"type":"user","uuid":"boundary-uuid-001","message":{"role":"user","content":"hi"}}'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","id":"msg-main-1","model":"claude-opus-4-8","stop_reason":"end_turn","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":100,"cache_creation_input_tokens":200}}}'
  } >"${sessdir}/transcript.jsonl" || return 1
  # Subagent 1 (dedup_key "suba1"): 300/150/0/0.
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","id":"msg-suba1","model":"claude-opus-4-8","stop_reason":"end_turn","usage":{"input_tokens":300,"output_tokens":150,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}' \
    >"${sessdir}/transcript/subagents/agent-suba1.jsonl" || return 1
  # Subagent 2 (dedup_key "suba2"): 200/100/50/0.
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","id":"msg-suba2","model":"claude-opus-4-8","stop_reason":"end_turn","usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}}' \
    >"${sessdir}/transcript/subagents/agent-suba2.jsonl" || return 1
}
