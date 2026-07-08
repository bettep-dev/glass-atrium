#!/usr/bin/env bats
# enforce-workflow-verify-stage.bats — Bats suite for the PreToolUse(Workflow) static
#   verify-stage gate. Pins two heuristics: the qa-code-reviewer presence+ordering check
#   (pre-existing) and the R5 DEV-verifier co-location check (a dev-* token within
#   COLOCATION_WINDOW chars of the reviewer = the DEV half of the {qa-code-reviewer, DEV}
#   verify team). Both are comment-stripped and FAIL-OPEN dominant.
#
# Decision channel = exit code only (PreToolUse): exit 0 PASS / exit 2 BLOCK.
# Input is the real PreToolUse(Workflow) envelope: {"tool_name":"Workflow",
#   "tool_input":{"script":"<js>"}}, built with jq so arbitrary quotes/parens in the
#   script body are escaped safely. WORKFLOW_GATE_FIRED_LOG is redirected to a temp path
#   so the trace never touches the live runtime log.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-workflow-verify-stage.sh"

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

# Shared docroute assertion tails (section q) — status + "doc-routing leak" stderr pair.
# Test-specific EXTRA asserts (stamped-form teaching line, the A1 plural/singular pair) stay inline.
assert_docroute_pass() { [[ "${status}" -eq 0 ]] && [[ ! "${output}" =~ "doc-routing leak" ]]; }
assert_docroute_block() { [[ "${status}" -eq 2 ]] && [[ "${output}" =~ "doc-routing leak" ]]; }

# A run of N real (non-comment) filler agent() calls — used to push a lone impl-DEV
# outside the co-location window with REAL code (comment-stripping cannot shrink it).
filler() {
  python3 -c "print(','.join(\"agent('glass-atrium-intel-reporter',{goal:'sectionXXXXXXXX'})\" for _ in range(${1})))"
}

# A recognized plan-reference token. C4 promoted the former entry advisory to a BLOCK_ENTRY: a
# DEV-spawning workflow with NEITHER a plan-ref NOR an [ENTRY-CLASS] simple-task token is blocked
# BEFORE the co-location verdict is reached. A real sizable verify-stage workflow always carries a
# plan-ref, so co-location fixtures embed one to ISOLATE the co-location behavior from BLOCK_ENTRY.
PLAN_REF="clauded-docs/100"

# A recognized [SIZE-EST] delegation-size self-attestation token — the SIBLING of PLAN_REF for the
# block-sizeest gate. block-sizeest promotes a would-be-PASS DEV workflow under ENTRY_OK that carries
# NO [SIZE-EST] token to exit 2 (raw-scanned, DEV-gated + ENTRY_OK-gated). So every DEV verify-stage
# PASS fixture must embed BOTH ${PLAN_REF} (isolate from BLOCK_ENTRY) AND ${SIZE_EST} (isolate from
# BLOCK_SIZEEST) to keep the co-location / ordering / resilience behavior under test isolated.
SIZE_EST="[SIZE-EST] bundles=1 tool_uses~=10"

# (a) reviewer + DEV-verifier both present before the first impl dev-* → PASS

@test "verify stage parallel(reviewer, dev) then impl dev → PASS (exit 0)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}), agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

@test "reviewer adjacent to dev verifier, far impl dev → PASS (co-located DEV present)" {
  local f
  f="$(filler 20)"
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-react',{goal:'feasible'})),${f},agent('glass-atrium-dev-react',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# DEV-verifier present, both parallel orderings → PASS (R5 false-BLOCK fix)

@test "parallel(dev, reviewer) dev-first ordering then impl dev → PASS (order-independent)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-dev-nestjs',{goal:'feasible'}),agent('glass-atrium-qa-code-reviewer',{goal:'judge'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

@test "long multi-sentence reviewer goal (~560 chars) with co-located dev → PASS" {
  local g
  g="judge $(python3 -c "print('x'*560)")"
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'${g}'}),agent('glass-atrium-dev-python',{goal:'feasible'})), agent('glass-atrium-dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# (b) reviewer present but DEV-verifier absent → BLOCK (exit 2)

@test "reviewer present, lone impl dev separated by real code > window → BLOCK_NOVERIFYDEV (exit 2)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-qa-code-reviewer',{goal:'judge plan feasibility in detail here'}),${f},agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # H1 cause split: token-specific PREPENDED cause line + base reason intact
  [[ "${output}" == *"CAUSE (block-noverifydev): reviewer present but no dev-* verifier"* ]]
  [[ "${output}" == *"missing its mandatory"* ]]
}

# implementation dev that the reviewer does not precede → BLOCK (ordering)

@test "separate impl dev runs far BEFORE the verify pair → BLOCK_ORDER (reviewer does not gate it)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-dev-nestjs',{goal:'impl early'}),${f},parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})))"
  [[ "${status}" -eq 2 ]]
  # H1 cause split: token-specific PREPENDED cause line + base reason intact
  [[ "${output}" == *"CAUSE (block-order): a dev-* token textually precedes EVERY qa-code-reviewer"* ]]
  [[ "${output}" == *"missing its mandatory"* ]]
}

# Discovery/Design dev-* used BEFORE the verify reviewer trips BLOCK_ORDER: the corrected cause
# states the flagged token may be an earlier Discovery/Design dev-* (not the implement stage) and
# names both lawful escape hatches (non-DEV Discovery agent; reviewer-first Contract phase). Same
# shape as the fixture above, framed as a legitimate Discovery pass.

@test "Discovery dev-* before the verify reviewer → BLOCK_ORDER cause names both escape hatches" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-dev-python',{goal:'DISCOVERY: analyze the existing modules before design'}),${f},parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-python',{goal:'feasible'})))"
  [[ "${status}" -eq 2 ]]
  # corrected block-order cause line present
  [[ "${output}" == *"CAUSE (block-order): a dev-* token textually precedes EVERY qa-code-reviewer"* ]]
  # (a) the flagged token MAY be an earlier Discovery/Design dev-*, not the implement stage
  [[ "${output}" == *"Discovery/Design"* ]]
  # escape hatch (a): non-DEV Discovery agent
  [[ "${output}" == *"glass-atrium-intel-researcher"* ]]
  # escape hatch (b): reviewer-first Contract phase
  [[ "${output}" == *"Contract"* ]]
  # shared base reason block intact (untouched)
  [[ "${output}" == *"missing its mandatory"* ]]
}

