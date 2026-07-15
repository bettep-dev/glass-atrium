export const meta = {
  name: 'trackB-campaign-full-fanout',
  description: 'Comment-reduction campaign FULL parallel fan-out (16 disjoint batches): remaining hooks (14), scripts (29), scripts/lib (11), monitor TS (54, arch excluded), top-level (3), test-intent bats (31), Track A split files (launcher + 9 ga-tui siblings). Every agent pinned to Opus (session main is Fable). Devs EDIT ONLY + self-verify; orchestrator commits sequentially after.',
  phases: [{ title: 'Reduce' }],
}

log('plan-ref: clauded-docs/3 — verified Track B comment-reduction plan; FULL parallel fan-out (16 disjoint batches), HEAD 07b2888, base bats 951 green. All agents pinned model=opus per user directive (main session is Fable). Devs EDIT ONLY — orchestrator does all git/manifest/bats/commit sequentially.')
log('[SIZE-EST] bundles=1 tool_uses~=15-30 per batch — each dev compresses its disjoint file set + self-verifies no-code-change/preserve-floor/syntax; NO git/manifest/full-bats/commit; 16 batches x 2 agents run parallel under the engine cap')

const COMMON = `Worktree cwd: /Users/testuser/Desktop/git/_ga-deps-fix, branch feature/deps-preflight-noninteractive, HEAD 07b2888. T0 classifier: bash test/comment-audit/comment-classifier.sh classify FILE -> "file comment code ratio shellcheck security extref banner". Baseline: test/comment-audit/canonical-baseline.tsv (same columns, tab-separated). Standard: shared-comment-logging.md.

GOAL: reduce comment over-density on YOUR ASSIGNED FILES ONLY — (1) remove decorative banner/divider comment lines (banners FORBIDDEN); also catch 2-line-wrapped / text-ending decorated headers the classifier misses (keep the architectural/scope LABEL as a plain comment, strip only the decoration); (2) compress verbose multi-line headers + restating-code + self-evident + duplicated-rationale prose to ONE essence line each.
PRESERVE (compress the prose, KEEP the fact): every shellcheck directive line (byte-inviolate; only its trailing reason may compress), every SECURITY: annotation (keep the threat rationale), every external/checkable ref (OWASP LLMxx / A0x / core-security.md / shared-*.md / RFC / URL), every non-obvious why / residual-risk note (keep as an essence line). Security-critical files get the SOFTER ceiling — cut NARRATIVE bloat only, never threat/gaming-avoidance/data-safety rationale.

SELF-VERIFY GATES (you run these; do NOT run the full bats suite, do NOT git add, do NOT regenerate manifest, do NOT commit):
- NO-CODE-CHANGE per file: every +/- line in "git diff -- FILE" (excluding the +++/--- headers) must be a STANDALONE COMMENT line or a BLANK line — zero code-line changes. For shell: first non-space char of the changed line is a hash. For TypeScript: first non-space chars are // or /* or * or */. Construct the grep yourself and show it returns empty. If any code line changed, revert that edit.
- PRESERVE-FLOOR per file: classifier columns 5/6/7 (shellcheck/SECURITY/extref) IDENTICAL to canonical-baseline.tsv; if the file is NOT in the baseline, snapshot its classify output FIRST (before any edit) and hold the floor against that snapshot.
- SYNTAX per file: shell -> bash -n clean (skip bash -n for .bats; instead run bats on each edited .bats file and it must PASS with the same test count). TypeScript -> no syntax gate needed beyond the diff gate (orchestrator runs tsc at commit time).
Leave your edits UNSTAGED in the working tree. Do NOT touch any file outside your batch. If budget approaches, STOP clean (whole files only — revert any half-edited file). Report: files compressed, per-file comment before/after, and per-file gate confirmation. Print a full multi-line [COMPLETION] block closed by [/COMPLETION].`

