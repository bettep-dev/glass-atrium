# Maintainer note — `scoped/scope-report.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Delivery status

Membership is not delivery. The Tier-2 stanza that used to head the rule file stated MEMBERSHIP only: no code selects a scope file by agent, so the file reaches glass-atrium-intel-reporter at no point in a spawn (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`, measured 2026-09-10). Nothing in it obliges the reporter directly; every duty binds through the copy in `agents/glass-atrium-intel-reporter.md`, and that body's own opening states the same fact to its reader.

Consequences a maintainer works from:

- A duty that must BIND the reporter has to live in the agent body. Homing it here and leaving a pointer in the body delivers the pointer and nothing else.
- A passage in the agent body that looks like a redundant mirror of this file is the agent's ONLY copy — never cut it on the grounds that this file carries it.

## Coupled readers

| Reader | Reads | Consequence of deleting what it reads |
|---|---|---|
| `scripts/test/doctrine-budget-parity.bats` | `## Pre-drawing Doctrine [REPORT]`, as the SoT it compares against the monitor sources | the suite reds — that section is machine-load-bearing in this file and cannot move here |
| `autoagent/daemon_cycle.py` | the whole file, excerpted as the C3 axis of the rule-improvement verify prompt | an empty file directs a `C3: FAIL` verdict; the agent→scope-file basename map also breaks if the file is renamed or moved out of `scoped/` |
| a maintainer syncing a delivered copy | the canonical text the agent-body copies derive from | the delivered copy loses its maintained source |
| a maintainer debugging a monitor 400 | the server-enforced facts (POST tuple, schema gates, column cap, threshold SoT) | the prose statement of what a POST is rejected for goes with it |

## Machine-read byte contract — `## Pre-drawing Doctrine [REPORT]`

`scripts/test/doctrine-budget-parity.bats` extracts the cap numbers, the warn/fail ratios and the size-preset class names from that section's own text and compares them against the monitor sources. What that makes byte-fragile:

- the heading must begin its line, and the suite reads from it to the next `##` heading — so no further `##` heading may be opened inside the section;
- the cap line and the band line each stay ONE line, keeping their `·` separators and their comparison glyphs; the suite's mutation row rewrites the first cap in place, so that line's `nodes` spelling is fixed too;
- the Budget step must keep naming a `content-budget.ts` path — a section naming none fails the cap and band rows rather than reading as parity against nothing;
- the preset class names are matched by prefix, so the section must not introduce a further token sharing `doc-diagram-`.

`agents/glass-atrium-intel-reporter.md` → `### Visual-Maximization Floor` restates literals the parity suite does NOT read on the body side, so a value changed in the doctrine must be changed there by hand.

## Server-enforced schema gates (they bind no agent; reader is the monitor maintainer)

Source: `monitor/src/server/clauded-docs/html-validator.ts`.

- **Gate 1 — HTML5 baseline** → code `html_structure_invalid`, whose response names the missing fields. `html_body` must carry a doctype · an `<html>` root · a NON-EMPTY `<title>` · a `<body>` · ≥1 semantic landmark (`<main>`/`<article>`/`<section>`) · ≥1 heading · a `<meta charset>`. `<meta viewport>` is NOT checked — the server re-injects charset and viewport on GET. The dark-base skeleton already carries every checked element.
- **Gate 2 — D8 column cap** → comparison tables ≤5 columns enforced server-side, not only by reviewer judgment; a multi-config table over the cap is split per config. Violation → code `d8_p2_violation`.

## Co-edit rosters (what moves together when a rule changes)

| Rule text | Copies that must change with it |
|---|---|
| Three emission modes | `agents/glass-atrium-intel-reporter.md` → `## Output Format Routing` · `agents/glass-atrium-intel-planner.md` → `### Three emission modes (evaluate in order)` |
| HTML request test | `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test (explicit-request-only — heuristic auto-HTML FORBIDDEN)` · `agents/glass-atrium-intel-planner.md` → `### HTML request test (explicit-request-only — heuristic auto-HTML FORBIDDEN)` · `rules/glass-atrium/orchestrator-role.md` → `#### Deliverable exposure and designer composition (Decision phase)`, not canonical yet the one copy reaching every subagent |
| Visual-Maximization Floor | `agents/glass-atrium-intel-reporter.md` → `### Visual-Maximization Floor` (authoring canonical) · `agents/glass-atrium-intel-planner.md` → `### Visual-Maximization Floor — Baseline (always)` and `### Visual-Maximization Floor — Content-driven escalation` |
| Dark base default | `agents/glass-atrium-intel-reporter.md` → `### Dark Theme & Typography (MUST)` · `agents/glass-atrium-intel-planner.md` → `### Dark base, typography and status vocabulary` |
| Emission contract / POST tuple | `agents/glass-atrium-intel-reporter.md` → `### POST tuple + copy-paste curl` · `agents/glass-atrium-intel-planner.md` → `### Emission contract (POST tuple)`; the authority is the route source `monitor/src/server/routes/clauded-docs.ts`, not any prose copy |
| `[DOC-ROUTE]` stamp | `agents/glass-atrium-intel-reporter.md` → `## Output Format Routing`, the exception clause inside the turn-0 routing hard gate · `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`, the same clause · delegation-side canonical `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria` |
| Document lifecycle | `agents/glass-atrium-intel-reporter.md` → the bolded lead `**Document lifecycle duties — you are the completing agent and you own these:**` · `agents/glass-atrium-intel-planner.md` → `### Document lifecycle duties (delivered copy — the completing agent owns these)` |
| D8 requirement list | `agents/glass-atrium-intel-reporter.md` → `### Pre-Emission HTML Validation (D8 + Schema)`, the maintained source · `agents/glass-atrium-intel-planner.md` → `## Pre-Emission Verification Gate [PLANNING]` · `scoped/scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` |
| Diagram Standard runtime-load contract | `agents/glass-atrium-intel-reporter.md` → `### Sandbox-Safe Interactivity (MUST)` · `agents/glass-atrium-intel-planner.md` → `### Pre-Emission HTML Gates (user-requested HTML primary only)` |
| Pre-drawing Doctrine numbers | `agents/glass-atrium-intel-reporter.md` → `### Visual-Maximization Floor` (hand-synced, unjudged by the suite) |
| Designer Co-Emission Trigger | both author bodies' `## Designer Handoff Contract` · `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` · `skills/glass-atrium-design-html-co-emission/SKILL.md` · `rules/glass-atrium/orchestrator-role.md` → Visual-Weight Probe |
| D8 numeric thresholds | none in prose — `monitor/src/server/clauded-docs/d8-thresholds.json` is the authority and every prose number is a mirror |

## Standing drift reports (reported, not reconciled — the rule owner's call)

- The planning-side visual mirrors compressed away the `light-default-body` prohibition list, the HTML-comment-dropped-pre-scan carve-out, the OKLCH 2-tier token requirement and the `oklch` background option. Those mirrors were deleted from `scoped/scope-planning.md` in this pass, so the drift now sits between `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec (applies to user-requested HTML primary)` and the reporter body's authoring canonical.
- The anti-slop SoT (`agents/glass-atrium-design-designer.md`) and its mechanical detector (`skills/glass-atrium-design-anti-slop/SKILL.md`) are drifted in both directions: the detector carries patterns the SoT never adopted, including a pure-white-on-dark numeric floor with no canonical home, and omits the SoT's mixed-radius and workflow entries.
- The `prefers-reduced-motion` fallback is canonical at `agents/glass-atrium-dev-front.md` → `### prefers-reduced-motion (canonical SoT)`, which additionally forbids a hard cut; copies spread across the UI-emitting DEV fleet, the design references and the DESIGN template, some omitting that prohibition. No roster is kept, because the set grows with the fleet.

## Restructure + diet pass (this wave)

The rule file keeps the two rules no body carries, the sections a live suite or a Tier-1 pointer reads, and one pointer per externally-cited heading. No before/after character count is recorded here: a measured size drifts on the very next edit, and this note is read long after that edit.

- **Kept as sole copies**: the `URL + collected_at(YYYY-MM-DD)` citation format (`collected_at`: 0 hits across `agents/*.md`) and the residual anti-slop patterns (`background-clip`, `lavender`, `grid-cols-3`: 0 hits across `agents/*.md`, and self-declared absent from the designer SoT).
- **Kept because a Tier-1 pointer lands there**: `### Emission contract` — `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → Monitor address sends every agent here for "what to POST and when", and `rules/glass-atrium/core-git-workflow.md` → Pull Requests sends a reviewer here for the single-HTML-no-MD-companion storage model.
- **Kept because a live pointer calls this file the canonical for it**: `## Diagram Standard [REPORT]` ban/allow list, `## Report Structure [REPORT]`, `## Self-Evaluation Obligation [REPORT]`, `### Document Lifecycle`, `### Threshold SoT`, the T1-T5 table. Each was compressed to the operative statement; the rationale prose (R2/R3 rejection reasoning, the Mermaid rationale trio, the trigger-path steps) was dropped as duplicated in the bodies that act on it.
- **Dropped as duplicated in the delivered body**: the BASELINE requirement list, the d8 validator-safe color rule, the content-driven escalation, the dark-base detail, the D8 requirement list, the agent-only record authoring guide, the HTML-primary requirement list, and the branching-order MUST. Each is verbatim-equivalent in `agents/glass-atrium-intel-reporter.md`, which is the only copy the reporter reads.
- **Dropped as a stated contradiction**: the unconditional "Summary table REQUIRED" absolute, which the same file contradicted further down with the agent-only exemption. The rule now stands once, in the body, at the place the exemption qualifies it.
- **Moved here**: the delivery-status section, the coupled-readers table, the `Copies of … all in agreement` rosters now held by `## Co-edit rosters (what moves together when a rule changes)`, the machine-checked notices, the server-400 gate list and the standing drift reports.

## Landed this pass (each was an open pointer or a reported divergence)

**Dead mirrors repointed.** Five `agents/glass-atrium-intel-reporter.md` co-edit leads named `scoped/scope-planning.md` mirrors that file does not carry; it holds no `###` heading at all, so each was a zero-hit citation sitting inside a delivered body. Every one now names the planner-body section that holds the live copy, and the `## Co-edit rosters (what moves together when a rule changes)` rows above name the same headings.

| Co-edit lead | Section it now names in `agents/glass-atrium-intel-planner.md` |
|---|---|
| `Co-edit set for this mode table —` | `### Three emission modes (evaluate in order)` |
| `Co-edit set for the tuple —` | `### Emission contract (POST tuple)` |
| `Co-edit set for this test —` | `### HTML request test (explicit-request-only — heuristic auto-HTML FORBIDDEN)` |
| `Co-edit set for the dark-base default —` | `### Dark base, typography and status vocabulary` |
| `Co-edit set for the runtime-load contract —` | `### Pre-Emission HTML Gates (user-requested HTML primary only)` |

- **Two further dead `scoped/scope-planning.md` references in the same body went with them**, both the same zero-hit class rather than a separate defect: the `## Machine-Read Structure` consumer table listed that file among the files quoting this body's heading names (it names this agent nowhere), and the anti-slop co-edit cluster claimed a pointer there (that file carries no anti-slop text at all).
- **Both agent-body pointers into this note are gone**, honouring `## Companion-citation convention (corpus-wide, stated in every companion)`: the `Co-edit set for the D8 requirement list —` lead dropped its roster-row pointer and keeps the copies it already enumerates inline, and the reporter's `### Visual-Maximization Floor` two-axes paragraph now states the planner-side drift in its own words rather than naming `## Standing drift reports (reported, not reconciled — the rule owner's call)`.
  - The linkage is not lost, it is recorded here: that roster row and that drift report are the maintainer-side record for both passages.
  - **The removals were a pre-manifest precaution, not a standing rule against a delivered body citing a companion.** The stated ground — that the target resolves to nothing on a live install — expires with the commit that stages the companions and regenerates the manifest in one unit.
  - What keeps them removed afterwards is that convention's citation economy, not non-resolution; its HTML-comment bullet is why `agents/GLASS_ATRIUM_GLOBAL_RULES.md` keeps its opening `<!-- MAINTAINER:` comment naming a companion.
- **The reporter body heading `### Visual-Maximization Floor` was shortened** out of its parenthesised authoring-detail form, so nothing resolves against it by prefix. Its citers now match it byte for byte: `scoped/scope-report.md` → `### Visual-Maximization Floor`, the `Visual-Maximization Floor` and `Pre-drawing Doctrine numbers` roster rows above, and this note's machine-read byte-contract section where it names that body section as the hand-synced restatement.
  - The scope and policy-SoT facts the long heading carried were already stated in the section's own opening paragraphs, so shortening dropped no rule.
