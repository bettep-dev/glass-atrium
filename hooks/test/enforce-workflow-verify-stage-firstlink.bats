#!/usr/bin/env bats
# enforce-workflow-verify-stage-firstlink.bats — pins the first-link revision-cycle ADVISORY
# (seventh advisory pass).
#
# ADVISORY ONLY (stderr + exit 0), emitted on the PASS arm so it can mask no verdict: the blocking
# fixture below asserts the block still wins with the nudge absent.
#
# Hermetic: the monitor loopback is a counting `curl` PATH shim serving a canned three-document
# supersede chain — no live monitor, no background child, no live-install read (the full-URL override
# pins the base and the shim never opens a socket). The chain is DERIVED by the walk, so the depth and
# root the advisory reports are the fixture's own shape rather than anything the script asserts.
#
#   fixture chain:  103  --supersedes_id-->  102  --supersedes_id-->  101 (root, supersedes_id null)
#
# Every DEV fixture here is SCHEMA-FREE — a text-mode {reviewer, dev} verify stage, the canonical
# shape — so the compliant case pins that a script is never nudged for lacking a schema it is
# designed not to have.
#
# BATS GATING NOTE: only the LAST command gates a test — every assertion carries `|| return 1`.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
HOOK_SH="${WFGATE_SH:-${GA}/hooks/enforce-workflow-verify-stage.sh}"
NUDGE_PHRASE='ADVISORY (first-link question, non-blocking)'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"

  WORK="$(mktemp -d -t wfgate-firstlink.XXXXXX)"
  SHIMBIN="${WORK}/bin"
  DOCS="${WORK}/docs"
  COUNT_FILE="${WORK}/curl.count"
  TRACE_LOG="${WORK}/workflow-gate-fired.log"
  mkdir -p "${SHIMBIN}" "${DOCS}"
  : >"${COUNT_FILE}"

  printf '%s\n' '{"id":101,"supersedes_id":null}' >"${DOCS}/101.json"
  printf '%s\n' '{"id":102,"supersedes_id":101}' >"${DOCS}/102.json"
  printf '%s\n' '{"id":103,"supersedes_id":102}' >"${DOCS}/103.json"

  # Counting curl shim: one tally char per call, then serve the doc named by the URL's trailing id.
  # An unknown id exits 22 (curl's -f HTTP-error status), which is the monitor-down shape too.
  cat >"${SHIMBIN}/curl" <<'SH'
#!/usr/bin/env bash
printf 'x' >>"${CURL_COUNT_FILE}"
url=""
for a in "$@"; do
  case "${a}" in
    http*) url="${a}" ;;
  esac
done
doc="${DOCS_DIR}/${url##*/}.json"
[[ -r "${doc}" ]] || exit 22
cat "${doc}"
SH
  chmod +x "${SHIMBIN}/curl"

  DECL_TEAM="/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */"
  SIZE_EST="[SIZE-EST] bundles=1 tool_uses~=10 — small."
  SCOPE_DECL="[SCOPE] files=hooks/a.sh · deliverable=bug-fix · out=none"
  # The literal, read from the HOOK rather than retyped: a test carrying its own copy would pass
  # against a paraphrase the production scan can no longer find.
  LITERAL="$(sed -n "s/^readonly FIRST_LINK_LITERAL='\(.*\)'$/\1/p" "${HOOK_SH}")"
  [[ -n "${LITERAL}" ]] || skip "could not read FIRST_LINK_LITERAL from ${HOOK_SH}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

curl_count() { wc -c <"${COUNT_FILE}" | tr -d '[:space:]'; }

# A passing, schema-free DEV workflow referencing plan id $1, with $2 spliced into the verify goal.
dev_script() {
  printf '%s\n' "${DECL_TEAM}" \
    "log('plan-ref: clauded-docs/${1}');" \
    "log('${SIZE_EST}');" \
    "log('${SCOPE_DECL}');" \
    "parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible — ${2}'}));" \
    "agent('glass-atrium-dev-nestjs',{goal:'implement'});"
}

# Fire the hook over the Workflow envelope. Extra `KEY=VALUE` args become environment overrides.
run_hook() {
  local script="${1}"
  shift
  run env \
    PATH="${SHIMBIN}:${PATH}" \
    CURL_COUNT_FILE="${COUNT_FILE}" \
    DOCS_DIR="${DOCS}" \
    WORKFLOW_GATE_MONITOR_URL="http://127.0.0.1:16145/api/clauded-docs" \
    WORKFLOW_GATE_FIRED_LOG="${TRACE_LOG}" \
    "$@" \
    bash -c '
      payload="$(jq -n --arg s "$1" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
      printf "%s" "${payload}" | bash "$2" 2>&1
    ' _ "${script}" "${HOOK_SH}"
}

