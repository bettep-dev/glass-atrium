# Maintainer note — agents/glass-atrium-intel-planner.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `scripts/test/agent-frontmatter-identity.bats` | frontmatter `name` / `tools` / `scope` against the cycle base | pins identity only; body text is outside its parse |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys (name, tools, scope) | live edits to them are blocked for every caller (LLM06) |
| `autoagent/lib/editable_merge.py` | EDITABLE region count and order, local vs release | a count change routes the merge to the manual structural-change ceremony |
| `scripts/test/manifest-check-clean.bats` | the `manifest.json` hash entry for this path | any body edit needs a manifest regeneration — a whole-tree barrier, never run beside other writers |
| `hooks/validate-scope-drift.sh` | a plan's `<section id="target-files">` (HTML) or `## Target Files` (md) | the body's `### Target-Files Section` shape rules are what this parser reads in plans — load-bearing |
| `scripts/test/doctrine-budget-parity.bats` | `scoped/scope-report.md` + `scoped/scope-planning.md` only | never opens this body; the Pre-drawing decision core is a hand-synced copy no suite guards |

- Suites that name the agent in a roster or fixture read the NAME, never this body — for example:
  - `hooks/test/inject-scope-rules*.bats` · `hooks/test/enforce-*.bats`
  - `hooks/test/block-doc-routing-leak.bats` · `hooks/test/h2-untrusted-ingest.bats`
  - `hooks/test/workflow-gate-completion-channel.bats` · `hooks/test/workflow-gate-plan-stage.bats`
  - `scripts/test/test_inject_sync.py` · `autoagent/test/test_pre_verify_budget_injection.py`
- No suite checks that the body's headings still exist; the citers below are the only guard.

## Body text other files cite

- Headings and leads cited by name, so a rename edits every citer in the same pass:
  - `agents/glass-atrium-intel-reporter.md` (co-edit sets; `### Current-state only` cites `## Absolute Rules` as the canonical detector set and exception whitelist)
  - `scoped/scope-planning.md` and `scoped/maintainers/{scope-planning,scope-report,scope-dev,scope-qa,orchestrator-role,shared-authoring-hygiene}.md`
  - `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md` (`## Designer Handoff Contract`)
- The Current-State Only detector literals are machine-read patterns: never translate or reflow them.

## Register copies

The other copies of each `## Canonical & Mirror Register` row, edited together with the body section:

- **Three emission modes**: `scoped/scope-report.md` → `### Three emission modes`, a pointer · `scoped/scope-planning.md` → `## Output Format Routing [PLANNING]`, a pointer restating nothing.
- **Emission contract**: `scoped/scope-planning.md` → `## Output Format Routing [PLANNING]`, a pointer restating nothing · the reporter-side pair in `agents/glass-atrium-intel-reporter.md`.
- **HTML request test**: `scoped/scope-planning.md` → `## Output Format Routing [PLANNING]`, a pointer naming it · the orchestrator copy, `skills/glass-atrium-ops-orchestrator-role.md` → Exposure Determination plus `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md`.
- **Document lifecycle duties · Document stages and closing**: `scoped/scope-planning.md` → `## Output Format Routing [PLANNING]`, a pointer naming it.
- **Open Questions / claim marking**: `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]` quotes `[SELF-CHECKED:]`.
- **Ambiguity Gate**: axis set shared with `scoped/scope-dev.md`.
- **Designer Handoff Contract · indicator thresholds**: `scoped/scope-planning.md` → `## Designer Co-Emission Trigger [PLANNING]` (pointer) · reporter `## Designer Handoff Contract` · designer `## HTML Primary Co-Emission Role` (veto line) · `skills/glass-atrium-design-html-co-emission/SKILL.md`.
- **dev-front markup exception**: the judging half in `skills/glass-atrium-ops-orchestrator-role.md` → `#### Monitoring-phase notes` plus `deliverable-exposure.md` · `agents/glass-atrium-dev-front.md`.
- **Visual-Maximization Floor · Dark base default**: `scoped/scope-report.md` → `### Visual-Maximization Floor` + `### Dark base default`, pointers · `scoped/scope-planning.md` → `## Output Format Routing [PLANNING]` names the floor and carries no dark-base copy.
- **Pre-drawing decision core · adopted type set**: `scoped/scope-planning.md` (pointer); every member list is corrected against `diagram-types.json` (roster: `scoped/maintainers/scope-report.md` → **Mermaid adopted-set copies**).
- **D8 thresholds**: prose copies in `scoped/scope-report.md`, the reporter body and `scoped/scope-qa.md`; `scoped/scope-planning.md` → `## Output Format Routing [PLANNING]` names them as a pointer and states no number.
- **prefers-reduced-motion fallback**: copies across the UI-emitting DEV fleet, the design references and the DESIGN.md template.
- **Anti-slop patterns**: the `glass-atrium-design-anti-slop` skill · dev-front `### Anti-AI-Slop` subset · the `scoped/scope-report.md` residual supplement.

## Editor duties

- A D8 number changes in `d8-thresholds.json` first; a prose-only number edit in this body is forbidden.
- The body keeps no inline copy of the reporter's Canonical HTML Skeleton.
- Standing drift between this body and its canonicals is recorded at `scoped/maintainers/scope-report.md` → `## Standing drift reports (reported, not reconciled — the rule owner's call)`.
- Each on-request site states its own scope line; `### Default Plan Shape` keeps no list of the sites that prescribe those structures.
- The body carries no specs-first rule: the planner writes no code.
- `## Pre-Emission Verification Gate [PLANNING]` points at `### Verify Before You Assert` and keeps only the halt — no per-check table restating those bullets.
- `### Completion emit` restates neither the manual nor the schema placement rule (`core-outcome-record.md` owns them); it keeps the `task_type` choice, the after-POST timing and the no-`completion_block` fallback.
- The lifecycle copies omit the null-status-actor note and the chain-root file-count clause, as the scope-report canonical does; the file-count leg is the reviewer's half.
- An excluded-type diagram notice is not stored — `monitor/src/server/routes/clauded-docs.ts` → `logDiagramNotices`, `buildWriteResponse` are its only channels; a copy claiming persistence is wrong.