# (c) a comment-only DEV-verifier token is NOT counted

@test "DEV verifier only inside a comment, real impl dev far away → BLOCK (comment dev not counted)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}), /* verify with agent('glass-atrium-dev-nestjs') goes here */ ${f}, agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# (d) parse ambiguity / fail-open paths → PASS

@test "empty script → PASS (nothing to inspect, fail-open)" {
  run_hook ""
  [[ "${status}" -eq 0 ]]
}

@test "non-Workflow tool_name → PASS (out of scope)" {
  run bash -c '
    printf "%s" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/x\"}}" | WORKFLOW_GATE_FIRED_LOG="$2" bash "$1"
  ' _ "${HOOK_SH}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]]
}

@test "garbage non-JSON stdin → PASS (jq fails, fail-open)" {
  run bash -c '
    printf "%s" "not json at all <<<" | WORKFLOW_GATE_FIRED_LOG="$2" bash "$1"
  ' _ "${HOOK_SH}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]]
}

@test "url inside a goal string (//) does not false-strip the reviewer line → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'see http://x.test/plan'}),agent('glass-atrium-dev-python',{goal:'feasible'})), agent('glass-atrium-dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# (e) regression: pre-existing reviewer-only checks unchanged

@test "regression: DEV present, NO reviewer anywhere → BLOCK_NOREV (exit 2)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # H1 cause split: token-specific PREPENDED cause line + base reason intact
  [[ "${output}" == *"CAUSE (block-norev): no non-comment qa-code-reviewer token anywhere"* ]]
  [[ "${output}" == *"missing its mandatory"* ]]
}

@test "regression: no DEV spawn at all → PASS (Stage-2 exempt)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'doc'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]]
}

# A lone dev immediately followed by the reviewer with NOTHING after is statically ambiguous —
# indistinguishable from a verify-only stage with the dev listed first — so it fail-opens to PASS
# (the co-located dev is read as the verify-DEV, leaving no implementation dev to gate).
@test "lone dev then adjacent reviewer, no impl after → PASS (ambiguous, fail-open)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]]
}

