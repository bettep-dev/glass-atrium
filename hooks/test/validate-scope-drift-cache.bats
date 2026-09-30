#!/usr/bin/env bats
# validate-scope-drift.sh — monitor-leg suite (PLAN_FILE unset): plan selection, format dispatch,
# and the per-session resolution cache.
#
# Selection binds exactly one `implementing` plan and parses its Target Files list by the plan's
# own format; the cache stores that binding once per session and MUST NOT change the verdict.
#
# Assertions proven here:
#   * the list request carries the stage filter; only a lone `implementing` row binds (two such
#     plans, other stages, or a server ignoring the filter → no binding to a wrong plan)
#   * format dispatch: an md plan binds through its `## Target Files` heading only, never through a
#     quoted HTML section; an html plan through its target-files section
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
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${HOOK}" ]] || skip "hook not found: ${HOOK}"
  WORK="$(mktemp -d -t scope-drift-cache.XXXXXX)"
  SHIMBIN="${WORK}/bin"
  CACHE_DIR="${WORK}/cache"
  COUNT_FILE="${WORK}/curl.count"
  URL_LOG="${WORK}/curl.urls"
  LIST_JSON="${WORK}/list.json"
  DOC_DIR="${WORK}/docs"
  SID="sess-cache-test"
  mkdir -p "${SHIMBIN}" "${DOC_DIR}"
  : >"${COUNT_FILE}"

  # Canned monitor responses. List → one implementing HTML plan (id 5). GET → HTML body whose
  # target-files section whitelists exactly two paths (the LIVE resolution).
  printf '%s\n' '{"total":1,"rows":[{"id":5,"doc_status":"implementing","format":"html","created_at":"2026-07-01T00:00:00Z"}]}' \
    >"${LIST_JSON}"
  printf '%s\n' '{"id":5,"format":"html","body":"<section id=\"target-files\"><ul><li>hooks/validate-scope-drift.sh</li><li>src/allowed/in-scope.ts</li></ul></section>"}' \
    >"${DOC_DIR}/5.json"

  # Counting curl shim: one tally char per call. The list arm accepts a query string; the GET arm
  # serves the doc fixture named by the requested id, so a wrongly picked row gets no body.
  cat >"${SHIMBIN}/curl" <<'SH'
#!/usr/bin/env bash
printf 'x' >>"${CURL_COUNT_FILE}"
url=""
for a in "$@"; do
  case "${a}" in
    http*) url="${a}" ;;
  esac
done
printf '%s\n' "${url}" >>"${CURL_URL_LOG}"
case "${url}" in
  */clauded-docs | */clauded-docs\?*) cat "${LIST_JSON_FILE}" ;;
  */clauded-docs/*)
    doc="${DOC_JSON_DIR}/${url##*/}.json"
    [[ -f "${doc}" ]] || exit 22
    cat "${doc}"
    ;;
  *) exit 22 ;;
esac
SH
  chmod +x "${SHIMBIN}/curl"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
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

# Replace the list response with the given rows. Args: row JSON objects, e.g. '{"id":7,...}'.
set_list_rows() {
  jq -cn --args '{total: ($ARGS.positional | length), rows: [$ARGS.positional[] | fromjson]}' "$@" \
    >"${LIST_JSON}"
}

# Write the GET fixture for one plan. Args: $1=id  $2=format  $3=body.
write_doc() {
  jq -cn --argjson id "${1}" --arg fmt "${2}" --arg body "${3}" '{id: $id, format: $fmt, body: $body}' \
    >"${DOC_DIR}/${1}.json"
}

# md plan body: a `## Target Files` list between two other sections.
MD_PLAN_BODY="$(printf '%s\n' '# Plan' '## Goal' '- ship it' '## Target Files' \
  '- `hooks/md-listed.sh`' '- `src/md/listed.ts`' '## Open Questions' '- none')"

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
    CURL_URL_LOG="${URL_LOG}" \
    LIST_JSON_FILE="${LIST_JSON}" \
    DOC_JSON_DIR="${DOC_DIR}" \
    PATH="${SHIMBIN}:${PATH}" \
    bash -c 'bash "$0" 2>&1' "${HOOK}" <<<"${input}"
}

@test "out-of-scope: verdict identical on live(1st) and cached(2nd) edit; loopback fires once per session" {
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] || { echo "1st exit ${status} != 0" >&2; return 1; }
  [[ "${output}" == *SCOPE-070* ]] && [[ "${output}" == *plan-doc* ]] \
    || { echo "1st(live) missing plan-doc SCOPE-070: ${output}" >&2; return 1; }
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

@test "list request asks the monitor for implementing rows, up to 200" {
  run_hook "/work/repo/src/allowed/in-scope.ts"
  local list_url
  list_url="$(head -n 1 "${URL_LOG}")"
  [[ "${list_url}" == *'?'*doc_status=implementing* ]] && [[ "${list_url}" == *limit=200* ]] \
    || { echo "list URL lacks the stage filter or the limit: ${list_url}" >&2; return 1; }
}

