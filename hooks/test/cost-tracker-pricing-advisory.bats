#!/usr/bin/env bats
# cost-tracker-pricing-advisory.bats — Bats suite for the cost-tracker Stop hook
#   pricing advisories over the pricing.json SoT + shared pricing_loader
#   (CID 2026-07-02T1055_pricing-sot_e7b2, plan task P5; supersedes the T13a
#   lockstep-era suite — cost math semantics preserved, advisory contract now
#   keyed on the loader's resolution label).
#
# Covered cases (advisory only where noted; cost math anchors preserved):
#   1. known model + fresh baseline → priced + SILENT (no advisory), exit 0
#   2. unknown model → stderr advisory model=unknown:<id> resolution=fallback
#      + structured DATA-183 emit + still recorded
#   3. stale baseline → staleness advisory naming age + window (from the SoT)
#   4. cost math anchor — known opus-4-8 1000in/500out → cost_usd=0.0175
#   5. unknown model is NOT zero-priced — fallback_model (fable-5, the most
#      expensive row) prices it at 0.035; row recorded, model id preserved
#   6. dated id (claude-haiku-4-5-20251001) → haiku rate 0.0035 via
#      normalize_model_key (sot resolution, no advisory)
#   7. fable-5 → first-class SoT row at 10/50 rates (0.035), no advisory
#   8. each zero-cost id of the parity table (fixtures/model-id-pricing-parity.json:
#      missing model field, '', '<synthetic>')
#      → no advisory, no DATA-183, clean $0 row despite billable usage
#   9. each near miss of a zero-cost id → walks the resolution chain:
#      fallback price + model=unknown:<id> advisory
#  10. synthetic sonnet-5 launch window (fixture tier) — COST_TRACKER_TODAY 2026-08-31 →
#      intro 0.007, 2026-09-01 → standard 0.0105 (tier-by-date in the loader)
#  11. family-matched NEW id (claude-opus-4-9) → older-family rate 0.0175 +
#      model=unknown:<id> resolution=family_latest + DATA-183 — the
#      under-billing surfacing guard (silent family pricing is forbidden)
#  12. corrupt pricing SoT → parser crash is LOUD: PricingSotError text
#      relayed to the hook's stderr, distinct DATA-184 emitted, non-zero
#      NON-2 exit (Stop-hook exit 2 has blocking semantics)
#  13. symlinked invocation (production ~/.claude/hooks topology) → the
#      PRICING_LIB_DIR derivation canonicalizes BASH_SOURCE, so the loader
#      imports from the REAL hooks/lib: exit 0, no ModuleNotFoundError,
#      no DATA-184, pricing resolution demonstrably ran
#  14. unknown model on a live schema → cost row priced by the fallback,
#      advisory on stderr, no core.hook_failures row (a pricing gap is no
#      write failure)
#  15. failed cost write, known or unknown model → exactly one
#      core.hook_failures row, naming the session
#
# Isolation:
#   * COST_TRACKER_TODAY injects a deterministic "today" (no wall clock).
#   * PRICING_SOT_PATH points at a per-test fixture SoT with a PINNED
#     last_verified (2026-07-02) + window (90) — production pricing.json
#     edits (rate rows, last_verified bumps) never break this suite.
#   * PRICING_REMOTE_DISABLE=1 guarantees ZERO network I/O: the loader's
#     remote step is gated off, unknown models resolve family/fallback.
#   * PRICING_LIB_DIR points the sliced parser at hooks/lib — the hook shell
#     exports it itself, but parser-direct runs must supply it (the heredoc
#     runs under `python3 -c`, where __file__ is absent).
#   * Cases 1-13: PGHOST forced to a nonexistent socket → the PG dual-write
#     fails open (advisory/pricing path exercised without a live DB).
#   * Cases 14-15: an ephemeral cluster (lib/ephemeral-pg.bash) carrying the
#     real migration chain, re-created per test from a template; PGHOST/PGPORT
#     redirect the hook there and eph_assert_isolated proves no other target.
#   * Synthetic transcript jsonl via mktemp (no live transcript dependency).