@test "regression: reviewer token only inside a comment, dev spawned → BLOCK (comment-stripped)" {
  run_hook "pipeline(/* should add agent('glass-atrium-qa-code-reviewer') */ agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# (f) C4 entry-miss BLOCK — C4 promoted the former STDERR-only advisory to a real BLOCK_ENTRY
# (stderr reason + exit 2). A DEV-spawning workflow with NEITHER a plan-ref NOR an [ENTRY-CLASS]
# simple-task token is now BLOCKED before the verify-stage verdict, decoupled from it. bats `run`
# merges STDERR into $output, so the entry-miss reason is asserted via $output.

@test "entry: DEV + valid verify-stage, NO plan-ref NO token → BLOCK_ENTRY (exit 2)" {
  run_hook "pipeline(parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 2 ]]
}

@test "entry: [ENTRY-CLASS] simple-task token present → no entry-miss block (exit 0)" {
  run_hook "pipeline(parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge [ENTRY-CLASS] simple-task: trivial config edit'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement ${SIZE_EST}'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

@test "entry: plan-reference present → no entry-miss block (exit 0)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'see clauded-docs/4821 for the plan ${SIZE_EST}'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

# P0 asymmetric raw-scan: the [ENTRY-CLASS] token is now scanned on RAW src, so a token inside a
# comment SILENCES entry-miss (matching the manual gate's raw grep). Pre-P0 this asserted a BLOCK;
# the contract is now reversed. The deeper P0 coverage lives in section (j).
@test "entry: [ENTRY-CLASS] token inside a comment now SILENCES entry-miss → PASS (P0 raw-scan)" {
  run_hook "pipeline(parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), /* [ENTRY-CLASS] simple-task: hidden in a comment */ agent('glass-atrium-dev-nestjs',{goal:'implement ${SIZE_EST}'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

@test "entry: verify-stage BLOCK script with no plan-ref/no token → entry-miss SUPPRESSED (decoupled)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 2 ]]
}

# (g) exit-code-decoupling REGRESSION — every pre-existing case's status is IDENTICAL to before
# the C4 entry-miss block was promoted. The expected statuses below are the ground-truth verdicts
# the suite above already pins (PASS fixtures carry a plan-ref to isolate co-location from the C4
# BLOCK_ENTRY; BLOCK fixtures land on a verify-stage BLOCK that subsumes the entry check). This
# block re-asserts every fixture's status as a consolidated regression guard. (output text is
# intentionally NOT asserted here — only `status` is the regression subject.)

@test "regression(exit): every suite fixture yields its ground-truth status" {
  local f20 f45 g
  f20="$(filler 20)"
  f45="$(filler 45)"
  g="judge $(python3 -c "print('x'*560)")"

  # Each entry: "<expected_status>::<script>" — mirrors the current suite fixtures + their statuses.
  local cases=(
    "0::pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}), agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
    "0::pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-react',{goal:'feasible'})),${f20},agent('glass-atrium-dev-react',{goal:'implement'}))"
    "0::pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-dev-nestjs',{goal:'feasible'}),agent('glass-atrium-qa-code-reviewer',{goal:'judge'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
    "0::pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'${g}'}),agent('glass-atrium-dev-python',{goal:'feasible'})), agent('glass-atrium-dev-python',{goal:'implement'}))"
    "2::pipeline(agent('glass-atrium-qa-code-reviewer',{goal:'judge plan feasibility in detail here'}),${f45},agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
    "2::pipeline(agent('glass-atrium-dev-nestjs',{goal:'impl early'}),${f45},parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})))"
    "2::pipeline(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}), /* verify with agent('glass-atrium-dev-nestjs') goes here */ ${f45}, agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
    "0::"
    "0::pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'see http://x.test/plan'}),agent('glass-atrium-dev-python',{goal:'feasible'})), agent('glass-atrium-dev-python',{goal:'implement'}))"
    "2::pipeline(agent('glass-atrium-intel-planner',{goal:'plan'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
    "0::pipeline(agent('glass-atrium-intel-reporter',{goal:'doc'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
    "0::pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
    "2::pipeline(/* should add agent('glass-atrium-qa-code-reviewer') */ agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
    "2::pipeline(agent('glass-atrium-intel-planner',{goal:'author the plan inline now'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  )

  local entry expected script
  for entry in "${cases[@]}"; do
    expected="${entry%%::*}"
    script="${entry#*::}"
    run_hook "${script}"
    [[ "${status}" -eq "${expected}" ]] || {
      echo "REGRESSION: expected ${expected}, got ${status} for: ${script}" >&2
      return 1
    }
  done
}

# (h) SECOND DETECTION PASS — doc-routing leak (weakest layer, string heuristic, fail-open).
# An intel-reporter / intel-planner spawn hardcoding a local-FS Target with NO monitor-POST
# instruction is BLOCKED (exit 2, distinct "doc-routing leak" stderr); a monitor-POST signal
# anywhere, a non-doc agent, or no hardcoded path shape fails open to PASS. exit code + stderr only.

@test "docroute: reporter spawn hardcodes local Target, no monitor POST → BLOCK (exit 2)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE the report to ~/design-md-analysis/improvement-report.md then Write the markdown file'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: planner spawn mkdir -p then Write local path, no POST → BLOCK (exit 2)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'mkdir -p \$HOME/reports && Write the plan markdown'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: same reporter spawn WITH a monitor-POST instruction → PASS (exit 0)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE the report to ~/r.md then POST it to the monitor clauded-docs API'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: planner /tmp staging cat-piped into clauded-docs POST → PASS (staging is normal)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'Target file: /tmp/plan.md then curl POST /api/clauded-docs with html_body'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: non-doc non-DEV agent with a local path → PASS (unrelated, fail-open)" {
  run_hook "pipeline(agent('glass-atrium-qa-code-reviewer',{goal:'Target file: ~/notes.md review it'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: doc agent spawn with NO hardcoded local path → PASS (fail-open)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize the findings into a coherent document'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: local Target path inside a comment is comment-stripped → PASS (fail-open)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize'}) /* Target file: ~/leak.md */)"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: leak nested in an otherwise-valid DEV verify-stage workflow → BLOCK (independent pass)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE to ~/r.md'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-python',{goal:'feasible'})), agent('glass-atrium-dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "doc-routing leak" ]]
}

# (i) CO-LOCATION FP FIX — finditer over ALL reviewer spans + parallel(...) group-bounds. Each
# fixture carries a plan-ref so C4's BLOCK_ENTRY never preempts the co-location verdict under test.

# FP1 (multi-reviewer): a leading audit/Phase-1 qa-code-reviewer (no co-located dev) followed by a
# genuine parallel(qa,dev) verify pair + impl dev. finditer over every reviewer span finds the later
# pair, so the leading audit reviewer no longer determines the verdict → PASS.
@test "coloc: leading audit reviewer + later parallel(qa,dev) + impl → PASS (finditer)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),agent('glass-atrium-qa-code-reviewer',{goal:'AUDIT phase'}),${f},parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-react',{goal:'feasible'})),agent('glass-atrium-dev-react',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# FP2 (window-blowout): a SINGLE genuine parallel(qa, <1100-char goal>, dev) pair whose long inline
# goal pushes the qa+dev tokens past COLOCATION_WINDOW. The char-window alone would miss it, but the
# parallel(...) group-bounds detection recognizes the pair STRUCTURALLY → PASS.
@test "coloc: parallel(qa,<1100-char goal>,dev) + impl → PASS (parallel-group-bounds)" {
  local big
  big="$(python3 -c "print('x'*1100)")"
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'${big}'}),agent('glass-atrium-dev-python',{goal:'feasible'})),agent('glass-atrium-dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# Zero-reviewer hard guarantee — DEV impl with NO qa-code-reviewer token anywhere → BLOCK. Preserved
# verbatim across the FP fix (the fix may only WIDEN the PASS set for genuine verify pairs).
@test "coloc: DEV impl, NO qa-code-reviewer anywhere → BLOCK (zero-reviewer guarantee)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# RED-TEAM BYPASS (MANDATORY must-BLOCK): one stray/audit qa-code-reviewer + 2+ SCATTERED impl dev-*
# spawns + NO genuine parallel(qa,dev) pair anywhere. This is the case the DROPPED precede-fallback
# would have wrongly PASSed (it absorbed the first impl dev as a phantom verify-DEV). With NO
# precede-fallback present, the only verify-DEV signals are co-location/group-bounds — neither holds
# here — so has_verify_dev=false → BLOCK. This proves the precede-fallback bypass is closed.
@test "coloc: stray audit reviewer + 2+ scattered impl devs, NO parallel pair → BLOCK (bypass closed)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),agent('glass-atrium-qa-code-reviewer',{goal:'AUDIT phase'}),${f},agent('glass-atrium-dev-nestjs',{goal:'impl1'}),${f},agent('glass-atrium-dev-react',{goal:'impl2'}))"
  [[ "${status}" -eq 2 ]]
}

# Lone impl dev (1 dev, no verify pair possible) separated from the reviewer by real code beyond the
# window → no co-located/co-grouped verify-DEV → BLOCK. The single-dev shape can never form a verify
# pair, so it stays blocked (no fallback widens it).
@test "coloc: reviewer + lone impl dev beyond window, no pair → BLOCK" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),agent('glass-atrium-qa-code-reviewer',{goal:'judge feasibility'}),${f},agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# (j) P0 ASYMMETRIC RAW-SCAN — the entry / plan / monitor-POST self-attestation tokens are scanned
# on RAW src (matching the manual gate's raw grep), while spawn/agentType tokens + the leak TRIGGER
# stay comment-stripped (anti-gaming preserved). Locks the comment-placement false-BLOCK incident
# (FM-FB1/FM-FB2) and proves the no-weaken guarantee: a commented spawn/reviewer/dev still BLOCKs.

