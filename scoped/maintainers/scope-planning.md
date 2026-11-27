# Maintainer note — `scoped/scope-planning.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Delivery status

- The rule file reaches glass-atrium-intel-planner whole at spawn through the part slots, selected by its `agent-registry.json` row (`rules.scope`).
  - Mechanism: `rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`.
  - `scoped/scope-report.md` is not in that row.
- A planner-body passage restating a rule-file duty is a redundant mirror — reduce it to a pointer plus the planner-only delta, the shape the body's Ambiguity Gate and claim-marking passages carry.
- A planner-body copy of a report-side canonical is the copy the planner applies — never cut it as a duplicate of `scoped/scope-report.md`.
- A rule-file heading that states no rule is a signpost kept for the files that cite it by name, not a stub to re-fill with duty text.

## What this file is, and is not

- **Is**: the canonical for a narrow planning-only core — the Ambiguity Gate's planning-side axis statement and the claim-marking tag literals.
- **Is not**: a mirror of the report-side emission, visual, diagram or document-lifecycle rules; the rule file's preamble names where each one's canonical is listed.
  - Why: the planner already applies its body copies, so a mirror restates them to the same reader and adds one more place to edit.

## Coupled readers

| Reader | Reads | Consequence of breaking it |
|---|---|---|
| glass-atrium-intel-planner, at spawn | the whole file, as its Tier-2 rule text | the rule leaves the planner's context |
| `scripts/test/doctrine-budget-parity.bats` | `## Pre-drawing Doctrine [PLANNING]`: heading, non-empty body, the literal `scope-report.md`, any restated cap | an absent or emptied section reds the row; a restated cap diverging from the report SoT reds it too |
| `autoagent/daemon_cycle.py` | the whole file, excerpted as the `C3` axis of the rule-improvement verify prompt | an empty file directs `C3: FAIL`; a rename or a move out of `scoped/` breaks its agent→scope-file map |
| `scripts/agent_lifecycle/registry_ops.py` | the path, as the PLANNING scope file | a rename or move breaks its scope→file map |
| `scoped/maintainers/scope-dev.md` | `## Ambiguity Gate [PLANNING]`, asserted to restate the six weighted axes | the assertion goes stale |
| each heading pointer in `agents/`, `scoped/`, `skills/` or `rules/` (bare grep: `scope-planning.md`) | a rule-file heading, by name | a rename leaves each pointer resolving to nothing |

## Co-edit rosters (what moves together when a rule changes)

- **No code in plans**: `agents/glass-atrium-intel-planner.md` → `## Design Expression Rules (No Code — Zero Tolerance)`, the stronger copy — it carries the detector patterns and the Mermaid carve-out.
- **Ambiguity Gate axes**: axis canonical `scoped/scope-dev.md` → Ambiguity Gate — a weight changed there is hand-carried into the rule file; the planner body points at the rule file and restates no weight.
- **Claim-marking tag literals**:
  - reviewer-side consumer `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]`, which quotes `[SELF-CHECKED:]`;
  - `agents/glass-atrium-intel-planner.md` → `## Open Questions Section (plan body slot)`, which points at the rule file and carries `[UNCHECKED: …]` only inside its entry shape.
- **`[DOC-ROUTE]` stamp** — the rule file holds no copy:
  - delivered copy: `agents/glass-atrium-intel-planner.md` → `### Turn-0 routing hard gate`, the stamp table and the `The stamp attests` bullet;
  - delegation-side canonical: `skills/glass-atrium-ops-orchestrator-role.md` → `## Delegation Criteria`;
  - static gate: `hooks/enforce-workflow-verify-stage.sh`, which scans workflow scripts and never this file.
- **Pre-drawing doctrine, designer trigger**: canonical `scoped/scope-report.md` → `## Pre-drawing Doctrine [REPORT]` and `## Designer Co-Emission Trigger [REPORT]`.
  - The planner's own copies: `### Pre-drawing decision core (delivered copy — apply to EVERY Mermaid block, not only the first)` and `## Designer Handoff Contract`.
