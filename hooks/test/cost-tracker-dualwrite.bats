#!/usr/bin/env bats
# cost-tracker-dualwrite.bats — characterization safety-net pinning the TWO
# load-bearing contracts of the cost-tracker.sh -> _pg_dual_write.py per-row
# write path, so a later BATCH-write refactor can be proven behavior-equivalent
# against CURRENT code:
#
#   1. SUM-invariance — the token totals (input+output+cache) and the row COUNT
#      (1 main turn + N subagent) that land in core.cost_events equal the known
#      fixture totals. The refactor must preserve exactly this fold.
#   2. UPSERT idempotency — firing the same Stop event twice re-aggregates the
#      SAME (session_id, dedup_key) rows (ON CONFLICT DO UPDATE), never doubling
#      or accumulating. The refactor must preserve this arbiter identity.
#   3. Effort tier — turn and subagent rows carry the last non-null `effort` on an
#      assistant record by transcript position, plus a mixed-tier flag; no
#      assistant-carried tier → both NULL; a schema without the columns (hooks
#      deployed before the migration) still lands every row.
#
# ISOLATION (non-negotiable): _pg_dual_write.py connects host/port-less via
# psycopg.connect("dbname=glass_atrium"), so PGHOST/PGPORT redirect every write
# in the hook chain to an EPHEMERAL single-file cluster (private Unix socket, no
# TCP) — never the production /tmp glass_atrium (22k+ live rows). The definitive
# proof is _assert_prod_isolated: the fixture session_id must hold ZERO rows in
# production. A raw production before/after total is NOT used as the gate — the
# live session's own cost-tracker writes to production during the run, so a
# strict-equality total would flake; the fixture-session-row count is the
# invariant that actually isolates.
#
# HOME override: HOOK_LOG_DIR is ${HOME}/.glass-atrium/logs (the subagent mtime
# cache), so HOME is repointed to a temp dir — the run leaves NO artifact under
# the real ~/.glass-atrium. psycopg lives in the HOME-derived PEP 370 user
# site-packages, so PYTHONPATH carries the REAL user-site (captured before the
# override) to keep the import alive.

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
EPH_MIGRATION_SQL="${BATS_TEST_DIRNAME}/../../monitor/prisma/migrations/20260930000000_add_effort_to_outcomes_and_cost_events/migration.sql"

# shellcheck disable=SC2154
setup_file() {
  # Every test here shares the one per-file database → no parallel tests within this file.
  export BATS_NO_PARALLELIZE_WITHIN_FILE=true
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
  # Distinctive fixture session id — production session ids are UUIDs, so this
  # literal can never collide with a live row.
  export EPH_SID="bats-eph-dualwrite-fixture"
  export EPH_EXPECT_TOKENS EPH_EXPECT_ROWS

  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata"
  export EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock"
  export EPH_PORT="55432"
  export EPH_HOME="${BATS_FILE_TMPDIR}/home"
  export EPH_SESSDIR="${BATS_FILE_TMPDIR}/session"
  export EPH_TX="${EPH_SESSDIR}/transcript.jsonl"
  mkdir -p "${EPH_HOME}"

  # Real user site-packages (psycopg, PEP 370) — captured BEFORE the HOME
  # override so the import survives under the temp HOME.
  export EPH_USER_SITE
  EPH_USER_SITE="$(python3 -m site --user-site)"

  export EPH_HOOK_SH
  EPH_HOOK_SH="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)/cost-tracker.sh"

  # The batch writer, driven DIRECTLY (bypassing cost-tracker.sh) so the
  # partial-success test can feed it a hand-built mixed [good, bad, good] batch.
  export EPH_WRITER_PY
  EPH_WRITER_PY="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)/_pg_dual_write.py"

  # Production baseline total (default socket; PGHOST/PGPORT are never exported,
  # so this hits production) — informational only, reported in teardown_file.
  export EPH_PROD_BEFORE
  EPH_PROD_BEFORE="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.cost_events;" 2>/dev/null || echo "unavailable")"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
  # The effort columns come from the real migration file, which also alters core.outcomes.
  local ddl
  ddl="$(eph_pg_outcomes_schema_sql)" || return 1
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q <<<"${ddl}" \
    || return 1
  _eph_apply_migration || return 1
  eph_build_fixture "${EPH_SESSDIR}" || return 1
}