@test "a lone implementing md plan binds its Target Files heading: a listed path passes" {
  set_list_rows '{"id":7,"doc_status":"implementing","format":"md","created_at":"2026-07-01T00:00:00Z"}'
  write_doc 7 md "${MD_PLAN_BODY}"
  run_hook "/work/repo/src/md/listed.ts"
  # The cached binding separates a matched list from a fail-open silence.
  [[ "${status}" -eq 0 ]] && [[ "${output}" != *SCOPE-070* ]] \
    && awk 'NR == 2 { found = ($0 == "7") } END { exit !found }' "${CACHE_DIR}/${SID}.cache" \
    && grep -qF 'src/md/listed.ts' "${CACHE_DIR}/${SID}.cache" \
    || { echo "listed md path not passed through a bound plan 7: ${output}" >&2; return 1; }
}

@test "a lone implementing md plan binds its Target Files heading: an unlisted path warns" {
  set_list_rows '{"id":7,"doc_status":"implementing","format":"md","created_at":"2026-07-01T00:00:00Z"}'
  write_doc 7 md "${MD_PLAN_BODY}"
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] && [[ "${output}" == *SCOPE-070* ]] && [[ "${output}" == *'"plan_id":7'* ]] \
    || { echo "unlisted path not flagged against the md plan: ${output}" >&2; return 1; }
}

@test "an md plan binds only through its heading, never through a quoted HTML section" {
  # No Target Files heading, but the body quotes the HTML contract example (as the planner body
  # does) — a section parse here would bind placeholder paths and flag every real edit.
  set_list_rows '{"id":7,"doc_status":"implementing","format":"md","created_at":"2026-07-01T00:00:00Z"}'
  write_doc 7 md "$(printf '%s\n' '# Plan' '## Goal' '```html' \
    '<section id="target-files"><ul><li><code>/absolute/path/one.ts</code></li></ul></section>' '```')"
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] && [[ "${output}" != *SCOPE-070* ]] \
    || { echo "md plan without a heading bound something: ${output}" >&2; return 1; }
}

@test "no binding unless exactly one plan is implementing" {
  local -a rows=(
    'two implementing plans|{"id":7,"doc_status":"implementing","format":"md","created_at":"2026-07-01T00:00:00Z"}|{"id":8,"doc_status":"implementing","format":"md","created_at":"2026-07-02T00:00:00Z"}'
    'doc_review rows only|{"id":7,"doc_status":"doc_review","format":"md","created_at":"2026-07-01T00:00:00Z"}|{"id":8,"doc_status":"doc_review","format":"md","created_at":"2026-07-02T00:00:00Z"}'
    'retired progress stage|{"id":7,"doc_status":"progress","format":"md","created_at":"2026-07-01T00:00:00Z"}|{"id":8,"doc_status":"done","format":"md","created_at":"2026-07-02T00:00:00Z"}'
  )
  write_doc 7 md "${MD_PLAN_BODY}"
  write_doc 8 md "${MD_PLAN_BODY}"
  local row name a b
  for row in "${rows[@]}"; do
    IFS='|' read -r name a b <<<"${row}"
    set_list_rows "${a}" "${b}"
    SCOPE_DRIFT_CACHE_BYPASS=1 run_hook "/work/repo/src/other/out-of-scope.ts"
    [[ "${status}" -eq 0 ]] && [[ "${output}" != *SCOPE-070* ]] \
      || { echo "${name}: bound a plan: ${output}" >&2; return 1; }
  done
  # Each row stopped at the list call: no plan body was fetched.
  local c
  c="$(curl_count)"
  [[ "${c}" -eq "${#rows[@]}" ]] || { echo "a plan body was fetched; curl count ${c} != ${#rows[@]}" >&2; return 1; }
}

@test "a server ignoring the stage filter still binds only the implementing row" {
  # The newer, higher-id doc_review row lists the edited path; binding it would silence the warning.
  set_list_rows \
    '{"id":7,"doc_status":"implementing","format":"md","created_at":"2026-07-01T00:00:00Z"}' \
    '{"id":9,"doc_status":"doc_review","format":"md","created_at":"2026-07-03T00:00:00Z"}' \
    '{"id":8,"doc_status":"done","format":"md","created_at":"2026-07-02T00:00:00Z"}'
  write_doc 7 md "${MD_PLAN_BODY}"
  write_doc 9 md "$(printf '%s\n' '## Target Files' '- src/other/out-of-scope.ts')"
  run_hook "/work/repo/src/other/out-of-scope.ts"
  [[ "${status}" -eq 0 ]] && [[ "${output}" == *SCOPE-070* ]] && [[ "${output}" == *'"plan_id":7'* ]] \
    || { echo "did not bind the implementing row 7: ${output}" >&2; return 1; }
}