# BATS_TEST_DIRNAME is assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154
HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/cost-tracker.sh"

# Same date as the fixture SoT last_verified → age 0 → staleness silent.
FRESH_TODAY="2026-07-02"

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"
# shellcheck source=SCRIPTDIR/lib/ephemeral-pg.bash
source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"

# Missing PostgreSQL tooling skips only the cases that call _eph_reset_db.
setup_file() {
  local bin
  for bin in initdb pg_ctl createdb dropdb psql python3; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      export EPH_SKIP="missing required tool: ${bin} (PostgreSQL client/server + python3)"
      return 0
    fi
  done
  export EPH_DATADIR="${BATS_FILE_TMPDIR}/pgdata" EPH_SOCKDIR="${BATS_FILE_TMPDIR}/sock" \
    EPH_PORT="55475" EPH_DB="glass_atrium" EPH_TEMPLATE="eph_cost_tpl"
  # psycopg sits in the PEP 370 user site, which the per-test HOME override would hide.
  export EPH_USER_SITE
  EPH_USER_SITE="$(python3 -m site --user-site)"
  # eph_pg_start's hand DDL lands on the bootstrap DB; the template gets the real migrations.
  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "eph_boot" || return 1
  eph_pg_create_migrated_db "${EPH_SOCKDIR}" "${EPH_PORT}" "${EPH_TEMPLATE}" || return 1
}

teardown_file() {
  if [[ -z "${EPH_SKIP:-}" ]]; then
    eph_pg_stop "${EPH_DATADIR}"
  fi
}

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/cost-tracker-bats.XXXXXX")"
  # Absolute even under a relative TMPDIR — the teardown guard refuses a relative target.
  TEST_TMP="$(cd -- "${TEST_TMP}" && pwd -P)"
  FIXTURE_SOT="${TEST_TMP}/pricing.json"
  # Fixture SoT: value-aligned with the production rows the cases anchor on
  # (opus-4-8, fable-5 fallback, haiku-4-5) plus a synthetic sonnet-5 tier, with a
  # pinned last_verified so the staleness cases stay deterministic forever.
  cat >"${FIXTURE_SOT}" <<'JSON'
{
  "schema_version": 1,
  "last_verified": "2026-07-02",
  "stale_after_days": 90,
  "currency": "USD",
  "unit": "per_mtok",
  "fallback_model": "claude-fable-5",
  "remote_sources": [
    {
      "name": "own-repo",
      "url": "https://raw.githubusercontent.com/bettep-dev/glass-atrium/main/hooks/pricing.json",
      "format": "sot",
      "timeout_seconds": 3
    },
    {
      "name": "litellm",
      "url": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      "format": "litellm",
      "timeout_seconds": 3
    }
  ],
  "overlay_cache_path": "data/pricing-remote-overlay.json",
  "overlay_ttl_hours": 24,
  "models": {
    "claude-opus-4-8": {"input": 5.0, "output": 25.0, "cache_read": 0.5, "cache_creation": 6.25},
    "claude-fable-5": {"input": 10.0, "output": 50.0, "cache_read": 1.0, "cache_creation": 12.5},
    "claude-sonnet-5": {
      "input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_creation": 3.75,
      "tiers": [
        {"until": "2026-08-31", "input": 2.0, "output": 10.0, "cache_read": 0.2, "cache_creation": 2.5}
      ]
    },
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0, "cache_read": 0.1, "cache_creation": 1.25}
  }
}
JSON
}

teardown() {
  if ga_guard_path "${TEST_TMP:-}"; then rm -rf -- "${TEST_TMP:?}"; fi
}

# Write a synthetic single-turn transcript: one user line + one assistant
# message carrying usage for the given model. Token counts override (args 3/4)
# defaults 1000 input / 500 output — the harness-synthetic case needs 0/0.
_make_transcript() {
  local model="${1}" out="${2}" in_tok="${3:-1000}" out_tok="${4:-500}"
  {
    printf '%s\n' '{"type":"user","message":{"role":"user","content":"hi"}}'
    printf '{"type":"assistant","message":{"role":"assistant","id":"msg_t13a","model":"%s","stop_reason":"end_turn","usage":{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n' "${model}" "${in_tok}" "${out_tok}"
  } >"${out}"
}