teardown_file() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    return 0
  fi
  eph_pg_stop "${EPH_DATADIR}"
  # Report the production before/after total for visibility. Any delta is
  # ambient live-session traffic, NOT a leak — the leak gate is the per-test
  # zero-fixture-rows assertion. Emitted on fd 3 (bats diagnostic channel).
  local after
  after="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.cost_events;" 2>/dev/null || echo "unavailable")"
  echo "# production core.cost_events total: before=${EPH_PROD_BEFORE} after=${after}" >&3
}

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

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

_eph_apply_migration() {
  psql -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -v ON_ERROR_STOP=1 -q \
    -f "${EPH_MIGRATION_SQL}"
}

# "<effort>|<has_mixed_effort>" of session $1's $2-kind row; NULL prints as <null>.
_eph_effort() {
  _eph_q "SELECT coalesce(effort, '<null>') || '|' || coalesce(has_mixed_effort::text, '<null>')
          FROM core.cost_events WHERE session_id = '${1}' AND kind = '${2}';"
}

# $1 = shape, $2 = session dir. transcript.jsonl = an earlier turn carrying `max`, then the shape
# as the current turn; subagents/agent-<shape>.jsonl = the shape alone. Every shape plants a
# non-assistant `effort` that a type-blind reader would return.
_write_effort_session() {
  python3 - "${1}" "${2}" <<'PY'
import json, os, sys

shape, sessdir = sys.argv[1], sys.argv[2]
OPUS = "claude-opus-4-8"
HAIKU = "claude-haiku-4-5"
seq = [0]


def usage(n):
    return {"input_tokens": n, "output_tokens": n, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0}


def user(uuid, text):
    return {"type": "user", "uuid": uuid, "message": {"role": "user", "content": text}}


def attachment(effort=None):
    rec = {"type": "attachment", "attachment": {"type": "todo_reminder", "content": []}}
    if effort is not None:
        rec["effort"] = effort
    return rec


def assistant(model, effort=None):
    seq[0] += 1
    rec = {"type": "assistant", "message": {"role": "assistant", "id": "msg-%d" % seq[0],
           "model": model, "stop_reason": "end_turn", "usage": usage(10)}}
    if effort is not None:
        rec["effort"] = effort
    return rec


def synthetic_notice():
    return {"type": "assistant", "message": {"role": "assistant", "id": "msg-synthetic",
            "model": "<synthetic>", "stop_reason": "stop_sequence", "usage": usage(0),
            "content": [{"type": "text", "text": "Session limit reached"}]}}


boundary = user("boundary-" + shape, "delegation prompt")
SHAPES = {
    "mixed": [
        boundary, attachment(), attachment(),
        assistant(OPUS, "high"), assistant(OPUS), assistant(OPUS, "xhigh"), assistant(OPUS),
        attachment("low"),
    ],
    "single": [
        boundary, attachment(), assistant(OPUS, "high"), assistant(OPUS),
        assistant(OPUS, "high"), attachment("max"),
    ],
    "haiku-only": [boundary, attachment(), assistant(HAIKU), assistant(HAIKU), attachment("low")],
    "synthetic-only": [boundary, synthetic_notice(), attachment("low")],
    "no-assistant": [boundary, attachment("low"), attachment()],
}
earlier_turn = [user("earlier-" + shape, "earlier prompt"), assistant(OPUS, "max")]
subdir = os.path.join(sessdir, "transcript", "subagents")
os.makedirs(subdir, exist_ok=True)
files = {
    os.path.join(sessdir, "transcript.jsonl"): earlier_turn + SHAPES[shape],
    os.path.join(subdir, "agent-" + shape + ".jsonl"): SHAPES[shape],
}
for path, records in files.items():
    with open(path, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")
PY
}

# Ordered projection of the row identity + token payload — a stable snapshot for
# the idempotency equality check (independent of id / inserted_at / cost).
_eph_snapshot() {
  _eph_q "SELECT string_agg(
            kind || '|' || coalesce(dedup_key, '') || '|' ||
            input_tokens || '|' || output_tokens || '|' ||
            cache_read_tokens || '|' || cache_creation_tokens,
            ',' ORDER BY kind, dedup_key)
          FROM core.cost_events;"
}

