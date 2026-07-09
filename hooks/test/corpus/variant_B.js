/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/1
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
export const meta = {
  name: 'ga-tui-bug-simplify-review',
  description: 'plan-ref clauded-docs/1: /simplify (4-dimension cleanup review + apply) on the TUI install bugfix diff, then a final QA review. Bugfix is BATS-green (583/0) + coverage 7/7; the pre-existing pg-orphan harness + oss-e2e E2E-skip are folded into the launcher-split test-audit (NOT regressions). [SIZE-EST] apply bundles=1 tool_uses~=20; the 4 review dims + final review are read-only.',
  phases: [ { title: 'Simplify-review' }, { title: 'Simplify-apply' }, { title: 'Final-review' } ],
}

const WT = '/Users/bettep/Desktop/git/_ga-deps-fix'

const FINDINGS_SCHEMA = { type:'object', additionalProperties:false,
  properties:{ dimension:{type:'string'}, findings:{type:'array',items:{type:'object',additionalProperties:false,
    properties:{ file:{type:'string'}, line:{type:'integer'}, summary:{type:'string'}, cost:{type:'string'}, fix:{type:'string'} }, required:['file','summary','fix'] }} },
  required:['dimension','findings'] }
const FINAL_SCHEMA = { type:'object', additionalProperties:false,
  properties:{ verdict:{type:'string'}, bats_green:{type:'boolean'}, unmet:{type:'array',items:{type:'string'}}, summary:{type:'string'} },
  required:['verdict','bats_green','summary'] }

async function robustAgent(p,o){ let r = await agent(p,o); if(r===null) r = await agent(p,o); return r }
const EMIT = 'Before the StructuredOutput call, print a full multi-line [COMPLETION] block (result/task_type/metric_pass/confidence/summary) terminated by [/COMPLETION] as a dedicated text turn, THEN call StructuredOutput.'

const DIFF_SCOPE = [
  'Review ONLY the newly-authored bugfix LOGIC in the shell files changed this session. Get the diff via `git show`/`git diff` of the FOUR bugfix-logic commits: 410d80a (T1 self-heal + T2 build_monitor return), 42b4fc4 (T2b exit_step/die_step + T3 hash -r), 9aaf5e8 (T4 PGCONNECT_TIMEOUT + T5 per-detect idle brackets), 686dae6 (T6 GRAND_TOTAL). Files: glass-atrium, lib/ga-core.sh, lib/ga-db.sh, lib/ga-env.sh, lib/ga-deps.sh.',
  'DO NOT flag: the Korean->English translation (commit 556a27d, pure text), the test-only harness reconciliation (032cb7c), byte-identical moves, or any pre-existing code outside these 4 commits. This is behavior-preserving quality cleanup, NOT bug-hunting.',
].join('\n')

const PREEXIST = 'KNOWN pre-existing non-green (NOT your breakage, do NOT try to fix, do NOT treat as a regression): (1) test/uninstall-pg-untouched-utc-guard-harness.sh B3/B3b (expects an rm_socket the code does not emit) — proven to fail identically at 42b4fc4 (pre-T4/T5) and clear_unmanaged_pg_orphan is byte-identical through the ga-core split, so it is unrelated to T1-T6; (2) test/oss-e2e-bootstrap.sh self-skips (fresh-machine E2E). Everything ELSE MUST stay green: full bats (test/*.bats + scripts/test/*.bats) = 583 ok / 0 not-ok, the other 6 non-E2E test/*.sh harnesses, and ./scripts/generate-manifest.sh --check exit 0.'

