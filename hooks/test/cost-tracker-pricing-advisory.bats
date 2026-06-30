#!/usr/bin/env bats
# cost-tracker-pricing-advisory.bats — Bats suite for the cost-tracker Stop hook
#   pricing-drift advisories (T13a / D-1: silent pricing drift surfacing).
#
# 검증 대상 (advisory only, cost math 불변):
#   1. known-model + fresh baseline → priced + SILENT (자문 미발화), exit 0
#   2. unknown-model → unknown-model 자문(STDERR, 모델명 명시) + DATA-183 구조화
#      emit(모니터 hook-failure 경로) + 여전히 기록, exit 0
#   3. stale-baseline → staleness 자문(STDERR, 경과일/윈도우 명시), exit 0
#   4. cost math 불변 — known opus-4-8 1000in/500out → cost_usd=0.0525 (regression guard)
#   5. unknown-model 은 zero-priced 아님 — opus fallback 으로 동일 0.0525 가격(기록 유지)
#   6. dated id(claude-haiku-4-5-20251001) → haiku 단가 0.0035 해석(opus fallback 아님)
#   7. fable-5 → 10/50 단가 0.035 (PRICING 등재 확인)
#   8. '<synthetic>'(하네스 합성 레코드) → 자문/DATA-183 미발화 + $0 행 정상 기록
#   9. model 필드 부재(empty model) → 자문/DATA-183 미발화 (fallback 가격은 유지)
#
# 격리: COST_TRACKER_TODAY env 로 '오늘' 날짜를 결정적으로 주입(시계 의존 제거).
#   PGHOST 를 부재 소켓으로 강제 → PG dual-write + hook_failures INSERT 모두
#   fail-open(자문/가격 경로 단독 검증, 라이브 DB 미접촉).
#   합성 transcript jsonl 을 mktemp 로 생성(라이브 transcript 미의존).

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/cost-tracker.sh"

# PRICING_LAST_VERIFIED 와 동일한 날짜 → age 0 → staleness 미발화 (격리용).
FRESH_TODAY="2026-06-10"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/cost-tracker-bats.XXXXXX")"
}