# Fire the Stop hook once, redirected to the ephemeral cluster. Clears the
# subagent mtime cache first so EVERY row (turn + subagent) travels the UPSERT on
# each fire — the mtime cache is a documented optimization, not correctness, so
# forcing a full re-scan is the stronger characterization. $1 = optional stderr
# capture file. Positional args into `bash -c` avoid any interpolation injection.
_fire_stop() {
  _fire_stop_on "${EPH_SID}" "${EPH_TX}" "${1:-/dev/null}"
}

# $1 = session id, $2 = transcript path, $3 = optional stderr capture file.
_fire_stop_on() {
  local stderr_file="${3:-/dev/null}"
  if ga_guard_path "${EPH_HOME}"; then rm -rf -- "${EPH_HOME:?}/.glass-atrium/logs/cost-subagent-mtime"; fi
  local stdin_json
  stdin_json="$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"/tmp","permission_mode":"default","hook_event_name":"Stop"}' \
    "${1}" "${2}")"
  env HOME="${EPH_HOME}" PYTHONPATH="${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    PRICING_REMOTE_DISABLE=1 COST_TRACKER_TODAY="2026-07-02" CLAUDE_SESSION_ID='' \
    bash -c 'printf "%s" "$1" | "$2" 2>"$3"' _ "${stdin_json}" "${EPH_HOOK_SH}" "${stderr_file}"
}

# Definitive isolation gate: every fixture session (EPH_SID prefix) must have ZERO rows in
# production. PGHOST/PGPORT are never exported, but unset explicitly so this can
# only reach the production default socket. Production unreachable → isolation
# holds by construction (the hook only ever connects to the ephemeral PGHOST).
_assert_prod_isolated() {
  local leaked
  leaked="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.cost_events WHERE session_id LIKE '${EPH_SID}%';" \
    2>/dev/null || echo "SKIP")"
  [[ "${leaked}" == "SKIP" ]] && return 0
  [[ "${leaked}" -eq 0 ]] || {
    echo "ISOLATION BREACH: ${leaked} fixture rows reached production" >&2
    return 1
  }
}

@test "SUM-invariance: token totals and row count are preserved through the per-row dual-write" {
  _eph_q "TRUNCATE core.cost_events;" || return 1
  _fire_stop || return 1

  local rows tok turns subs
  rows="$(_eph_q "SELECT count(*) FROM core.cost_events;")" || return 1
  tok="$(_eph_q "SELECT coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) FROM core.cost_events;")" || return 1
  turns="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE kind = 'turn';")" || return 1
  subs="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE kind = 'subagent';")" || return 1

  [[ "${rows}" -eq "${EPH_EXPECT_ROWS}" ]] || { echo "row count ${rows} != ${EPH_EXPECT_ROWS}" >&2; return 1; }
  [[ "${tok}" -eq "${EPH_EXPECT_TOKENS}" ]] || { echo "token sum ${tok} != ${EPH_EXPECT_TOKENS}" >&2; return 1; }
  # 1 main turn + 2 subagent partition (the row-count shape the refactor pins).
  [[ "${turns}" -eq 1 ]] || { echo "turn rows ${turns} != 1" >&2; return 1; }
  [[ "${subs}" -eq 2 ]] || { echo "subagent rows ${subs} != 2" >&2; return 1; }

  _assert_prod_isolated || return 1
}