// ---- Phase 1: Simplify-review (4 parallel /simplify dimensions) ----
phase('Simplify-review')
const DIMS = [
  { key:'reuse', prompt:'REUSE: flag newly-authored fix code that re-implements something the codebase already has (grep lib/ga-*.sh + shared helpers); name the existing helper to call instead.' },
  { key:'simplification', prompt:'SIMPLIFICATION: flag unnecessary complexity the fix added — redundant/derivable state, copy-paste variation, deep nesting, leftover dead code; name the simpler equivalent.' },
  { key:'efficiency', prompt:'EFFICIENCY: flag wasted work the fix introduced — redundant recomputation, repeated I/O, avoidable subshells/forks on the render/hot path; name the cheaper form.' },
  { key:'altitude', prompt:'ALTITUDE: check each fix sits at the right depth, not a fragile bandaid/special-case layered on shared infra; prefer generalizing the mechanism.' },
]
const reviews = await parallel(DIMS.map(d => () => robustAgent([
  'Role: glass-atrium-qa-code-reviewer running the /simplify ' + d.key + ' dimension on ' + WT + '. ' + d.prompt,
  DIFF_SCOPE,
  'Return findings[] each with file, line, summary, cost, and the concrete fix. Empty array if the code is already clean on this dimension. Be conservative — this code already passed a Stage-2 verify gate + per-wave review, so only flag genuinely worthwhile cleanups. ' + EMIT,
].join('\n'), { label:'simplify:' + d.key, phase:'Simplify-review', agentType:'glass-atrium-qa-code-reviewer', effort:'high', schema:FINDINGS_SCHEMA })))
const allFindings = reviews.filter(Boolean).flatMap(r => (r.findings || []).map(f => ({ ...f, dimension: r.dimension })))
log('Simplify-review: ' + allFindings.length + ' findings across 4 dimensions')

// ---- Phase 2: Simplify-apply (dev applies accepted findings, re-verifies) ----
phase('Simplify-apply')
let applyResult = 'no findings — skipped'
if (allFindings.length > 0) {
  applyResult = await agent([
    '[SIZE-EST] bundles=1 tool_uses~=20 — apply cleanup findings + re-run tests (no new feature).',
    'plan-ref: clauded-docs/1. In ' + WT + ' (branch feature/deps-preflight-noninteractive), apply the ACCEPTED /simplify findings below to the bugfix code. DEDUP first (several may point at one line/mechanism). SKIP any finding whose fix would change intended behavior, reach outside the 4 bugfix commits, or that you judge a false positive — note the skip with a one-line reason. Behavior-preserving cleanup only.',
    'FINDINGS:', JSON.stringify(allFindings, null, 2),
    'After applying: re-run the FULL bats suite + the non-E2E harnesses. ' + PREEXIST + ' If any change makes a previously-green test go red, REVERT that specific change. If you touched a shippable file, regenerate manifest.json + re-check (exit 0). git add ONLY your changed files (no -A); commit (- [x] Apply /simplify cleanup to TUI install bugfix). NO push/merge; retry on index.lock.',
    'Report: findings applied vs skipped (one-line reasons each), files changed, bats still 583/0, commit hash. Emit a multi-line [COMPLETION] block (task_type: refactor) terminated by [/COMPLETION].',
  ].join('\n'), { label:'simplify:apply', phase:'Simplify-apply', agentType:'glass-atrium-dev-shell', effort:'high' })
  log('Simplify-apply done')
} else { log('Simplify-apply: skipped (0 findings)') }

// ---- Phase 3: Final-review (whole bugfix-diff QA verdict) ----
phase('Final-review')
const finalRev = await robustAgent([
  'Role: glass-atrium-qa-code-reviewer. FINAL review of the COMPLETED TUI install bugfix in ' + WT + ' (branch feature/deps-preflight-noninteractive). Review the whole bugfix diff (the 4 logic commits 410d80a/42b4fc4/9aaf5e8/686dae6 + the Korean translation 556a27d + the harness reconciliation 032cb7c + any /simplify cleanup just applied). Confirm: each of the 3 bugs (blank-box hang / step-count 6->19 / monitor-build force-quit) is fixed at its ROOT (not symptom), the T2b force-quit class + CLI exit semantics are correct, no 편법 in any test (real fail-before/pass-after; the reconciled harnesses updated expectations to the NEW intended behavior, not weakened), and the code is green.',
  'Re-run a quick confirmation: full bats totals + ./scripts/generate-manifest.sh --check. ' + PREEXIST,
  'Return verdict pass|revise, bats_green true|false, unmet[] (concrete blockers with file:line if revise), and a 1-line summary. ' + EMIT,
].join('\n'), { label:'final-review', phase:'Final-review', agentType:'glass-atrium-qa-code-reviewer', effort:'high', schema:FINAL_SCHEMA })
log('Final-review: verdict=' + (finalRev && finalRev.verdict) + ' bats_green=' + (finalRev && finalRev.bats_green))

return { simplify_findings: allFindings.length, apply: applyResult, final: finalRev }