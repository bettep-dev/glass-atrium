# Maintainer note — `scoped/scope-planning.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Delivery status

Membership is not delivery. No code selects a scope file by agent, so this file reaches glass-atrium-intel-planner at no point in a spawn (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`, measured 2026-09-10). Every duty binds through the copy in `agents/glass-atrium-intel-planner.md`.

- A duty homed only here binds nobody at run time — it must ALSO live in the agent body.
- Never cut a planner-body passage as a duplicate of this file: that body copy is the only one the agent reads.
- A heading here that states no rule is a signpost kept for the files that cite it by name, not a stub to re-fill with duty text.

## What this file is, and is not

- **Is**: the canonical for a narrow planning-only core — the Ambiguity Gate's planning-side axis statement, and the claim-marking tag literals.
- **Is not**: the canonical for HTML emission, visual, diagram or document-lifecycle rules. `scoped/scope-report.md` is, and it says so at each of those headings. This file no longer mirrors them: a mirror of a canonical a maintainer can read directly binds nobody at run time and costs one more place to edit.

## Coupled readers

| Reader | Reads | Consequence of breaking it |
|---|---|---|
| `scripts/test/doctrine-budget-parity.bats` | `## Pre-drawing Doctrine [PLANNING]` — the heading, a NON-EMPTY body, the literal `scope-report.md` in it, and any cap it restates | an absent or emptied section reds the row; a restated cap that diverges from the report SoT reds it too |
| `autoagent/daemon_cycle.py` | the whole file, excerpted as the C3 axis of the rule-improvement verify prompt | an empty file directs a `C3: FAIL` verdict; the agent→scope-file basename map also breaks if the file is renamed or moved out of `scoped/` |
| `scoped/maintainers/scope-dev.md` | `## Ambiguity Gate [PLANNING]`, asserted to restate the six weighted axes | the assertion goes stale |
| `agents/glass-atrium-intel-planner.md` co-edit map | `## Claim Marking & Consultation [PLANNING]` and `## Ambiguity Gate [PLANNING]` by name | the body's maintained source disappears |

## Co-edit rosters (what moves together when a rule changes)

| Rule text | Copies that must change with it |
|---|---|
| No code in plans | `agents/glass-atrium-intel-planner.md` → `## Design Expression Rules (No Code — Zero Tolerance)`, the stronger copy: it carries the detector patterns and the Mermaid carve-out |
| Ambiguity Gate axes | axis canonical `scoped/scope-dev.md` → Ambiguity Gate · delivered `agents/glass-atrium-intel-planner.md` → `## Pre-Execution Verification [PLANNING]` — a weight changed in one is hand-carried into two others |
| Claim-marking tag literals | delivered `agents/glass-atrium-intel-planner.md` → `## Open Questions Section (plan body slot)` · reviewer-side consumer `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]`, which quotes `[SELF-CHECKED:]` |
| `[DOC-ROUTE]` stamp | delivered `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`, the exception clause inside the turn-0 gate · delegation-side canonical `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria` · the static gate `hooks/enforce-workflow-verify-stage.sh`, which scans workflow scripts and never this file |
| Pre-drawing doctrine, designer trigger, emission routing | `scoped/scope-report.md` is canonical for all three; the planner's own copies are `## Visual Design Spec (applies to user-requested HTML primary)`, `## Designer Handoff Contract` and `## Output Format Routing` |

## Restructure + diet pass (this wave)

- **Kept as sole copies**: the self-settle-before-consult ordering, the `needs_domain_consult` route and the pre-commitment against the Open Questions mechanism's own growth. Each returns 0 hits in `agents/glass-atrium-intel-planner.md`.
- **Kept because a named reader resolves into it**: the six weighted axes (asserted by `scoped/maintainers/scope-dev.md`), the two tag literals (the body's co-edit map), and the `## Pre-drawing Doctrine [PLANNING]` pointer (the parity suite).
- **Kept because the heading names the content beneath it**: `## Absolute Rules [PLANNING]`. No citer forces that name; the rule file points at `core-compliance-matrix.md` → `## Precedence Resolution` for the precedence order, not the reverse.
- **Dropped as duplicated in the delivered body**: the score–evidence consistency rule, the EARS acceptance-criteria format with its worked Good/Bad pair, the confidence-tiered bands with the `[DRAFT: clarify before DEV]` literal, the Open-Questions entry shape, the empty-section rule, the self-settle tool list, the forbidden-self-spawn bullet (also Tier-1 `core-security.md` and the orchestrator's MAX_DEPTH rule) and the honest-backing bullet. Each is verbatim-equivalent or stronger in `agents/glass-atrium-intel-planner.md`.
- **Dropped as a six-label skeleton**: the Pre-drawing decision steps, which carried the labels without the literals. The step names survive as one line; the literals live at `scope-report.md` → `## Pre-drawing Doctrine [REPORT]` and in the planner body.
- **Moved here**: the delivery-status section, the coupled-reader list, the pointer apparatus of `## Output Format Routing [PLANNING]` and `## Designer Co-Emission Trigger [PLANNING]`, the co-edit rosters, and the machine-checked-pointer notices.
- **Dropped as duplicated in the delivered body — the `[DOC-ROUTE]` exception**: `agents/glass-atrium-intel-planner.md` → `## Output Format Routing` carries the same `What the stamp attests` / `Absent the stamp` pair, states the exception as the stamped evidence for the gate's own default, and adds that delegation phrasing never substitutes for the stamp.
  - The rule-file copy was the weaker of the two and reached no agent; what survives under `## Output Format Routing [PLANNING]` is the preamble pointer into that body.
  - The stamp's full linkage — delivered copy, delegation-side canonical, static gate — is the `[DOC-ROUTE]` stamp row of `## Co-edit rosters (what moves together when a rule changes)` above, which never listed the rule file.

## `needs_domain_consult` — decision recorded

Kept, with its honest backing stated at the bullet. Tree-wide, the token appears in this file alone: `agents/glass-atrium-intel-planner.md` never emits it, and `rules/glass-atrium/orchestrator-role.md` carries no Monitoring-phase duty to consume it, unlike the `needs_devfront_markup:` precedent it was modelled on. Deleting it would remove the design rather than the defect, so it stays on record and the rule file says the route does not work today.

Two edits would make it live, and neither is in this pass's scope:

- `agents/glass-atrium-intel-planner.md` — an emit duty beside the existing `needs_devfront_markup:` signal in `## Designer Handoff Contract`.
- `rules/glass-atrium/orchestrator-role.md` → `#### Monitoring-phase notes` — a consuming judgment beside the dev-front markup one, which is where the precedent already sits.

## Pointers into the removed mirrors — repaired

This file stopped mirroring the report-side canonicals, and the sites still calling it a mirror have now been repaired. The repair REPOINTS rather than deletes: the sections named below are pointer prose in this file that names the report headings, so the co-edit edge is live — rename a heading in `scope-report.md` and this file's pointer text goes stale with nothing to catch it. Deleting the entries would hide that edge.

- `agents/glass-atrium-intel-planner.md` → `## Canonical & Mirror Register`: the rows for three emission modes / emission contract, HTML request test, document lifecycle duties, D8 thresholds and visual-maximization floor / dark base default now name `## Output Format Routing [PLANNING]` as a pointer; the designer-handoff row names `## Designer Co-Emission Trigger [PLANNING]`, which always resolved — only the word mirror was wrong.
- The visual-floor row additionally states that this file carries no dark-base copy in any form, so the entry cannot be read as a second copy.
- `skills/glass-atrium-ops-orchestrator.md`: the lifecycle-SoT bullet and the completing-agent bullet name the same pointer section. The `[DOC-ROUTE]` paragraph's mirror clause was DROPPED instead — its claimed counterpart, the delegation-phrasing sentence, has no match in this file at HEAD, so there was no pointer left to name.
- `rules/glass-atrium/core-git-workflow.md` → `## Pull Requests`: the `scope-planning.md` half of the `.html`-deliverable bullet was dropped, the citation being to an Emission contract only `scope-report.md` carries. That file is Tier 1 and reaches every agent, which is why the half was removed rather than softened.
- `skills/glass-atrium-design-contrast-check/SKILL.md`: the `scope-planning.md` half of its `### Dark base default` cross-reference was dropped on the same ground.
- The two rows naming this file as CANONICAL — Open Questions / claim marking, and Ambiguity Gate — are correct and unchanged.
- The row for the dev-front markup exception names `## Designer Co-Emission Trigger [PLANNING]`, which resolves, and was left as it stands.
- The same class in `agents/glass-atrium-intel-reporter.md` and `agents/glass-atrium-design-designer.md` is recorded by `scoped/maintainers/scope-report.md` rather than here.

## The eleven headings the cut removed — the answer is citer repair, not restore

`32a0685` removed eleven headings from the rule file, and they are recoverable from the commit rather than from any surviving audit: Output Policy [PLANNING] · Three emission modes · HTML request test · HTML primary requirements · Visual-Maximization Floor · Dark base default · HTML Visual Decision Requirements (D8) · Threshold SoT · Emission contract · Document Lifecycle · Diagram Standard [PLANNING].

- Every one of them was a MIDDLE copy — between a canonical a maintainer reads directly at `scoped/scope-report.md` and a delivered copy the planner applies in its own body. Restoring any of them re-creates a drift pair in a file no agent reads.
- The defect they left is the dangling pointers, not lost text, so repairing the citing sites discharges it in full. Read the eleven as REPOINTED, never as an unexplained shortfall in a restore count.
- The repaired sites are the ones listed in the section above.

## Leave-deleted verdicts here are dated, not closed

Every leave-deleted verdict in this companion reasons from the measured fact recorded under `## Delivery status` — that a `scoped/` body reaches no agent at spawn. That premise is scheduled to go false when split injection lands.

- Read the leave-deleted set as decided under the CURRENT delivery regime and re-litigable once the regime changes — never as settled.
- Relocating a duty into an agent body to route around the premise stays FORBIDDEN: it manufactures the body-versus-rule-file drift this epic exists to end.
