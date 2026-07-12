#!/usr/bin/env bats
# agent-tracker.bats — characterization safety-net pinning the write contract of
# the agent-tracker.sh -> _pg_dual_write.py SINGLE-ROW path, so an interpreter-
# consolidation refactor (drop the redundant outer `python3 -c` envelope wrapper +
# collapse the 4x hook_get_field field-extract spawns into ONE parse pass) can be
# proven behavior-equivalent against CURRENT (double-interpreter) code:
#
#   1. WRITE-CONTRACT — a SubagentStart and a SubagentStop fire each land exactly
#      one core.agent_events row carrying the correct (event_name, agent_id,
#      agent_type) key. This is the row shape the refactor must keep byte-identical.
#   2. UPSERT idempotency — re-firing the SAME event with a FIXED event_ts hits the
#      agent_events_dedup UNIQUE(event_ts, agent_id, event_name) arbiter (ON
#      CONFLICT DO NOTHING), never doubling the row. event_ts is pinned via a `date`
#      shim on PATH — the hook sources its timestamp from `date +%Y-%m-%dT%H:%M:%S%z`,
#      so without the shim two fires crossing a wall-clock second would land two
#      rows and mask the arbiter.
#   3. PERF-INVARIANT — the consolidated hook fires exactly 2 python3 subprocesses
#      per event (1 parse pass + 1 writer helper), down from 5 in the pre-refactor
#      double-interpreter path (3x hook_get_field + 1 envelope wrapper + 1 writer).
#
# ISOLATION (non-negotiable): _pg_dual_write.py connects host/port-less via
# psycopg.connect("dbname=glass_atrium"), so PGHOST/PGPORT redirect every write in
# the hook chain to an EPHEMERAL single-file cluster (private Unix socket, no TCP) —
# never the production /tmp glass_atrium (23k+ live rows). The definitive proof is
# _assert_prod_isolated: the distinctive fixture agent_id must hold ZERO rows in
# production.
#
# HOME override: agent-tracker writes no artifact under HOME, but HOME is repointed
# to a temp dir for parity + safety, and PYTHONPATH carries the REAL PEP 370 user
# site-packages (captured before the override) to keep the psycopg import alive.

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
setup_file() {
  # Required tooling — absent → skip the whole file gracefully (portable), set
  # via a marker each test's setup() reads (setup_file cannot skip directly).
  local bin
  for bin in initdb pg_ctl createdb psql python3; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin} (PostgreSQL client/server + python3)"
      return 0
    fi
  done

  source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"

  export EPH_DB="glass_atrium"
  # Distinctive fixture agent id — production agent_ids are opaque hashes, so this
  # literal can never collide with a live row (the isolation gate keys on it).
  export EPH_AID="bats-eph-agtracker-fixture-aid"
  export EPH_ATYPE="glass-atrium-dev-shell"

  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  # A distinct port from cost-tracker-dualwrite.bats (55432) — listen_addresses=''
  # means the port only names the socket file, so a distinct value avoids any
  # confusion if both suites run against sockets in a shared parent tmp.
  export EPH_PORT="55433"
  export EPH_HOME="${BATS_FILE_TMPDIR}/home"
  mkdir -p "${EPH_HOME}"

  # Fixed-timestamp `date` shim dir — pins the hook's event_ts so the UPSERT
  # arbiter is stable across re-fires (see file header rationale). Prepended to
  # PATH only inside _fire_agent, so it shadows `date` for the hook alone.
  export EPH_SHIMDIR="${BATS_FILE_TMPDIR}/shim"
  mkdir -p "${EPH_SHIMDIR}"
  # Mirrors the real `date +%Y-%m-%dT%H:%M:%S%z` output format (+HHMM offset, no
  # colon) so the text -> timestamptz(6) cast path is exercised faithfully.
  cat >"${EPH_SHIMDIR}/date" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '2026-07-12T00:00:00+0000'
