#!/usr/bin/env bats
# advisory-read-cache.bats — short-TTL per-session read-cache suite for the two PreToolUse(Agent)
# advisory hooks (advisory-context-budget.sh + advisory-spawn-cost.sh).
#
# Both hooks import psycopg + open a FRESH DB connect on every manual Agent spawn just to read one
# budget/cost integer. The shared hook_cache_read/hook_cache_write helpers (hook-utils.sh) add a
# short-TTL per-session cache so repeated same-session spawns reuse the last read. The cache is an
# optimization ONLY — the advisory value/verdict for a fixed input MUST be identical to the uncached
# path, and any cache anomaly (stale / bypassed / corrupt / no-key) falls back to the live read.
#
# Assertions proven here (per the GOAL):
#   (1) two spawns within TTL → exactly ONE psycopg connect (2nd is a cache hit)
#   (2) a TTL-expired / bypassed cache re-reads live (connect fires again; stale value discarded)
#   (3) the advisory value on a cache hit equals the uncached path's value (verdict parity)
#   (4) a corrupt/unreadable cache fails OPEN to the live read (advisory still fires)
#
# Hermetic: psycopg is a fake module on PYTHONPATH that tallies each connect() into a count file and
# returns a canned value — no live DB, no live monitor. HOME + the cache dir are redirected under
# mktemp, so no real ~/.claude write. The DB-read python3 -c calls psycopg.connect (counted); the
# hooks' JSON-parse python3 calls import only json (never psycopg), so the tally counts DB reads only.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
CTX_HOOK="${GA}/hooks/advisory-context-budget.sh"
COST_HOOK="${GA}/hooks/advisory-spawn-cost.sh"