# (a) incident regression-lock: a //-line commented [ENTRY-CLASS] token + a valid verify-stage + an
# impl dev, NO plan-ref → entry-miss SILENCED → PASS. Pre-P0 this was the entry-miss false-BLOCK that
# triggered this whole fix. The newline after the // comment is load-bearing (a line comment runs to
# EOL), faithfully reproducing the `// [ENTRY-CLASS]` incident shape.
@test "P0(a): //-line [ENTRY-CLASS] + verify-stage + impl, no plan-ref → PASS (incident regression-lock)" {
  run_hook "pipeline(// [ENTRY-CLASS] simple-task: one-line config fix
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-shell',{goal:'feasible'})), agent('glass-atrium-dev-shell',{goal:'implement ${SIZE_EST}'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

# (b) sibling false-BLOCK (FM-FB2): a commented plan-ref + a valid verify-stage + an impl dev, NO
# [ENTRY-CLASS] token → entry-miss SILENCED → PASS.
@test "P0(b): commented plan-ref + verify-stage + impl → PASS (entry silenced)" {
  run_hook "pipeline(/* Plan: clauded-docs/123 */ parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-react',{goal:'feasible'})), agent('glass-atrium-dev-react',{goal:'implement ${SIZE_EST}'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

# (c) suppressor direction fix: a doc-agent spawn with a REAL local Target (the stripped leak TRIGGER
# still fires) but the monitor-POST routing note only inside a COMMENT → the raw-scanned suppressor
# still fires → BLOCK_DOCROUTE suppressed → PASS. Pre-P0 the stripped comment lost the suppressor and
# false-BLOCKed a correctly-routed doc workflow.
@test "P0(c): commented monitor-POST note suppresses BLOCK_DOCROUTE → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE the report to ~/r.md'}) /* route: POST to clauded-docs */)"
  [[ ! "${output}" =~ "doc-routing leak" ]]
  [[ "${status}" -eq 0 ]]
}

# (d) NO-WEAKEN guarantee: a COMMENTED qa-code-reviewer must STILL fail the verify-stage — the strip
# on spawn/agentType tokens is the anti-gaming property, preserved by P0. A plan-ref is present so the
# BLOCK is unambiguously the verify-stage verdict (not entry-miss).
@test "P0(d): commented qa-code-reviewer + plan-ref + impl dev → BLOCK (anti-gaming preserved)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/9'}), /* agent('glass-atrium-qa-code-reviewer') verify here */ agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# (e) a commented dev-* spawn is still treated as ABSENT (dev_re stays comment-stripped): a real
# reviewer + a commented dev verifier + a real impl dev beyond the co-location window → no co-located
# verify-DEV → BLOCK (the verify-stage gate is still enforced). plan-ref isolates from entry-miss.
@test "P0(e): commented dev-* verifier not counted, real impl dev far → BLOCK (verify-stage enforced)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/9'}),agent('glass-atrium-qa-code-reviewer',{goal:'judge'}), /* agent('glass-atrium-dev-nestjs') verify */ ${f}, agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# (k) SYNCED-ROSTER MEMBERSHIP PROBE — a real synced DEV member (dev-swift) is recognized by the
# gate as a DEV-implementation spawn (DEV impl with NO qa-code-reviewer / plan-ref / [ENTRY-CLASS]
# token → BLOCK), while a non-member (intel-reporter) alone is not gated (exit 0). Proves the gate
# keys on DEV_SET membership. dev-swift is the agent whose DEV_SET absence originally motivated the
# gate-roster auto-sync (agent_lifecycle add/delete + `sync-gate-roster`); the BLOCK case fails RED
# if dev-swift is ever dropped from DEV_SET, confirming the gate reads the synced list.

@test "membership: dev-swift impl, NO reviewer/plan-ref/token → BLOCK (synced DEV member recognized)" {
  run_hook "pipeline(agent('glass-atrium-dev-swift',{goal:'implement the swift module'}))"
  [[ "${status}" -eq 2 ]]
}

@test "membership: non-member intel-reporter alone → PASS (not a DEV spawn, exit 0)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize the findings'}))"
  [[ "${status}" -eq 0 ]]
}

# (l) T1 INLINE-PLAN no-widening + message-content — an in-script intel-planner author stage
# (an inline one-shot author+verify+implement workflow) carrying NO minted clauded-docs/<N> id STILL
# blocks (entry-miss, exit 2): R2 (widen the gate to accept an inline planner spawn as a plan-ref)
# was REJECTED, so the gate did NOT widen — parity with the existing "DEV + valid verify-stage, NO
# plan-ref NO token → BLOCK_ENTRY" fixture, plus an inline author stage. The rewritten message pins
# exactly TWO resolution paths (persist a plan / record a simple-task token), carries the INLINE-PLAN
# reasons, and DROPS the old "author a qa-code-reviewer verify-stage" path. bats `run` merges STDERR
# into $output.

@test "T1 no-widen: inline intel-planner author + verify-stage + impl, NO minted id → BLOCK_ENTRY (exit 2)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'author the plan inline now'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 2 ]]
}

@test "T1 message: exactly TWO resolution paths, INLINE-PLAN reasons, removed verify-stage path absent" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'author the plan inline now'}), parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # INLINE-PLAN note + >=1 reason marker (SEPARATION). Substring form `== *"..."*` keeps the quoted
  # needle literal, so regex-special chars ([], /) match as text.
  [[ "${output}" == *"INLINE-PLAN"* ]]
  [[ "${output}" == *"SEPARATION"* ]]
  # resolution path (1): persist a plan
  [[ "${output}" == *"clauded-docs/"* ]]
  [[ "${output}" == *"POST /api/clauded-docs"* ]]
  # resolution path (2): simple-task token
  [[ "${output}" == *"[ENTRY-CLASS] simple-task"* ]]
  # removed THIRD path ABSENT — assert the PRECISE phrase, NOT the bare token "verify-stage": the
  # hook-name tag [enforce-workflow-verify-stage] legitimately contains "verify-stage", so a
  # bare-token assertion would false-fail.
  [[ "${output}" != *"qa-code-reviewer verify-stage"* ]]
}

# (m) F1 TWO-STEP REVEAL FIX — when a DEV workflow lands on the missing-verify-stage BLOCK AND
# also carries no entry signal (entry_marker == ENTRY_ADVISORY), the BLOCK message now CONDITIONALLY
# appends an entry-format addendum (the two escape paths) so the author resolves the verify-stage AND
# the entry signal in ONE pass instead of two round-trips. Strictly MESSAGE-ONLY: entry_marker selects
# the message text, never the verdict or the exit code (still 2). The addendum is phrased WITHOUT the
# literal "entry-miss" so the dedicated entry-miss channel tag stays absent from this BLOCK's output.
# bats `run` merges STDERR into $output; the substring `== *"..."*` form keeps the [], /, () in the
# needle literal (regex-special chars match as text).

