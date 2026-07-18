#!/usr/bin/env bats
# enforce-workflow-verify-stage.bats — Bats suite for the PreToolUse(Workflow) static
#   [AGENT-COMPOSITION] declaration gate. The gate REPLACED the prior shape-inference machinery with a
#   comment-canonical [AGENT-COMPOSITION] declaration block that the hook consistency-checks against the
#   code — roles are DECLARED by the author, not GUESSED from layout. This suite pins the declaration
#   contract:
#   presence (block-nodecl), grammar (block-grammar), the DEV hard-gate (block-noverifydev), the
#   zero-reviewer hard guarantee (block-norev — survives the upstream form), the consistency checks
#   (a block-declspawn / b + b' block-undecl / c block-computed / d block-order / e block-upstream),
#   the retained entry / size-est / docroute gates, and the accepted honor-system floor (a lying
#   declaration passes).
#
# Decision channel = exit code only (PreToolUse): exit 0 PASS / exit 2 BLOCK.
# Input is the real PreToolUse(Workflow) envelope: {"tool_name":"Workflow",
#   "tool_input":{"script":"<js>"}}, built with jq so arbitrary quotes/parens in the script body are
#   escaped safely. WORKFLOW_GATE_FIRED_LOG is redirected to a temp path so the trace never touches the
#   live runtime log.
#
# bats-1.13 LAST-COMMAND SEMANTICS (load-bearing): a test fails ONLY on its final command's non-zero
#   exit — an intermediate `[[ ... ]]` that is not the last line does NOT fail the test. Every
#   assertion below is therefore written `[[ ... ]] || return 1` so it gates regardless of position
#   (`return` runs in the test-body function scope → fails the test immediately). Never leave a bare
#   intermediate `[[ ... ]]` — it would silently pass.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-workflow-verify-stage.sh"
CORPUS_DIR="${BATS_TEST_DIRNAME}/corpus"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  TRACE_LOG="${BATS_TEST_TMPDIR}/workflow-gate-fired.log"
}

# Drive the hook with a Workflow envelope wrapping $1 (the JS script string).
# jq -n --arg escapes the script body; the trace log is sandboxed to the temp dir.
run_hook() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" bash "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# Drive the hook with a corpus FILE ($1 = path) via jq --rawfile so the exact bytes are the script.
run_hook_file() {
  run bash -c '
    file="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --rawfile s "${file}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" bash "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# firing-trace tag assertion — verdict=<tag> recorded on the most recent firing.
assert_trace() { grep -q "verdict=${1}" "${TRACE_LOG}"; }

# Shared docroute assertion tails — status + "doc-routing leak" stderr pair combined into ONE
# command so they gate as the final command (or via `|| return 1`).
assert_docroute_pass() { [[ "${status}" -eq 0 && ! "${output}" =~ "doc-routing leak" ]]; }
assert_docroute_block() { [[ "${status}" -eq 2 && "${output}" =~ "doc-routing leak" ]]; }

# A recognized plan-reference token — every DEV-spawning PASS fixture needs one (or an [ENTRY-CLASS]
# token) to clear the entry-miss gate.
PLAN_REF="clauded-docs/100"
# A recognized [SIZE-EST] delegation-size self-attestation token — every DEV PASS fixture under
# ENTRY_OK needs one to clear the size-attestation gate.
SIZE_EST="[SIZE-EST] bundles=1 tool_uses~=10"

# Canonical in-script Stage-2 verify-team declaration (reviewer + EXACTLY ONE dev type). Prepended to
# a fixture as a real /* */ block comment (the string-literal guard keeps a string-resident copy inert).
DECL_TEAM='/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */'

# =====================================================================================================
# SECTION A — fail-open / tooling gates (no DEV spawn, no declaration needed → PASS).
# =====================================================================================================

@test "failopen: empty script → PASS (nothing to inspect) + pass-noscript trace" {
  run_hook ""
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass-noscript || return 1
}

@test "failopen: non-Workflow tool_name → PASS (out of scope)" {
  run bash -c '
    printf "%s" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/x\"}}" | WORKFLOW_GATE_FIRED_LOG="$2" bash "$1"
  ' _ "${HOOK_SH}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "failopen: garbage non-JSON stdin → PASS (jq fails, fail-open)" {
  run bash -c '
    printf "%s" "not json at all <<<" | WORKFLOW_GATE_FIRED_LOG="$2" bash "$1"
  ' _ "${HOOK_SH}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]] || return 1
}

# VERDICT-PLUMBING TRAP (runtime half): a python-side verdict token missing from the bash enumerated
# case silently falls to the `*)` default → PASS. Pinning an UNKNOWN token → PASS makes the fail-open
# default explicit; the static set-equality test (section J) pins that no REAL token is missing.
@test "failopen: unknown helper verdict token → PASS (exit 0, enumerated-case default)" {
  local stub_dir
  stub_dir="${BATS_TEST_TMPDIR}/stub-bin"
  mkdir -p "${stub_dir}"
  printf '#!/usr/bin/env bash\nprintf "BLOCK_FUTURE\\nENTRY_OK\\n"\n' >"${stub_dir}/python3"
  chmod +x "${stub_dir}/python3"
  run bash -c '
    script="$1"; hook="$2"; trace="$3"; stub="$4"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | PATH="${stub}:${PATH}" WORKFLOW_GATE_FIRED_LOG="${trace}" bash "${hook}"
  ' _ "pipeline(agent('glass-atrium-dev-nestjs',{goal:'implement'}))" "${HOOK_SH}" "${TRACE_LOG}" "${stub_dir}"
  [[ "${status}" -eq 0 ]] || return 1
}

# =====================================================================================================
# SECTION B — non-DEV exempt (no dev-* literal anywhere → Stage-2 exempt → PASS, no declaration needed).
# =====================================================================================================

@test "exempt: doc-only workflow (reporter + reviewer, no DEV) → PASS (Stage-2 exempt)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'doc'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "exempt: non-member intel-researcher alone → PASS (not a DEV spawn)" {
  run_hook "agent('glass-atrium-intel-researcher',{goal:'research only'})"
  [[ "${status}" -eq 0 ]] || return 1
}

