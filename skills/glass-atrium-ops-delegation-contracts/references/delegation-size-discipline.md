# Delegation-size discipline (per-delegation, distinct from runtime concurrency)

- **Where it sits**: under `skills/glass-atrium-ops-orchestrator-role.md` → `### Spawn Budget`, beside the runtime concurrency ceilings (`#### Depth and concurrency ceilings`) it is distinct from.
- **Pointer site**: `#### Delegation-size discipline` in that file.

## DEV-mode token

- **`[SIZE-EST]` self-attestation token (sibling to `[ENTRY-CLASS]`)**: the DEV-mode form.
  - Format `[SIZE-EST] bundles=N tool_uses~=N — <1-line reason>`: `bundles` = how many PRIMARY categories THIS delegation packs · `tool_uses~=N` = the orchestrator's rough pre-spawn tool_use estimate.
  - Placement: `skills/glass-atrium-ops-orchestrator-role.md` → `### Context Handoff Size` → Attestation-token placement. On the manual path `enforce-verification-gate.sh` reads it from `.tool_input.prompt`.
  - **Honesty framing** — why the pointer rounds a borderline count UP: under-estimating `bundles`/`tool_uses` is the DANGEROUS error, masking an oversized delegation past the split discipline; over-estimating is the SAFE error.
  - **Scope of this contract — existence/self-attestation only**: the token records the orchestrator's own estimate, and the gates check its PRESENCE, never its correctness — the same existence-only boundary as `[ENTRY-CLASS]`.
  - Enforcement, both paths — manual: `enforce-verification-gate.sh`, guarded by `hook_is_subagent` so it fires on orchestrator-origin spawns only · ultracode: `enforce-workflow-verify-stage.sh`, DEV-gated, raw-scanning the script. Both BLOCK a DEV spawn missing the token.
    - Except a simple-task entry with no plan-ref, which both pass silently (`skills/glass-atrium-ops-orchestrator-role.md` → `#### Entry classification (DEV delegations)` → **Simple-task waiver**).

## Analysis-mode token

- **`[SIZE-EST]` analysis mode (schema-mode NON-DEV analysis/research/audit spawn — the INPUT-side right-sizing complement)**:
  - Which spawns: glass-atrium-intel-researcher / glass-atrium-intel-planner / glass-atrium-intel-reporter / glass-atrium-qa-code-reviewer, each whose single terminal StructuredOutput IS the deliverable.
  - Why: such a spawn has no `files × 4.5` edit analog — it spends its budget on reads and reasoning, so a broad read + `effort:high` + a 3-4-field schema starves the emit step (the non-emit failure class).
    - Non-emission share and re-derivation recipe: `skills/glass-atrium-ops-orchestrator.md` → Completion-channel non-emission (MEASUREMENT SoT).
  - Format `[SIZE-EST] reads~=N fields=N effort=<medium|high> scope=<allowlist|bounded> — <1-line reason>`: `reads~=N` = the pre-spawn read/tool-use estimate · `fields` = the output schema's required-field count · `effort` = the chosen reasoning tier · `scope` = an explicit file/dir READ allowlist, never a repo sweep.
  - Read-scope anchor (the read analog of `files × 4.5`): a simple fact-find ~3-10 reads · a direct comparison ~10-15 reads per source.
  - **Reserve-then-check (gate BEFORE work begins)**: the input budget the read allowlist is sized to is `input_budget = context_window − reserved_output`.
  - **Output-field cap**: 2-3 fields.
  - **Effort matched to depth**: the unmeasured default for a spawn whose author sets a tier — `medium` for broad reads, `high` only for narrow-scope deep reasoning.
  - Honesty and backing as in DEV mode, `reads~`/`fields` included: presence is checked, correctness never.
  - Gate: `enforce-workflow-verify-stage.sh` fires an ADVISORY nudge (never exit 2, fail-open) on a schema-mode non-DEV analysis spawn missing this token — unlike the DEV-mode exit-2 block.

## Notes on the pointer-site items

- **One-agent-budget sizing — why**: an over-packed delegation truncates — the sub-agent runs out of budget mid-work and emits no `[COMPLETION]`. The cause is per-delegation SIZE, not the number of workflow stages.
- **DEV-mode split shape**: order each kept implementation+tests unit tests-first; peel off run-full-suite / report-consolidation.
  - Worked (≈ figures illustrative): 4-category request → A = implement + its new tests (≈25 tool_uses) → orchestrator cheap-verify → B = full-suite + report (≈15) — each ≤2 bundles and under the HARD SECONDARY ceiling; do NOT split B finer (COUNTER-CAVEAT).
- **HARD SECONDARY — why (anti-gaming)**: it closes the single-giant-implement-bundle hole that the bundle count alone leaves open.
- **COUNTER-CAVEAT — cost**: a split into 1-line tasks re-tokenizes system prompt + tool schemas + handoff on every spawn, so over-fragmentation inflates TOTAL session cost.
- **Subagent-side runtime complement**: this orchestrator-side split is the primary guard, and it is honor-system; the subagent's own turn meter and tool-use advisory only make its threshold visible.
- **Per-file tool_use measurement (feeds the `[SIZE-EST]` estimate in `## DEV-mode token`)**: one file edit+verify+commit unit costs ~4-5 tool_uses measured.
  - The `files × 4.5` anchor built on it is a floor, calibrated UP, never down.
  - Its split line sits clear of the truncation band, with headroom for the reserved `[COMPLETION]`/emit tail.

