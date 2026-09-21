# Turn-Budget Injection Text (Cross-Cutting Concern)

Source file for the two marker blocks below, which the `inject-scope-rules.sh` SubagentStart hook extracts verbatim. Nothing else here is delivered, so a duty homed in this file reaches no agent. The policy SoT is `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Turn Budget & Graceful Exit`: a policy change lands there first and is then re-compressed into the blocks below by hand, an obligation no test checks.

## Meter block (NOT sourced here yet — the third injected turn-budget text)

A third turn-budget text reaches every subagent at spawn and is not in this file: the meter, `hooks/inject-scope-rules.sh` → `build_meter_block`. It delivers the 80%-ceiling / `needs_context` half of the discipline, which is exactly why both blocks below omit that half. It is a `printf` literal in shell, so an edit to the policy section does not reach a running agent and nothing greps a shell literal — this pointer is what makes that copy visible from the corpus side. Do not park a dormant second copy of the meter text here while it is unsourced.

## BUDGET-DEV block

Injected to `BUDGET_DEV_AGENTS`. Sizing-only on purpose — the non-droppable meter block already carries the ceiling half on every spawn.

<!-- BYTE-BUDGET: this injected block feeds inject-scope-rules.sh — <=300 B hard, <=260 B target (nodrop.bats pins the source-contract); any rewording must re-run hooks/test/inject-scope-rules-nodrop.bats. -->
<!-- AGENT-INJECT:BUDGET-DEV:START -->
**Budget sizing (auto-injected DEV · full: `~/.glass-atrium/scoped/shared-turn-budget.md`)**
- Estimate `tool_uses ~= files x 4.5`; >~30 → report to split before accepting.
- >4 files or >2 modules → stage 1-2 files at a time, verify each.
<!-- AGENT-INJECT:BUDGET-DEV:END -->

## BUDGET-ANALYSIS block

Injected to `BUDGET_ANALYSIS_AGENTS`, a roster with no DEV member. It carries the analysis bullet — allowlist reads · reserve the emit tail · partial on ceiling — and omits the ceiling rationale for the same reason as BUDGET-DEV.

<!-- BYTE-BUDGET: this injected block feeds inject-scope-rules.sh — <=364 B; any rewording must re-run hooks/test/inject-scope-rules-nodrop.bats. -->
<!-- AGENT-INJECT:BUDGET-ANALYSIS:START -->
**Budget sizing (auto-injected analysis · full: `~/.glass-atrium/scoped/shared-turn-budget.md`)**
- Bound reads to an explicit allowlist (no repo sweep); reserve the emit tail — `[COMPLETION]`/StructuredOutput IS the deliverable.
- Broad scope (>~20 reads) or near the ceiling → STOP, emit a partial cited result.
<!-- AGENT-INJECT:BUDGET-ANALYSIS:END -->