run_lint() {
  local script="${1}"
  shift
  run env \
    PATH="${SHIMBIN}:${PATH}" \
    CURL_COUNT_FILE="${COUNT_FILE}" \
    DOCS_DIR="${DOCS}" \
    WORKFLOW_GATE_MONITOR_URL="http://127.0.0.1:16145/api/clauded-docs" \
    WORKFLOW_GATE_FIRED_LOG="${TRACE_LOG}" \
    "$@" \
    bash -c 'printf "%s" "$1" | bash "$2" --lint 2>&1' _ "${script}" "${HOOK_SH}"
}

@test "depth-2 chain, question absent → advisory naming the walked depth and root, exit 0, traced" {
  run_hook "$(dev_script 103 'judge it')"
  [[ "${status}" -eq 0 ]] || { echo "advisory must never block, status ${status} -- ${output}" >&2; return 1; }
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || { echo "no nudge -- ${output}" >&2; return 1; }
  [[ "${output}" == *"chain depth 2"* ]] || { echo "depth not derived -- ${output}" >&2; return 1; }
  [[ "${output}" == *"chain root clauded-docs/101"* ]] || { echo "root not walked to -- ${output}" >&2; return 1; }
  grep -q 'advisory=[^[:space:]]*first-link' "${TRACE_LOG}" || { echo "not traced: $(cat "${TRACE_LOG}")" >&2; return 1; }
}

@test "depth-1 chain → same walk resolves the SAME root, one link shallower (predicate parity)" {
  run_hook "$(dev_script 102 'judge it')"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"chain depth 1"* ]] || { echo "depth not derived -- ${output}" >&2; return 1; }
  [[ "${output}" == *"chain root clauded-docs/101"* ]] || { echo "root differs -- ${output}" >&2; return 1; }
}

@test "chain root itself (depth 0) is a real negative, not a nudge" {
  run_hook "$(dev_script 101 'judge it')"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged an original plan -- ${output}" >&2; return 1; }
  [[ "$(curl_count)" == "1" ]] || { echo "expected one GET, got $(curl_count)" >&2; return 1; }
}

@test "the verbatim question silences the nudge on a schema-free verify stage, before any GET" {
  run_hook "$(dev_script 103 "${LITERAL}")"
  [[ "${status}" -eq 0 ]] || { echo "status ${status} -- ${output}" >&2; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged despite the question -- ${output}" >&2; return 1; }
  [[ "$(curl_count)" == "0" ]] || { echo "walked despite the short-circuit: $(curl_count) GETs" >&2; return 1; }
}

@test "monitor unreachable → silent, exit 0 (fail-open on infrastructure)" {
  rm -f "${DOCS}/103.json"
  run_hook "$(dev_script 103 'judge it')"
  [[ "${status}" -eq 0 ]] || { echo "infrastructure trouble must not block, status ${status}" >&2; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged on a failed GET -- ${output}" >&2; return 1; }
}

@test "curl absent → silent, exit 0, and the gate still reaches its verdict" {
  # A PATH holding every other executable, so the ONLY thing missing is curl. Removing curl by
  # emptying PATH instead would make the assertion vacuous — the hook would fail open on the first
  # absent coreutil and pass this test while proving nothing — which is why the trace assertion below
  # is the positive control: it fires only if the gate ran all the way to its verdict.
  local nocurl="${WORK}/nocurl" dir tool
  mkdir -p "${nocurl}"
  while IFS= read -r dir; do
    [[ -d "${dir}" ]] || continue
    for tool in "${dir}"/*; do
      [[ -f "${tool}" && -x "${tool}" ]] || continue
      [[ "${tool##*/}" == "curl" ]] && continue
      [[ -e "${nocurl}/${tool##*/}" ]] || ln -s "${tool}" "${nocurl}/${tool##*/}"
    done
  done < <(printf '%s' "${PATH}" | tr ':' '\n')
  [[ ! -e "${nocurl}/curl" ]] || { echo "curl leaked into the farm" >&2; return 1; }

  run env -i PATH="${nocurl}" HOME="${WORK}" \
    WORKFLOW_GATE_MONITOR_URL="http://127.0.0.1:16145/api/clauded-docs" \
    WORKFLOW_GATE_FIRED_LOG="${TRACE_LOG}" \
    bash -c '
      payload="$(jq -n --arg s "$1" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
      printf "%s" "${payload}" | bash "$2" 2>&1
    ' _ "$(dev_script 103 'judge it')" "${HOOK_SH}"
  [[ "${status}" -eq 0 ]] || { echo "status ${status} -- ${output}" >&2; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged with no curl -- ${output}" >&2; return 1; }
  grep -q 'verdict=pass' "${TRACE_LOG}" || { echo "gate never reached a verdict: $(cat "${TRACE_LOG}" 2>&1)" >&2; return 1; }
}

@test "a chain deeper than the GET cap → silent (unpriceable, so fail-open)" {
  run_hook "$(dev_script 103 'judge it')" WORKFLOW_GATE_CHAIN_MAX_HOPS=2
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged past the cap -- ${output}" >&2; return 1; }
  [[ "$(curl_count)" == "2" ]] || { echo "cap not honored: $(curl_count) GETs" >&2; return 1; }
}

@test "a workflow with no plan-ref never walks (no id to resolve)" {
  run_hook "${DECL_TEAM}
log('[ENTRY-CLASS] simple-task: one file, no contract change.');
log('${SIZE_EST}');
log('${SCOPE_DECL}');
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}));
agent('glass-atrium-dev-nestjs',{goal:'implement'});"
  [[ "${status}" -eq 0 ]] || { echo "status ${status} -- ${output}" >&2; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged with no plan-ref -- ${output}" >&2; return 1; }
  [[ "$(curl_count)" == "0" ]] || { echo "walked with no id: $(curl_count) GETs" >&2; return 1; }
}