# Variant WITHOUT a model field — reproduces the empty-model row shape (a usage
# record whose model is absent → parser emits model=null).
_make_transcript_no_model() {
  local out="${1}"
  {
    printf '%s\n' '{"type":"user","message":{"role":"user","content":"hi"}}'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","id":"msg_nomodel","stop_reason":"end_turn","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}'
  } >"${out}"
}

# Build the Stop hook stdin JSON for a transcript path.
_stop_input() {
  printf '{"session_id":"sess-t13a","transcript_path":"%s","cwd":"/tmp","permission_mode":"default","hook_event_name":"Stop"}' "${1}"
}

# Run the hook with deterministic 'today', the fixture SoT, remote gated off,
# fail-open PG, no env session leakage.
# Args: $1=transcript_path $2=today_iso $3=stderr_capture_file
_run_hook() {
  local xpath="${1}" today="${2}" stderr_file="${3}"
  local stdin_json
  stdin_json="$(_stop_input "${xpath}")"
  COST_TRACKER_TODAY="${today}" PGHOST="/nonexistent-socket-xyzzy" CLAUDE_SESSION_ID='' \
    PRICING_SOT_PATH="${FIXTURE_SOT}" PRICING_REMOTE_DISABLE=1 \
    run bash -c "printf '%s' '${stdin_json}' | '${HOOK_SH}' 2>'${stderr_file}'"
}

# Slice the embedded parser python out of the hook (between the PARSED=$( open
# and the `' 2>` close, stripping the first + last marker lines).
_parser_body() {
  # SC2312: the sed exit codes in this pipeline are deliberately unchecked —
  # an empty/failed slice cannot pass silently because every downstream parser
  # run asserts on the emitted JSON (an empty body yields no output → fail).
  # shellcheck disable=SC2312
  sed -n "/^PARSED=\$(DATE/,/^' 2>/p" "${HOOK_SH}" \
    | sed -n "/python3 -c '/,/^' 2>/p" | sed '1d;$d'
}

# Run the sliced parser body directly (cost-math assertions on its stdout
# JSON). The runner supplies the loader seams the hook shell would otherwise
# export: PRICING_LIB_DIR (sys.path insert target) + the fixture
# PRICING_SOT_PATH + the remote kill-switch (network-free guarantee).
# Args: $1=transcript_path $2=today_iso (also used as the emitted row date)
_run_parser() {
  local xpath="${1}" today="${2}"
  local parser_body
  parser_body="$(_parser_body)"
  run env DATE="${today}" TIME="01:00:00" SESSION_ID="sess-t13a" \
    TRANSCRIPT_PATH="${xpath}" COST_TRACKER_TODAY="${today}" \
    PRICING_LIB_DIR="${HOOKS_DIR}/lib" PRICING_SOT_PATH="${FIXTURE_SOT}" \
    PRICING_REMOTE_DISABLE=1 \
    python3 -c "${parser_body}"
}

# Fresh glass_atrium from the migrated template → no row or schema change crosses tests or rows.
_eph_reset_db() {
  if [[ -n "${EPH_SKIP:-}" ]]; then
    skip "${EPH_SKIP}"
  fi
  export GA_BATS_PG_RECORD="${BATS_TEST_TMPDIR:?}/pg-connect.log"
  : >"${GA_BATS_PG_RECORD}"
  PGOPTIONS='-c client_min_messages=warning' \
    dropdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" --if-exists "${EPH_DB}" || return 1
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -T "${EPH_TEMPLATE}" "${EPH_DB}"
}

_eph_q() {
  psql -X -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" -d "${EPH_DB}" -tAqc "${1}"
}