@test "UPSERT idempotency: re-firing the same Stop re-aggregates identical rows (never doubles)" {
  _eph_q "TRUNCATE core.cost_events;" || return 1

  _fire_stop || return 1
  local snap1
  snap1="$(_eph_snapshot)" || return 1

  _fire_stop || return 1
  local snap2
  snap2="$(_eph_snapshot)" || return 1

  # Same (session_id, dedup_key) rows, same token payload — DO UPDATE, not INSERT.
  [[ "${snap1}" == "${snap2}" ]] || { echo "snapshot changed:\n  fire1=[${snap1}]\n  fire2=[${snap2}]" >&2; return 1; }

  # And the totals are still the single-fire partition — not doubled, not additive.
  local rows tok
  rows="$(_eph_q "SELECT count(*) FROM core.cost_events;")" || return 1
  tok="$(_eph_q "SELECT coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) FROM core.cost_events;")" || return 1
  [[ "${rows}" -eq "${EPH_EXPECT_ROWS}" ]] || { echo "rows doubled: ${rows} != ${EPH_EXPECT_ROWS}" >&2; return 1; }
  [[ "${tok}" -eq "${EPH_EXPECT_TOKENS}" ]] || { echo "tokens additive: ${tok} != ${EPH_EXPECT_TOKENS}" >&2; return 1; }

  _assert_prod_isolated || return 1
}

@test "batch path fires exactly ONE writer subprocess per Stop (perf-invariant)" {
  _eph_q "TRUNCATE core.cost_events;" || return 1

  # Count writer subprocesses via a python3 shim on PATH. The parser + driver run
  # as `python3 -c ...` (no helper-path arg → no match); ONLY the writer runs as
  # `python3 .../_pg_dual_write.py`. The old per-row fan-out fired N writers (3
  # here — 1 turn + 2 subagent); the batch path MUST collapse it to exactly 1.
  local shimbin="${BATS_TEST_TMPDIR}/shimbin"
  local countfile="${BATS_TEST_TMPDIR}/writer.count"
  local real_py3
  real_py3="$(command -v python3)"
  mkdir -p "${shimbin}"
  : >"${countfile}"
  cat >"${shimbin}/python3" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\${a}" in
    *_pg_dual_write.py) printf 'x' >>"${countfile}" ;;
  esac
done
exec "${real_py3}" "\$@"
EOF
  chmod +x "${shimbin}/python3"

  if ga_guard_path "${EPH_HOME}"; then rm -rf -- "${EPH_HOME:?}/.glass-atrium/logs/cost-subagent-mtime"; fi
  local stdin_json
  stdin_json="$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"/tmp","permission_mode":"default","hook_event_name":"Stop"}' \
    "${EPH_SID}" "${EPH_TX}")"
  env PATH="${shimbin}:${PATH}" HOME="${EPH_HOME}" PYTHONPATH="${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    PRICING_REMOTE_DISABLE=1 COST_TRACKER_TODAY="2026-07-02" CLAUDE_SESSION_ID='' \
    bash -c 'printf "%s" "$1" | "$2" 2>/dev/null' _ "${stdin_json}" "${EPH_HOOK_SH}" || return 1

  local writer_calls
  writer_calls="$(wc -c <"${countfile}" | tr -d '[:space:]')"
  [[ "${writer_calls}" -eq 1 ]] || { echo "writer subprocess count ${writer_calls} != 1 (batch not single-invocation)" >&2; return 1; }

  # The single batch invocation still lands the full 3-row / 2600-token partition.
  local rows tok
  rows="$(_eph_q "SELECT count(*) FROM core.cost_events;")" || return 1
  tok="$(_eph_q "SELECT coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) FROM core.cost_events;")" || return 1
  [[ "${rows}" -eq "${EPH_EXPECT_ROWS}" ]] || { echo "row count ${rows} != ${EPH_EXPECT_ROWS}" >&2; return 1; }
  [[ "${tok}" -eq "${EPH_EXPECT_TOKENS}" ]] || { echo "token sum ${tok} != ${EPH_EXPECT_TOKENS}" >&2; return 1; }

  _assert_prod_isolated || return 1
}

