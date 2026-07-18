#!/usr/bin/env bats
# pre-compact-db-source.bats — pins pre-compact.sh's NEW primary source: the survival packet's
# recent-outcomes table + active-CID correlation now read PG core.outcomes (DB-only sink; per-outcome
# .md files retired) via the SELECT-only _pg_outcome_read.py helper, with the legacy .md scan kept
# ONLY as a fallback. Four proofs:
#   (a) DB-PRIMARY — seeded core.outcomes rows surface newest-first under the `| result | summary |`
#       header (the `summary` column label PROVES the DB path won over the .md fallback), and an
#       active-status row with a cid surfaces in the Active correlation IDs section.
#   (b) EMPTY DB → legacy .md fallback (header reverts to `path`, empty dir → (none)).
#   (c) DB UNREACHABLE → the hook NEVER blocks compaction: exit 0, graceful (none) degrade.
#   (d) HELPER loud-fail — _pg_outcome_read.py against a dead socket prints ONE stderr note + exits 5.
#
# ISOLATION: _pg_outcome_read.py connects host/port-less via psycopg.connect("dbname=glass_atrium"),
# so PGHOST/PGPORT redirect every read to an EPHEMERAL single-file cluster (private Unix socket, no
# TCP) — never the production /tmp glass_atrium. psycopg lives in the HOME-derived PEP 370 user
# site-packages, so PYTHONPATH carries the REAL user-site (captured before the HOME override) to keep
# the import alive under the sandbox HOME.

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  local bin
  for bin in initdb pg_ctl createdb psql python3; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin} (PostgreSQL client/server + python3)"
      return 0
    fi
  done
  if ! python3 -c "import psycopg" >/dev/null 2>&1; then
    export EPH_SKIP="psycopg not importable (required by _pg_outcome_read.py)"
    return 0
  fi

  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"

  export EPH_DB="glass_atrium"
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55443"

  export EPH_USER_SITE
  EPH_USER_SITE="$(python3 -m site --user-site)"

  export EPH_HOOK_SH
  EPH_HOOK_SH="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)/pre-compact.sh"
  export EPH_READ_PY
  EPH_READ_PY="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)/_pg_outcome_read.py"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1

  # Minimal core.outcomes — only the columns _pg_outcome_read.py SELECTs. `result` is plain text here
  # (production uses the core."OutcomeResult" enum, but result::text is a valid no-op cast on text too),
  # so the test needs no enum-type setup.
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q <<'SQL' || return 1
CREATE TABLE core.outcomes (
  id             bigserial PRIMARY KEY,
  record_ts      timestamptz NOT NULL,
  agent          text,
  task_type      text,
  result         text,
  summary        text,
  correlation_id text,
  cid            text
);
SQL
}

teardown_file() {
  [[ -n "${EPH_SKIP:-}" ]] && return 0
  eph_pg_stop "${EPH_DATADIR}"
}

setup() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    skip "${EPH_SKIP}"
  fi
  PC_TMP="$(mktemp -d -t pre-compact-db.XXXXXX)"
}

teardown() {
  [[ -n "${PC_TMP:-}" && -d "${PC_TMP}" ]] && rm -rf -- "${PC_TMP}" || true
}

_eph_q() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -tAqc "${1}"
}

# Insert one outcome row. Args: record_ts result summary cid
seed_outcome() {
  _eph_q "INSERT INTO core.outcomes (record_ts, agent, task_type, result, summary, cid)
          VALUES ('${1}', 'x', 'feature', '${2}', '${3}', $( [[ -n "${4}" ]] && printf "'%s'" "${4}" || printf 'NULL' ));"
}

# Build a sandbox HOME with an (empty) legacy outcomes dir + a transcript; echo nothing (sets caller state).
make_home() {
  mkdir -p "${1}/.claude/data/outcomes"
  printf '{"line":1}\n' >"${1}/transcript.jsonl"
}

# Drive the hook against the EPHEMERAL cluster. Args: home  [extra_env_kv...]. Populates $status/$output.
run_hook_db() {
  local home="${1}"; shift
  local payload
  payload="$(jq -nc --arg t "${home}/transcript.jsonl" \
    '{session_id:"sesDB", trigger:"auto", transcript_path:$t}')"
  run env \
    HOME="${home}" \
    PYTHONPATH="${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" \
    PGPORT="${EPH_PORT}" \
    "$@" \
    bash -c 'cd "$1" && exec bash "$2" <<<"$3"' _ "${home}" "${EPH_HOOK_SH}" "${payload}"
}