# Run the hook against the ephemeral cluster; a temp HOME keeps the subagent mtime cache out of
# the real tree. Positional args into `bash -c` avoid interpolation.
# Args: $1=transcript_path $2=stderr_capture_file
_run_hook_eph() {
  local stdin_json home="${TEST_TMP}/home"
  stdin_json="$(_stop_input "${1}")"
  mkdir -p "${home}"
  # shellcheck disable=SC2016 # $1-$3 expand in the child shell
  run env -u GA_DATA_ROOT HOME="${home}" PYTHONPATH="${EPH_PG_RECORDER_DIR}:${EPH_USER_SITE}" \
    PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}" COST_TRACKER_TODAY="${FRESH_TODAY}" \
    CLAUDE_SESSION_ID='' PRICING_SOT_PATH="${FIXTURE_SOT}" PRICING_REMOTE_DISABLE=1 \
    bash -c 'printf "%s" "$1" | "$2" 2>"$3"' _ "${stdin_json}" "${HOOK_SH}" "${2}"
}

# Case 1: known model + fresh baseline → priced + SILENT advisory-wise

@test "known model with fresh baseline prices silently (no pricing advisory) and exits 0" {
  local tx stderr_file
  tx="${TEST_TMP}/known.jsonl"
  stderr_file="${TEST_TMP}/err1.txt"
  _make_transcript "claude-opus-4-8" "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [[ "${status}" -eq 0 ]]
  local err
  err="$(cat "${stderr_file}")"
  # No pricing advisory on the happy path (sot resolution is silent).
  [[ ! "${err}" =~ "pricing baseline stale" ]]
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
}

# Case 2: unknown model → advisory names the model + resolution label

@test "unknown model emits STDERR advisory with resolution=fallback plus structured DATA-183" {
  local tx stderr_file
  tx="${TEST_TMP}/unknown.jsonl"
  stderr_file="${TEST_TMP}/err2.txt"
  _make_transcript "claude-foobar-9-9" "${tx}"
  # Fresh baseline date so ONLY the unknown-model advisory can fire.
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [[ "${status}" -eq 0 ]]
  local err
  err="$(cat "${stderr_file}")"
  # "model=unknown:" is the preserved DATA-183 grep anchor; the resolution
  # label is appended for operator triage (no foobar family in the SoT and
  # remote is gated off → the conservative fallback rung priced it).
  [[ "${err}" =~ "model=unknown:claude-foobar-9-9" ]]
  [[ "${err}" =~ "resolution=fallback" ]]
  # The structured DATA-183 emit carrying the model id.
  [[ "${err}" =~ '"error_code":"DATA-183"' ]]
  [[ "${err}" =~ '"models":"claude-foobar-9-9"' ]]
  # Staleness MUST NOT fire here (date is fresh) — isolates the unknown signal.
  [[ ! "${err}" =~ "pricing baseline stale" ]]
}

# Case 3: stale baseline → staleness advisory with age + window

@test "stale pricing baseline emits a STDERR staleness advisory and exits 0" {
  local tx stderr_file
  tx="${TEST_TMP}/known.jsonl"
  stderr_file="${TEST_TMP}/err3.txt"
  _make_transcript "claude-opus-4-8" "${tx}"
  # 'today' far past the fixture last_verified + 90d window → stale. Known
  # model → no unknown-model noise.
  _run_hook "${tx}" "2027-01-01" "${stderr_file}"
  [[ "${status}" -eq 0 ]]
  local err
  err="$(cat "${stderr_file}")"
  [[ "${err}" =~ "pricing baseline stale" ]]
  [[ "${err}" =~ "window=90" ]]
  # Known model → unknown-model advisory MUST NOT fire (isolates staleness).
  [[ ! "${err}" =~ "model=unknown" ]]
}

# Case 4: cost math regression guard (known model)