# POSITIVE: missing verify-stage + DEV spawn + NO plan-ref + NO [ENTRY-CLASS] token → exit 2
# (missing-verify-stage BLOCK) AND the message CARRIES the entry-format addendum (both escape paths).
# The dedicated "entry-miss" channel tag MUST remain absent (the no-literal-`entry-miss` constraint).
@test "F1 positive: missing verify-stage + ENTRY_ADVISORY → BLOCK (exit 2) with entry-format addendum" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # still the missing-verify-stage BLOCK (base reason intact)
  [[ "${output}" == *"missing its mandatory"* ]]
  # addendum lead-in + both entry-format escape paths surfaced in the SAME block
  [[ "${output}" == *"entry classification / plan-reference also required"* ]]
  [[ "${output}" == *"POST /api/clauded-docs"* ]]
  [[ "${output}" == *"[ENTRY-CLASS] simple-task"* ]]
  # dedicated entry-miss channel tag stays absent (no-literal-`entry-miss` phrasing constraint)
  [[ ! "${output}" =~ "entry-miss" ]]
}

# NEGATIVE (anti-conflation): missing verify-stage + DEV spawn but WITH a plan-ref (clauded-docs/<N>)
# → entry_marker == ENTRY_OK → exit 2 (still missing-verify-stage BLOCK) AND the addendum is ABSENT
# (no false nudge when the author already supplied an entry signal).
@test "F1 negative: missing verify-stage + ENTRY_OK (plan-ref) → BLOCK (exit 2), NO entry addendum" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/777'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # still the missing-verify-stage BLOCK
  [[ "${output}" == *"missing its mandatory"* ]]
  # addendum NOT appended (ENTRY_OK → no entry nudge)
  [[ "${output}" != *"entry classification / plan-reference also required"* ]]
  [[ "${output}" != *"POST /api/clauded-docs"* ]]
}

# DECOUPLING regression-lock: entry_marker affects only the MESSAGE, never the exit code. The exit
# stays 2 in BOTH the ENTRY_ADVISORY (no plan-ref) and the ENTRY_OK (plan-ref) missing-verify cases,
# while the addendum text appears only in the ENTRY_ADVISORY branch → proves message/exit decoupling.
@test "F1 decouple: entry_marker drives MESSAGE only, exit stays 2 in both ADVISORY and OK" {
  # ENTRY_ADVISORY missing-verify case → exit 2 + addendum present
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"entry classification / plan-reference also required"* ]]

  # ENTRY_OK missing-verify case → exit STILL 2 + addendum absent
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/777'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" != *"entry classification / plan-reference also required"* ]]
}

# (n) T1 DOCROUTE-PATH GENERALIZATION — the centralized entry addendum (formerly inline on the
# verify-stage path only) now ALSO rides the docroute "block-docroute" verdict via block_and_exit's
# ALLOWLIST gate (explicit enumeration block-norev|block-noverifydev|block-order|block-docroute,
# NO block-* glob — block-entry stays excluded). A doc-routing leak that
# ALSO spawns a DEV agent with no plan-ref/token lands on BLOCK_DOCROUTE with entry_marker ==
# ENTRY_ADVISORY → the SAME entry-format addendum appends, closing the two-round-trip gap on the
# docroute path. FIXTURE PURITY (HARD): NO `clauded-docs` token and NO plan-ref — MONITOR_POST_RE
# matches bare `clauded-docs`, which would BOTH suppress docroute detection AND flip entry_marker to
# ENTRY_OK via PLAN_REF, silently breaking both arms. Assertions key on the discriminator
# `entry classification / plan-reference also required`, NOT `POST /api/clauded-docs` (the latter
# already lives in the docroute BASE reason → would FALSE-PASS). bats `run` merges STDERR into
# $output; `== *"..."*` keeps the [], /, () in the needle literal.

# POSITIVE: docroute leak (doc-agent local Target, NO monitor-POST) + a dev-* spawn + NO plan-ref/token
# → BLOCK_DOCROUTE (exit 2) AND the entry-format addendum appended (the docroute-path gap closed). The
# dedicated "entry-miss" channel tag MUST remain absent (no-literal-`entry-miss` constraint, mirroring
# the F1 positive test).
@test "docroute F1: leak + dev-* spawn + ENTRY_ADVISORY → BLOCK (exit 2) with entry-format addendum" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE to ~/r.md'}), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # still the docroute BLOCK (base reason intact)
  [[ "${output}" == *"doc-routing leak"* ]]
  # addendum lead-in surfaced on the docroute path (the gap closed)
  [[ "${output}" == *"entry classification / plan-reference also required"* ]]
  # the neutralized addendum is path-agnostic — BOTH old verify-stage-specific phrases are gone
  [[ "${output}" != *"beyond the missing verify-stage above"* ]]
  [[ "${output}" != *"so once the verify-stage is fixed it will STILL be blocked"* ]]
  # dedicated entry-miss channel tag stays absent (no-literal-`entry-miss` phrasing constraint)
  [[ ! "${output}" =~ "entry-miss" ]]
}

# NEGATIVE (no-spurious): a PURE doc-agent leak with NO dev-* spawn → entry_marker forced ENTRY_OK via
# `not dev_present` (line 523) → BLOCK_DOCROUTE (exit 2) but the addendum lead-in is ABSENT (no entry
# nudge without a DEV spawn). Distinct from the monitor-POST PASS case: no monitor-POST here, so the
# leak still BLOCKs — only the addendum is withheld.
@test "docroute F1: pure leak, NO dev-* spawn → BLOCK (exit 2), NO entry addendum (no spurious nudge)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: WRITE to ~/r.md'}))"
  [[ "${status}" -eq 2 ]]
  # still the docroute BLOCK
  [[ "${output}" == *"doc-routing leak"* ]]
  # addendum ABSENT (ENTRY_OK → no entry nudge with no DEV spawn)
  [[ "${output}" != *"entry classification / plan-reference also required"* ]]
  # the dedicated entry-miss tag is likewise absent (ENTRY_OK never reaches the entry-miss block)
  [[ ! "${output}" =~ "entry-miss" ]]
}

# (o) T2 ENTRY-MISS COPY-PASTE SCAFFOLD — the entry-miss BLOCK message now carries a ready-to-fill
# plan-stub scaffold so the compliant path costs fewer keystrokes than overriding. Strictly MESSAGE-ONLY:
# the scaffold rides the SAME entry-miss reason string; the gate decision (exit 2), the regexes, and the
# entry_marker logic are untouched. The fixture is the canonical entry-miss shape (DEV spawn with a valid
# verify-stage but NEITHER a plan-ref NOR an [ENTRY-CLASS] token) — identical to the section (f) fixture
# "entry: DEV + valid verify-stage, NO plan-ref NO token → BLOCK_ENTRY (exit 2)", so it pins that the
# exit-2 entry-miss verdict is byte-for-byte preserved while the new scaffold text is present. bats `run`
# merges STDERR into $output; `== *"..."*` keeps the [], /, (), <> in the needle literal.