packet_tail() { # home
  awk '/## Recent outcomes/{p=1} p' "${1}/.claude/compact-backups/"*_survival.md
}

@test "(a) DB-primary: core.outcomes rows surface newest-first with summary header + active CID" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  _eph_q "TRUNCATE core.outcomes;" || return 1
  # o1 oldest … o3 newest. o2 is blocked+cid (active — must surface); o3 is done+cid (NOT active-status);
  # o1 is done, no cid.
  seed_outcome "2026-07-16 08:01:00+00" done       "first outcome"   "" || return 1
  seed_outcome "2026-07-16 08:02:00+00" blocked    "second blocked"  "cid-b2" || return 1
  seed_outcome "2026-07-16 08:03:00+00" done       "third done"      "cid-d3" || return 1

  local home="${PC_TMP}/a"
  make_home "${home}"
  run_hook_db "${home}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}"; echo "${output}"; return 1; }

  local pkt
  pkt="$(packet_tail "${home}")"
  # The `summary` column label proves the DB path (not the .md `path` fallback).
  [[ "${pkt}" == *"| result | summary |"* ]] || { echo "not DB-sourced:"; echo "${pkt}"; return 1; }
  # Newest-first: third (newest) row present; all three summaries present.
  [[ "${pkt}" == *"| done | third done |"* ]] || { echo "missing newest row"; echo "${pkt}"; return 1; }
  [[ "${pkt}" == *"| blocked | second blocked |"* ]] || return 1
  [[ "${pkt}" == *"| done | first outcome |"* ]] || return 1
  # Active-status row with a cid surfaces; the done+cid row does NOT.
  [[ "${pkt}" == *"- cid-b2 (status: blocked)"* ]] || { echo "missing active cid"; echo "${pkt}"; return 1; }
  [[ "${pkt}" != *"cid-d3"* ]] || { echo "done+cid wrongly listed active"; echo "${pkt}"; return 1; }
}

@test "(b) empty DB → legacy .md fallback (path header, (none))" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  _eph_q "TRUNCATE core.outcomes;" || return 1

  local home="${PC_TMP}/b"
  make_home "${home}" # empty .claude/data/outcomes
  run_hook_db "${home}"
  [ "${status}" -eq 0 ] || return 1

  local pkt
  pkt="$(packet_tail "${home}")"
  # 0 DB rows → outcome_tuples empty → fallback path selected (label reverts to `path`), empty dir → (none).
  [[ "${pkt}" == *"| result | path |"* ]] || { echo "expected fallback path header"; echo "${pkt}"; return 1; }
  [[ "${pkt}" == *"| (none) | - |"* ]] || return 1
  [[ "${pkt}" == *"- (none)"* ]] || return 1
}

@test "(c) DB unreachable → hook never blocks compaction (exit 0, graceful degrade)" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local home="${PC_TMP}/c"
  make_home "${home}"
  # Point PGHOST at a dead socket dir — connect_timeout=1 fails fast, helper exits non-zero, hook degrades.
  run_hook_db "${home}" PGHOST="${PC_TMP}/nonexistent-sock" PGPORT="1"
  [ "${status}" -eq 0 ] || { echo "hook blocked on DB-unreachable: exit ${status}"; echo "${output}"; return 1; }
  local pkt
  pkt="$(packet_tail "${home}")"
  [[ "${pkt}" == *"## Recent outcomes"* ]] || return 1
  [[ "${pkt}" == *"| (none) | - |"* ]] || return 1
}

@test "(d) helper loud-fail: unreachable DB prints one stderr note + exits 5" {
  local errf="${PC_TMP}/helper.err"
  run env PYTHONPATH="${EPH_USER_SITE}" PGHOST="${PC_TMP}/dead-sock" PGPORT="1" \
    bash -c 'python3 "$1" 5 2>"$2"' _ "${EPH_READ_PY}" "${errf}"
  [ "${status}" -eq 5 ] || { echo "helper exit ${status} != 5"; cat "${errf}"; return 1; }
  grep -q "core.outcomes read failed" "${errf}" || { echo "no loud-fail note"; cat "${errf}"; return 1; }
  # Exactly one note line (not spam).
  [ "$(wc -l <"${errf}" | tr -d '[:space:]')" -eq 1 ] || { echo "expected 1 stderr line"; cat "${errf}"; return 1; }
}