SH
  chmod +x "${EPH_SHIMDIR}/date"

  # Real user site-packages (psycopg, PEP 370) — captured BEFORE the HOME override
  # so the import survives under the temp HOME.
  export EPH_USER_SITE
  EPH_USER_SITE="$(python3 -m site --user-site)"

  export EPH_HOOK_SH
  EPH_HOOK_SH="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)/agent-tracker.sh"

  # Production baseline total (default socket; PGHOST/PGPORT are never exported,
  # so this hits production) — informational only, reported in teardown_file.
  export EPH_PROD_BEFORE
  EPH_PROD_BEFORE="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.agent_events;" 2>/dev/null || echo "unavailable")"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
}

teardown_file() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    return 0
  fi
  eph_pg_stop "${EPH_DATADIR}"
  # Report the production before/after total for visibility. Any delta is ambient
  # live-session traffic, NOT a leak — the leak gate is the per-test zero-fixture-
  # rows assertion. Emitted on fd 3 (bats diagnostic channel).
  local after
  after="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.agent_events;" 2>/dev/null || echo "unavailable")"
  echo "# production core.agent_events total: before=${EPH_PROD_BEFORE} after=${after}" >&3
}

setup() {
  # Explicit if — a trailing `[[ ... ]] && skip` returns the failing test's exit
  # when EPH_SKIP is empty (bats reads setup()'s status), spuriously failing.
  if [[ -n "${EPH_SKIP:-}" ]]; then
    skip "${EPH_SKIP}"
  fi
}

# Query the EPHEMERAL cluster (explicit -h/-p override any ambient env).
_eph_q() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -tAqc "${1}"
}

# Ordered projection of the full row identity — a stable snapshot for the
# idempotency equality check (independent of the auto-assigned id).
_eph_snapshot() {
  _eph_q "SELECT string_agg(
            event_ts::text || '|' || event_name || '|' || agent_id || '|' || agent_type,
            ',' ORDER BY event_ts, event_name)
          FROM core.agent_events;"
}

# Fire the agent-tracker hook once, redirected to the ephemeral cluster with the
# fixed-timestamp date shim on PATH. Args: $1=event_name $2=agent_id $3=agent_type.
# Positional args into `bash -c` avoid any interpolation injection.
_fire_agent() {
  local event_name="${1}" agent_id="${2}" agent_type="${3}"
  local stdin_json
  stdin_json="$(printf '{"hook_event_name":"%s","agent_id":"%s","agent_type":"%s"}' \
    "${event_name}" "${agent_id}" "${agent_type}")"
  env PATH="${EPH_SHIMDIR}:${PATH}" HOME="${EPH_HOME}" PYTHONPATH="${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    bash -c 'printf "%s" "$1" | "$2" 2>/dev/null' _ "${stdin_json}" "${EPH_HOOK_SH}"
}

# Definitive isolation gate: the distinctive fixture agent_id must have ZERO rows
# in production. PGHOST/PGPORT are never exported, but unset explicitly so this can
# only reach the production default socket. Production unreachable → isolation
# holds by construction (the hook only ever connects to the ephemeral PGHOST).
_assert_prod_isolated() {
  local leaked
  leaked="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.agent_events WHERE agent_id = '${EPH_AID}';" \
    2>/dev/null || echo "SKIP")"
  [[ "${leaked}" == "SKIP" ]] && return 0
  [[ "${leaked}" -eq 0 ]] || {
    echo "ISOLATION BREACH: ${leaked} fixture rows reached production" >&2
    return 1
  }
}

@test "write-contract: SubagentStart + SubagentStop each land one agent_events row with correct keys" {
  _eph_q "TRUNCATE core.agent_events;" || return 1

  _fire_agent "SubagentStart" "${EPH_AID}" "${EPH_ATYPE}" || return 1
  _fire_agent "SubagentStop" "${EPH_AID}" "${EPH_ATYPE}" || return 1

  local rows starts stops keyed
  rows="$(_eph_q "SELECT count(*) FROM core.agent_events;")" || return 1
  starts="$(_eph_q "SELECT count(*) FROM core.agent_events WHERE event_name = 'SubagentStart';")" || return 1
  stops="$(_eph_q "SELECT count(*) FROM core.agent_events WHERE event_name = 'SubagentStop';")" || return 1
  keyed="$(_eph_q "SELECT count(*) FROM core.agent_events WHERE agent_id = '${EPH_AID}' AND agent_type = '${EPH_ATYPE}';")" || return 1

  # Distinct event_name → distinct arbiter → two rows for the one agent id.
  [[ "${rows}" -eq 2 ]] || { echo "row count ${rows} != 2" >&2; return 1; }
  [[ "${starts}" -eq 1 ]] || { echo "SubagentStart rows ${starts} != 1" >&2; return 1; }
  [[ "${stops}" -eq 1 ]] || { echo "SubagentStop rows ${stops} != 1" >&2; return 1; }
  [[ "${keyed}" -eq 2 ]] || { echo "agent_id/agent_type mismatch: ${keyed} != 2" >&2; return 1; }

  _assert_prod_isolated || return 1
}