# (a) the COPY-PASTE SCAFFOLD string is present in the entry-miss BLOCK stderr.
@test "T2 scaffold: entry-miss BLOCK message carries the copy-paste plan-stub scaffold" {
  run_hook "pipeline(parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # this is the dedicated entry-miss channel (not a verify-stage / docroute block)
  [[ "${output}" =~ "entry-miss" ]]
  # scaffold lead-in + both ready-to-fill resolution stubs surfaced
  [[ "${output}" == *"COPY-PASTE SCAFFOLD"* ]]
  # path (1) persisted-plan stub: the POST curl + the minted-id plan-ref log line
  [[ "${output}" == *"POST http://127.0.0.1:16145/api/clauded-docs"* ]]
  [[ "${output}" == *"log('plan-ref: clauded-docs/<DOC_ID>')"* ]]
  # path (2) simple-task stub: the ready-to-fill [ENTRY-CLASS] log line (E1 criterion-negation form)
  [[ "${output}" == *"log('[ENTRY-CLASS] simple-task: multi-file=no"* ]]
}

# (b) byte-for-byte preservation of the pre-existing exit-2 entry-miss verdict — the scaffold is purely
# additive to the message and changes NOTHING about the decision. Re-asserts the section (f) ground-truth:
# entry-miss fixture → exit 2 AND the "entry-miss" channel tag present (the scaffold did not move the
# block onto a different channel).
@test "T2 scaffold: pre-existing exit-2 entry-miss verdict preserved (message-only change)" {
  run_hook "pipeline(parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})), agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "entry-miss" ]]
  # the base entry-miss reason is intact alongside the new scaffold (no text was replaced)
  [[ "${output}" == *"NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification"* ]]
}

# (p) H1/T1 CAUSE-SPLIT + TRACE OBSERVABILITY — the verify-stage BLOCK verdict is cause-split
# into three tokens (BLOCK_NOREV / BLOCK_NOVERIFYDEV / BLOCK_ORDER; token-specific cause-line asserts
# live inline on the retagged fixtures above). The bash side dispatches on an EXACT-token case whose
# default is the strict enumerated fail-open (any unknown/future helper token → PASS, exit 0), and
# the empty-script fail-open branches now emit the distinct pass-noscript trace tag (verdict/exit
# unchanged — observability only).

# H1 fail-open: an UNKNOWN helper verdict token must fall through the case default to exit 0. A stub
# python3 (prepended to PATH) forces the helper output, isolating the bash dispatch from the real
# helper logic. ENTRY_OK on line 2 keeps the entry promotion quiet (verdict dispatch isolated).
@test "H1 fail-open: unknown helper verdict token → PASS (exit 0, enumerated-case default)" {
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
  [[ "${status}" -eq 0 ]]
}

# T1 trace: the empty-script fail-open branch emits the distinct pass-noscript tag (not bare pass),
# so telemetry can separate "nothing to scan" from a real scanned pass.
@test "T1 trace: empty script fail-open emits verdict=pass-noscript to the firing trace" {
  run_hook ""
  [[ "${status}" -eq 0 ]]
  grep -q "verdict=pass-noscript" "${TRACE_LOG}"
}

# (q) T1 DOCROUTE DESTINATION-GATE + [DOC-ROUTE] TOKEN — regex + stamp-suppressor semantics
# live at the hook's LOCAL_TARGET_RE / TOKEN_LINE_RE comments (enforce-workflow-verify-stage.sh).
# FIXTURE PURITY (HARD): token fixtures carry NO clauded-docs / monitor substrings —
# MONITOR_POST_RE would independently suppress and silently un-test the token arm.
# Accepted static FNs, comment-documented NOT asserted (runtime Write hook = primary .md guard):
# preposition-less "save <path>" · verb-evasion (put/drop) · "the deliverable is <path>". Accepted
# residual FPs, comment-documented NOT asserted: .html/.markdown edit-existing MENTIONS still block
# by design until T4 (relief: the [DOC-ROUTE] token when user-requested).

@test "docroute-gate: edit-existing .md mention ('at' framing) → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Update the existing document at ~/.glass-atrium/rules/x.md - revise section Y'}))"
  assert_docroute_pass
}

@test "docroute-gate: read-context .md reference, StructuredOutput deliverable → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'read ~/.glass-atrium/scoped/scope-dev.md for background; deliverable is StructuredOutput'}))"
  assert_docroute_pass
}

@test "docroute-gate: plural 'Target files:' 6-element edit-delegation header → PASS (A11 companion)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'Target files: ~/.glass-atrium/rules/x.md
Constraints: edit in place
Completion criteria: emit StructuredOutput'}))"
  assert_docroute_pass
}

@test "docroute-gate: memory/progress checkpoint phrasings → PASS (A3/A4a left-boundary lookbehind)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save your progress notes to memory/progress-x.md'}))"
  assert_docroute_pass
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'write your progress notes to memory/progress-x.md'}))"
  assert_docroute_pass
}

@test "docroute-gate: 'emit StructuredOutput summarizing <path>.md' → PASS (emit not a destination verb)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'emit StructuredOutput summarizing ~/.glass-atrium/rules/x.md'}))"
  assert_docroute_pass
}

@test "docroute-gate: output-as-noun 'Output Format Routing in <path>.md' → PASS ('in' excluded)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'follow the Output Format Routing in ~/.glass-atrium/scoped/scope-report.md'}))"
  assert_docroute_pass
}

@test "docroute-gate: 'revise and save <path>.md in place' → PASS (no destination preposition)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'revise and save ~/.glass-atrium/rules/x.md in place'}))"
  assert_docroute_pass
}

@test "docroute-gate: 'Persist nothing. Read <path>.md for context' → PASS (persist without destination)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Persist nothing. Read ~/.glass-atrium/rules/x.md for context'}))"
  assert_docroute_pass
}

# token-present PASS — each carries a REAL leak trigger (a vacuous no-trigger suppression test is
# FORBIDDEN); the stamp is the ONLY suppressor in scope (fixture purity above).