const BATCHES = [
  { id: 'H1', agent: 'glass-atrium-dev-shell', files: 'hooks/enforce-workflow-verify-stage.sh (single file, 431 comment lines — the biggest hook). SOFTER ceiling: this is the workflow verify-stage gate; preserve every gate-semantics rationale (BLOCK_ORDER positional rule, entry-token raw-scan, DEV-classification heuristics, fail-open enumerated-case defaults, [SIZE-EST]/[ENTRY-CLASS]/[DOC-ROUTE] token contracts) as essence lines.' },
  { id: 'H2', agent: 'glass-atrium-dev-shell', files: 'hooks/track-outcome.sh (single file, 345 comment lines). SOFTER ceiling: the outcome recorder; preserve the parse-tier contract ([COMPLETION] newline anchor, multi-line-form mandate, reverse-scan preferring the last COMPLETION-bearing text), grader input-surface invariant (block-resident-only evidence), synthesis/downgrade_origin semantics, style_ref cross-verification, correction-signal keying.' },
  { id: 'H3', agent: 'glass-atrium-dev-shell', files: 'hooks/inject-scope-rules.sh, hooks/cost-tracker.sh, hooks/detect-secret-file-write.sh, hooks/block-doc-routing-leak.sh. SOFTER ceiling (security-dense): preserve the LLM01 path-traversal note, the AGENT-INJECT extract_block allowlist rationale, secret-pattern coverage + DOCUMENTED RESIDUAL boundary, doc-route stamp path-scoping rules.' },
  { id: 'H4', agent: 'glass-atrium-dev-shell', files: 'hooks/hook-utils.sh, hooks/validate-scope-drift.sh, hooks/lint-workflow-template-literal.sh, hooks/telemetry-activation.sh, hooks/post-edit-typecheck.sh, hooks/post-edit-outcome-sync.sh, hooks/pre-compact.sh, hooks/inject-session-context.sh (8 smaller hooks). Standard ceiling; preserve the hook-utils WHY notes (LLM01), PLAN_FILE/scope-drift contract, template-literal bash-pitfall rationale, CONTINUITY header contract.' },
  { id: 'S1', agent: 'glass-atrium-dev-shell', files: 'run: ls scripts/*.sh | sort | sed -n "1,10p" — those 10 files exactly. Do NOT touch scripts/lib or scripts/test or scripts/agent_lifecycle.' },
  { id: 'S2', agent: 'glass-atrium-dev-shell', files: 'run: ls scripts/*.sh | sort | sed -n "11,20p" — those 10 files exactly. Do NOT touch scripts/lib or scripts/test or scripts/agent_lifecycle. NOTE: if update.sh is in your slice it is SOFTER ceiling (5 SECURITY annotations + apply-lock/update-pause contracts).' },
  { id: 'S3', agent: 'glass-atrium-dev-shell', files: 'run: ls scripts/*.sh | sort | sed -n "21,29p" — those 9 files exactly. Do NOT touch scripts/lib or scripts/test or scripts/agent_lifecycle. NOTE: if update.sh is in your slice it is SOFTER ceiling (5 SECURITY annotations + apply-lock/update-pause contracts); monitor-log-rotate.sh must keep the launchd fd-preservation why (launchd never reopens fds -> truncate not unlink).' },
  { id: 'SL', agent: 'glass-atrium-dev-shell', files: 'all scripts/lib/*.sh (11 files). SOFTER ceiling for apply-lock.sh (3 SECURITY; pid-liveness + TTL stale-reclaim contract), apply-gate.sh, sensitive-refusal.sh, update-pause-flag.sh; keep the mirror-farm + daemon-bootstrap-common ordering/why notes.' },
  { id: 'M1', agent: 'glass-atrium-dev-node', files: 'all monitor/src/server/types/*.ts AND all monitor/src/server/clauded-docs/*.ts (TypeScript). Preserve: the control-chars lastIndex-on-global-regex gotcha (a real bug-class warning), RFC 8259 ref, html-validator policy notes, the wiki types local-enum duplication rationale. Self-evident field-name comments are the main cut target in types/.' },
  { id: 'M2', agent: 'glass-atrium-dev-node', files: 'all monitor/src/server/routes/*.ts (TypeScript; biggest absolute volume: clauded-docs.ts ~791 comment lines, improvement.ts ~545). Ratio is already moderate — cut verbose block narration + duplicated route-flow prose; PRESERVE route-contract/edge-case notes (optimistic-lock expected_hash flow, status-only cascade, supersede semantics, doc_status transitions).' },
  { id: 'M3', agent: 'glass-atrium-dev-node', files: 'every remaining monitor/src/server/**/*.ts EXCLUDING the types/, clauded-docs/, routes/ directories AND EXCLUDING everything under monitor/src/server/architecture/ plus monitor/src/server/types/architecture.ts and monitor/src/server/routes/architecture.ts (architecture set is already lean — leave completely untouched; the types/routes architecture files are covered by that exclusion, not your batch). Also do NOT touch monitor/src/generated.' },
  { id: 'T', agent: 'glass-atrium-dev-shell', files: 'build-glass-atrium.sh, install.sh, monitor/scripts/oss-db-setup.sh. install.sh is user-facing bootstrap — keep its safety/why notes; oss-db-setup.sh keep any destructive-guard / idempotency rationale.' },
  { id: 'TI1', agent: 'glass-atrium-dev-shell', files: 'all hooks/test/*.bats (14 files). TEST-INTENT TIER: NO flat ratio target — remove ONLY banners + restated-assertion prose; "what this asserts / why this test exists" intent notes are near-load-bearing, keep them (one-essence-line where verbose). GATE: run bats on each edited file — must pass with the same test count.' },
  { id: 'TI2', agent: 'glass-atrium-dev-shell', files: 'all scripts/test/*.bats (17 files). TEST-INTENT TIER: same rules as hooks/test — banners + restated-assertion prose only; keep intent notes; run bats per edited file, same count, all pass.' },
  { id: 'SPA', agent: 'glass-atrium-dev-shell', files: 'glass-atrium (the thin loader, ~908 lines) + lib/ga-tui-caps.sh + lib/ga-tui-term.sh + lib/ga-tui-primitives.sh + lib/ga-tui-frame.sh. NOT in the baseline -> snapshot-first floor. PRESERVE: the loader R8 contract notes (strict-mode/trap loader-owned, siblings never re-arm), source-order/readonly MIN_ROWS-after-MENU_COUNT rationale, set-u stub grouping notes, cleanup/fd-4 lifecycle notes, ERR-trap LINENO note. AFTER editing run this targeted bats subset and ALL must pass: test/workbox-bar-count-visible-during-resolve.bats test/continuous-index.bats test/install-step-counter-grand-total.bats test/spinner-cursor-visibility.bats test/spinner-jobcontrol-restore.bats.' },
  { id: 'SPB', agent: 'glass-atrium-dev-shell', files: 'lib/ga-tui-workbox.sh + lib/ga-tui-run.sh + lib/ga-tui-monitor.sh + lib/ga-tui-dispatch.sh + lib/ga-tui-preflight.sh. NOT in the baseline -> snapshot-first floor. SOFTER ceiling: these carry the A1 blank-box fix + counter contracts. PRESERVE as essence lines: the RC-1 render contract comments (COMPOUND gate run+bar-present; publish STEP_BAR_CUR BEFORE the spinner fork; seed STEP_INDEX only-when-empty), the R3 no-subshell brace-group counter contract (run_step/run_gate_quiet), GRAND_TOTAL freeze + disp_n fallback rationale, GA_TUI_STEP exit_step/die_step dispatch notes, monitor stop/restore ownership guards, preflight fd-4 + PREFLIGHT_EXIT_BLOCKED + bounded-poll/anti-hang notes. AFTER editing run this targeted bats subset and ALL must pass: test/workbox-bar-count-visible-during-resolve.bats test/continuous-index.bats test/install-step-counter-grand-total.bats test/run-step-fail-return.bats test/deps-preflight-noninteractive.bats test/pg-detect-connect-deadline.bats test/uninstall-detached-daemons.bats test/monitor-build-selfheal.bats.' },
]

