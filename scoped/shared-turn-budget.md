# Turn-Budget Injection Text (Cross-Cutting Concern)

- Source file for the two marker blocks below, which the `inject-scope-rules.sh` SubagentStart hook extracts verbatim.
- Nothing else here is delivered, so a duty homed in this file reaches no agent.
- Policy SoT: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Turn Budget & Graceful Exit`.
  - A policy change lands there first, then is re-compressed by hand into the blocks below; no test checks this.

## Meter block (NOT sourced here yet — the third injected turn-budget text)

- The meter reaches every subagent at spawn from outside this file: `hooks/inject-scope-rules.sh` → `build_meter_block`.
- It delivers the 80%-ceiling / `needs_context` half of the discipline, so both blocks below omit that half.
- It is a `printf` shell literal: an edit to the policy section does not reach a running agent, and nothing greps it — this pointer keeps that copy visible from the corpus side.
- Keep no dormant second copy of the meter text here while it is unsourced.

## BUDGET-DEV block

- Injected to `BUDGET_DEV_AGENTS`.

<!-- BYTE-BUDGET: <=300 B hard, <=260 B target (nodrop.bats pins the source-contract); any rewording must re-run hooks/test/inject-scope-rules-nodrop.bats. -->
<!-- AGENT-INJECT:BUDGET-DEV:START -->
**Budget sizing (auto-injected DEV)**
- Estimate `tool_uses ~= files x 4.5`; >~30 → report to split before accepting.
- >4 files or >2 modules → stage 1-2 files at a time, verify each.
<!-- AGENT-INJECT:BUDGET-DEV:END -->

## BUDGET-ANALYSIS block

- Injected to `BUDGET_ANALYSIS_AGENTS`.

<!-- BYTE-BUDGET: <=364 B; any rewording must re-run hooks/test/inject-scope-rules-nodrop.bats. -->
<!-- AGENT-INJECT:BUDGET-ANALYSIS:START -->
**Budget sizing (auto-injected analysis)**
- Bound reads to an explicit allowlist (no repo sweep).
- Reserve the emit tail — `[COMPLETION]`/StructuredOutput is the deliverable.
- Broad scope (>~20 reads) or near the ceiling → stop, emit a partial cited result.
<!-- AGENT-INJECT:BUDGET-ANALYSIS:END -->