@test "docroute-token: raw .md stamp suppresses its stamped-path leak line → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/user-req.md'}))
log('[DOC-ROUTE] user-requested-local: ~/reports/user-req.md — user asked for a local md copy')"
  assert_docroute_pass
}

@test "docroute-token: stamped form inside a /* */ comment still suppresses (raw-scan) → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/user-req.md'}))
/* [DOC-ROUTE] user-requested-local: ~/reports/user-req.md — user asked for a local md copy */"
  assert_docroute_pass
}

@test "docroute-token: raw .html stamp suppresses the A4b bare-path line → PASS" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'deliver the dashboard into ~/exports/dash.html'}))
log('[DOC-ROUTE] user-requested-local: ~/exports/dash.html — user asked for a local dashboard file')"
  assert_docroute_pass
}

@test "docroute-token: 'Revise and save the doc to ~/project/README.md' + stamp → PASS (adapted A19c)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Revise and save the doc to ~/project/README.md'}))
log('[DOC-ROUTE] user-requested-local: ~/project/README.md — user asked to revise the repo README')"
  assert_docroute_pass
}

# BLOCK matrix — destination-framed leaks stay blocked; the stderr teaches the canonical stamp.

@test "docroute-gate: 'save the finished report to <path>.md' → BLOCK (A4a 'to') + stamp taught" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the finished report to ~/reports/q3.md'}))"
  assert_docroute_block
  # A16: the BLOCK stderr teaches the canonical stamped form (user-explicit-request-only scope)
  [[ "${output}" == *"log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>')"* ]]
}

@test "docroute-gate: 'save the report as <path>.md' → BLOCK (A4a 'as')" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report as ~/reports/q3.md'}))"
  assert_docroute_block
}

@test "docroute-gate: 'store results under <path>.md' → BLOCK (A4a 'under')" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'store results under ~/reports/summary.md'}))"
  assert_docroute_block
}

@test "docroute-gate: 'deliver the final HTML into <path>.html' → BLOCK (A4b bare-path strength)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'deliver the final HTML into ~/exports/report.html'}))"
  assert_docroute_block
}

@test "docroute-gate: verb-free 'Deliverable: <path>.html' noun header → BLOCK (A4b bare-path — .html noun-headers ride A4b)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Deliverable: ~/reports/dash.html'}))"
  assert_docroute_block
}

@test "docroute-gate: verb-free 'Deliverable: <path>.md' noun header → BLOCK (A4c .md branch)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Deliverable: ~/reports/q3.md'}))"
  assert_docroute_block
}

@test "docroute-gate: passive 'should end up at <path>.html' → BLOCK (A4b)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'the dashboard should end up at ~/reports/dash.html'}))"
  assert_docroute_block
}

@test "docroute-gate: 'store the final deliverable at <path>.html' → BLOCK (A4b — former accepted FN, now TP)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'store the final deliverable at ~/reports/final.html'}))"
  assert_docroute_block
}

@test "docroute-gate: 'Target files: write everything to ~/x.md' → BLOCK (A3 residual catch under plural header)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'Target files: write everything to ~/x.md'}))"
  assert_docroute_block
}

@test "docroute-gate: 'Revise and save the doc to ~/project/README.md' WITHOUT token → BLOCK (adapted A19c)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Revise and save the doc to ~/project/README.md'}))"
  assert_docroute_block
}

@test "docroute-token: stamp for a DIFFERENT path never clears a separate leak → BLOCK (path-scoped)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: ~/notes/a.md — user asked for a local note file')"
  assert_docroute_block
}

@test "docroute-token: bare stamp without a path + real leak → BLOCK (path-after-colon required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the finished report to ~/reports/q3.md'}))
log('[DOC-ROUTE] user-requested-local: — no path stamped')"
  assert_docroute_block
}

@test "docroute-token: the degenerate '~' stamp + real leak on another line → BLOCK (concrete path required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: ~ — user asked')"
  assert_docroute_block
}

@test "docroute-token: the degenerate '/' stamp + real leak on another line → BLOCK (concrete path required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: / — root stamp')"
  assert_docroute_block
}

@test "docroute-token: the extensionless dir stamp '~/reports' + leak inside that dir → BLOCK (dot-extension required)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))
log('[DOC-ROUTE] user-requested-local: ~/reports — user asked for the reports dir')"
  assert_docroute_block
}

# A /* */ block comment spanning from the stamp line onto a DIFFERENT spawn's leak line must NOT
# merge the two source lines (strip_comments preserves newlines inside block comments) — the
# line-scoped stamp suppressor may drop only its own line, so the second spawn's leak still BLOCKs.
@test "docroute-token: block comment spans stamp line onto a different spawn's leak line → BLOCK (line identity)" {
  run_hook "log('[DOC-ROUTE] user-requested-local: ~/notes/a.md — user asked for a local note file') /* span
continues */ pipeline(agent('glass-atrium-intel-reporter',{goal:'save the report to ~/reports/b.md'}))"
  assert_docroute_block
}

@test "docroute-gate: A11 unit pair — singular 'Target file:' BLOCKs (A1), plural 'Target files:' PASSes" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target file: ~/x.md'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "doc-routing leak" ]]
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'Target files: ~/x.md'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

# (r) RESILIENCE ADVISORY (T7) — ADVISORY-ONLY (exit 0, stderr, NEVER exit 2). A DEV-spawning
# workflow with a schema-mode agent() but ZERO robustAgent/.catch resilience idiom gets a NON-blocking
# stderr nudge; robustAgent OR .catch anywhere suppresses it; no schema token or a non-DEV workflow is
# out of scope. Whole-script token presence (decidable + fail-open-consistent). bats `run` merges
# STDERR into $output; the `== *"..."*` form keeps the '(' in the needle literal. Fixtures carry a
# plan-ref so C4's BLOCK_ENTRY never preempts the PASS cases under test.

# FIRE + non-blocking: valid verify-stage DEV workflow + plan-ref + a 'schema' token, NO robustAgent/
# .catch → exit 0 (the advisory NEVER blocks) AND the resilience advisory is emitted on stderr.
@test "resilience: schema-mode DEV workflow, no robustAgent/catch → PASS (exit 0) + advisory fires" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge with a schema-bound verdict'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"ADVISORY (resilience"* ]]
}

