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

# A run of N real (non-comment) filler agent() calls — used to push a lone impl-DEV
# outside the co-location window with REAL code (comment-stripping cannot shrink it).
filler() {
  python3 -c "print(','.join(\"agent('intel-reporter',{goal:'sectionXXXXXXXX'})\" for _ in range(${1})))"
}

# A recognized plan-reference token. C4 promoted the former entry advisory to a BLOCK_ENTRY: a
# DEV-spawning workflow with NEITHER a plan-ref NOR an [ENTRY-CLASS] simple-task token is blocked
# BEFORE the co-location verdict is reached. A real sizable verify-stage workflow always carries a
# plan-ref, so co-location fixtures embed one to ISOLATE the co-location behavior from BLOCK_ENTRY.
PLAN_REF="clauded-docs/100"

# --- (a) reviewer + DEV-verifier both present before the first impl dev-* → PASS ---

@test "verify stage parallel(reviewer, dev) then impl dev → PASS (exit 0)" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}), parallel(agent('qa-code-reviewer',{goal:'judge'}), agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

@test "reviewer adjacent to dev verifier, far impl dev → PASS (co-located DEV present)" {
  local f
  f="$(filler 20)"
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-react',{goal:'feasible'})),${f},agent('dev-react',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# --- DEV-verifier present, both parallel orderings → PASS (R5 false-BLOCK fix) ---

@test "parallel(dev, reviewer) dev-first ordering then impl dev → PASS (order-independent)" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('dev-nestjs',{goal:'feasible'}),agent('qa-code-reviewer',{goal:'judge'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

@test "long multi-sentence reviewer goal (~560 chars) with co-located dev → PASS" {
  local g
  g="judge $(python3 -c "print('x'*560)")"
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('qa-code-reviewer',{goal:'${g}'}),agent('dev-python',{goal:'feasible'})), agent('dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# --- (b) reviewer present but DEV-verifier absent → BLOCK (exit 2) ---

@test "reviewer present, lone impl dev separated by real code > window → BLOCK (exit 2)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('qa-code-reviewer',{goal:'judge plan feasibility in detail here'}),${f},agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# --- implementation dev that the reviewer does not precede → BLOCK (ordering) ---

@test "separate impl dev runs far BEFORE the verify pair → BLOCK (reviewer does not gate it)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('dev-nestjs',{goal:'impl early'}),${f},parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})))"
  [[ "${status}" -eq 2 ]]
}

# --- (c) a comment-only DEV-verifier token is NOT counted ---

@test "DEV verifier only inside a comment, real impl dev far away → BLOCK (comment dev not counted)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('qa-code-reviewer',{goal:'judge'}), /* verify with agent('dev-nestjs') goes here */ ${f}, agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# --- (d) parse ambiguity / fail-open paths → PASS ---

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
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('qa-code-reviewer',{goal:'see http://x.test/plan'}),agent('dev-python',{goal:'feasible'})), agent('dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# --- (e) regression: pre-existing reviewer-only checks unchanged ---

@test "regression: DEV present, NO reviewer anywhere → BLOCK (exit 2)" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan'}), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

@test "regression: no DEV spawn at all → PASS (Stage-2 exempt)" {
  run_hook "pipeline(agent('intel-reporter',{goal:'doc'}), agent('qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]]
}

# A lone dev immediately followed by the reviewer with NOTHING after is statically ambiguous —
# indistinguishable from a verify-only stage with the dev listed first — so it fail-opens to PASS
# (the co-located dev is read as the verify-DEV, leaving no implementation dev to gate).
@test "lone dev then adjacent reviewer, no impl after → PASS (ambiguous, fail-open)" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),agent('dev-nestjs',{goal:'feasible'}), agent('qa-code-reviewer',{goal:'review'}))"
  [[ "${status}" -eq 0 ]]
}

@test "regression: reviewer token only inside a comment, dev spawned → BLOCK (comment-stripped)" {
  run_hook "pipeline(/* should add agent('qa-code-reviewer') */ agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# --- (f) C4 entry-miss BLOCK — C4 promoted the former STDERR-only advisory to a real BLOCK_ENTRY
# (stderr reason + exit 2). A DEV-spawning workflow with NEITHER a plan-ref NOR an [ENTRY-CLASS]
# simple-task token is now BLOCKED before the verify-stage verdict, decoupled from it. bats `run`
# merges STDERR into $output, so the entry-miss reason is asserted via $output. ---

@test "entry: DEV + valid verify-stage, NO plan-ref NO token → BLOCK_ENTRY (exit 2)" {
  run_hook "pipeline(parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 2 ]]
}

@test "entry: [ENTRY-CLASS] simple-task token present → no entry-miss block (exit 0)" {
  run_hook "pipeline(parallel(agent('qa-code-reviewer',{goal:'judge [ENTRY-CLASS] simple-task: trivial config edit'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

@test "entry: plan-reference present → no entry-miss block (exit 0)" {
  run_hook "pipeline(agent('intel-planner',{goal:'see clauded-docs/4821 for the plan'}), parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

# P0 asymmetric raw-scan: the [ENTRY-CLASS] token is now scanned on RAW src, so a token inside a
# comment SILENCES entry-miss (matching the manual gate's raw grep). Pre-P0 this asserted a BLOCK;
# the contract is now reversed. The deeper P0 coverage lives in section (j).
@test "entry: [ENTRY-CLASS] token inside a comment now SILENCES entry-miss → PASS (P0 raw-scan)" {
  run_hook "pipeline(parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), /* [ENTRY-CLASS] simple-task: hidden in a comment */ agent('dev-nestjs',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

@test "entry: verify-stage BLOCK script with no plan-ref/no token → entry-miss SUPPRESSED (decoupled)" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan'}), agent('dev-nestjs',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 2 ]]
}

# --- (g) exit-code-decoupling REGRESSION — every pre-existing case's status is IDENTICAL to before
# the C4 entry-miss block was promoted. The expected statuses below are the ground-truth verdicts
# the suite above already pins (PASS fixtures carry a plan-ref to isolate co-location from the C4
# BLOCK_ENTRY; BLOCK fixtures land on a verify-stage BLOCK that subsumes the entry check). This
# block re-asserts every fixture's status as a consolidated regression guard. (output text is
# intentionally NOT asserted here — only `status` is the regression subject.) ---

@test "regression(exit): every suite fixture yields its ground-truth status" {
  local f20 f45 g
  f20="$(filler 20)"
  f45="$(filler 45)"
  g="judge $(python3 -c "print('x'*560)")"

  # Each entry: "<expected_status>::<script>" — mirrors the current suite fixtures + their statuses.
  local cases=(
    "0::pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}), parallel(agent('qa-code-reviewer',{goal:'judge'}), agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
    "0::pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-react',{goal:'feasible'})),${f20},agent('dev-react',{goal:'implement'}))"
    "0::pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('dev-nestjs',{goal:'feasible'}),agent('qa-code-reviewer',{goal:'judge'})), agent('dev-nestjs',{goal:'implement'}))"
    "0::pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('qa-code-reviewer',{goal:'${g}'}),agent('dev-python',{goal:'feasible'})), agent('dev-python',{goal:'implement'}))"
    "2::pipeline(agent('qa-code-reviewer',{goal:'judge plan feasibility in detail here'}),${f45},agent('dev-nestjs',{goal:'implement'}))"
    "2::pipeline(agent('dev-nestjs',{goal:'impl early'}),${f45},parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})))"
    "2::pipeline(agent('qa-code-reviewer',{goal:'judge'}), /* verify with agent('dev-nestjs') goes here */ ${f45}, agent('dev-nestjs',{goal:'implement'}))"
    "0::"
    "0::pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('qa-code-reviewer',{goal:'see http://x.test/plan'}),agent('dev-python',{goal:'feasible'})), agent('dev-python',{goal:'implement'}))"
    "2::pipeline(agent('intel-planner',{goal:'plan'}), agent('dev-nestjs',{goal:'implement'}))"
    "0::pipeline(agent('intel-reporter',{goal:'doc'}), agent('qa-code-reviewer',{goal:'review'}))"
    "0::pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),agent('dev-nestjs',{goal:'feasible'}), agent('qa-code-reviewer',{goal:'review'}))"
    "2::pipeline(/* should add agent('qa-code-reviewer') */ agent('dev-nestjs',{goal:'implement'}))"
    "2::pipeline(agent('intel-planner',{goal:'author the plan inline now'}), parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
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

# --- (h) SECOND DETECTION PASS — doc-routing leak (weakest layer, string heuristic, fail-open). ---
# An intel-reporter / intel-planner spawn hardcoding a local-FS Target with NO monitor-POST
# instruction is BLOCKED (exit 2, distinct "doc-routing leak" stderr); a monitor-POST signal
# anywhere, a non-doc agent, or no hardcoded path shape fails open to PASS. exit code + stderr only.

@test "docroute: reporter spawn hardcodes local Target, no monitor POST → BLOCK (exit 2)" {
  run_hook "pipeline(agent('intel-reporter',{goal:'Target file: WRITE the report to ~/design-md-analysis/improvement-report.md then Write the markdown file'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: planner spawn mkdir -p then Write local path, no POST → BLOCK (exit 2)" {
  run_hook "pipeline(agent('intel-planner',{goal:'mkdir -p \$HOME/reports && Write the plan markdown'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: same reporter spawn WITH a monitor-POST instruction → PASS (exit 0)" {
  run_hook "pipeline(agent('intel-reporter',{goal:'Target file: WRITE the report to ~/r.md then POST it to the monitor clauded-docs API'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: planner /tmp staging cat-piped into clauded-docs POST → PASS (staging is normal)" {
  run_hook "pipeline(agent('intel-planner',{goal:'Target file: /tmp/plan.md then curl POST /api/clauded-docs with html_body'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: non-doc non-DEV agent with a local path → PASS (unrelated, fail-open)" {
  run_hook "pipeline(agent('qa-code-reviewer',{goal:'Target file: ~/notes.md review it'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: doc agent spawn with NO hardcoded local path → PASS (fail-open)" {
  run_hook "pipeline(agent('intel-reporter',{goal:'synthesize the findings into a coherent document'}))"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: local Target path inside a comment is comment-stripped → PASS (fail-open)" {
  run_hook "pipeline(agent('intel-reporter',{goal:'synthesize'}) /* Target file: ~/leak.md */)"
  [[ "${status}" -eq 0 ]]
  [[ ! "${output}" =~ "doc-routing leak" ]]
}

@test "docroute: leak nested in an otherwise-valid DEV verify-stage workflow → BLOCK (independent pass)" {
  run_hook "pipeline(agent('intel-reporter',{goal:'Target file: WRITE to ~/r.md'}), parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-python',{goal:'feasible'})), agent('dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "doc-routing leak" ]]
}

# --- (i) CO-LOCATION FP FIX — finditer over ALL reviewer spans + parallel(...) group-bounds. Each
# fixture carries a plan-ref so C4's BLOCK_ENTRY never preempts the co-location verdict under test. ---

# FP1 (multi-reviewer): a leading audit/Phase-1 qa-code-reviewer (no co-located dev) followed by a
# genuine parallel(qa,dev) verify pair + impl dev. finditer over every reviewer span finds the later
# pair, so the leading audit reviewer no longer determines the verdict → PASS.
@test "coloc: leading audit reviewer + later parallel(qa,dev) + impl → PASS (finditer)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),agent('qa-code-reviewer',{goal:'AUDIT phase'}),${f},parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-react',{goal:'feasible'})),agent('dev-react',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# FP2 (window-blowout): a SINGLE genuine parallel(qa, <1100-char goal>, dev) pair whose long inline
# goal pushes the qa+dev tokens past COLOCATION_WINDOW. The char-window alone would miss it, but the
# parallel(...) group-bounds detection recognizes the pair STRUCTURALLY → PASS.
@test "coloc: parallel(qa,<1100-char goal>,dev) + impl → PASS (parallel-group-bounds)" {
  local big
  big="$(python3 -c "print('x'*1100)")"
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),parallel(agent('qa-code-reviewer',{goal:'${big}'}),agent('dev-python',{goal:'feasible'})),agent('dev-python',{goal:'implement'}))"
  [[ "${status}" -eq 0 ]]
}

# Zero-reviewer hard guarantee — DEV impl with NO qa-code-reviewer token anywhere → BLOCK. Preserved
# verbatim across the FP fix (the fix may only WIDEN the PASS set for genuine verify pairs).
@test "coloc: DEV impl, NO qa-code-reviewer anywhere → BLOCK (zero-reviewer guarantee)" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),agent('dev-nestjs',{goal:'implement'}))"
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
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),agent('qa-code-reviewer',{goal:'AUDIT phase'}),${f},agent('dev-nestjs',{goal:'impl1'}),${f},agent('dev-react',{goal:'impl2'}))"
  [[ "${status}" -eq 2 ]]
}

# Lone impl dev (1 dev, no verify pair possible) separated from the reviewer by real code beyond the
# window → no co-located/co-grouped verify-DEV → BLOCK. The single-dev shape can never form a verify
# pair, so it stays blocked (no fallback widens it).
@test "coloc: reviewer + lone impl dev beyond window, no pair → BLOCK" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('intel-planner',{goal:'plan ${PLAN_REF}'}),agent('qa-code-reviewer',{goal:'judge feasibility'}),${f},agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# --- (j) P0 ASYMMETRIC RAW-SCAN — the entry / plan / monitor-POST self-attestation tokens are scanned
# on RAW src (matching the manual gate's raw grep), while spawn/agentType tokens + the leak TRIGGER
# stay comment-stripped (anti-gaming preserved). Locks the comment-placement false-BLOCK incident
# (FM-FB1/FM-FB2) and proves the no-weaken guarantee: a commented spawn/reviewer/dev still BLOCKs. ---

# (a) incident regression-lock: a //-line commented [ENTRY-CLASS] token + a valid verify-stage + an
# impl dev, NO plan-ref → entry-miss SILENCED → PASS. Pre-P0 this was the entry-miss false-BLOCK that
# triggered this whole fix. The newline after the // comment is load-bearing (a line comment runs to
# EOL), faithfully reproducing the `// [ENTRY-CLASS]` incident shape.
@test "P0(a): //-line [ENTRY-CLASS] + verify-stage + impl, no plan-ref → PASS (incident regression-lock)" {
  run_hook "pipeline(// [ENTRY-CLASS] simple-task: one-line config fix
parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-shell',{goal:'feasible'})), agent('dev-shell',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

# (b) sibling false-BLOCK (FM-FB2): a commented plan-ref + a valid verify-stage + an impl dev, NO
# [ENTRY-CLASS] token → entry-miss SILENCED → PASS.
@test "P0(b): commented plan-ref + verify-stage + impl → PASS (entry silenced)" {
  run_hook "pipeline(/* Plan: clauded-docs/123 */ parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-react',{goal:'feasible'})), agent('dev-react',{goal:'implement'}))"
  [[ ! "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 0 ]]
}

# (c) suppressor direction fix: a doc-agent spawn with a REAL local Target (the stripped leak TRIGGER
# still fires) but the monitor-POST routing note only inside a COMMENT → the raw-scanned suppressor
# still fires → BLOCK_DOCROUTE suppressed → PASS. Pre-P0 the stripped comment lost the suppressor and
# false-BLOCKed a correctly-routed doc workflow.
@test "P0(c): commented monitor-POST note suppresses BLOCK_DOCROUTE → PASS" {
  run_hook "pipeline(agent('intel-reporter',{goal:'Target file: WRITE the report to ~/r.md'}) /* route: POST to clauded-docs */)"
  [[ ! "${output}" =~ "doc-routing leak" ]]
  [[ "${status}" -eq 0 ]]
}

# (d) NO-WEAKEN guarantee: a COMMENTED qa-code-reviewer must STILL fail the verify-stage — the strip
# on spawn/agentType tokens is the anti-gaming property, preserved by P0. A plan-ref is present so the
# BLOCK is unambiguously the verify-stage verdict (not entry-miss).
@test "P0(d): commented qa-code-reviewer + plan-ref + impl dev → BLOCK (anti-gaming preserved)" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan clauded-docs/9'}), /* agent('qa-code-reviewer') verify here */ agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# (e) a commented dev-* spawn is still treated as ABSENT (dev_re stays comment-stripped): a real
# reviewer + a commented dev verifier + a real impl dev beyond the co-location window → no co-located
# verify-DEV → BLOCK (the verify-stage gate is still enforced). plan-ref isolates from entry-miss.
@test "P0(e): commented dev-* verifier not counted, real impl dev far → BLOCK (verify-stage enforced)" {
  local f
  f="$(filler 45)"
  run_hook "pipeline(agent('intel-planner',{goal:'plan clauded-docs/9'}),agent('qa-code-reviewer',{goal:'judge'}), /* agent('dev-nestjs') verify */ ${f}, agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
}

# --- (k) SYNCED-ROSTER MEMBERSHIP PROBE — a real synced DEV member (dev-swift) is recognized by the
# gate as a DEV-implementation spawn (DEV impl with NO qa-code-reviewer / plan-ref / [ENTRY-CLASS]
# token → BLOCK), while a non-member (intel-reporter) alone is not gated (exit 0). Proves the gate
# keys on DEV_SET membership. dev-swift is the agent whose DEV_SET absence originally motivated the
# gate-roster auto-sync (agent_lifecycle add/delete + `sync-gate-roster`); the BLOCK case fails RED
# if dev-swift is ever dropped from DEV_SET, confirming the gate reads the synced list. ---

@test "membership: dev-swift impl, NO reviewer/plan-ref/token → BLOCK (synced DEV member recognized)" {
  run_hook "pipeline(agent('dev-swift',{goal:'implement the swift module'}))"
  [[ "${status}" -eq 2 ]]
}

@test "membership: non-member intel-reporter alone → PASS (not a DEV spawn, exit 0)" {
  run_hook "pipeline(agent('intel-reporter',{goal:'synthesize the findings'}))"
  [[ "${status}" -eq 0 ]]
}

# --- (l) T1 INLINE-PLAN no-widening + message-content — an in-script intel-planner author stage
# (an inline one-shot author+verify+implement workflow) carrying NO minted clauded-docs/<N> id STILL
# blocks (entry-miss, exit 2): R2 (widen the gate to accept an inline planner spawn as a plan-ref)
# was REJECTED, so the gate did NOT widen — parity with the existing "DEV + valid verify-stage, NO
# plan-ref NO token → BLOCK_ENTRY" fixture, plus an inline author stage. The rewritten message pins
# exactly TWO resolution paths (persist a plan / record a simple-task token), carries the INLINE-PLAN
# reasons, and DROPS the old "author a qa-code-reviewer verify-stage" path. bats `run` merges STDERR
# into $output. ---

@test "T1 no-widen: inline intel-planner author + verify-stage + impl, NO minted id → BLOCK_ENTRY (exit 2)" {
  run_hook "pipeline(agent('intel-planner',{goal:'author the plan inline now'}), parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${output}" =~ "entry-miss" ]]
  [[ "${status}" -eq 2 ]]
}

@test "T1 message: exactly TWO resolution paths, INLINE-PLAN reasons, removed verify-stage path absent" {
  run_hook "pipeline(agent('intel-planner',{goal:'author the plan inline now'}), parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
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

# --- (m) F1 TWO-STEP REVEAL FIX — when a DEV workflow lands on the missing-verify-stage BLOCK AND
# also carries no entry signal (entry_marker == ENTRY_ADVISORY), the BLOCK message now CONDITIONALLY
# appends an entry-format addendum (the two escape paths) so the author resolves the verify-stage AND
# the entry signal in ONE pass instead of two round-trips. Strictly MESSAGE-ONLY: entry_marker selects
# the message text, never the verdict or the exit code (still 2). The addendum is phrased WITHOUT the
# literal "entry-miss" so the dedicated entry-miss channel tag stays absent from this BLOCK's output.
# bats `run` merges STDERR into $output; the substring `== *"..."*` form keeps the [], /, () in the
# needle literal (regex-special chars match as text). ---

# POSITIVE: missing verify-stage + DEV spawn + NO plan-ref + NO [ENTRY-CLASS] token → exit 2
# (missing-verify-stage BLOCK) AND the message CARRIES the entry-format addendum (both escape paths).
# The dedicated "entry-miss" channel tag MUST remain absent (the no-literal-`entry-miss` constraint).
@test "F1 positive: missing verify-stage + ENTRY_ADVISORY → BLOCK (exit 2) with entry-format addendum" {
  run_hook "pipeline(agent('intel-planner',{goal:'plan'}), agent('dev-nestjs',{goal:'implement'}))"
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
  run_hook "pipeline(agent('intel-planner',{goal:'plan clauded-docs/777'}), agent('dev-nestjs',{goal:'implement'}))"
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
  run_hook "pipeline(agent('intel-planner',{goal:'plan'}), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"entry classification / plan-reference also required"* ]]

  # ENTRY_OK missing-verify case → exit STILL 2 + addendum absent
  run_hook "pipeline(agent('intel-planner',{goal:'plan clauded-docs/777'}), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" != *"entry classification / plan-reference also required"* ]]
}

# --- (n) T1 DOCROUTE-PATH GENERALIZATION — the centralized entry addendum (formerly inline on the
# verify-stage "block" path only) now ALSO rides the docroute "block-docroute" verdict via
# block_and_exit's ALLOWLIST gate ($2 == "block" || $2 == "block-docroute"). A doc-routing leak that
# ALSO spawns a DEV agent with no plan-ref/token lands on BLOCK_DOCROUTE with entry_marker ==
# ENTRY_ADVISORY → the SAME entry-format addendum appends, closing the two-round-trip gap on the
# docroute path. FIXTURE PURITY (HARD): NO `clauded-docs` token and NO plan-ref — MONITOR_POST_RE
# matches bare `clauded-docs`, which would BOTH suppress docroute detection AND flip entry_marker to
# ENTRY_OK via PLAN_REF, silently breaking both arms. Assertions key on the discriminator
# `entry classification / plan-reference also required`, NOT `POST /api/clauded-docs` (the latter
# already lives in the docroute BASE reason → would FALSE-PASS). bats `run` merges STDERR into
# $output; `== *"..."*` keeps the [], /, () in the needle literal. ---

# POSITIVE: docroute leak (doc-agent local Target, NO monitor-POST) + a dev-* spawn + NO plan-ref/token
# → BLOCK_DOCROUTE (exit 2) AND the entry-format addendum appended (the docroute-path gap closed). The
# dedicated "entry-miss" channel tag MUST remain absent (no-literal-`entry-miss` constraint, mirroring
# the F1 positive test).
@test "docroute F1: leak + dev-* spawn + ENTRY_ADVISORY → BLOCK (exit 2) with entry-format addendum" {
  run_hook "pipeline(agent('intel-reporter',{goal:'Target file: WRITE to ~/r.md'}), agent('dev-nestjs',{goal:'implement'}))"
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
  run_hook "pipeline(agent('intel-reporter',{goal:'Target file: WRITE to ~/r.md'}))"
  [[ "${status}" -eq 2 ]]
  # still the docroute BLOCK
  [[ "${output}" == *"doc-routing leak"* ]]
  # addendum ABSENT (ENTRY_OK → no entry nudge with no DEV spawn)
  [[ "${output}" != *"entry classification / plan-reference also required"* ]]
  # the dedicated entry-miss tag is likewise absent (ENTRY_OK never reaches the entry-miss block)
  [[ ! "${output}" =~ "entry-miss" ]]
}

# --- (o) T2 ENTRY-MISS COPY-PASTE SCAFFOLD — the entry-miss BLOCK message now carries a ready-to-fill
# plan-stub scaffold so the compliant path costs fewer keystrokes than overriding. Strictly MESSAGE-ONLY:
# the scaffold rides the SAME entry-miss reason string; the gate decision (exit 2), the regexes, and the
# entry_marker logic are untouched. The fixture is the canonical entry-miss shape (DEV spawn with a valid
# verify-stage but NEITHER a plan-ref NOR an [ENTRY-CLASS] token) — identical to the section (f) fixture
# "entry: DEV + valid verify-stage, NO plan-ref NO token → BLOCK_ENTRY (exit 2)", so it pins that the
# exit-2 entry-miss verdict is byte-for-byte preserved while the new scaffold text is present. bats `run`
# merges STDERR into $output; `== *"..."*` keeps the [], /, (), <> in the needle literal. ---

# (a) the COPY-PASTE SCAFFOLD string is present in the entry-miss BLOCK stderr.
@test "T2 scaffold: entry-miss BLOCK message carries the copy-paste plan-stub scaffold" {
  run_hook "pipeline(parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  # this is the dedicated entry-miss channel (not a verify-stage / docroute block)
  [[ "${output}" =~ "entry-miss" ]]
  # scaffold lead-in + both ready-to-fill resolution stubs surfaced
  [[ "${output}" == *"COPY-PASTE SCAFFOLD"* ]]
  # path (1) persisted-plan stub: the POST curl + the minted-id plan-ref log line
  [[ "${output}" == *"POST http://127.0.0.1:7842/api/clauded-docs"* ]]
  [[ "${output}" == *"log('plan-ref: clauded-docs/<DOC_ID>')"* ]]
  # path (2) simple-task stub: the ready-to-fill [ENTRY-CLASS] log line
  [[ "${output}" == *"log('[ENTRY-CLASS] simple-task: <one-line reason"* ]]
}

# (b) byte-for-byte preservation of the pre-existing exit-2 entry-miss verdict — the scaffold is purely
# additive to the message and changes NOTHING about the decision. Re-asserts the section (f) ground-truth:
# entry-miss fixture → exit 2 AND the "entry-miss" channel tag present (the scaffold did not move the
# block onto a different channel).
@test "T2 scaffold: pre-existing exit-2 entry-miss verdict preserved (message-only change)" {
  run_hook "pipeline(parallel(agent('qa-code-reviewer',{goal:'judge'}),agent('dev-nestjs',{goal:'feasible'})), agent('dev-nestjs',{goal:'implement'}))"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "entry-miss" ]]
  # the base entry-miss reason is intact alongside the new scaffold (no text was replaced)
  [[ "${output}" == *"NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification"* ]]
}