@test "UPSERT idempotency: re-firing SubagentStart with a fixed event_ts never doubles the row" {
  _eph_q "TRUNCATE core.agent_events;" || return 1

  _fire_agent "SubagentStart" "${EPH_AID}" "${EPH_ATYPE}" || return 1
  local snap1
  snap1="$(_eph_snapshot)" || return 1

  _fire_agent "SubagentStart" "${EPH_AID}" "${EPH_ATYPE}" || return 1
  local snap2
  snap2="$(_eph_snapshot)" || return 1

  # Same (event_ts, agent_id, event_name) row, unchanged payload — DO NOTHING.
  [[ "${snap1}" == "${snap2}" ]] || { echo "snapshot changed: fire1=[${snap1}] fire2=[${snap2}]" >&2; return 1; }

  local rows
  rows="$(_eph_q "SELECT count(*) FROM core.agent_events;")" || return 1
  [[ "${rows}" -eq 1 ]] || { echo "rows doubled: ${rows} != 1 (arbiter DO NOTHING failed)" >&2; return 1; }

  _assert_prod_isolated || return 1
}

@test "perf-invariant: consolidated agent-tracker fires exactly 2 python3 subprocesses per fire (was 5)" {
  _eph_q "TRUNCATE core.agent_events;" || return 1

  # Count EVERY python3 invocation via a counting shim on PATH. The pre-refactor
  # double-interpreter path fired 5 per event (3x hook_get_field field-extract + 1
  # envelope-building `python3 -c` wrapper + 1 writer helper); the consolidated
  # single-parse path MUST collapse it to 2 (1 parse pass + 1 writer helper). The
  # shim `exec`s the real python3 so behavior is unchanged, only counted. The
  # fixed-timestamp `date` shim (EPH_SHIMDIR) rides after shimbin on PATH so the
  # landed row stays deterministic without shadowing the python3 counter.
  local shimbin="${BATS_TEST_TMPDIR}/perfshim"
  local countfile="${BATS_TEST_TMPDIR}/py3.count"
  local real_py3
  real_py3="$(command -v python3)"
  mkdir -p "${shimbin}"
  : >"${countfile}"
  cat >"${shimbin}/python3" <<EOF
#!/usr/bin/env bash
printf 'x' >>"${countfile}"
exec "${real_py3}" "\$@"
EOF
  chmod +x "${shimbin}/python3"

  local stdin_json
  stdin_json="$(printf '{"hook_event_name":"SubagentStart","agent_id":"%s","agent_type":"%s"}' \
    "${EPH_AID}" "${EPH_ATYPE}")"
  env PATH="${shimbin}:${EPH_SHIMDIR}:${PATH}" HOME="${EPH_HOME}" PYTHONPATH="${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    bash -c 'printf "%s" "$1" | "$2" 2>/dev/null' _ "${stdin_json}" "${EPH_HOOK_SH}" || return 1

  local py3_calls
  py3_calls="$(wc -c <"${countfile}" | tr -d '[:space:]')"
  [[ "${py3_calls}" -eq 2 ]] || { echo "python3 subprocess count ${py3_calls} != 2 (was 5 pre-consolidation)" >&2; return 1; }

  # The single parse+write path still lands the one agent_events row.
  local rows
  rows="$(_eph_q "SELECT count(*) FROM core.agent_events;")" || return 1
  [[ "${rows}" -eq 1 ]] || { echo "row count ${rows} != 1 (single-row write dropped)" >&2; return 1; }

  _assert_prod_isolated || return 1
}
