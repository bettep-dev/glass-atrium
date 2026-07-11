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
# HOME override: HOOK_LOG_DIR is ${HOME}/.claude/logs (the subagent mtime
# cache), so HOME is repointed to a temp dir — the run leaves NO artifact under
# the real ~/.claude. psycopg lives in the HOME-derived PEP 370 user
# site-packages, so PYTHONPATH carries the REAL user-site (captured before the
# override) to keep the import alive.

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

  # Production baseline total (default socket; PGHOST/PGPORT are never exported,
  # so this hits production) — informational only, reported in teardown_file.
  export EPH_PROD_BEFORE
  EPH_PROD_BEFORE="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.cost_events;" 2>/dev/null || echo "unavailable")"

  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_DB}" || return 1
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
  local stderr_file="${1:-/dev/null}"
  rm -rf "${EPH_HOME}/.claude/logs/cost-subagent-mtime" 2>/dev/null || true
  local stdin_json
  stdin_json="$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"/tmp","permission_mode":"default","hook_event_name":"Stop"}' \
    "${EPH_SID}" "${EPH_TX}")"
  env HOME="${EPH_HOME}" PYTHONPATH="${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" \
    PRICING_REMOTE_DISABLE=1 COST_TRACKER_TODAY="2026-07-02" CLAUDE_SESSION_ID='' \
    bash -c 'printf "%s" "$1" | "$2" 2>"$3"' _ "${stdin_json}" "${EPH_HOOK_SH}" "${stderr_file}"
}

# Definitive isolation gate: the fixture session must have ZERO rows in
# production. PGHOST/PGPORT are never exported, but unset explicitly so this can
# only reach the production default socket. Production unreachable → isolation
# holds by construction (the hook only ever connects to the ephemeral PGHOST).
_assert_prod_isolated() {
  local leaked
  leaked="$(env -u PGHOST -u PGPORT psql -d "${EPH_DB}" -tAqc \
    "SELECT count(*) FROM core.cost_events WHERE session_id = '${EPH_SID}';" \
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