@test "a non-DEV workflow is never nudged and never walks" {
  run_hook "log('plan-ref: clauded-docs/103');
agent('glass-atrium-intel-researcher',{goal:'survey'});"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudged a non-DEV workflow -- ${output}" >&2; return 1; }
  [[ "$(curl_count)" == "0" ]] || { echo "walked a non-DEV workflow: $(curl_count) GETs" >&2; return 1; }
}

@test "a blocking verdict still wins, with no nudge and no walk (PASS-arm siting)" {
  run_hook "log('plan-ref: clauded-docs/103');
log('${SIZE_EST}');
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}));
agent('glass-atrium-dev-nestjs',{goal:'implement'});"
  [[ "${status}" -eq 2 ]] || { echo "declaration-less DEV script must block, status ${status}" >&2; return 1; }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || { echo "nudge masked a block -- ${output}" >&2; return 1; }
  [[ "$(curl_count)" == "0" ]] || { echo "blocked script paid for a walk: $(curl_count) GETs" >&2; return 1; }
}

@test "--lint preview reaches the same verdict and writes no trace line" {
  run_lint "$(dev_script 103 'judge it')"
  [[ "${status}" -eq 0 ]] || { echo "status ${status} -- ${output}" >&2; return 1; }
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || { echo "lint parity lost -- ${output}" >&2; return 1; }
  [[ ! -s "${TRACE_LOG}" ]] || { echo "lint wrote a trace: $(cat "${TRACE_LOG}")" >&2; return 1; }
}

@test "the hook's literal matches the scope-dev.md canonical byte-for-byte (cross-read)" {
  local canonical
  # The backticked sentence on the line after the first-link bullet, in the DEV-side canonical.
  canonical="$(sed -n '/First-link question/,/^  - /p' "${GA}/scoped/scope-dev.md" \
    | sed -n 's/^  > `\(.*\)`$/\1/p')"
  [[ -n "${canonical}" ]] || { echo "canonical sentence not found in scoped/scope-dev.md" >&2; return 1; }
  [[ "${LITERAL}" == "${canonical}" ]] || {
    echo "literal drift:" >&2
    echo "  hook: ${LITERAL}" >&2
    echo "  rule: ${canonical}" >&2
    return 1
  }
}

@test "the new code path reads no workflow-scripts directory" {
  # Absence AC: the revision signal comes from the monitor API, never from a session transcript or a
  # workflows/ scratch dir. Whole-file grep — the hook has no other reason to name any of these.
  ! grep -nE 'subagents|/projects/|workflows/|[.]jsonl' "${HOOK_SH}" || {
    echo "session/workflow directory reference introduced" >&2
    return 1
  }
}