@test "known opus-4-8 1000in/500out computes cost_usd=0.0175 (corrected opus rates)" {
  local tx
  tx="${TEST_TMP}/known.jsonl"
  _make_transcript "claude-opus-4-8" "${tx}"
  _run_parser "${tx}" "${FRESH_TODAY}"
  [[ "${status}" -eq 0 ]]
  # (1000*5 + 500*25)/1e6 = 0.0175. Literal-substring match (glob, not regex)
  # so the '.' in the value is not treated as a regex metacharacter.
  [[ "${output}" == *'"cost_usd": 0.0175'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# Case 5: unknown model is NOT zero-priced (fable-5 fallback records cost)

@test "unknown model still records cost via most-expensive fable-5 fallback (not zero-priced)" {
  local tx
  tx="${TEST_TMP}/unknown.jsonl"
  _make_transcript "claude-foobar-9-9" "${tx}"
  _run_parser "${tx}" "${FRESH_TODAY}"
  [[ "${status}" -eq 0 ]]
  # fallback_model fable-5 (10/50, most expensive row) → (1000*10 + 500*50)/1e6
  # = 0.035; the row records (not zero, not error). Literal-substring (glob)
  # match to keep '.' out of regex context.
  [[ "${output}" == *'"cost_usd": 0.035'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
  # Model id is preserved as-emitted (so the dashboard shows the new model).
  [[ "${output}" == *'claude-foobar-9-9'* ]]
}

# Case 6: dated snapshot id resolves to its base row (NOT the fallback)

@test "dated claude-haiku-4-5-20251001 prices at haiku rates (0.0035), no unknown advisory" {
  local tx stderr_file
  tx="${TEST_TMP}/haiku-dated.jsonl"
  stderr_file="${TEST_TMP}/err6.txt"
  _make_transcript "claude-haiku-4-5-20251001" "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [[ "${status}" -eq 0 ]]
  local err
  err="$(cat "${stderr_file}")"
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
  _run_parser "${tx}" "${FRESH_TODAY}"
  [[ "${status}" -eq 0 ]]
  # (1000*1 + 500*5)/1e6 = 0.0035 — haiku rates, 1/10 of the fable-5 fallback.
  [[ "${output}" == *'"cost_usd": 0.0035'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# Case 7: fable-5 is a first-class SoT row at 10/50 rates

@test "claude-fable-5 prices at 10/50 rates (0.035) with no unknown advisory" {
  local tx stderr_file
  tx="${TEST_TMP}/fable.jsonl"
  stderr_file="${TEST_TMP}/err7.txt"
  _make_transcript "claude-fable-5" "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [[ "${status}" -eq 0 ]]
  local err
  err="$(cat "${stderr_file}")"
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
  _run_parser "${tx}" "${FRESH_TODAY}"
  [[ "${status}" -eq 0 ]]
  # (1000*10 + 500*50)/1e6 = 0.035 — flat 1M-window rate, no [1m] tier entry.
  [[ "${output}" == *'"cost_usd": 0.035'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# Prints `<null|str><US><model><US><stored model as JSON>` per id under the given parity-table key (the
# row stores an empty id as null); the unit separator keeps an empty id a field of its own on read-back.
_parity_rows() {
  python3 -I -c 'import json, sys
for model in json.load(open(sys.argv[1]))[sys.argv[2]]:
    print("null" if model is None else "str", model or "", json.dumps(model or None), sep="\x1f")' \
    "${BATS_TEST_DIRNAME}/fixtures/model-id-pricing-parity.json" "${1}"
}

# Case 8: every zero-cost parity id is allowlisted (no advisory, no DATA-183, $0 row)

@test "an id the parity table prices at zero emits no unknown advisory and no DATA-183, records a \$0 row" {
  local rows kind model model_json tx stderr_file err
  rows="$(_parity_rows zero_cost_ids)"
  while IFS=$'\x1f' read -r kind model model_json; do
    tx="${TEST_TMP}/zero-${kind}-${#model}.jsonl"
    stderr_file="${tx}.err"
    # Billable usage, so only the allowlist (never 0 tokens) can make the row $0.
    if [[ "${kind}" == "null" ]]; then _make_transcript_no_model "${tx}"; else _make_transcript "${model}" "${tx}"; fi
    _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
    err="$(cat "${stderr_file}")"
    [[ "${status}" -eq 0 && "${err}" != *"model=unknown"* && "${err}" != *"DATA-183"* ]] || {
      echo "zero-cost ${kind} '${model}': status ${status}: ${err}"
      return 1
    }
    _run_parser "${tx}" "${FRESH_TODAY}"
    # Trailing comma pins the full value — bare '0.0' would prefix-match 0.0525.
    [[ "${status}" -eq 0 && "${output}" == *'"cost_usd": 0.0,'* && "${output}" == *'"parse_error": false'* &&
      "${output}" == *"\"model\": ${model_json}"* ]] || {
      echo "zero-cost ${kind} '${model}': ${output}"
      return 1
    }
  done <<<"${rows}"
}

# Case 9: a near miss of a zero-cost id walks the resolution chain (advisory + fallback price)

@test "a near miss of a zero-cost id is priced by the fallback with an unknown advisory" {
  local rows kind model tx stderr_file err
  rows="$(_parity_rows rate_lookup_ids)"
  while IFS=$'\x1f' read -r kind model _; do
    tx="${TEST_TMP}/near-${kind}-${#model}.jsonl"
    stderr_file="${tx}.err"
    _make_transcript "${model}" "${tx}"
    _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
    err="$(cat "${stderr_file}")"
    [[ "${status}" -eq 0 && "${err}" == *"model=unknown:${model} "* ]] || {
      echo "near miss ${kind} '${model}': status ${status}: ${err}"
      return 1
    }
  done <<<"${rows}"
}

# Case 10: synthetic sonnet-5 launch window (fixture tier, intro rate through 2026-08-31)

@test "a tiered fixture row prices claude-sonnet-5 at intro 0.007 on 2026-08-31 and standard 0.0105 on 2026-09-01" {
  local tx
  tx="${TEST_TMP}/sonnet5.jsonl"
  _make_transcript "claude-sonnet-5" "${tx}"
  # Last intro day (inclusive boundary): (1000*2 + 500*10)/1e6 = 0.007.
  _run_parser "${tx}" "2026-08-31"
  [[ "${status}" -eq 0 ]]
  # Trailing comma pins the full value (bare '0.007' could prefix-match longer floats).
  [[ "${output}" == *'"cost_usd": 0.007,'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
  # First standard day: (1000*3 + 500*15)/1e6 = 0.0105.
  _run_parser "${tx}" "2026-09-01"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *'"cost_usd": 0.0105,'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# Case 11: family-matched new id → family_latest rate + LOUD advisory

@test "family-matched claude-opus-4-9 prices at opus-4-8 rate with resolution=family_latest advisory and DATA-183" {
  local tx stderr_file
  tx="${TEST_TMP}/opus49.jsonl"
  stderr_file="${TEST_TMP}/err11.txt"
  _make_transcript "claude-opus-4-9" "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [[ "${status}" -eq 0 ]]
  local err
  err="$(cat "${stderr_file}")"
  # Under-billing surfacing guard: the older-family rate may UNDER-price a
  # newer model, so family_latest MUST be as loud as fallback (advisory +
  # DATA-183) — silent family pricing is forbidden.
  [[ "${err}" =~ "model=unknown:claude-opus-4-9" ]]
  [[ "${err}" =~ "resolution=family_latest" ]]
  [[ "${err}" =~ '"error_code":"DATA-183"' ]]
  [[ "${err}" =~ '"models":"claude-opus-4-9"' ]]
  # Cost math: family-latest resolves the opus-4-8 row → (1000*5 + 500*25)/1e6.
  _run_parser "${tx}" "${FRESH_TODAY}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *'"cost_usd": 0.0175'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# Case 12: corrupt pricing SoT → LOUD parser-crash failure

@test "corrupt pricing SoT fails loud: PricingSotError on stderr, DATA-184, non-zero non-2 exit" {
  local tx stderr_file
  tx="${TEST_TMP}/priced-turn.jsonl"
  stderr_file="${TEST_TMP}/err12.txt"
  # A PRICED turn (known model, real usage) so the parser reaches load_pricing
  # — the reachable production trigger for an uncaught PricingSotError.
  _make_transcript "claude-opus-4-8" "${tx}"
  # Overwrite the valid setup fixture with invalid JSON (the SoT-typo shape).
  printf '%s' '{"schema_version": 1, "corrupt' >"${FIXTURE_SOT}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  # Loud-fail, but never exit 2 (Stop-hook exit 2 has blocking semantics).
  [[ "${status}" -ne 0 ]]
  [[ "${status}" -ne 2 ]]
  local err
  err="$(cat "${stderr_file}")"
  # The loader diagnostic must SURVIVE to the hook's stderr (a crash inside
  # the guarded capture must not destroy the PARSER_STDERR relay).
  [[ "${err}" =~ "PricingSotError" ]]
  # Distinct persisted class: DATA-184 (parser crashed / pricing SoT invalid)
  # — never overloaded onto DATA-182 (python3 fallback) or DATA-181/183.
  [[ "${err}" =~ '"error_code":"DATA-184"' ]]
  [[ ! "${err}" =~ '"error_code":"DATA-182"' ]]
  [[ ! "${err}" =~ '"error_code":"DATA-181"' ]]
}

# Case 13: symlinked invocation resolves lib through the REAL script path

@test "symlinked hook invocation imports pricing_loader via canonicalized BASH_SOURCE (no DATA-184)" {
  local link_dir tx stderr_file err
  # Rebuild the production ~/.claude/hooks topology: the hook + hook-utils.sh
  # are symlinks into the real hooks dir, and lib/ is a REAL directory holding
  # other libs but NOT pricing_loader.py — the trap an unresolved
  # ${BASH_SOURCE%/*}/lib derivation falls into (ModuleNotFoundError →
  # parser exit 1 → DATA-184 on every Stop).
  link_dir="${TEST_TMP}/symlink-hooks"
  mkdir -p "${link_dir}/lib"
  printf '%s\n' '# decoy lib — deliberately NOT pricing_loader.py' \
    >"${link_dir}/lib/style-ref-consts.sh"
  ln -s "${HOOKS_DIR}/cost-tracker.sh" "${link_dir}/cost-tracker.sh"
  ln -s "${HOOKS_DIR}/hook-utils.sh" "${link_dir}/hook-utils.sh"
  tx="${TEST_TMP}/symlink.jsonl"
  stderr_file="${TEST_TMP}/err13.txt"
  # Unknown model on purpose: its resolution=fallback advisory is emitted from
  # INSIDE calc_cost, so its presence is positive proof the cost math ran
  # through the loader under the symlinked invocation (import succeeded).
  _make_transcript "claude-foobar-9-9" "${tx}"
  HOOK_SH="${link_dir}/cost-tracker.sh"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [[ "${status}" -eq 0 ]]
  err="$(cat "${stderr_file}")"
  [[ ! "${err}" =~ "ModuleNotFoundError" ]]
  [[ ! "${err}" =~ '"error_code":"DATA-184"' ]]
  [[ "${err}" =~ "resolution=fallback" ]]
}

# Case 14: a pricing gap is an advisory, never a recorded write failure

@test "an unknown model is priced by the fallback and advised on stderr without a hook_failures row" {
  _eph_reset_db
  local tx stderr_file err failures priced
  tx="${TEST_TMP}/unknown-eph.jsonl"
  stderr_file="${TEST_TMP}/err14.txt"
  _make_transcript "claude-foobar-9-9" "${tx}"
  _run_hook_eph "${tx}" "${stderr_file}"
  err="$(cat "${stderr_file}")"
  [[ "${status}" -eq 0 ]] || {
    echo "exit ${status}: ${err}"
    return 1
  }
  [[ "${err}" == *"model=unknown:claude-foobar-9-9"* && "${err}" == *'"error_code":"DATA-183"'* ]] || {
    echo "advisory missing from stderr: ${err}"
    return 1
  }
  failures="$(_eph_q "SELECT error_kind::text || '|' || payload_ref FROM core.hook_failures;")" || return 1
  [[ -z "${failures}" ]] || {
    echo "hook_failures rows: ${failures}"
    return 1
  }
  # fallback fable-5 (10/50) → (1000*10 + 500*50)/1e6 = 0.035, stored under the raw model id
  priced="$(_eph_q "SELECT count(*) FROM core.cost_events WHERE model = 'claude-foobar-9-9' AND cost_usd = 0.035;")" || return 1
  [[ "${priced}" -eq 1 ]] || {
    echo "fallback-priced cost rows: ${priced}"
    return 1
  }
  # the batch writer's connection is the only one the hook opens
  eph_assert_isolated 1
}

# Case 15: a real cost write failure keeps its one hook_failures record

@test "a failed cost write records one hook_failures row naming the session, known model or unknown" {
  local -a rows=('known|claude-opus-4-8' 'unknown|claude-foobar-9-9')
  local row name model tx stderr_file failures
  # UndefinedTable is neither IntegrityError nor OperationalError → kind unknown, after one retry
  local want="cost-tracker|core.cost_events|unknown|sess-t13a|true"
  for row in "${rows[@]}"; do
    IFS='|' read -r name model <<<"${row}"
    _eph_reset_db
    _eph_q "ALTER TABLE core.cost_events RENAME TO cost_events_offline;" || return 1
    tx="${TEST_TMP}/write-fail-${name}.jsonl"
    stderr_file="${TEST_TMP}/err15-${name}.txt"
    _make_transcript "${model}" "${tx}"
    _run_hook_eph "${tx}" "${stderr_file}"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: exit ${status}"
      cat -- "${stderr_file}"
      return 1
    }
    failures="$(_eph_q "SELECT hook_name || '|' || target_table || '|' || error_kind::text || '|'
      || payload_ref || '|' || retry_attempted::text FROM core.hook_failures;")" || return 1
    [[ "${failures}" == "${want}" ]] || {
      echo "${name}: hook_failures rows: ${failures}"
      return 1
    }
    # the batch writer's connection plus its one hook_failures record
    eph_assert_isolated 2 || {
      echo "${name}: isolation"
      return 1
    }
  done
}

@test "the parser stderr temp never outlives the run, on a clean exit or a parser crash" {
  local -a rows=('clean|0' 'crash|1')
  local row name want tx tmp_root leftovers
  tx="${TEST_TMP}/leftover.jsonl"
  _make_transcript "claude-opus-4-8" "${tx}"
  for row in "${rows[@]}"; do
    IFS='|' read -r name want <<<"${row}"
    tmp_root="${TEST_TMP}/tmp-${name}"
    mkdir -p "${tmp_root}"
    if [[ "${name}" == "crash" ]]; then
      printf '%s' '{"schema_version": 1, "corrupt' >"${FIXTURE_SOT}"
    fi
    TMPDIR="${tmp_root}" _run_hook "${tx}" "${FRESH_TODAY}" "${TEST_TMP}/err-${name}.txt"
    [[ "${status}" -eq "${want}" ]] || {
      echo "${name}: exit ${status}, want ${want}"
      return 1
    }
    leftovers="$(find "${tmp_root}" -name 'cost-tracker-stderr.*' | wc -l | tr -d ' ')"
    [[ "${leftovers}" == "0" ]] || {
      echo "${name}: parser stderr temp left under TMPDIR: ${leftovers}"
      return 1
    }
  done
}

# A relative TMPDIR makes the mktemp template relative — teardown must still reach the sandbox.
@test "teardown removes the sandbox that setup made under a relative TMPDIR" {
  local suite_tmp="${TEST_TMP}" base="${BATS_TEST_TMPDIR}/relative-tmpdir"
  mkdir -p "${base}/rel"
  cd -- "${base}" || return 1
  TMPDIR=rel setup
  [[ -d "${TEST_TMP}" ]] || {
    echo "setup made no sandbox at ${TEST_TMP}" >&2
    return 1
  }
  run teardown
  TEST_TMP="${suite_tmp}"
  [[ "${status}" -eq 0 && -z "${output}" ]] || {
    echo "teardown failed (status ${status}): ${output}" >&2
    return 1
  }
  local left
  left="$(ls -A -- "${base}/rel")"
  [[ -z "${left}" ]] || {
    echo "sandbox left behind: ${left}" >&2
    return 1
  }
}
