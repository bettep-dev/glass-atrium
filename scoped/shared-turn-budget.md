# Turn-Budget Injection Text (Cross-Cutting Concern)

Single-source SoT for the INJECTED turn-budget discipline TEXT — the two marker blocks below, delivered by the `inject-scope-rules.sh` SubagentStart hook. Policy SoT is `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Turn Budget & Graceful Exit`; this file owns only the compressed injection variants, never the policy — a policy change lands there first, then is manually re-compressed here (sync is a manual obligation, not a mechanically enforced guarantee).

## Rosters (delivery — `hooks/inject-scope-rules.sh`)

- `BUDGET_DEV_AGENTS` (9) = DEV(13) − daemon-carrier exclusions {glass-atrium-dev-nestjs, glass-atrium-dev-python, glass-atrium-dev-react, glass-atrium-dev-shell}. The four carriers keep daemon-evolved in-body budget bullets (the daemon rewrites agent BODIES, never hook sources) — injecting on top would double-deliver.
- `BUDGET_ANALYSIS_AGENTS` (6) = glass-atrium-intel-planner, glass-atrium-intel-reporter, glass-atrium-qa-code-reviewer, glass-atrium-design-designer, glass-atrium-meta-agent, glass-atrium-wiki-curator (glass-atrium-intel-researcher excluded — carrier).

## BUDGET-DEV block

> The block below (between the `AGENT-INJECT:BUDGET-DEV` markers) is extracted verbatim by the `inject-scope-rules.sh` SubagentStart hook and injected into the `BUDGET_DEV_AGENTS` roster. It is sizing-only ON PURPOSE: the 80%-ceiling / `needs_context` half of the canonical discipline is intentionally OMITTED — the non-droppable turn-budget meter block already delivers it on every spawn, so restating it here would be intra-assembly duplication. The marker name differs from every other `AGENT-INJECT` block so the sed ranges never collide.

<!-- BYTE-BUDGET: this injected block feeds inject-scope-rules.sh — <=300 B hard, <=260 B target (nodrop.bats pins the source-contract); any rewording must re-run hooks/test/inject-scope-rules-nodrop.bats. -->
<!-- AGENT-INJECT:BUDGET-DEV:START -->
**Budget sizing (auto-injected DEV · full: `~/.glass-atrium/scoped/shared-turn-budget.md`)**
- Estimate `tool_uses ~= files x 4.5`; >~30 → report for decomposition before accepting.
- >4-file or >2-module work → stage 1-2 files at a time, verify each.
<!-- AGENT-INJECT:BUDGET-DEV:END -->

## BUDGET-ANALYSIS block

> The block below (between the `AGENT-INJECT:BUDGET-ANALYSIS` markers) is extracted verbatim by the same hook and injected into the `BUDGET_ANALYSIS_AGENTS` roster. It mirrors the canonical analysis bullet (allowlist reads · reserve the emit tail · partial-on-ceiling) in full — analysis-consumer assemblies are small, so no compression beyond the byte contract is needed.

<!-- BYTE-BUDGET: this injected block feeds inject-scope-rules.sh — <=364 B; any rewording must re-run hooks/test/inject-scope-rules-nodrop.bats. -->
<!-- AGENT-INJECT:BUDGET-ANALYSIS:START -->
**Budget sizing (auto-injected analysis · full: `~/.glass-atrium/scoped/shared-turn-budget.md`)**
- Bound reads to an explicit allowlist (no repo sweep); reserve the emit tail — the final `[COMPLETION]`/StructuredOutput IS the deliverable.
- Broad scope (>~20 reads) or near the 80% ceiling → STOP, emit a partial cited result (a partial beats a lost run).
<!-- AGENT-INJECT:BUDGET-ANALYSIS:END -->
