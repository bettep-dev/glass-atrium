#!/usr/bin/env bats
# validate-scope-drift.sh — per-session resolution-cache suite.
#
# Pins the PLAN_FILE-unset (monitor-API) latency optimization: the resolved plan id + target-file
# list are cached once per session so subsequent same-session edits skip BOTH loopback curls + the
# HTML re-parse. The cache is an optimization ONLY — the drift verdict for a fixed (plan, target)
# input MUST be identical to the uncached path, and any cache anomaly falls back to the live lookup.
#
# Assertions proven here:
#   * loopback fires exactly ONCE per session (2nd edit is a cache hit, zero curls)
#   * verdict parity: 1st edit (live path) and 2nd edit (cache path) yield the SAME block/pass
#     decision for both an in-scope and an out-of-scope target
#   * a fresh cache actually drives the verdict (zero curls), a stale/bypassed/corrupt/no-key cache
#     fails open to the live resolution
#
# Hermetic: the monitor loopback is a counting `curl` PATH shim returning canned JSON — no live
# monitor, no real ~/.claude write (HOME + cache dir are redirected under mktemp).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
HOOK="${GA}/hooks/validate-scope-drift.sh"

setup() {
  [[ -f "${HOOK}" ]] || skip "hook not found: ${HOOK}"
  WORK="$(mktemp -d -t scope-drift-cache.XXXXXX)"
  SHIMBIN="${WORK}/bin"
  CACHE_DIR="${WORK}/cache"
  COUNT_FILE="${WORK}/curl.count"
  LIST_JSON="${WORK}/list.json"
  DOC_JSON="${WORK}/doc.json"
  SID="sess-cache-test"
  mkdir -p "${SHIMBIN}"
  : >"${COUNT_FILE}"

  # Canned monitor responses. List → one in-progress doc (id 5). GET → HTML body whose
  # target-files section whitelists exactly two paths (the LIVE resolution).
  printf '%s\n' '{"total":1,"rows":[{"id":5,"doc_status":"progress","created_at":"2026-07-01T00:00:00Z"}]}' \
    >"${LIST_JSON}"
  printf '%s\n' '{"id":5,"body":"<section id=\"target-files\"><ul><li>hooks/validate-scope-drift.sh</li><li>src/allowed/in-scope.ts</li></ul></section>"}' \
    >"${DOC_JSON}"

  # Counting curl shim: one tally char per call; list vs GET distinguished by URL suffix.
  cat >"${SHIMBIN}/curl" <<'SH'
#!/usr/bin/env bash
printf 'x' >>"${CURL_COUNT_FILE}"
url=""
for a in "$@"; do
  case "${a}" in
    http*) url="${a}" ;;
  esac