teardown() {
  rm -rf "${TEST_TMP}"
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

# Run the hook with deterministic 'today', fail-open PG, no env session leakage.
# Args: $1=transcript_path $2=today_iso $3=stderr_capture_file
_run_hook() {
  local xpath="${1}" today="${2}" stderr_file="${3}"
  local stdin_json
  stdin_json="$(_stop_input "${xpath}")"
  COST_TRACKER_TODAY="${today}" PGHOST="/nonexistent-socket-xyzzy" CLAUDE_SESSION_ID='' \
    run bash -c "printf '%s' '${stdin_json}' | '${HOOK_SH}' 2>'${stderr_file}'"
}

# Slice the embedded parser python out of the hook (between the PARSED=$( open
# and the `' 2>` close, stripping the first + last marker lines).
_parser_body() {
  sed -n "/^PARSED=\$(DATE/,/^' 2>/p" "${HOOK_SH}" \
    | sed -n "/python3 -c '/,/^' 2>/p" | sed '1d;$d'
}

# --- Case 1: known model + fresh baseline → priced + SILENT advisory-wise ---

@test "known model with fresh baseline prices silently (no pricing advisory) and exits 0" {
  local tx stderr_file
  tx="${TEST_TMP}/known.jsonl"
  stderr_file="${TEST_TMP}/err1.txt"
  _make_transcript "claude-opus-4-8" "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [ "${status}" -eq 0 ]
  local err
  err="$(cat "${stderr_file}")"
  # No pricing-drift advisory on the happy path.
  [[ ! "${err}" =~ "pricing baseline stale" ]]
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
}

# --- Case 2: unknown model → advisory names the model + DATA-183 persisted path ---

@test "unknown model emits STDERR advisory plus structured DATA-183 naming the model" {
  local tx stderr_file
  tx="${TEST_TMP}/unknown.jsonl"
  stderr_file="${TEST_TMP}/err2.txt"
  _make_transcript "claude-foobar-9-9" "${tx}"
  # Fresh baseline date so ONLY the unknown-model advisory can fire.
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [ "${status}" -eq 0 ]
  local err
  err="$(cat "${stderr_file}")"
  [[ "${err}" =~ "model=unknown:claude-foobar-9-9" ]]
  # The monitor-facing hook-failure path: structured emit carrying the model id.
  [[ "${err}" =~ '"error_code":"DATA-183"' ]]
  [[ "${err}" =~ '"models":"claude-foobar-9-9"' ]]
  # Staleness MUST NOT fire here (date is fresh) — isolates the unknown signal.
  [[ ! "${err}" =~ "pricing baseline stale" ]]
}

# --- Case 3: stale baseline → staleness advisory with age + window ---

@test "stale pricing baseline emits a STDERR staleness advisory and exits 0" {
  local tx stderr_file
  tx="${TEST_TMP}/known.jsonl"
  stderr_file="${TEST_TMP}/err3.txt"
  _make_transcript "claude-opus-4-8" "${tx}"
  # 'today' far past last-verified+90d → stale. Known model → no unknown noise.
  _run_hook "${tx}" "2027-01-01" "${stderr_file}"
  [ "${status}" -eq 0 ]
  local err
  err="$(cat "${stderr_file}")"
  [[ "${err}" =~ "pricing baseline stale" ]]
  [[ "${err}" =~ "window=90" ]]
  # Known model → unknown-model advisory MUST NOT fire (isolates staleness).
  [[ ! "${err}" =~ "model=unknown" ]]
}

# --- Case 4: cost math regression guard (known model) ---

@test "known opus-4-8 1000in/500out computes cost_usd=0.0525 (math unchanged)" {
  local tx parser_body
  tx="${TEST_TMP}/known.jsonl"
  _make_transcript "claude-opus-4-8" "${tx}"
  parser_body="$(_parser_body)"
  run env DATE="2026-06-10" TIME="01:00:00" SESSION_ID="sess-t13a" \
    TRANSCRIPT_PATH="${tx}" COST_TRACKER_TODAY="${FRESH_TODAY}" \
    python3 -c "${parser_body}"
  [ "${status}" -eq 0 ]
  # (1000*15 + 500*75)/1e6 = 0.0525. Literal-substring match (glob, not regex)
  # so the '.' in the value is not treated as a regex metacharacter.
  [[ "${output}" == *'"cost_usd": 0.0525'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# --- Case 5: unknown model is NOT zero-priced (opus fallback records cost) ---

@test "unknown model still records cost via opus fallback (not zero-priced)" {
  local tx parser_body
  tx="${TEST_TMP}/unknown.jsonl"
  _make_transcript "claude-foobar-9-9" "${tx}"
  parser_body="$(_parser_body)"
  run env DATE="2026-06-10" TIME="01:00:00" SESSION_ID="sess-t13a" \
    TRANSCRIPT_PATH="${tx}" COST_TRACKER_TODAY="${FRESH_TODAY}" \
    python3 -c "${parser_body}"
  [ "${status}" -eq 0 ]
  # Opus fallback rate → same 0.0525 as Case 4; the row records (not zero, not
  # error). Literal-substring (glob) match to keep '.' out of regex context.
  [[ "${output}" == *'"cost_usd": 0.0525'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
  # Model id is preserved as-emitted (so the dashboard shows the new model).
  [[ "${output}" == *'claude-foobar-9-9'* ]]
}

# --- Case 6: dated snapshot id resolves to its base row (NOT opus fallback) ---

@test "dated claude-haiku-4-5-20251001 prices at haiku rates (0.0035), no unknown advisory" {
  local tx stderr_file parser_body
  tx="${TEST_TMP}/haiku-dated.jsonl"
  stderr_file="${TEST_TMP}/err6.txt"
  _make_transcript "claude-haiku-4-5-20251001" "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [ "${status}" -eq 0 ]
  local err
  err="$(cat "${stderr_file}")"
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
  parser_body="$(_parser_body)"
  run env DATE="2026-06-10" TIME="01:00:00" SESSION_ID="sess-t13a" \
    TRANSCRIPT_PATH="${tx}" COST_TRACKER_TODAY="${FRESH_TODAY}" \
    python3 -c "${parser_body}"
  [ "${status}" -eq 0 ]
  # (1000*1 + 500*5)/1e6 = 0.0035 — haiku rates, 1/15 of the opus fallback.
  [[ "${output}" == *'"cost_usd": 0.0035'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# --- Case 7: fable-5 is a first-class PRICING row at 10/50 rates ---

@test "claude-fable-5 prices at 10/50 rates (0.035) with no unknown advisory" {
  local tx stderr_file
  tx="${TEST_TMP}/fable.jsonl"
  stderr_file="${TEST_TMP}/err7.txt"
  _make_transcript "claude-fable-5" "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [ "${status}" -eq 0 ]
  local err
  err="$(cat "${stderr_file}")"
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
  local parser_body
  parser_body="$(_parser_body)"
  run env DATE="2026-06-10" TIME="01:00:00" SESSION_ID="sess-t13a" \
    TRANSCRIPT_PATH="${tx}" COST_TRACKER_TODAY="${FRESH_TODAY}" \
    python3 -c "${parser_body}"
  [ "${status}" -eq 0 ]
  # (1000*10 + 500*50)/1e6 = 0.035 — flat 1M-window rate, no [1m] tier entry.
  [[ "${output}" == *'"cost_usd": 0.035'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# --- Case 8: harness-synthetic model is allowlisted (no advisory, no DATA-183) ---

@test "harness-synthetic model emits no unknown advisory and no DATA-183, records \$0 row" {
  local tx stderr_file
  tx="${TEST_TMP}/synthetic.jsonl"
  stderr_file="${TEST_TMP}/err8.txt"
  # Real harness-synthetic records carry all-zero usage → faithful 0/0 tokens.
  _make_transcript "<synthetic>" "${tx}" 0 0
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [ "${status}" -eq 0 ]
  local err
  err="$(cat "${stderr_file}")"
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
  # The row itself is still recorded (clean $0, not a parse error).
  local parser_body
  parser_body="$(_parser_body)"
  run env DATE="2026-06-10" TIME="01:00:00" SESSION_ID="sess-t13a" \
    TRANSCRIPT_PATH="${tx}" COST_TRACKER_TODAY="${FRESH_TODAY}" \
    python3 -c "${parser_body}"
  [ "${status}" -eq 0 ]
  # Trailing comma pins the full value — bare '0.0' would prefix-match 0.0525.
  [[ "${output}" == *'"cost_usd": 0.0,'* ]]
  [[ "${output}" == *'"model": "<synthetic>"'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}

# --- Case 9: empty model (field absent) is allowlisted (no advisory, no DATA-183) ---

@test "missing model field emits no unknown advisory and no DATA-183" {
  local tx stderr_file
  tx="${TEST_TMP}/no-model.jsonl"
  stderr_file="${TEST_TMP}/err9.txt"
  _make_transcript_no_model "${tx}"
  _run_hook "${tx}" "${FRESH_TODAY}" "${stderr_file}"
  [ "${status}" -eq 0 ]
  local err
  err="$(cat "${stderr_file}")"
  [[ ! "${err}" =~ "model=unknown" ]]
  [[ ! "${err}" =~ "DATA-183" ]]
  # Cost math unchanged: model-less usage still prices at the opus fallback
  # (conservative) — only the advisory channel is exempted.
  local parser_body
  parser_body="$(_parser_body)"
  run env DATE="2026-06-10" TIME="01:00:00" SESSION_ID="sess-t13a" \
    TRANSCRIPT_PATH="${tx}" COST_TRACKER_TODAY="${FRESH_TODAY}" \
    python3 -c "${parser_body}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'"cost_usd": 0.0525'* ]]
  [[ "${output}" == *'"model": null'* ]]
  [[ "${output}" == *'"parse_error": false'* ]]
}