## Effort-scaling table

- **Pointer site**: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Analysis fan-out and team cardinality` → **Effort-scaling by task shape**.
- **What it sets — detail**: it is the companion to `[SIZE-EST]`, which sizes each agent; this table holds the shape → cardinality mapping.

| Task shape | Team cardinality | Example |
|------------|------------------|---------|
| Simple fact lookup / single-file edit | **1 agent** (no fan-out) | "find where X is defined and fix the typo" |
| Comparison / multi-source cross-check / independent multi-section work | **2-4 agents** in parallel | "compare 3 libraries", "review these 4 independent modules" |
| Broad open-ended research sweep | fan out toward the engine's runtime concurrency self-cap | "survey the whole landscape of Y" |

- Deep-but-single-threaded work escalates reasoning DEPTH through the `effort` parameter, not more agents.
- Add agents only when sub-tasks are genuinely independent.

## Analysis-Track Right-Sizing (input-side)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Analysis-Track Right-Sizing (input-side) [ORCHESTRATOR]`, which states the duty and when it fires.
- The `robustAgent` layer (`skills/glass-atrium-ops-orchestrator.md` → `##### Copyable helper (robustAgent)`) hardens the output side — a non-emit no longer crashes the run. This section removes the input-side cause of that non-emit.
- Rule SoT, per bound:
  - read allowlist (`scope`), **Effort matched to depth** and field cap — `## Analysis-mode token` above → **`[SIZE-EST]` analysis mode**;
  - the analysis-mode split trigger — `skills/glass-atrium-ops-orchestrator-role.md` → `#### Delegation-size discipline` → **Split triggers**;
  - decompose-by-domain — `skills/glass-atrium-ops-orchestrator-role.md` → `#### Analysis fan-out and team cardinality`.
- Deltas this section adds, per track:
  - **Bounded read-scope** — each allowlist entry is a `{ path, extent }` pair the skeleton renders into the prompt; a bare-path entry is the defect.
    - Extent follows `references/delegation-prompt.md` → `## Read-Extent Discipline`.
  - **Output-field shape** — prefer a single free-text `analysis` field (`skills/glass-atrium-ops-orchestrator.md` → `#### Resilient Workflow Authoring [ORCHESTRATOR]` → **Shape-tolerant schema authoring**).
  - **Budget-guard idiom** — a hard tool-use ceiling with a stop-and-emit-partial instruction in the delegation prompt.
- **Machine-checked repetition** — paraphrase neither pin away:
  - `hooks/test/orchestrator-skill-schema-example.bats` requires `completion_block` as a declared, uncapped member inside this section's `AnalysisSchema` fence.
  - `hooks/test/workflow-gate-completion-channel.bats` replays the fence through the gate.

Copyable skeleton — every bound rendered into one bounded fan-out:

```js
// [SIZE-EST] reads~=8 fields=2 effort=medium scope=allowlist — bounded per-track analysis spawn
// [OWNERSHIP] trackA: hooks/** worktree: <path|isolated> · trackB: monitor/src/** worktree: <path|isolated> — disjoint read sets, existence-only
// per-track read allowlists — explicit + disjoint, one per [OWNERSHIP] track, never a repo sweep.
// `<…>` extents are substitution points: each example names a section of its own path, so change the extent whenever you change the path.
const READ_TRACKS = [
  { allowlist: [
      { path: 'hooks/enforce-workflow-verify-stage.sh', extent: '<extent — e.g. the token-grammar block only>' },
      { path: 'hooks/test/', extent: '<extent — e.g. the bats cases naming that hook>' },
    ], goal: 'trackA: audit the gate hook + its bats coverage' },
  { allowlist: [
      { path: 'monitor/src/server/routes/', extent: '<extent — e.g. handler signatures; a body only where a signature flags>' },
    ], goal: 'trackB: audit the monitor route surface' },
];
// Render guard — a legacy bare-string allowlist entry would render `undefined — undefined` silently.
const renderEntry = (a) => {
  if (!a || !a.path || !a.extent) throw new Error('READ_TRACKS entry must be { path, extent }: ' + JSON.stringify(a));
  return a.path + ' — ' + a.extent;
};
const budgetGuard =
  'Hard budget: about 15 tool uses. The terminal StructuredOutput is the deliverable, so keep enough budget to emit it. ' +
  'Read only the allowlist below, at the stated extent; no repo sweep; effort=medium (raise to high ONLY for narrow deep reasoning). ' +
  'Emit only the declared fields, none of them capped; write bulk evidence to a file and return its path in findings. ' +
  'When you near the budget, stop and emit a partial cited answer: a partial beats a lost one.';
// bounded schema: one free-text absorber + the completion channel, both uncapped (Absolute schema-cap rules)
const AnalysisSchema = { findings: 'string', completion_block: 'string' };
const results = await parallel(READ_TRACKS.map((t) =>
  robustAgent('glass-atrium-intel-researcher', {
    agentType: 'glass-atrium-intel-researcher',
    goal: budgetGuard + '\nREAD ALLOWLIST (path — extent; read no more of each): '
      + t.allowlist.map(renderEntry).join(' · ') + '\nTASK: ' + t.goal,
    effort: 'medium', schema: AnalysisSchema,
  })));
const findings = results.filter(Boolean); // dropped nulls = surfaced-incomplete, re-delegable
```
