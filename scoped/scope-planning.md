# PLANNING Scope Rules

Canonical rule text for the PLANNING scope (glass-atrium-intel-planner). The report-side emission, visual and diagram rules enter at `scoped/scope-report.md`, but not every one is canonical there. Each rule's canonical, and where the planner applies it: `agents/glass-atrium-intel-planner.md` → `## Canonical & Mirror Register`.

Maintainer material — co-edit rosters, delivery status and the machine-read pointer contract — is in `scoped/maintainers/scope-planning.md`.

## Absolute Rules [PLANNING]

Final authority on an ambiguous PLANNING rule is this file, whole; this section concentrates that authority rather than narrowing it to itself. Corpus-wide precedence order: `rules/glass-atrium/core-compliance-matrix.md` → `## Precedence Resolution`.

- **No code in plans**: SQL, TS, pseudocode and new function-name proposals are FORBIDDEN — code authoring is the DEV agent's domain.
  - The prohibition covers the IMPLEMENTATION a plan prescribes. The presentation carrier of a user-requested HTML primary — Tailwind classes, Mermaid source, the claim-marking tags below — is the deliverable's own form, not plan content.
  - Detector patterns and the Mermaid carve-out: `agents/glass-atrium-intel-planner.md` → `## Design Expression Rules (No Code — Zero Tolerance)`.
- **Brief plans by default**: a plan is brief and direction-only; the exhaustive structures (acceptance criteria among them) appear only when the on-request test is met, which is stated once at `agents/glass-atrium-intel-planner.md` → `### Default Plan Shape`.

## Output Format Routing [PLANNING]

The request-driven emission model — three emission modes · HTML request test · POST tuple · document lifecycle · visual floor · D8 thresholds — enters at `scoped/scope-report.md` → `## Output Format Routing [REPORT]`. Its rules are canonical at more than one site; `agents/glass-atrium-intel-planner.md` → `## Canonical & Mirror Register` names the canonical of each.

The copy the planner applies, the `[DOC-ROUTE]` exception to the turn-0 routing gate included, is `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`.

## Pre-drawing Doctrine [PLANNING]

Pointer only. `scope-report.md` → `## Pre-drawing Doctrine [REPORT]` is the SoT: the adopted and excluded type lists, the budget caps and the size presets live there once, and this section restates no number so nothing here can drift from them.

The decision order it defines, applied before drawing any Mermaid block in a user-requested HTML plan: Type → Direction → Budget → Preset → semantic-role `classDef` → Layout. The copy the planner applies is `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec (applies to user-requested HTML primary)`.

## Designer Co-Emission Trigger [PLANNING]

Pointer only. The T1-T5 indicators and the 2-agent composition are canonical at `scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`.

- Planner copy: `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract`.
- Designer copy: `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role`.
- Orchestrator count: `rules/glass-atrium/orchestrator-role.md` → Visual-Weight Probe.

## Ambiguity Gate [PLANNING]

- **6-axis weighted score, shared with DEV** (axis canonical: `scope-dev.md` → Ambiguity Gate): Purpose 30% · Scope 25% · Technical 20% · Acceptance 15% · Audience 5% · Dependency 5%.
- What each score band obliges a planner to do — the confidence-tiered bands and the score–evidence consistency cap — is canonical at `agents/glass-atrium-intel-planner.md` → `### Ambiguity Gate (banded, not a single threshold)`; the EARS acceptance-criteria form with its measurement method is `## Content Quality Bars (per deliverable type)` in the same body.
- **Audience axis ≥ 0.9**: resolve the exposure question at planning time — will the user explicitly request a shareable HTML artifact, or is this an intermediate record — so format routing is pre-decided rather than discovered at emission.

## Claim Marking & Consultation [PLANNING]

Extends the Ambiguity Gate from axis granularity to claim granularity: the gate marks which AXIS is uncertain, this marks which CLAIM is, so the verification team receives a question list rather than a score.

- The two tag literals are canonical here.
- `agents/glass-atrium-intel-planner.md` → `## Open Questions Section (plan body slot)` holds the entry shape and which claims carry a tag.
- `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]` quotes `[SELF-CHECKED:]` in the reviewer's marking judgment.

- `[SELF-CHECKED: <instrument you ran this turn>]` — names the INSTRUMENT, never the conclusion: the file Read, the pattern Grepped, the command run and what it returned. A tag naming no instrument is not a self-check.
- `[UNCHECKED: <the question that would settle it>]` — carries a QUESTION, not a restated claim, because that string becomes another actor's work item verbatim.
- **An unmarked substantive claim is UNCHECKED** — so omission and self-report inflation can only WIDEN the downstream question list, never exempt a claim from it.
- Every `[UNCHECKED:]` question appears once, verbatim, in the plan's `## Open Questions` section in the body slot's entry shape; its `load-bearing` value follows the test defined once at `scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`.
- **Consultation while authoring — two lawful routes, in this order**:
  - **Self-settle first**: a claim your own `Read` / `Glob` / `Grep` / `Bash` can settle, you settle — then it is `[SELF-CHECKED: <instrument>]`. Converting your own assumption is cheaper than routing it.
  - **Domain consult second**: a claim needing a domain agent's judgment you cannot supply → emit `needs_domain_consult: <agent-type> — <the question>` in your `[COMPLETION]`, on the `needs_devfront_markup:` signal precedent, for the orchestrator to judge in its Monitoring phase.
    - Honest backing: the emitting half is specified here and nowhere else, and no orchestrator-side duty consumes the token today — the route is a design on record, not a working path.
- **Pre-commitment against this mechanism's own growth**: when the Open Questions list grows past what the plan can carry, do NOT extend the list — that is the Ambiguity Gate `< 0.6` clarification-interview band, and the plan is not ready to be written. The existing score bands are the bound: no new cap, no count.

## CQRS Exception [META+PLANNING+DESIGN]

Pointer only. Rule: `scope-meta.md` → CQRS Exception (read+write allowed; self-review mandatory).