- **The `[DOC-ROUTE]` divergence between the two delivered author bodies is closed.** The reporter's turn-0 gate refused an orchestrator-supplied local target unconditionally while the planner's gate carried the stamped exception, so one rule read two ways depending on which agent was spawned; the reporter gate now carries the same exception lead and the same `What the stamp attests` / `Absent the stamp` pair.
  - Watch this one on every future edit to either gate: the new `[DOC-ROUTE]` stamp roster row above is what makes the third site — the delegation-side canonical the stamp is authored at — visible from here.

## Open pointers this pass did not repair (owners are outside its scope)

- `agents/glass-atrium-intel-reporter.md` → `## Agent-Only Record Authoring Contract (token-optimized format)` and `### Cross-references and completion record` cite a `scoped/scope-report.md` "reference-document authoring guide".
  - This file carries no section of that name; the live text is that body's own Agent-Only Record Authoring Contract.
- `agents/glass-atrium-design-designer.md` → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` names `scoped/scope-planning.md` → `### Visual-Maximization Floor`, absent from that file.
  - Repair when the designer body is next touched: name `scoped/scope-report.md` → `### Visual-Maximization Floor`, which is where the residual-pattern supplement actually lives, and drop the planning half.
- Neither is repaired by pointing the citing line at this note: an agent body never cites a companion, so the repair target is a heading inside a rule file or inside the delivered body itself.

## Follow-up the rule file cannot discharge

The citation format and the residual anti-slop patterns bind nobody until they are authored into `agents/glass-atrium-intel-reporter.md`. Suggested homes: the citation format under `## Content Quality Bars`; the residual patterns beside the prohibited-pattern pointer that already sits at the body's anti-slop bullet, which today names the SoT and this file's supplement without carrying either list.