done
case "${url}" in
  */clauded-docs) cat "${LIST_JSON_FILE}" ;;
  */clauded-docs/*) cat "${DOC_JSON_FILE}" ;;
  *) exit 22 ;;
esac
SH
  chmod +x "${SHIMBIN}/curl"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Total loopback curl calls so far.
curl_count() { wc -c <"${COUNT_FILE}" | tr -d '[:space:]'; }

# Pre-seed the per-session cache. Args: $1=epoch $2=plan_id $3=files (newline-separated).
seed_cache() {
  mkdir -p "${CACHE_DIR}"
  {
    printf '%s\n' "${1}"
    printf '%s\n' "${2}"
    printf '%s\n' "${3}"
  } >"${CACHE_DIR}/${SID}.cache"
}

# Fire the hook once for a given edit target (PLAN_FILE forced unset → the API+cache path).
# ATRIUM_MONITOR_PORT short-circuits the port resolver; SCOPE_DRIFT_MONITOR_URL pins the loopback;
# SCOPE_DRIFT_CACHE_DIR + HOME redirect all writes under WORK. stderr merged into $output.
# Test-specific toggles (SCOPE_DRIFT_CACHE_BYPASS / _TTL) inherit via the ambient environment.
run_hook() {
  local fp="${1}" input
  input="$(jq -n --arg sid "${SID}" --arg fp "${fp}" \
    '{session_id: $sid, tool_input: {file_path: $fp}}')"
  run env -u PLAN_FILE \
    HOME="${WORK}" \
    ATRIUM_MONITOR_PORT=16145 \
    SCOPE_DRIFT_MONITOR_URL="http://127.0.0.1:16145/api/clauded-docs" \
    SCOPE_DRIFT_CACHE_DIR="${CACHE_DIR}" \
    CURL_COUNT_FILE="${COUNT_FILE}" \
    LIST_JSON_FILE="${LIST_JSON}" \
    DOC_JSON_FILE="${DOC_JSON}" \
    PATH="${SHIMBIN}:${PATH}" \
    bash -c 'bash "$0" 2>&1' "${HOOK}" <<<"${input}"
}

@test "out-of-scope: verdict identical on live(1st) and cached(2nd) edit; loopback fires once per session" {
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "1st exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *SCOPE-070* ]] || { echo "1st(live) missing SCOPE-070: ${output}" >&2; return 1; }
  local c1
  c1="$(curl_count)"
  [[ "${c1}" -eq 2 ]] || { echo "1st edit curl count ${c1} != 2 (list+GET expected)" >&2; return 1; }

  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "2nd exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *SCOPE-070* ]] || { echo "2nd(cached) verdict drift — SCOPE-070 lost: ${output}" >&2; return 1; }
  local c2
  c2="$(curl_count)"
  [[ "${c2}" -eq 2 ]] || { echo "2nd edit re-curled; total ${c2} != 2 (cache miss)" >&2; return 1; }
}

@test "in-scope: verdict identical on live(1st) and cached(2nd) edit; loopback fires once per session" {
  run_hook "/work/repo/src/allowed/in-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "1st exit ${status} != 0" >&2; return 1; }
  [[ "${output}" != *SCOPE-070* ]] || { echo "1st(live) false SCOPE-070 on in-scope: ${output}" >&2; return 1; }
  local c1
  c1="$(curl_count)"
  [[ "${c1}" -eq 2 ]] || { echo "1st edit curl count ${c1} != 2" >&2; return 1; }

  run_hook "/work/repo/src/allowed/in-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "2nd exit ${status} != 0" >&2; return 1; }
  [[ "${output}" != *SCOPE-070* ]] || { echo "2nd(cached) verdict drift — false SCOPE-070: ${output}" >&2; return 1; }
  local c2
  c2="$(curl_count)"
  [[ "${c2}" -eq 2 ]] || { echo "2nd edit re-curled; total ${c2} != 2 (cache miss)" >&2; return 1; }
}

@test "fresh cache hit drives the verdict with zero loopback curls" {
  # Cache whitelists a path the LIVE list does NOT → a clean verdict + zero curls proves the
  # cached list (not the loopback) drove the decision.
  seed_cache "$(date +%s)" 5 "src/cached-only/special.ts"
  run_hook "/work/repo/src/cached-only/special.ts"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" != *SCOPE-070* ]] || { echo "cached whitelist ignored: ${output}" >&2; return 1; }
  local c
  c="$(curl_count)"
  [[ "${c}" -eq 0 ]] || { echo "cache hit still curled ${c} != 0" >&2; return 1; }
}

@test "TTL-expired cache is ignored; live resolution wins (staleness safety)" {
  # A stale cache would (falsely) whitelist the out-of-scope path; expiry must discard it and the
  # live list must re-fire the SCOPE-070 advisory.
  seed_cache 100 5 "src/other/out-of-scope.ts"
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *SCOPE-070* ]] || { echo "stale cache used instead of live: ${output}" >&2; return 1; }
  local c
  c="$(curl_count)"
  [[ "${c}" -eq 2 ]] || { echo "stale-refresh curl count ${c} != 2" >&2; return 1; }
}

@test "SCOPE_DRIFT_CACHE_BYPASS forces a live resolve despite a fresh valid cache" {
  # Fresh cache that WOULD whitelist the target; the explicit bypass signal must ignore it.
  seed_cache "$(date +%s)" 5 "src/other/out-of-scope.ts"
  export SCOPE_DRIFT_CACHE_BYPASS=1
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *SCOPE-070* ]] || { echo "bypass used the cache: ${output}" >&2; return 1; }
  local c
  c="$(curl_count)"
  [[ "${c}" -eq 2 ]] || { echo "bypass curl count ${c} != 2" >&2; return 1; }
}

@test "empty session id disables caching; each edit re-resolves live (no shared-key collision)" {
  SID=""
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${output}" == *SCOPE-070* ]] || { echo "1st verdict wrong: ${output}" >&2; return 1; }
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${output}" == *SCOPE-070* ]] || { echo "2nd verdict wrong: ${output}" >&2; return 1; }
  local c
  c="$(curl_count)"
  [[ "${c}" -eq 4 ]] || { echo "no-key caching leaked; 2 edits curl count ${c} != 4" >&2; return 1; }
}

@test "corrupt cache file fails open to live resolution" {
  mkdir -p "${CACHE_DIR}"
  printf 'not-an-integer\ngarbage\n' >"${CACHE_DIR}/${SID}.cache"
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *SCOPE-070* ]] || { echo "corrupt cache not fail-open: ${output}" >&2; return 1; }
  local c
  c="$(curl_count)"
  [[ "${c}" -eq 2 ]] || { echo "corrupt-cache curl count ${c} != 2" >&2; return 1; }
}