setup() {
  [[ -f "${CTX_HOOK}" ]] || skip "hook not found: ${CTX_HOOK}"
  [[ -f "${COST_HOOK}" ]] || skip "hook not found: ${COST_HOOK}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"

  WORK="$(mktemp -d -t advisory-read-cache.XXXXXX)"
  PYDIR="${WORK}/pypath"
  CACHE_DIR="${WORK}/cache"
  CONNCOUNT="${WORK}/connect.count"
  mkdir -p "${PYDIR}"
  : >"${CONNCOUNT}"

  # Fake psycopg: tally one char per connect(), return a canned single-column row (FAKE_PG_VALUE).
  # Mirrors the exact API the hooks use: connect() → context-manager conn → cursor() → context-manager
  # cur → execute(sql, params) → fetchone() == (value,).
  cat >"${PYDIR}/psycopg.py" <<'PY'
import os


class _Cur:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        return None

    def fetchone(self):
        return (int(os.environ.get("FAKE_PG_VALUE", "0")),)


class _Conn:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _Cur()


def connect(*a, **k):
    cf = os.environ.get("FAKE_PG_CONNECT_COUNT_FILE")
    if cf:
        with open(cf, "a") as fh:
            fh.write("x")
    return _Conn()
PY
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Total psycopg connects observed so far (one tally char per live DB read).
conn_count() { wc -c <"${CONNCOUNT}" | tr -d '[:space:]'; }

# Pre-seed a per-session cache file (line1=epoch, line2=value). $1=hook_env_prefix cache dir already
# fixed; $2=session_id $3=epoch $4=value.
seed_cache() {
  local sid="${2}" safe_sid
  safe_sid="$(printf '%s' "${sid}" | tr -cd 'A-Za-z0-9_-')"
  mkdir -p "${CACHE_DIR}"
  {
    printf '%s\n' "${3}"
    printf '%s\n' "${4}"
  } >"${CACHE_DIR}/${safe_sid}.cache"
}

# Fire advisory-context-budget.sh once. FAKE_PG_VALUE drives the DB read; threshold forced low so the
# advisory fires (a value to compare). CONTEXT_ADVISORY_TEST_TOKENS unset → the fake-psycopg DB path
# runs. Ambient CACHE_TTL/BYPASS toggles inherit. stderr merged into $output.
run_ctx() {
  local sid="${1}" input
  input="$(jq -n --arg sid "${sid}" '{tool_name:"Agent", session_id:$sid}')"
  run env -u CONTEXT_ADVISORY_TEST_TOKENS \
    HOME="${WORK}" \
    PYTHONPATH="${PYDIR}" \
    FAKE_PG_VALUE="${FAKE_PG_VALUE:-500000}" \
    FAKE_PG_CONNECT_COUNT_FILE="${CONNCOUNT}" \
    CONTEXT_BUDGET_ADVISORY_CACHE_DIR="${CACHE_DIR}" \
    CONTEXT_BUDGET_ADVISORY_THRESHOLD="${CTX_THRESH:-100000}" \
    bash -c 'bash "$0" 2>&1' "${CTX_HOOK}" <<<"${input}"
}

# Fire advisory-spawn-cost.sh once. Threshold is hardcoded 2000000 → FAKE_PG_VALUE above it fires.
run_cost() {
  local sid="${1}" input
  input="$(jq -n --arg sid "${sid}" '{tool_name:"Agent", session_id:$sid}')"
  run env -u COST_ADVISORY_TEST_TOKENS \
    HOME="${WORK}" \
    PYTHONPATH="${PYDIR}" \
    FAKE_PG_VALUE="${FAKE_PG_VALUE:-3000000}" \
    FAKE_PG_CONNECT_COUNT_FILE="${CONNCOUNT}" \
    SPAWN_COST_ADVISORY_CACHE_DIR="${CACHE_DIR}" \
    bash -c 'bash "$0" 2>&1' "${COST_HOOK}" <<<"${input}"
}

# ---- advisory-context-budget.sh ------------------------------------------------------------------

@test "ctx: two spawns within TTL → ONE psycopg connect (2nd is a cache hit)" {
  local sid="sess-ctx-hit"
  run_ctx "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "1st exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"context-budget-advisory"* ]] || { echo "1st advisory missing: ${output}" >&2; return 1; }
  local c1
  c1="$(conn_count)"
  [[ "${c1}" -eq 1 ]] || { echo "1st spawn connect count ${c1} != 1" >&2; return 1; }

  run_ctx "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "2nd exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"context-budget-advisory"* ]] || { echo "2nd advisory missing: ${output}" >&2; return 1; }
  local c2
  c2="$(conn_count)"
  [[ "${c2}" -eq 1 ]] || { echo "2nd spawn re-connected; total ${c2} != 1 (cache miss)" >&2; return 1; }
}

@test "ctx: cache hit value equals uncached path value (verdict parity, ~500k both spawns)" {
  local sid="sess-ctx-parity"
  run_ctx "${sid}"
  [[ "${output}" == *"~500k"* ]] || { echo "1st(live) value not 500k: ${output}" >&2; return 1; }

  run_ctx "${sid}"
  [[ "${output}" == *"~500k"* ]] || { echo "2nd(cached) value drifted from live: ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 1 ]] || { echo "parity check re-read live; count ${c} != 1" >&2; return 1; }
}

@test "ctx: fresh seeded cache drives the value with ZERO connects (hit proof)" {
  # Cache value (600000) differs from the live FAKE_PG_VALUE (500000): a 600k advisory + zero connects
  # proves the CACHED value (not the DB) drove the verdict.
  local sid="sess-ctx-seeded"
  seed_cache _ "${sid}" "$(date +%s)" 600000
  run_ctx "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"~600k"* ]] || { echo "cached value ignored (expected 600k): ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 0 ]] || { echo "cache hit still connected ${c} != 0" >&2; return 1; }
}

@test "ctx: TTL-expired cache is discarded → live re-read (stale value ignored)" {
  # A stale cache (epoch 100) whitelisting 600k must be discarded; the LIVE 500k must win + connect.
  local sid="sess-ctx-stale"
  seed_cache _ "${sid}" 100 600000
  run_ctx "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"~500k"* ]] || { echo "stale cache used instead of live: ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 1 ]] || { echo "TTL-expired path connect count ${c} != 1" >&2; return 1; }
}