function reviewerPrompt(b) {
  return `Pre-compression review (glass-atrium-qa-code-reviewer, READ-ONLY) for one comment-reduction batch. ${COMMON}

YOUR BATCH (${b.id}) FILES: ${b.files}

Enumerate the PRESERVE set for these files (file:line): every SECURITY: annotation, shellcheck directive, external/checkable ref, and every non-obvious why / residual-risk note that MUST survive as an essence line (name the fact each encodes). Flag files needing the softer ceiling. Output the per-file PRESERVE inventory + a SHORT verdict PROCEED (or HOLD naming any file to exclude).`
}

function devPrompt(b, concerns) {
  return `Comment-reduction batch ${b.id} (EDIT ONLY — no git/manifest/full-bats/commit). ${COMMON}

YOUR BATCH FILES: ${b.files}

# Reviewer preserve inventory (do NOT drop these facts; if the reviewer HOLD-excluded a file, skip it)
--- PRESERVE NOTES ---
${concerns}
--- END ---

Steps: (1) resolve your exact file list; snapshot each file's classify output BEFORE editing; (2) banner sweep + prose compression per GOAL, preserving every inventory fact; (3) self-run the gates per file (no-code-change diff EMPTY, preserve-floor identical, syntax gate); (4) leave edits UNSTAGED. Report per-file before/after + gate confirmations. Print the multi-line [COMPLETION] block.`
}

phase('Reduce')
const results = await pipeline(
  BATCHES,
  (b) => agent(reviewerPrompt(b), { label: 'preserve:' + b.id, phase: 'Reduce', agentType: 'glass-atrium-qa-code-reviewer', model: 'opus' }),
  (review, b) => agent(devPrompt(b, review || '(no reviewer output)'), { label: 'reduce:' + b.id, phase: 'Reduce', agentType: b.agent, model: 'opus' }).then(r => ({ batch: b.id, impl: r ? 'done' : 'EMPTY' })),
)

return results