- **Emission routing**: canonical per row of `agents/glass-atrium-intel-planner.md` → `## Canonical & Mirror Register`; the planner's own copy is `## Output Format Routing`.
- **Report-side heading renames**: the rule file's pointer prose names `scoped/scope-report.md` headings, so a rename there edits that prose in the same pass.
  - The parity suite checks only the literal `scope-report.md`, so nothing else catches a stale heading name.

## Restructure + diet pass — dispositions

- **Kept as sole copies**: the self-settle-before-consult ordering, the `needs_domain_consult` route and the pre-commitment against the Open Questions mechanism's own growth — none has a copy in `agents/glass-atrium-intel-planner.md`.
- **Kept because a named reader resolves into it**:
  - the six weighted axes (asserted by `scoped/maintainers/scope-dev.md`);
  - the two tag literals (the planner body's `## Canonical & Mirror Register` row);
  - the `## Pre-drawing Doctrine [PLANNING]` pointer (the parity suite);
  - `## Absolute Rules [PLANNING]` (the planner body's `## Design Expression Rules (No Code — Zero Tolerance)` cites it by name).
    - Its preamble points at `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution` for the precedence order, not the reverse.
- **Dropped as duplicated in the planner body** — each verbatim-equivalent or stronger in `agents/glass-atrium-intel-planner.md`:
  - the score–evidence consistency rule · the EARS acceptance-criteria format with its worked Good/Bad pair · the confidence-tiered bands with the `[DRAFT: clarify before DEV]` literal
  - the Open-Questions entry shape · the empty-section rule · the self-settle tool list · the honest-backing bullet
  - the `[DOC-ROUTE]` exception — `### Turn-0 routing hard gate` carries it, adding that delegation phrasing never substitutes for the stamp.
- **Dropped with no planner-body copy — the forbidden-self-spawn bullet**: the prohibition is structural, since the planner's frontmatter `tools:` grants no `Agent` tool.
- **Dropped as a six-label skeleton**: the Pre-drawing decision steps, which carried the labels without the literals.
  - The step names survive as one line; the literals live at `scope-report.md` → `## Pre-drawing Doctrine [REPORT]` and in the planner body.
- **Dropped as middle copies — the report-side headings**:
  - Output Policy [PLANNING] · Three emission modes · HTML request test · HTML primary requirements · Visual-Maximization Floor · Dark base default · HTML Visual Decision Requirements (D8) · Threshold SoT · Emission contract · Document Lifecycle · Diagram Standard [PLANNING].
  - Each sat between the `scoped/scope-report.md` canonical and the planner's body copy; restoring one re-creates a drift pair.
  - A citer still naming one is repointed to a surviving pointer or to its `scoped/scope-report.md` canonical, never answered by a restore.

## `needs_domain_consult` — decision recorded

- Kept as a design on record: the rule file's honest-backing sub-bullet says the route does not work today, and deleting the bullet would remove the design rather than the defect.
- These edits make it live, modelled on the `needs_devfront_markup:` precedent; neither belongs to a diet pass:
  - `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract` — an emit duty beside the existing `needs_devfront_markup:` signal.
  - `skills/glass-atrium-ops-orchestrator-role.md` → `#### Monitoring-phase notes` — a consuming judgment beside the dev-front markup one.

## Leave-deleted verdicts here are dated, not closed

- The leave-deleted verdicts in this note were decided while a `scoped/` body reached no agent at spawn; `## Delivery status` records that premise false now, so each is open to re-check.

| Surviving copy of a deleted passage | Verdict |
|---|---|
| reaches the planner — its body or the rule file | stays deleted: restoring it restates that copy to the same reader |
| only in a file outside the planner's row (`scoped/scope-report.md` included) | re-opens: restore it in the rule file, or confirm a planner-body copy |

- Relocating a duty into the agent body to route around delivery stays forbidden: it manufactures body-versus-rule-file drift.