@test "partial-success: a mid-batch execute failure commits both siblings, exits 3, loud-fails the bad row" {
  _eph_q "TRUNCATE core.cost_events;" || return 1

  # A mixed [good, bad, good] batch fed DIRECTLY to _pg_dual_write.py. The middle
  # row keeps an allowlisted target + columns (so it PASSES the identifier gate)
  # but carries a non-numeric input_tokens, so it fails at execute against the
  # bigint column — the riskiest partial-success path. `session_id` = EPH_SID so
  # the isolation gate covers these rows too; distinct dedup_keys avoid the
  # (session_id, dedup_key) UPSERT collapsing the two good rows into one.
  local envelope
  envelope=$(
    cat <<JSON
{"hook_name":"cost-tracker","target_table":"core.cost_events","payload_ref":"${EPH_SID}","rows":[
{"event_date":"2026-07-02","event_time":"12:00:00","session_id":"${EPH_SID}","kind":"turn","dedup_key":"partial-good-1","input_tokens":1000,"output_tokens":500,"cache_read_tokens":100,"cache_creation_tokens":200,"cost_usd":0.01,"duration_ms":100,"num_turns":1,"parse_error":false},
{"event_date":"2026-07-02","event_time":"12:00:00","session_id":"${EPH_SID}","kind":"turn","dedup_key":"partial-bad","input_tokens":"not-a-number","output_tokens":500,"cache_read_tokens":0,"cache_creation_tokens":0,"cost_usd":0.01,"duration_ms":100,"num_turns":1,"parse_error":false},
{"event_date":"2026-07-02","event_time":"12:00:00","session_id":"${EPH_SID}","kind":"turn","dedup_key":"partial-good-2","input_tokens":2000,"output_tokens":100,"cache_read_tokens":50,"cache_creation_tokens":0,"cost_usd":0.01,"duration_ms":100,"num_turns":1,"parse_error":false}
]}
JSON
  )

  # Positional args into `bash -c` avoid any interpolation injection. The pipeline
  # exit is the writer's (last stage), so ${status} is the writer's exit code.
  local writer_stderr="${BATS_TEST_TMPDIR}/partial.stderr"
  run env HOME="${EPH_HOME}" PYTHONPATH="${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    bash -c 'printf "%s" "$1" | python3 "$2" 2>"$3"' _ "${envelope}" "${EPH_WRITER_PY}" "${writer_stderr}"

  # Named partial-success exit code (3) — the batch had a failed row.
  [[ "${status}" -eq 3 ]] || { echo "writer exit ${status} != 3 (partial-success code)"; cat "${writer_stderr}"; return 1; }

  # BOTH valid siblings committed — the good-row count is exactly 2.
  local good_rows
  good_rows="$(_eph_q "SELECT count(*) FROM core.cost_events;")" || return 1
  [[ "${good_rows}" -eq 2 ]] || { echo "committed rows ${good_rows} != 2 (siblings did not both survive)"; return 1; }

  # The row AFTER the failure committed — the definitive proof that autocommit=True
  # keeps the mid-batch failure from poisoning the connection for later rows.
  local after_row
  after_row="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE dedup_key = 'partial-good-2';")" || return 1
  [[ "${after_row}" -eq 1 ]] || { echo "post-failure row missing (aborted-transaction poisoning)"; return 1; }

  # The row BEFORE the failure also committed.
  local before_row
  before_row="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE dedup_key = 'partial-good-1';")" || return 1
  [[ "${before_row}" -eq 1 ]] || { echo "pre-failure row missing"; return 1; }

  # The failing row never landed.
  local bad_row
  bad_row="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE dedup_key = 'partial-bad';")" || return 1
  [[ "${bad_row}" -eq 0 ]] || { echo "the bad row unexpectedly committed"; return 1; }

  # The structured per-row loud-fail line fired for the failed row (stderr JSON).
  grep -q '"dedup_key":"partial-bad"' "${writer_stderr}" || { echo "no structured per-row stderr for the failed row"; cat "${writer_stderr}"; return 1; }

  _assert_prod_isolated || return 1
}