# SUPPRESS (robustAgent present anywhere) → no advisory, exit 0. Wrapping the agent() calls in
# robustAgent leaves the quoted agentType tokens intact, so the verify-stage still PASSes.
@test "resilience: robustAgent wrapper present → PASS (exit 0), NO advisory" {
  run_hook "pipeline(robustAgent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(robustAgent('glass-atrium-qa-code-reviewer',{goal:'judge with schema'}),robustAgent('glass-atrium-dev-nestjs',{goal:'feasible'})),robustAgent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"ADVISORY (resilience"* ]]
}

# SUPPRESS (a bare .catch present, no robustAgent) → no advisory, exit 0. Either resilience token
# anywhere silences the nudge.
@test "resilience: bare .catch present (no robustAgent) → PASS (exit 0), NO advisory" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge with schema'}).catch(()=>null),agent('glass-atrium-dev-nestjs',{goal:'feasible'})),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"ADVISORY (resilience"* ]]
}

# SCHEMA-GATED: a DEV workflow with NO 'schema' token → out of scope → no advisory (exit 0).
@test "resilience: DEV workflow with NO schema token → PASS (exit 0), NO advisory (schema-gated)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"ADVISORY (resilience"* ]]
}

# DEV-GATED: a non-DEV (doc-only) workflow with a schema token and no resilience idiom → out of scope
# → no advisory (exit 0). The advisory only fires on DEV-spawning workflows.
@test "resilience: non-DEV doc workflow with schema, no catch → PASS (exit 0), NO advisory (DEV-gated)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize with a schema-shaped output'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"ADVISORY (resilience"* ]]
}

# DECOUPLING: a schema-no-catch DEV workflow that ALSO omits its verify-stage → exit 2 from the
# verify-stage BLOCK (block-norev), NOT from the advisory. The advisory rides alongside on stderr but
# is never the cause of the exit-2 — proving the advisory neither blocks nor suppresses a real block.
@test "resilience: schema-no-catch DEV workflow missing verify-stage → BLOCK (exit 2, block-norev) + advisory rides along" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan ${PLAN_REF} ${SIZE_EST}'}), agent('glass-atrium-dev-nestjs',{goal:'implement with a schema output'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"CAUSE (block-norev)"* ]]
  [[ "${output}" == *"ADVISORY (resilience"* ]]
}

# (s) BLOCK_SIZEEST — a would-be-PASS DEV workflow under ENTRY_OK carrying NO [SIZE-EST]
# delegation-size self-attestation token in the RAW source is promoted to exit 2 (distinct
# "size-attestation miss" stderr, trace tag block-sizeest). DEV-gated + ENTRY_OK-gated + decoupled
# from the verify-stage verdict (promoted only at a would-be PASS, so a verify-stage BLOCK and the
# entry-miss block both keep priority). The token is raw-scanned (a commented [SIZE-EST] still
# counts), mirroring the [ENTRY-CLASS] / plan-ref P0 asymmetric-scan policy. Fixtures use LITERAL
# plan-refs (not ${PLAN_REF}) so the presence/absence of ${SIZE_EST} is unambiguous. bats `run`
# merges STDERR into $output; `== *"..."*` keeps the [], () in the needle literal.

# MISS: valid verify-stage + literal plan-ref (ENTRY_OK) but NO [SIZE-EST] → BLOCK_SIZEEST (exit 2)
# with the size-attestation remediation message + the block-sizeest firing trace. The entry addendum
# stays absent (structurally inert on block-sizeest — ENTRY_OK-only), as does the entry-miss tag.
@test "sizeest: DEV verify-stage under ENTRY_OK, NO [SIZE-EST] → BLOCK_SIZEEST (exit 2)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/55'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"size-attestation miss"* ]]
  [[ "${output}" == *"[SIZE-EST] bundles=N tool_uses~=N"* ]]
  # entry addendum + dedicated entry-miss tag both absent (block-sizeest fires only under ENTRY_OK)
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${output}" != *"entry classification / plan-reference also required"* ]]
  grep -q "verdict=block-sizeest" "${TRACE_LOG}"
}

# PRESENT: same fixture WITH a [SIZE-EST] token → PASS (exit 0), no size-attestation block.
@test "sizeest: DEV verify-stage under ENTRY_OK WITH [SIZE-EST] present → PASS (exit 0)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/55 ${SIZE_EST}'}),parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"size-attestation miss"* ]]
}

# RAW-SCAN: a [SIZE-EST] token inside a /* */ comment still counts (raw attestation_src scan) → PASS.
@test "sizeest: [SIZE-EST] token inside a comment still counts → PASS (raw-scan, exit 0)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/55'}), /* [SIZE-EST] bundles=3 tool_uses~=30 */ parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"size-attestation miss"* ]]
}

# PRIORITY: an entry-missing DEV script (no plan-ref/token, no [SIZE-EST]) → BLOCK_ENTRY, NOT
# block-sizeest. block-sizeest is ENTRY_OK-gated, so it never fires under ENTRY_ADVISORY — entry-miss
# claims the block. Proves entry-miss keeps priority.
@test "sizeest: entry-missing DEV → BLOCK_ENTRY not block-sizeest (entry-miss priority)" {
  run_hook "pipeline(parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "entry-miss" ]]
  [[ "${output}" != *"size-attestation miss"* ]]
  grep -q "verdict=block-entry" "${TRACE_LOG}"
}

# DEV-GATED: a non-DEV (doc-only) workflow with NO [SIZE-EST] → PASS (exit 0). block-sizeest only
# fires on DEV-spawning workflows.
@test "sizeest: non-DEV doc workflow with NO [SIZE-EST] → PASS (DEV-gated, exit 0)" {
  run_hook "pipeline(agent('glass-atrium-intel-reporter',{goal:'synthesize the findings'}), agent('glass-atrium-qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"size-attestation miss"* ]]
}

# PRIORITY (verify-stage): a DEV workflow under ENTRY_OK with NO reviewer AND no [SIZE-EST] →
# BLOCK_NOREV (verify-stage verdict), NOT block-sizeest. block-sizeest is promoted only at a would-be
# PASS emit, so a verify-stage BLOCK always keeps priority — proves the decoupling.
@test "sizeest: missing verify-stage keeps priority over block-sizeest (BLOCK_NOREV, not size)" {
  run_hook "pipeline(agent('glass-atrium-intel-planner',{goal:'plan clauded-docs/55'}),agent('glass-atrium-dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"CAUSE (block-norev)"* ]]
  [[ "${output}" != *"size-attestation miss"* ]]
}