# F7 accepted-FN pin (KNOWN LIMITATION disclosure, hook header): a fully-COMPUTED agentType spawn
# (agentType resolved at runtime) with ZERO dev-* literals ANYWHERE is invisible to Tier A → the
# script reads as non-DEV → Stage-2 EXEMPT → PASS. Pre-existing Tier-A-blind blind spot, retained
# UNCHANGED by the declaration contract (accepted fail-open false-negative — a missed bypass beats a
# false BLOCK). If this ever flips to exit 2, the disclosed accepted floor moved silently.
@test "exempt(F7 accepted-FN): computed agentType + ZERO dev literals anywhere → PASS (Tier-A blind spot)" {
  run_hook "log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
const chosen = pickAgent()
pipeline(agent('build it',{agentType: chosen}))"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# =====================================================================================================
# SECTION C — BLOCK_NODECL (missing declaration on a DEV workflow — presence parity with entry/size).
# =====================================================================================================

@test "nodecl: DEV workflow, NO declaration → BLOCK_NODECL (missing composition declaration)" {
  run_hook "log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"missing composition declaration"* ]] || return 1
  assert_trace block-nodecl || return 1
}

# Presence parity: even a REAL in-script {qa, dev} verify pair does NOT satisfy the gate without the
# declaration block (the block is the mandatory self-attestation, like [ENTRY-CLASS] / [SIZE-EST]).
@test "nodecl: valid in-script verify pair but NO declaration → BLOCK_NODECL (absence blocks)" {
  run_hook "parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-nodecl || return 1
}

# membership: dev-swift (a synced DEV_SET member) is recognized as a DEV spawn → no declaration →
# BLOCK_NODECL. Fails RED if dev-swift is ever dropped from the runtime DEV_SET roster.
@test "nodecl: dev-swift impl, no declaration → BLOCK_NODECL (synced DEV member recognized)" {
  run_hook "agent('glass-atrium-dev-swift',{goal:'implement the swift module'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-nodecl || return 1
}

# string-residency: a declaration whose ONLY sentinel pair sits inside a JS string literal is treated
# as ABSENT (the provenance guard keeps a worked example quoted into a prompt inert) → BLOCK_NODECL,
# and the stderr names string-residency + the /* */ fix.
@test "nodecl: sentinel pair ONLY inside a string literal → BLOCK_NODECL + string-residency note" {
  run_hook "const GOAL = \`The gate wants:
[AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-shell
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION]\`;
agent('glass-atrium-dev-shell',{goal:GOAL})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"missing composition declaration"* ]] || return 1
  [[ "${output}" == *"STRING-RESIDENCY"* ]] || return 1
  assert_trace block-nodecl || return 1
}

# =====================================================================================================
# SECTION D — BLOCK_GRAMMAR (malformed declaration — a DECIDABLE author error, distinct from ABSENCE).
#   Binding condition 1: the grammar-malformed verdict token (block-grammar) is explicitly enumerated
#   and DISTINCT from block-nodecl ("malformed" vs "missing" stderr). Each fixture carries a real
#   {qa, dev} spawn so the block is unambiguously the grammar verdict.
# =====================================================================================================

@test "grammar: unknown key → BLOCK_GRAMMAR (malformed composition declaration)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
bogus: something
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"malformed composition declaration"* ]] || return 1
  assert_trace block-grammar || return 1
}

@test "grammar: duplicate key → BLOCK_GRAMMAR" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
impl: glass-atrium-dev-react
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

@test "grammar: unknown agent name → BLOCK_GRAMMAR (name not in runtime DEV_SET + reviewer literal)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-bogus
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

# Exact-shape pin: names in a verify clause MUST be comma-separated. A space-joined pair collapses to
# ONE token that is not in the runtime DEV_SET + reviewer literal → unknown name → BLOCK_GRAMMAR
# (the confusion the enriched authoring surfaces warn against).
@test "grammar: space-separated verify pair (no comma) → BLOCK_GRAMMAR (reads as one unknown name)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

@test "grammar: line without a known key + colon → BLOCK_GRAMMAR" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
this line has no key colon
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

@test "grammar: unterminated block (open sentinel, no close) → BLOCK_GRAMMAR" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

@test "grammar: 2+ comment-resident blocks → BLOCK_GRAMMAR (ambiguous authority)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-react
impl: glass-atrium-dev-react
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

@test "grammar: team-form verify naming 2+ dev types → BLOCK_GRAMMAR (Stage-2 team = exactly one dev)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs, glass-atrium-dev-react
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

@test "grammar: malformed upstream clause → BLOCK_GRAMMAR" {
  run_hook "/* [AGENT-COMPOSITION]
verify: upstream something-bogus
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
agent('glass-atrium-qa-code-reviewer',{goal:'r'});agent('glass-atrium-dev-shell',{goal:'i'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

# Binding condition 1 (explicit): the malformed-declaration token is DISTINCT from missing-declaration
# — "malformed" and "missing" are different stderr causes on different trace tags, never conflated.
@test "grammar: malformed token DISTINCT from missing-declaration (binding condition 1)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
bogus: x
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${output}" == *"malformed composition declaration"* ]] || return 1
  [[ "${output}" != *"missing composition declaration"* ]] || return 1
  assert_trace block-grammar || return 1

  run_hook "parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${output}" == *"missing composition declaration"* ]] || return 1
  [[ "${output}" != *"malformed composition declaration"* ]] || return 1
  assert_trace block-nodecl || return 1
}

# =====================================================================================================
# SECTION D2 — string-mask extraction scan (stolen-match regression family). The extraction BLANKS
#   string-masked chars to spaces BEFORE any sentinel scan: previously the block finditer ran over RAW
#   src with post-hoc start filtering, so a string-resident OPENING sentinel stole a non-greedy match
#   through the REAL block's closer and a genuine declaration was mis-read as unterminated
#   (BLOCK_GRAMMAR). These fixtures pin coexistence of string mentions WITH real blocks in every state.
# =====================================================================================================

# (i) The live-defect shape: a string-resident opening-sentinel mention BEFORE a valid comment block.
# Pre-fix this BLOCKED as malformed-declaration (stolen match → unterminated); it must PASS.
@test "extract(mask): string opening-sentinel mention BEFORE a valid comment block → PASS (stolen-match repair)" {
  run_hook "const NOTE = 'mentions the [AGENT-COMPOSITION] contract token in prose'
${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# (ii) A string-resident COMPLETE pair coexisting with a valid comment block stays inert → PASS (pin).
@test "extract(mask): string-resident COMPLETE pair before a valid comment block → PASS (pair stays inert)" {
  run_hook "const EXAMPLE = 'worked example: [AGENT-COMPOSITION] verify: qa, dev [/AGENT-COMPOSITION]'
${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# (iii) A string-only OPENING mention with NO real block anywhere is still ABSENT → BLOCK_NODECL
# (complements the complete-pair string-residency pin in SECTION C).
@test "extract(mask): string-resident OPENING mention only, NO real block → BLOCK_NODECL (mention inert)" {
  run_hook "const NOTE = 'the [AGENT-COMPOSITION] token appears only inside this string'
agent('glass-atrium-dev-shell',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"missing composition declaration"* ]] || return 1
  assert_trace block-nodecl || return 1
}

# (iv) Duplicate-detection integrity: pre-fix, a string mention BETWEEN two real blocks let the stolen
# match swallow block 2 → hidden duplicate bypass ('ok'). Post-fix both real blocks are seen → duplicate.
@test "extract(mask): 2 real blocks with a string mention BETWEEN → BLOCK_GRAMMAR (duplicate not bypassed)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
const NOTE = 'prose mentioning [AGENT-COMPOSITION] between two real blocks'
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-react
impl: glass-atrium-dev-react
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"malformed composition declaration"* ]] || return 1
  assert_trace block-grammar || return 1
}

# (v) Coexistence preserves genuine-unterminated detection: a string mention plus a REAL open sentinel
# with no closer still lands on unterminated → BLOCK_GRAMMAR.
@test "extract(mask): string mention + genuinely unterminated real block → BLOCK_GRAMMAR (unterminated kept)" {
  run_hook "const NOTE = 'prose mentioning [AGENT-COMPOSITION] ahead of a broken block'
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-grammar || return 1
}

# (vi) Companion-site pin (span-exact excision at body_only_src): under the upstream form, a string
# mention BEFORE the block must not let a raw-src COMPOSITION_RE.sub over-delete the plan-ref citation
# sitting BETWEEN them — only the real block span is excised, so the citation survives → PASS.
@test "extract(mask): upstream form, string mention before block, plan-ref cited between → PASS (span-exact excision)" {
  run_hook "const NOTE = 'prose mentioning [AGENT-COMPOSITION] before the declaration'
log('plan-ref: clauded-docs/3')
/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/3
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
agent('glass-atrium-qa-code-reviewer',{goal:'final review'});agent('glass-atrium-dev-shell',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# =====================================================================================================
# SECTION E — BLOCK_NOVERIFYDEV (the Stage-2 DEV hard-gate lives in the grammar validator: a team-form
#   verify clause naming NO dev-* partner is rejected).
# =====================================================================================================

@test "noverifydev: reviewer-only verify team (no dev partner) → BLOCK_NOVERIFYDEV" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
agent('glass-atrium-qa-code-reviewer',{goal:'review'});agent('glass-atrium-dev-shell',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"verify team lacks the DEV half"* ]] || return 1
  assert_trace block-noverifydev || return 1
}

# =====================================================================================================
# SECTION F — BLOCK_NOREV (zero-reviewer hard guarantee — evaluated INDEPENDENTLY of the declaration
#   form and SURVIVES the upstream form: a fake upstream line can NEVER delete reviewer presence).
# =====================================================================================================

@test "norev: DEV + valid declaration but NO reviewer spawn anywhere → BLOCK_NOREV" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: clauded-docs/7')
agent('glass-atrium-dev-nestjs',{goal:'implement, but NO reviewer spawned anywhere'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-norev || return 1
}

# R1 pin: the upstream form + a DEV spawn + a MATCHING plan-ref + ZERO reviewer token → BLOCK_NOREV.
# The only cause of the block is the missing reviewer (plan-ref matches), proving upstream does NOT
# waive the zero-reviewer hard guarantee. Authored to FAIL against the sandbox prototype (which
# exited via the upstream PASS branch before the NOREV check).
@test "norev: upstream form + plan-ref + ZERO reviewer → BLOCK_NOREV (upstream never waives NOREV)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/3
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: clauded-docs/3')
agent('glass-atrium-dev-shell',{goal:'implement per the verified plan'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"does NOT waive it"* ]] || return 1
  assert_trace block-norev || return 1
}

# #26 pin: upstream form + a quote-bounded reviewer LITERAL that is a PROSE MENTION (Tier-A presence,
# but NOT a real Tier-B agent('reviewer',…)/agentType:'reviewer' spawn) + a matching plan-ref → the
# Tier-A NOREV check at :687 is satisfied by the quoted literal, but the upstream form must ADDITIONALLY
# require a real Tier-B reviewer spawn → BLOCK_NOREV. Authored to FAIL before the fix (the upstream
# branch previously PASSed on Tier-A presence alone, waiving the real-reviewer guarantee).
@test "norev(#26): upstream form + reviewer PROSE-MENTION only (no real spawn) → BLOCK_NOREV" {
  run_hook "/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/3
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: clauded-docs/3')
const REVIEWER_NOTE = 'glass-atrium-qa-code-reviewer'
agent('glass-atrium-dev-shell',{goal:'implement per the verified plan'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-norev || return 1
}

# =====================================================================================================
# SECTION G — consistency checks a / b / b' / c / d / e (declaration falsified against code) + the
#   two PASS shapes (in-script team greedy binding; in-script team + impl-computed).
# =====================================================================================================

# (a) a declared literal role (verify team member or impl) has NO matching spawn-position token.
@test "consistency(a): declared verify-dev never spawned → BLOCK_DECLSPAWN" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-react
impl: glass-atrium-dev-react
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
agent('glass-atrium-qa-code-reviewer',{goal:'review'});agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-declspawn || return 1
}

# Exact-shape pin: a declared verify-dev whose ONLY occurrence is a wrapper argument
# (robustAgent('type',…)) has no bare agent('type')/agentType:'type' spawn position — the lowercase
# agent( scan never matches the capital-A robustAgent( callee — so the declared type is un-spawned →
# BLOCK_DECLSPAWN. Fix is the opts agentType: literal or an impl-computed: declaration (see #45 robust
# PASS shape), NOT a validator change.
@test "consistency(a): declared verify-dev only as wrapper arg (robustAgent) → BLOCK_DECLSPAWN" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
async function robustAgent(agentType, opts) { return agent(opts.goal, { ...opts, agentType }).catch(() => null); }
agent('glass-atrium-qa-code-reviewer',{goal:'review'});robustAgent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-declspawn || return 1
}

# (b) a real Tier-B dev spawn in the code is not covered by any declaration clause.
@test "consistency(b): undeclared Tier-B spawn → BLOCK_UNDECL" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})
agent('glass-atrium-dev-python',{goal:'also implement, UNDECLARED'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-undecl || return 1
}

# (b') PROSE-MENTION sub-cause (binding condition 4): an exact-quoted dev-* name inside a goal/prose
# string (Tier-A hit, zero Tier-B spawns) is undeclared → BLOCK_UNDECL, and the stderr names the
# prose-mention case + its one-edit remediation.
@test "consistency(b' prose): quoted dev-* mention in a goal string, undeclared → BLOCK_UNDECL + PROSE-MENTION" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))
agent('glass-atrium-dev-nestjs',{goal:\"delegate to 'glass-atrium-dev-python' later\"})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"PROSE-MENTION"* ]] || return 1
  [[ "${output}" == *"ONE-EDIT"* ]] || return 1
  assert_trace block-undecl || return 1
}

# (b') CONFIG-ARRAY sub-cause (R3 closure): a dev literal parked in a config array (agent:'dev-*',
# Tier-A only, zero Tier-B spawn positions) that is undeclared → BLOCK_UNDECL. Authored to FAIL
# against the sandbox prototype (whose (b) iterated Tier-B only).
@test "consistency(b' config-array): undeclared config-array dev literal → BLOCK_UNDECL (R3 hole closed)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
const BATCHES=[{id:'H1',agent:'glass-atrium-dev-python'}]
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-undecl || return 1
}

# (c) a declared impl-computed type has NO Tier-A data-literal presence anywhere.
@test "consistency(c): declared impl-computed type absent from the data → BLOCK_COMPUTED" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl-computed: glass-atrium-dev-swift
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-computed || return 1
}

# (d) a declared implementation dev textually precedes EVERY reviewer (ungated implementation).
@test "consistency(d): impl dev precedes all reviewers → BLOCK_ORDER" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-react
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
agent('glass-atrium-dev-react',{goal:'implement BEFORE any review (ungated)'})
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-order || return 1
}

# (e) an upstream clauded-docs/<N> clause whose id is NOT cited by a plan-ref token in the body (the
# reviewer IS present so NOREV passes → the block is unambiguously the upstream-citation verdict).
@test "consistency(e): upstream clause without a body plan-ref citation → BLOCK_UPSTREAM" {
  run_hook "/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/9
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
agent('glass-atrium-qa-code-reviewer',{goal:'final review'});agent('glass-atrium-dev-shell',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-upstream || return 1
}

# PASS shape 1: canonical in-script {qa, dev-nestjs} verify pair gates a same-type dev-nestjs
# implementation via greedy-earliest dual-role binding (the first dev-nestjs = verify slot, the
# second = impl; the reviewer precedes it).
@test "consistency PASS: canonical in-script team, greedy dual-role binding → PASS" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
agent('glass-atrium-intel-planner',{goal:'author plan'})
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement per verified plan'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# PASS shape 2: in-script team + a declared impl-computed config-array fan-out → PASS.
@test "consistency PASS: in-script team + impl-computed config-array → PASS" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl-computed: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
const CFG = [{ a: 'glass-atrium-dev-shell' }]
pipeline(CFG, (b) => agent('impl', { agentType: b.a }))"
  [[ "${status}" -eq 0 ]] || return 1
}

# (a-count / #27) SAME-TYPE DUAL-ROLE with a SINGLE spawn, impl-first — the type is declared in BOTH
# verify: and impl: but has only ONE Tier-B spawn, so one declared role (verify partner OR impl) is
# provably unspawned. The greedy binding would absorb the lone spawn as the verify slot → zero impl
# positions → ordering check (d) vacuously passes (the bypass). The count facet of check (a) blocks it.
# Authored to FAIL before the fix (single-spawn dual-role impl-first PASSed via the ordering vacuity).
@test "consistency(a-count #27): same-type dual-role SINGLE spawn, impl-first → BLOCK_DECLSPAWN" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
agent('glass-atrium-dev-nestjs',{goal:'implement BEFORE review, the ONLY dual-role spawn'})
agent('glass-atrium-qa-code-reviewer',{goal:'review after'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-declspawn || return 1
}

# (a-count / #27) REGRESSION GUARD — the HONEST dev-first-parallel dual-role team with TWO spawns of the
# type (verify slot + impl slot) must still PASS. Guards against a future positional 'fix' that would
# false-block a dev-* appearing textually before the reviewer inside the verify parallel.
@test "consistency(a-count #27): honest dev-first-parallel dual-role, 2 spawns → PASS" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-dev-nestjs',{goal:'feasible verdict'}),agent('glass-atrium-qa-code-reviewer',{goal:'judge'}))
agent('glass-atrium-dev-nestjs',{goal:'implement per verified plan'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# =====================================================================================================
# SECTION H — upstream form (waives the in-script pair-mapping + ordering ONLY).
# =====================================================================================================

@test "upstream: valid upstream + reviewer spawn + body plan-ref → PASS" {
  run_hook "/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/3
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: clauded-docs/3')
agent('glass-atrium-qa-code-reviewer',{goal:'final review'});agent('glass-atrium-dev-shell',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
}

# =====================================================================================================
# SECTION I — legacy red-team 3-fixture family (binding condition 2) + accepted honor-system floor.
#   The historically hardest shape (a stray audit reviewer + scattered impl devs, no genuine verify
#   pair) is pinned in ALL THREE declaration states so a future refactor cannot silently move the
#   trust boundary.
# =====================================================================================================

# (i) NO declaration → BLOCK_NODECL. Under 952e84a inference this shape blocked UNCONDITIONALLY; now
# absence is the block cause (presence parity).
@test "redteam(i): legacy shape, NO declaration → BLOCK_NODECL" {
  run_hook "log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
agent('glass-atrium-qa-code-reviewer',{goal:'standalone audit note, NOT a verify partner'})
const pad='filler stage padding '
agent('glass-atrium-dev-shell',{goal:'scattered impl 1'})
const pad2='filler stage padding '
agent('glass-atrium-dev-node',{goal:'scattered impl 2'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-nodecl || return 1
}

# (ii) HONEST declaration — there is no genuine verify DEV to name, so the honest team clause is
# reviewer-only → the DEV hard-gate rejects it → BLOCK_NOVERIFYDEV (= DEV prototype adv4 intent).
@test "redteam(ii): legacy shape, HONEST reviewer-only verify → BLOCK_NOVERIFYDEV" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
agent('glass-atrium-qa-code-reviewer',{goal:'standalone audit note, NOT a verify partner'})
const pad='filler stage padding '
agent('glass-atrium-dev-shell',{goal:'scattered impl'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"verify team lacks the DEV half"* ]] || return 1
  assert_trace block-noverifydev || return 1
}

# (iii) LYING declaration — an impl dev declared as the verify partner → greedy binding absorbs its
# first spawn as the verify slot, some reviewer precedes the impl slot, so it PASSES.
#
# ACCEPTED-FLOOR HONESTY PIN — R2 REGRESSION TRADE vs 952e84a (mirrors plan_verify_v2 / r2_verification):
# under the shipped 952e84a inference this red-team shape blocked UNCONDITIONALLY (the STANDING
# REJECTION — no token could clear it). Under the declaration contract the floor MOVES from
# "must restructure the code" to a "one-line lie", the SAME honor-system floor as [ENTRY-CLASS] /
# [SIZE-EST] / plan-ref. This is the user's explicit locked trade (contract items 2/6): a floor
# RELOCATION to honor-system, NOT a silent weakening. Ordering check (d) still mechanically blocks
# every variant where an impl dev precedes ALL reviewers.
@test "redteam(iii) accepted-floor: LYING declaration on the legacy shape → PASS (honor-system floor)" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-shell
impl: glass-atrium-dev-node
[/AGENT-COMPOSITION] */
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
agent('glass-atrium-qa-code-reviewer',{goal:'standalone audit note'})
const pad='filler stage padding '
agent('glass-atrium-dev-shell',{goal:'scattered impl 1, LIED as the verify dev'})
const pad2='filler stage padding '
agent('glass-atrium-dev-node',{goal:'scattered impl 2'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# =====================================================================================================
# SECTION I2 — JS REGEX-LITERAL LEXING (#29). strip_comments + _string_mask are regex-literal-aware so
#   a // (or a quote/backtick) INSIDE a regex literal is not mis-lexed as a comment/string — the mis-lex
#   otherwise blanks the rest of a source line (or desyncs string state) and false-BLOCKs a compliant
#   workflow. The regression guard (iv) proves a genuine //-commented reviewer is still stripped.
# =====================================================================================================

# (i) a regex literal /\/\//g whose inner // used to trip the line-comment lexer, blanking the rest of
# the line (the reviewer + dev parallel spawn) → block-norev. With regex awareness the whole line
# survives → the reviewer spawn is seen → PASS. Authored to FAIL before the fix.
@test "regex(#29 i): /\\/\\//g before the reviewer spawn on the same line → PASS (was block-norev)" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
const norm = (s) => s.replace(/\/\//g, '/'); parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# (ii) a regex literal containing a backtick char-class /[\`]/ that used to open a spurious template
# string, which then paired with the real multi-line template's backticks and engulfed the declaration
# block → block-nodecl. With regex awareness the backtick is regex content, the real template pairs
# correctly, and the declaration is extracted → PASS. Authored to FAIL before the fix.
@test "regex(#29 ii): backtick char-class regex + multi-line template before the declaration → PASS (was block-nodecl)" {
  run_hook "const RE = /[\`]/
const tpl = \`line1
line2\`
${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# (iii) a char-class regex /[/]/ (a slash INSIDE the character class) on a spawn-bearing line — the
# class-aware termination must not stop the regex at the inner slash. Reviewer spawn survives → PASS.
@test "regex(#29 iii): char-class regex /[/]/ on a spawn-bearing line → PASS" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
const SEP = /[/]/; parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# (iv) REGRESSION GUARD — comment-stripping intent retained: a GENUINELY //-commented-out reviewer
# spawn (a real line comment, nxt char is a slash so it is NOT a regex) with no live reviewer still
# yields block-norev. The regex awareness must not swallow real line comments.
@test "regex(#29 iv): genuinely //-commented reviewer, no live reviewer → BLOCK_NOREV" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
// agent('glass-atrium-qa-code-reviewer',{goal:'this reviewer spawn is commented out'})
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-norev || return 1
}

# =====================================================================================================
# SECTION J — verdict plumbing (the VERDICT-PLUMBING TRAP: a python token missing from the bash case
#   silently PASSes). Static set-equality across the emit set / case arms + the ADR-2 allowlist scope.
# =====================================================================================================

@test "plumbing: python BLOCK_* emit set == bash case-arm set (no silent-PASS token)" {
  local py_tokens case_tokens
  py_tokens="$(grep -oE '"BLOCK_[A-Z_]+"' "${HOOK_SH}" | tr -d '"' | sort -u)"
  case_tokens="$(grep -oE 'BLOCK_[A-Z_]+\)' "${HOOK_SH}" | tr -d ')' | sort -u)"
  [[ -n "${py_tokens}" ]] || return 1
  [[ "${py_tokens}" == "${case_tokens}" ]] || {
    echo "MISMATCH: python=[${py_tokens}] case=[${case_tokens}]" >&2
    return 1
  }
}

# The new block-grammar tag is in the block_and_exit ADR-2 addendum allowlist (deliberate opt-IN);
# block-entry and block-sizeest stay EXCLUDED (they own their own entry guidance / are ENTRY_OK-only).
@test "plumbing: ADR-2 addendum allowlist includes block-grammar, excludes block-entry/block-sizeest" {
  local line
  line="$(grep 'addendum_allowed=true ;;' "${HOOK_SH}")"
  [[ "${line}" == *"block-grammar"* ]] || return 1
  [[ "${line}" != *"block-entry"* ]] || return 1
  [[ "${line}" != *"block-sizeest"* ]] || return 1
}

# =====================================================================================================
# SECTION K — BLOCK_ENTRY (entry-miss). Under the declaration contract the entry-miss channel fires
#   ONLY on a would-be-PASS DEV workflow (valid declaration + reviewer + consistent) that lacks a
#   plan-ref AND an [ENTRY-CLASS] token — an ENTRY_ADVISORY at a non-BLOCK verdict.
# =====================================================================================================

@test "entry: valid declaration + verify pair, NO plan-ref NO token → BLOCK_ENTRY (entry-miss)" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" =~ "entry-miss" ]] || return 1
  assert_trace block-entry || return 1
}

@test "entry: valid declaration + [ENTRY-CLASS] token → PASS (entry signal satisfied)" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('[ENTRY-CLASS] simple-task: trivial config edit')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" =~ "entry-miss" ]] || return 1
}

@test "entry: valid declaration + plan-ref → PASS (entry signal satisfied)" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: clauded-docs/4821')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" =~ "entry-miss" ]] || return 1
}

# #28 word-boundary (PLAN_REF_RE mirror): an incidental 'workplan-2026' token is NOT a plan-ref, so a
# would-be-PASS DEV workflow whose ONLY entry signal is 'workplan-2026' still lands on BLOCK_ENTRY.
# Authored to FAIL before the anchor fix (unanchored plan-[0-9]+ matched inside 'workplan-2026' → PASS).
@test "entry(#28): 'workplan-2026' does NOT satisfy plan-ref → BLOCK_ENTRY" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('advance the workplan-2026 milestone note')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" =~ "entry-miss" ]] || return 1
  assert_trace block-entry || return 1
}

# #28 companion: a REAL 'plan-6569' slug still satisfies the plan-ref entry signal → PASS.
@test "entry(#28): real 'plan-6569' slug satisfies plan-ref → PASS" {
  run_hook "${DECL_TEAM}
log('${SIZE_EST}')
log('implement per plan-6569')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" =~ "entry-miss" ]] || return 1
  assert_trace pass || return 1
}

# BLOCK_NODECL carries the entry addendum: a DEV workflow with NO declaration AND no entry signal
# lands on block-nodecl AND appends the entry-format addendum (both needs surfaced in one pass).
@test "entry: no declaration + no entry signal → BLOCK_NODECL WITH entry-format addendum" {
  run_hook "parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"missing composition declaration"* ]] || return 1
  [[ "${output}" == *"entry classification / plan-reference also required"* ]] || return 1
  assert_trace block-nodecl || return 1
}

# =====================================================================================================
# SECTION L — BLOCK_SIZEEST (size-attestation miss — promoted at a would-be PASS under ENTRY_OK when
#   no [SIZE-EST] token is present; DEV-gated + ENTRY_OK-gated + raw-scanned).
# =====================================================================================================

@test "sizeest: valid declaration under ENTRY_OK, NO [SIZE-EST] → BLOCK_SIZEEST" {
  run_hook "${DECL_TEAM}
log('plan-ref: clauded-docs/55')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"size-attestation miss"* ]] || return 1
  assert_trace block-sizeest || return 1
}

@test "sizeest: valid declaration WITH [SIZE-EST] present → PASS" {
  run_hook "${DECL_TEAM}
log('plan-ref: clauded-docs/55')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"size-attestation miss"* ]] || return 1
}

@test "sizeest: [SIZE-EST] token inside a comment still counts → PASS (raw-scan)" {
  run_hook "${DECL_TEAM}
log('plan-ref: clauded-docs/55')
/* [SIZE-EST] bundles=3 tool_uses~=30 */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"size-attestation miss"* ]] || return 1
}

@test "sizeest: non-DEV doc workflow with NO [SIZE-EST] → PASS (DEV-gated)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize the findings'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"size-attestation miss"* ]] || return 1
}

# =====================================================================================================
# SECTION M — SECOND DETECTION PASS: doc-routing leak (weakest layer, string heuristic, fail-open).
#   Retained verbatim from the pre-declaration hook — docroute detection runs BEFORE the declaration
#   check, so a leak blocks a doc-agent workflow regardless of the declaration.
# =====================================================================================================

@test "docroute: reporter spawn hardcodes local Target, no monitor POST → BLOCK" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE the report to ~/design-md-analysis/improvement-report.md then Write the markdown file'}))"
  assert_docroute_block || return 1
}

@test "docroute: planner spawn mkdir -p then Write local path, no POST → BLOCK" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'mkdir -p \$HOME/reports && Write the plan markdown'}))"
  assert_docroute_block || return 1
}

@test "docroute: same reporter spawn WITH a monitor-POST instruction → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE the report to ~/r.md then POST it to the monitor clauded-docs API'}))"
  assert_docroute_pass || return 1
}

@test "docroute: planner /tmp staging cat-piped into clauded-docs POST → PASS (staging is normal)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'Target file: /tmp/plan.md then curl POST /api/clauded-docs with html_body'}))"
  assert_docroute_pass || return 1
}

@test "docroute: non-doc non-DEV agent with a local path → PASS (unrelated, fail-open)" {
  run_hook "pipeline(agent('glass-atrium-qa-code-reviewer',{goal:'Target file: ~/notes.md review it'}))"
  assert_docroute_pass || return 1
}

@test "docroute: doc agent spawn with NO hardcoded local path → PASS (fail-open)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize the findings into a coherent document'}))"
  assert_docroute_pass || return 1
}

@test "docroute: local Target path inside a comment is comment-stripped → PASS (fail-open)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize'}) /* Target file: ~/leak.md */)"
  assert_docroute_pass || return 1
}

# docroute runs BEFORE the declaration check, so a nested DEV verify-stage workflow with a leak still
# blocks on the leak (independent pass), regardless of any declaration.
@test "docroute: leak nested in a DEV verify-stage workflow → BLOCK (docroute pass runs first)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE to ~/r.md'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-python',{goal:'feasible'})), agent('glass-atrium-dev-python',{goal:'implement'}))"
  assert_docroute_block || return 1
}

# P0 asymmetric raw-scan: a commented monitor-POST routing note still suppresses the leak (raw-scanned
# suppressor); a commented qa-reviewer / dev spawn still counts as absent (comment-stripped spawns).
@test "docroute: commented monitor-POST note suppresses BLOCK_DOCROUTE → PASS (raw-scan suppressor)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE the report to ~/r.md'}) /* route: POST to clauded-docs */)"
  assert_docroute_pass || return 1
}

# docroute + a dev-* spawn + ENTRY_ADVISORY → BLOCK_DOCROUTE with the entry-format addendum (the
# addendum rides the block-docroute verdict via the ADR-2 allowlist). Fixture purity: NO clauded-docs
# token (would suppress docroute AND flip entry_marker).
@test "docroute F1: leak + dev-* spawn + ENTRY_ADVISORY → BLOCK with entry-format addendum" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE to ~/r.md'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"doc-routing leak"* ]] || return 1
  [[ "${output}" == *"entry classification / plan-reference also required"* ]] || return 1
  assert_trace block-docroute || return 1
}

@test "docroute F1: pure leak, NO dev-* spawn → BLOCK, NO entry addendum (no spurious nudge)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE to ~/r.md'}))"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"doc-routing leak"* ]] || return 1
  [[ "${output}" != *"entry classification / plan-reference also required"* ]] || return 1
}

# docroute destination-gate + [DOC-ROUTE] token semantics (retained regression set).
@test "docroute-gate: edit-existing .md mention ('at' framing) → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Update the existing document at ~/.glass-atrium/rules/x.md - revise section Y'}))"
  assert_docroute_pass || return 1
}

@test "docroute-gate: read-context .md reference, StructuredOutput deliverable → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'read ~/.glass-atrium/scoped/scope-dev.md for background; deliverable is StructuredOutput'}))"
  assert_docroute_pass || return 1
}

@test "docroute-gate: memory/progress checkpoint phrasings → PASS (left-boundary lookbehind)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save your progress notes to memory/progress-x.md'}))"
  assert_docroute_pass || return 1
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'write your progress notes to memory/progress-x.md'}))"
  assert_docroute_pass || return 1
}

@test "docroute-gate: 'emit StructuredOutput summarizing <path>.md' → PASS (emit not a destination verb)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'emit StructuredOutput summarizing ~/.glass-atrium/rules/x.md'}))"
  assert_docroute_pass || return 1
}

@test "docroute-gate: 'revise and save <path>.md in place' → PASS (no destination preposition)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'revise and save ~/.glass-atrium/rules/x.md in place'}))"
  assert_docroute_pass || return 1
}

@test "docroute-token: raw .md stamp suppresses its stamped-path leak line → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/user-req.md'}))
log('[DOC-ROUTE] user-requested-local: ~/reports/user-req.md — user asked for a local md copy')"
  assert_docroute_pass || return 1
}

@test "docroute-token: stamped form inside a /* */ comment still suppresses (raw-scan) → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/user-req.md'}))
/* [DOC-ROUTE] user-requested-local: ~/reports/user-req.md — user asked for a local md copy */"
  assert_docroute_pass || return 1
}

@test "docroute-gate: 'save the finished report to <path>.md' → BLOCK + stamp taught" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the finished report to ~/reports/q3.md'}))"
  assert_docroute_block || return 1
  [[ "${output}" == *"log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>')"* ]] || return 1
}

@test "docroute-gate: 'store results under <path>.md' → BLOCK" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'store results under ~/reports/summary.md'}))"
  assert_docroute_block || return 1
}

@test "docroute-gate: 'deliver the final HTML into <path>.html' → BLOCK (bare-path strength)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'deliver the final HTML into ~/exports/report.html'}))"
  assert_docroute_block || return 1
}

@test "docroute-token: stamp for a DIFFERENT path never clears a separate leak → BLOCK (path-scoped)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: ~/notes/a.md — user asked for a local note file')"
  assert_docroute_block || return 1
}

@test "docroute-gate: A11 unit pair — singular 'Target file:' BLOCKs, plural 'Target files:' PASSes" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: ~/x.md'}))"
  assert_docroute_block || return 1
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target files: ~/x.md'}))"
  assert_docroute_pass || return 1
}

# --- RETAINED docroute regression family (restored near-verbatim from 952e84a). These are doc-agent-
# only fixtures (no DEV spawn) exercising the LOCAL_TARGET_RE / TOKEN_LINE_RE suppressor-precision
# guards, which are byte-equivalent to 952e84a; they need NO declaration rewrite. The declaration
# rework must NOT thin these safety-relevant pins (the silent 40→23 drop is the defect under repair).

@test "docroute-gate: plural 'Target files:' 6-element edit-delegation header → PASS (A11 companion)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'Target files: ~/.glass-atrium/rules/x.md
Constraints: edit in place
Completion criteria: emit StructuredOutput'}))"
  assert_docroute_pass || return 1
}

@test "docroute-gate: output-as-noun 'Output Format Routing in <path>.md' → PASS ('in' excluded)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'follow the Output Format Routing in ~/.glass-atrium/scoped/scope-report.md'}))"
  assert_docroute_pass || return 1
}

@test "docroute-gate: 'Persist nothing. Read <path>.md for context' → PASS (persist without destination)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Persist nothing. Read ~/.glass-atrium/rules/x.md for context'}))"
  assert_docroute_pass || return 1
}

@test "docroute-token: raw .html stamp suppresses the A4b bare-path line → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'deliver the dashboard into ~/exports/dash.html'}))
log('[DOC-ROUTE] user-requested-local: ~/exports/dash.html — user asked for a local dashboard file')"
  assert_docroute_pass || return 1
}

@test "docroute-token: 'Revise and save the doc to ~/project/README.md' + stamp → PASS (adapted A19c)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Revise and save the doc to ~/project/README.md'}))
log('[DOC-ROUTE] user-requested-local: ~/project/README.md — user asked to revise the repo README')"
  assert_docroute_pass || return 1
}

@test "docroute-gate: 'save the report as <path>.md' → BLOCK (A4a 'as')" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report as ~/reports/q3.md'}))"
  assert_docroute_block || return 1
}

@test "docroute-gate: verb-free 'Deliverable: <path>.html' noun header → BLOCK (A4b bare-path — .html noun-headers ride A4b)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Deliverable: ~/reports/dash.html'}))"
  assert_docroute_block || return 1
}

@test "docroute-gate: verb-free 'Deliverable: <path>.md' noun header → BLOCK (A4c .md branch)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Deliverable: ~/reports/q3.md'}))"
  assert_docroute_block || return 1
}

@test "docroute-gate: passive 'should end up at <path>.html' → BLOCK (A4b)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'the dashboard should end up at ~/reports/dash.html'}))"
  assert_docroute_block || return 1
}

@test "docroute-gate: 'store the final deliverable at <path>.html' → BLOCK (A4b — former accepted FN, now TP)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'store the final deliverable at ~/reports/final.html'}))"
  assert_docroute_block || return 1
}

@test "docroute-gate: 'Target files: write everything to ~/x.md' → BLOCK (A3 residual catch under plural header)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'Target files: write everything to ~/x.md'}))"
  assert_docroute_block || return 1
}

@test "docroute-gate: 'Revise and save the doc to ~/project/README.md' WITHOUT token → BLOCK (adapted A19c)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Revise and save the doc to ~/project/README.md'}))"
  assert_docroute_block || return 1
}

@test "docroute-token: bare stamp without a path + real leak → BLOCK (path-after-colon required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the finished report to ~/reports/q3.md'}))
log('[DOC-ROUTE] user-requested-local: — no path stamped')"
  assert_docroute_block || return 1
}

@test "docroute-token: the degenerate '~' stamp + real leak on another line → BLOCK (concrete path required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: ~ — user asked')"
  assert_docroute_block || return 1
}

@test "docroute-token: the degenerate '/' stamp + real leak on another line → BLOCK (concrete path required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: / — root stamp')"
  assert_docroute_block || return 1
}

@test "docroute-token: the extensionless dir stamp '~/reports' + leak inside that dir → BLOCK (dot-extension required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: ~/reports — user asked for the reports dir')"
  assert_docroute_block || return 1
}

# A /* */ block comment spanning from the stamp line onto a DIFFERENT spawn's leak line must NOT merge
# the two source lines (strip_comments preserves newlines inside block comments) — the line-scoped
# stamp suppressor may drop only its own line, so the second spawn's leak still BLOCKs.
@test "docroute-token: block comment spans stamp line onto a different spawn's leak line → BLOCK (line identity)" {
  run_hook "log('[DOC-ROUTE] user-requested-local: ~/notes/a.md — user asked for a local note file') /* span
continues */ pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))"
  assert_docroute_block || return 1
}

# =====================================================================================================
# SECTION N — RESILIENCE ADVISORY (advisory-only, never blocks). DEV PASS fixtures carry a valid
#   declaration + plan-ref + [SIZE-EST] so they reach the PASS verdict the advisory rides alongside.
# =====================================================================================================

@test "resilience: schema-mode DEV workflow, no robustAgent/catch → PASS + advisory fires" {
  run_hook "${DECL_TEAM}
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge with a schema-bound verdict'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"ADVISORY (resilience"* ]] || return 1
}

@test "resilience: bare .catch present → PASS, NO advisory" {
  run_hook "${DECL_TEAM}
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge with schema'}).catch(()=>null),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"ADVISORY (resilience"* ]] || return 1
}

@test "resilience: DEV workflow with NO schema token → PASS, NO advisory (schema-gated)" {
  run_hook "${DECL_TEAM}
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"ADVISORY (resilience"* ]] || return 1
}

@test "resilience: non-DEV doc workflow with schema, no catch → PASS, NO advisory (DEV-gated)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize with a schema-shaped output'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"ADVISORY (resilience"* ]] || return 1
}

# Decoupling: a schema-mode DEV workflow whose declaration is valid but spawns NO reviewer → the
# advisory rides on stderr but the exit-2 cause is block-norev, never the advisory.
@test "resilience: schema DEV, valid decl, no reviewer → BLOCK_NOREV + advisory rides along" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
agent('glass-atrium-dev-nestjs',{goal:'implement with a schema output'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"ADVISORY (resilience"* ]] || return 1
  assert_trace block-norev || return 1
}

# #45 per-site scan (moved into the python helper): the whole-script false-negative (ONE catch token
# ANYWHERE silenced the advisory) is closed. These pin the per-site classification: partially-wrapped
# fires; fully .catch-chained is silent; robustAgent-routed is silent.

# PARTIALLY WRAPPED — one schema site is .catch-chained (handled), another is bare (unhandled) → the
# advisory FIRES on the residual bare site. Authored to FAIL before the fix (the lone .catch silenced it).
@test "resilience(#45 partial): one .catch-chained schema site + one bare schema site → PASS + advisory fires" {
  run_hook "${DECL_TEAM}
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge with schema'}).catch(()=>null),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement with a schema output'})"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"ADVISORY (resilience"* ]] || return 1
}

# FULLY INLINE .catch-CHAINED — every schema-mode site is .catch-chained → HANDLED → silent.
@test "resilience(#45 full-catch): every schema site .catch-chained → PASS, NO advisory" {
  run_hook "${DECL_TEAM}
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge with schema'}).catch(()=>null),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement with a schema output'}).catch(()=>null)"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"ADVISORY (resilience"* ]] || return 1
}

# robustAgent-ROUTED — the schema spawn goes through the robustAgent wrapper (callee robustAgent, not
# agent), and the wrapper body inner agent() call carries no literal schema → NO unhandled agent-call
# site → silent. Declared impl-computed so the declaration is code-consistent (indirect spawn).
@test "resilience(#45 robust): schema work routed through robustAgent wrapper → PASS, NO advisory" {
  run_hook "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl-computed: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
async function robustAgent(agentType, opts) { return agent(opts.goal, { ...opts, agentType }).catch(() => null); }
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
robustAgent('glass-atrium-dev-nestjs', { goal: 'implement', schema: OutSchema })"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! "${output}" == *"ADVISORY (resilience"* ]] || return 1
}

# =====================================================================================================
# SECTION O — CORPUS (T8): the 3 undeclared originals are missing-declaration BLOCK pins; the 4
#   declared variants (both declaration forms) are PASS pins. The real archived scripts are the
#   durable regression anchor.
# =====================================================================================================

@test "corpus: blocked_9599.js (undeclared, config-array fan-out) → BLOCK_NODECL" {
  run_hook_file "${CORPUS_DIR}/blocked_9599.js"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-nodecl || return 1
}

@test "corpus: blocked_7938.js (undeclared, literal agentType spawn) → BLOCK_NODECL" {
  run_hook_file "${CORPUS_DIR}/blocked_7938.js"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-nodecl || return 1
}

@test "corpus: passed_9599_resubmit.js (undeclared, ternary literals) → BLOCK_NODECL" {
  run_hook_file "${CORPUS_DIR}/passed_9599_resubmit.js"
  [[ "${status}" -eq 2 ]] || return 1
  assert_trace block-nodecl || return 1
}

# UPSTREAM-form declared variant of the config-array fan-out (impl-computed + upstream clauded-docs/3).
@test "corpus: variant_A.js (upstream + impl-computed) → PASS" {
  run_hook_file "${CORPUS_DIR}/variant_A.js"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# UPSTREAM-form declared variant of the literal-spawn script (upstream clauded-docs/1 + impl dev-shell).
@test "corpus: variant_B.js (upstream + literal impl) → PASS" {
  run_hook_file "${CORPUS_DIR}/variant_B.js"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

@test "corpus: variant_resubmit.js (upstream + impl-computed) → PASS" {
  run_hook_file "${CORPUS_DIR}/variant_resubmit.js"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# TEAM-form (in-script {qa, dev} pair) declared variant — the OTHER declaration path, so the corpus
# exercises BOTH forms (not a single-path corpus).
@test "corpus: variant_team.js (in-script verify team) → PASS" {
  run_hook_file "${CORPUS_DIR}/variant_team.js"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# =====================================================================================================
# SECTION P — recalibrated whole-suite ground-truth cross-tab (safety net). Every listed fixture is
#   asserted against its declaration-contract ground-truth exit code; the BLOCK-intent rows prove 0
#   BLOCK-intent fixtures pass (no bypass regression), the PASS-intent rows prove no over-blocking.
# =====================================================================================================

@test "cross-tab: every fixture yields its declaration-contract ground-truth exit (0 BLOCK-intent PASS)" {
  local cases=(
    # --- PASS-intent (exit 0) ---
    "0::"
    "0::pipeline(agent('glass-atrium-intel-reporter',{goal:'doc'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
    "0::agent('glass-atrium-intel-researcher',{goal:'research only'})"
    "0::${DECL_TEAM}
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
    # upstream PASS (reviewer + body plan-ref)
    "0::/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/3
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: clauded-docs/3')
agent('glass-atrium-qa-code-reviewer',{goal:'final review'});agent('glass-atrium-dev-shell',{goal:'implement'})"
    # lying accepted-floor PASS
    "0::/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-shell
impl: glass-atrium-dev-node
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
agent('glass-atrium-qa-code-reviewer',{goal:'audit'})
agent('glass-atrium-dev-shell',{goal:'impl1 lied as verify'})
agent('glass-atrium-dev-node',{goal:'impl2'})"
    # --- BLOCK-intent (exit 2) ---
    "2::log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
    "2::agent('glass-atrium-dev-swift',{goal:'implement the swift module'})"
    "2::/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
bogus: x
[/AGENT-COMPOSITION] */
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
    "2::/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
agent('glass-atrium-qa-code-reviewer',{goal:'r'});agent('glass-atrium-dev-shell',{goal:'i'})"
    "2::/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: clauded-docs/7')
agent('glass-atrium-dev-nestjs',{goal:'no reviewer spawned'})"
    "2::/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/3
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: clauded-docs/3')
agent('glass-atrium-dev-shell',{goal:'implement, ZERO reviewer'})"
    "2::/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-react
impl: glass-atrium-dev-react
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
agent('glass-atrium-qa-code-reviewer',{goal:'r'});agent('glass-atrium-dev-nestjs',{goal:'i'})"
    "2::/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-react
[/AGENT-COMPOSITION] */
log('${SIZE_EST}')
log('plan-ref: ${PLAN_REF}')
agent('glass-atrium-dev-react',{goal:'impl before review'})
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'}))"
  )
  local entry expected script
  for entry in "${cases[@]}"; do
    expected="${entry%%::*}"
    script="${entry#*::}"
    run_hook "${script}"
    [[ "${status}" -eq "${expected}" ]] || {
      echo "CROSS-TAB REGRESSION: expected ${expected}, got ${status} for: ${script}" >&2
      return 1
    }
  done
}

# =====================================================================================================
# SECTION Q — self-consistency drift guards (T5 stderr scaffold · T11 skill skeletons) + suite-size
#   count meta-test (T6). These pin the AUTHOR-FACING worked examples (the hook's own stderr scaffold
#   + the skill's copy-verbatim skeletons) as LOAD-BEARING: if either drifts to a shape the gate would
#   reject, the paste-then-validate check fails RED. The count meta-test fails RED on any silent test
#   add/drop — the exact class of regression (the 40→23 docroute thinning) this fix repairs.
# =====================================================================================================

SKILL_MD="${BATS_TEST_DIRNAME}/../../skills/glass-atrium-ops-orchestrator.md"

# T5 acceptance: the worked [AGENT-COMPOSITION] scaffold the BLOCK_NODECL stderr teaches, extracted
# verbatim and pasted into a minimal matching DEV script, must itself clear the gate (exit 0). The
# stderr example is the author's only repair channel — a drift to an invalid grammar fails RED here.
@test "self-consistency(T5): BLOCK_NODECL stderr scaffold pasted into a DEV script → PASS" {
  run_hook "parallel(agent('glass-atrium-qa-code-reviewer',{goal:'j'}),agent('glass-atrium-dev-nestjs',{goal:'f'})), agent('glass-atrium-dev-nestjs',{goal:'i'})"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"missing composition declaration"* ]] || return 1
  local decl
  decl="$(printf '%s\n' "${output}" | awk '/\/\* \[AGENT-COMPOSITION\]/{grab=1} grab{print} /\[\/AGENT-COMPOSITION\] \*\//{if(grab)exit}')"
  [[ "${decl}" == *"[AGENT-COMPOSITION]"* ]] || return 1
  run_hook "${decl}
log('plan-ref: ${PLAN_REF}')
log('${SIZE_EST}')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  [[ "${status}" -eq 0 ]] || return 1
  assert_trace pass || return 1
}

# T11 acceptance: every copy-verbatim skeleton in the ops-orchestrator skill carrying an
# [AGENT-COMPOSITION] block, extracted WHOLE and submitted to the hook AS a script, must exit 0 — the
# skeletons authors copy-paste MUST clear the gate they teach. Fails RED if a skeleton drifts to a
# declaration↔code-inconsistent shape (the DECL_TEAM / variant_team.js drift-guard gap the reviewer
# flagged). Each fence is written to a temp .js and fed through run_hook_file (exact bytes).
@test "self-consistency(T11): each skill skeleton declaration fence → PASS" {
  [[ -f "${SKILL_MD}" ]] || skip "skill file not found: ${SKILL_MD}"
  local outdir="${BATS_TEST_TMPDIR}/skill-fences"
  mkdir -p "${outdir}"
  awk -v dir="${outdir}" '
    /^[[:space:]]*```js/ { infence = 1; buf = ""; hasdecl = 0; next }
    /^[[:space:]]*```[[:space:]]*$/ {
      if (infence) {
        if (hasdecl) { n++; f = dir "/fence_" n ".js"; printf "%s", buf > f; close(f) }
        infence = 0
      }
      next
    }
    infence { buf = buf $0 "\n"; if ($0 ~ /\[AGENT-COMPOSITION\]/) hasdecl = 1 }
    END { print n + 0 }
  ' "${SKILL_MD}" >"${outdir}/.count"
  local count
  count="$(cat "${outdir}/.count")"
  [[ "${count}" -ge 3 ]] || {
    echo "expected >=3 declaration-bearing skill skeletons, found ${count}" >&2
    return 1
  }
  local i
  for ((i = 1; i <= count; i++)); do
    run_hook_file "${outdir}/fence_${i}.js"
    [[ "${status}" -eq 0 ]] || {
      echo "SKILL SKELETON ${i} did NOT PASS (exit ${status})" >&2
      return 1
    }
  done
}

# T6 count meta-test: the suite @test total is pinned to a declared expected count so a silent test
# add/drop fails RED — the exact regression class (the 40→23 docroute thinning) this fix repairs.
# Update the pin ONLY on an intentional, reviewed add/drop.
@test "meta(T6): suite @test count equals the pinned expected total" {
  local actual
  actual="$(grep -cE '^@test ' "${BATS_TEST_DIRNAME}/enforce-workflow-verify-stage.bats")"
  [[ "${actual}" -eq 122 ]] || {
    echo "SUITE-SIZE DRIFT: expected 122 @test, found ${actual}" >&2
    return 1
  }
}