@test "effort and the mixed-tier flag land beside model on turn and subagent rows" {
  _eph_q "TRUNCATE core.cost_events;" || return 1
  # shape|want — want is the same on the turn (backward scan) and the subagent (forward scan) row.
  local rows=(
    "mixed|xhigh|true"
    "single|high|false"
    "haiku-only|<null>|<null>"
    "synthetic-only|<null>|<null>"
    "no-assistant|<null>|<null>"
  )
  local row shape want sid sessdir turn sub
  for row in "${rows[@]}"; do
    shape="${row%%|*}" want="${row#*|}"
    sid="${EPH_SID}-effort-${shape}"
    sessdir="${BATS_TEST_TMPDIR}/${shape}"
    _write_effort_session "${shape}" "${sessdir}" || return 1
    _fire_stop_on "${sid}" "${sessdir}/transcript.jsonl" || return 1
    turn="$(_eph_effort "${sid}" turn)" || return 1
    sub="$(_eph_effort "${sid}" subagent)" || return 1
    [[ "${turn}" == "${want}" && "${sub}" == "${want}" ]] || {
      echo "${shape}: want '${want}' on both rows, got turn='${turn}' subagent='${sub}'"
      return 1
    }
  done

  _assert_prod_isolated || return 1
}

@test "a re-fire refreshes effort and the mixed-tier flag on the same rows" {
  _eph_q "TRUNCATE core.cost_events;" || return 1
  local sid="${EPH_SID}-effort-refire" sessdir="${BATS_TEST_TMPDIR}/refire" late n turn sub
  _write_effort_session single "${sessdir}" || return 1
  _fire_stop_on "${sid}" "${sessdir}/transcript.jsonl" || return 1
  late='{"type":"assistant","effort":"xhigh","message":{"role":"assistant","id":"msg-late","model":"claude-opus-4-8","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}'
  printf '%s\n' "${late}" >>"${sessdir}/transcript.jsonl" || return 1
  printf '%s\n' "${late}" >>"${sessdir}/transcript/subagents/agent-single.jsonl" || return 1

  _fire_stop_on "${sid}" "${sessdir}/transcript.jsonl" || return 1

  n="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE session_id = '${sid}';")" || return 1
  turn="$(_eph_effort "${sid}" turn)" || return 1
  sub="$(_eph_effort "${sid}" subagent)" || return 1
  [[ "${n}" == "2" && "${turn}" == "xhigh|true" && "${sub}" == "xhigh|true" ]] || {
    echo "want 2 rows at 'xhigh|true', got rows=${n} turn='${turn}' subagent='${sub}'"
    return 1
  }
}

@test "a schema without the effort columns still writes the cost rows" {
  _eph_q "TRUNCATE core.cost_events;" || return 1
  local sid="${EPH_SID}-effort-premigration" sessdir="${BATS_TEST_TMPDIR}/premigration"
  local err="${BATS_TEST_TMPDIR}/premigration.stderr" st=0 n
  _write_effort_session mixed "${sessdir}" || return 1
  _eph_q "ALTER TABLE core.cost_events DROP COLUMN effort, DROP COLUMN has_mixed_effort;" || return 1
  _fire_stop_on "${sid}" "${sessdir}/transcript.jsonl" "${err}" || st=$?
  _eph_apply_migration || return 1

  n="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE session_id = '${sid}' AND input_tokens > 0;")" || return 1
  [[ "${st}" -eq 0 && "${n}" == "2" ]] || {
    echo "hook exit ${st}, token rows ${n} != 2:"
    cat -- "${err}"
    return 1
  }
}