@test "ctx: CACHE_BYPASS forces a live read despite a fresh valid cache" {
  local sid="sess-ctx-bypass"
  seed_cache _ "${sid}" "$(date +%s)" 600000
  export CONTEXT_BUDGET_ADVISORY_CACHE_BYPASS=1
  run_ctx "${sid}"
  [[ "${output}" == *"~500k"* ]] || { echo "bypass used the cache (expected live 500k): ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 1 ]] || { echo "bypass connect count ${c} != 1" >&2; return 1; }
}

@test "ctx: corrupt cache fails OPEN to the live read (advisory still fires)" {
  local sid="sess-ctx-corrupt" safe_sid
  safe_sid="$(printf '%s' "${sid}" | tr -cd 'A-Za-z0-9_-')"
  mkdir -p "${CACHE_DIR}"
  printf 'not-an-integer\ngarbage\n' >"${CACHE_DIR}/${safe_sid}.cache"
  run_ctx "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"context-budget-advisory"* ]] || { echo "corrupt cache suppressed advisory: ${output}" >&2; return 1; }
  [[ "${output}" == *"~500k"* ]] || { echo "corrupt cache not fail-open to live: ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 1 ]] || { echo "corrupt-cache connect count ${c} != 1" >&2; return 1; }
}

@test "ctx: empty session id short-circuits before any read (no advisory, zero connects)" {
  # The hook fail-opens on an absent session_id (step 2) BEFORE the token read, so the cache path is
  # never reached — proves the pre-existing short-circuit still holds after the caching change.
  run_ctx ""
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" != *"context-budget-advisory"* ]] || { echo "advisory fired on empty session: ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 0 ]] || { echo "empty session still connected ${c} != 0" >&2; return 1; }
}

# ---- advisory-spawn-cost.sh (shared helper — representative coverage) -----------------------------

@test "cost: two spawns within TTL → ONE psycopg connect (2nd is a cache hit)" {
  local sid="sess-cost-hit"
  run_cost "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "1st exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"agent-spawn-cost-advisory"* ]] || { echo "1st advisory missing: ${output}" >&2; return 1; }
  local c1
  c1="$(conn_count)"
  [[ "${c1}" -eq 1 ]] || { echo "1st spawn connect count ${c1} != 1" >&2; return 1; }

  run_cost "${sid}"
  [[ "${output}" == *"agent-spawn-cost-advisory"* ]] || { echo "2nd advisory missing: ${output}" >&2; return 1; }
  local c2
  c2="$(conn_count)"
  [[ "${c2}" -eq 1 ]] || { echo "2nd spawn re-connected; total ${c2} != 1 (cache miss)" >&2; return 1; }
}

@test "cost: fresh seeded cache drives the value with ZERO connects (hit proof + parity)" {
  # Cached 4000000 differs from live FAKE_PG_VALUE 3000000 → a 4000k advisory + zero connects proves
  # the cached value drove the verdict identically to a live read of that number.
  local sid="sess-cost-seeded"
  seed_cache _ "${sid}" "$(date +%s)" 4000000
  run_cost "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"~4000k"* ]] || { echo "cached value ignored (expected 4000k): ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 0 ]] || { echo "cache hit still connected ${c} != 0" >&2; return 1; }
}

@test "cost: corrupt cache fails OPEN to the live read (advisory still fires)" {
  local sid="sess-cost-corrupt" safe_sid
  safe_sid="$(printf '%s' "${sid}" | tr -cd 'A-Za-z0-9_-')"
  mkdir -p "${CACHE_DIR}"
  printf 'xyz\nabc\n' >"${CACHE_DIR}/${safe_sid}.cache"
  run_cost "${sid}"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *"agent-spawn-cost-advisory"* ]] || { echo "corrupt cache suppressed advisory: ${output}" >&2; return 1; }
  [[ "${output}" == *"~3000k"* ]] || { echo "corrupt cache not fail-open to live: ${output}" >&2; return 1; }
  local c
  c="$(conn_count)"
  [[ "${c}" -eq 1 ]] || { echo "corrupt-cache connect count ${c} != 1" >&2; return 1; }
}
