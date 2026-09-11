# PLANNING Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-intel-planner}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to PLANNING agents: glass-atrium-intel-planner.

## Delivery status — what this file reaches

- **What this file is: the canonical for a narrow planning-only core, and a canonical for nothing else.**
  - `## Ambiguity Gate [PLANNING]` and `## Claim Marking & Consultation [PLANNING]` are the maintained source the delivered planner-body copy was derived from.
  - Deleting either would leave that delivered copy with no maintained source.
- **What this file is not: the canonical for the HTML emission, visual, diagram or document-lifecycle rules.**
  - `scoped/scope-report.md` is, and it says so at every one of those headings.
  - This file no longer mirrors them: a mirror of a canonical a maintainer can read directly binds nobody at runtime and costs one more place to edit.
- **This file is NOT delivered to glass-atrium-intel-planner at spawn**: no code selects a scope file by agent (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).
- **Its readers** — one human, three machines-or-rules, and not the planner:
  - a human maintainer;
  - `scripts/test/doctrine-budget-parity.bats`, which reads `## Pre-drawing Doctrine [PLANNING]` by name and fails on an absent or empty section;
  - `autoagent/daemon_cycle.py`, which excerpts this file as the C3 axis of the rule-improvement verify prompt and directs a `C3: FAIL` verdict on an empty excerpt;
  - `rules/glass-atrium/core-compliance-matrix.md` → Precedence Resolution, which names this file's `## Absolute Rules` as the PLANNING scope's final authority on an ambiguous interpretation.
- **A duty homed only here binds nobody at runtime**: a duty that BINDS the planner must ALSO live in `agents/glass-atrium-intel-planner.md` — homing it here and leaving a pointer in the body delivers the pointer and nothing else.
- **Never cut a planner-body passage as a duplicate of this file**: that body copy is the only one the agent reads.
- **A heading here that states no rule is a signpost, not a stub**: three sections below are pointers carrying no rule of their own, kept because files outside the report/planning pair cite them by name. Do not re-fill one with duty text — the duty belongs in its canonical and in the planner body.

## Absolute Rules [PLANNING]

**Reader**: the maintainer resolving an ambiguous interpretation, per `rules/glass-atrium/core-compliance-matrix.md` → Precedence Resolution, which names this section as the PLANNING scope's final authority.

- **No code in plans**: SQL, TS, pseudocode, or new function-name proposals are FORBIDDEN — code authoring is the DEV agent's domain.
  - Copies of this statement (edit together):
    - this statement
    - the delivered and stronger copy at `agents/glass-atrium-intel-planner.md` → `## Design Expression Rules (No Code — Zero Tolerance)`, which carries the detector patterns and the Mermaid carve-out
  - Scope of the prohibition = the IMPLEMENTATION the plan prescribes. The presentation carrier of a user-requested HTML primary (Tailwind classes, Mermaid source, the claim-marking tags below) is the deliverable's own form, not plan content.
- **Brief plans by default**: a plan is brief and direction-only; the exhaustive structures appear only when the on-request test is met.
  - Pointer only — the default shape, the on-request list and its test live once, in the copy the planner reads: `agents/glass-atrium-intel-planner.md` → `### Default Plan Shape` → On-request structures.

## Output Format Routing [PLANNING]

> **Pointer — this section states no routing rule of its own.**

- **Canonical**: `scoped/scope-report.md` → `## Output Format Routing [REPORT]` holds the request-driven emission model — three emission modes · HTML request test · POST tuple · document lifecycle · visual floor · D8 thresholds.
- **The copy the planner applies**: `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`.
- **Why the heading survives**: files outside the report/planning pair cite it by name — `agents/GLASS_ATRIUM_GLOBAL_RULES.md` · `rules/glass-atrium/core-git-workflow.md` · `scoped/scope-qa.md` · `skills/glass-atrium-ops-orchestrator.md`.

**Undelivered and kept pending relocation — honoring the `[DOC-ROUTE]` stamp.** The planner body's turn-0 routing gate forbids obeying an orchestrator-supplied local path as a deliverable destination and names no exception to that refusal. The one sanctioned exception is the delegation-side stamp `log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>')`, which attests that the USER explicitly requested that local destination (new file OR edit of an existing user file); the stamped path is then honored as the destination.

- **Wrong action without it**: a planner holding only the body's refusal rule declines a legitimately stamped delegation and POSTs to the monitor against the user's explicit local-destination request.
- **Where it must land to bind**: `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`, as a named exception to the turn-0 gate. It cannot bind from here.
- **Delegation-side canonical for the stamp**: `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria`. Stamping without an actual explicit user request is a violation; the token is consumed by the `hooks/enforce-workflow-verify-stage.sh` static gate, which scans workflow scripts and never this file.

## Pre-drawing Doctrine [PLANNING]

> Canonical mirror — `scope-report.md` → `## Pre-drawing Doctrine [REPORT]` is the SoT and this section is a pointer only: the adopted/excluded type lists and the budget numbers live there ONCE, so nothing here can drift.

Machine-checked pointer: `scripts/test/doctrine-budget-parity.bats` reads this section by its heading, fails when the body stops naming `scope-report.md` as its SoT, and compares any cap this section restates against the canonical's own. Keeping it a pointer that states no cap is what keeps that row green.

Delivered mirror: `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec (applies to user-requested HTML primary)` carries the decision core in full, because neither this pointer nor the canonical it names reaches glass-atrium-intel-planner at spawn. This section stays a pointer and states no literal; the canonical and that body copy are edited together.

Before drawing any Mermaid block in a user-requested HTML plan, run its decision order there — each step builds on the previous:

- **Type** — from the adopted set
- **Direction** — one primary direction
- **Budget** — check, and split when over
- **Preset** — size preset
- **Semantic-role `classDef`**
- **Layout** — default, plus opt-out

## Designer Co-Emission Trigger [PLANNING]

> **Pointer — this section states no threshold of its own.**

- **Canonical**: `scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`.
- **T1-T5 thresholds the planner counts against**: delivered at `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract`.
- **The orchestrator's own counting site**: `rules/glass-atrium/orchestrator-role.md` → Visual-Weight Probe.
- **Designer side**: `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` · `skills/glass-atrium-design-html-co-emission/SKILL.md`.
- **dev-front markup exception**: those same author bodies, plus `rules/glass-atrium/orchestrator-role.md` → `#### Monitoring-phase notes`.
- **Why the heading survives**: the designer body and that skill cite it by name.

## Ambiguity Gate [PLANNING]

> Detailed rules: See `scope-dev.md` Ambiguity Gate section (6-axis weighted score). What each score band obliges a planner to do is the Confidence-tiered plan generation rule below.

**Copies (edit together)**: axis canonical `scope-dev.md` → Ambiguity Gate · this section (canonical for the planning-only rules below) · delivered `agents/glass-atrium-intel-planner.md` → `## Pre-Execution Verification [PLANNING]`, which carries the operative subset (the six axes, the three score bands and the score-evidence consistency rule).

- **6-axis Ambiguity Gate** (in sync with DEV — `scope-dev.md` "Ambiguity Gate" canonical): Purpose 30% · Scope 25% · Technical 20% · Acceptance 15% · Audience 5% · Dependency 5%
- **Audience axis ≥ 0.9 obligation**: at PLANNING time, resolve the single exposure question — "will the user explicitly request a shareable HTML artifact, or is this an intermediate record?" — so the request-driven format routing is pre-decided rather than discovered at emission time

**Score–evidence consistency** (PLANNING-only):

- Axis containing ≥ 1 unresolved-uncertainty item (any marker meaning "needs confirmation" / "TBD" / "undecided" / "needs investigation") → axis score **capped at 0.85**
- Axis score ≥ 0.9 → body MUST contain an explicit "0 unresolved-uncertainty items" audit line
- Every Acceptance Criterion a plan carries MUST declare a **measurement method**
  - Good: "AC2: p95 < 500ms — measured via: Grafana prod-api dashboard, 1-week average"
  - Bad: "AC2: responses get faster"
- Integrates with the self-check scans at `agents/glass-atrium-intel-planner.md` → `## Design Expression Rules (No Code — Zero Tolerance)` as the self-contradiction scan

**Acceptance-criteria format** (PLANNING-only):

- A plan carries acceptance criteria only when the on-request test is met (`## Absolute Rules [PLANNING]` → Brief plans by default)
- **EARS Acceptance Criteria format**: when a plan carries acceptance criteria, every AC MUST use EARS syntax — `When [trigger], the system shall [response]` (with optional `unless [exception]`).
  - The AC example format above ("AC2: p95 < 500ms — measured via: …") stays valid as measurement-method reinforcement; the EARS sentence itself is required for every AC.

**Confidence-tiered plan generation**:

- Score < 0.6 → do NOT generate plan; conduct clarification interview first.
- Score 0.6 – 0.79 → generate Draft Plan; mark every unresolved axis as `[DRAFT: clarify before DEV]`.
- Score ≥ 0.8 → generate Final Plan.

## Claim Marking & Consultation [PLANNING]

Extends the Ambiguity Gate above from axis granularity to claim granularity: the gate marks which AXIS is uncertain, this marks which CLAIM is — so the verification team receives a question list rather than a score.

**Copies (edit together — a change to either tag literal here is hand-carried)**: this section (canonical) · delivered `agents/glass-atrium-intel-planner.md` → `## Open Questions Section (plan body slot)`, which carries the operative subset (the two tag forms, the unmarked-is-UNCHECKED default and the which-claims test) · the reviewer-side consumer `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]`, which quotes the `[SELF-CHECKED:]` literal in its marking-judgment duty.

- **Marking format** — every substantive claim the plan rests on carries an inline tag at the end of its own bullet:
  - `[SELF-CHECKED: <instrument you ran this turn>]` — names the INSTRUMENT, never the conclusion: the file you Read, the pattern you Grepped, the command you ran and what it returned. A tag naming no instrument is not a self-check.
  - `[UNCHECKED: <the question that would settle it>]` — carries a QUESTION, not a restated claim, because that string becomes another actor's work item verbatim.
  - **An unmarked substantive claim is UNCHECKED.** Omission and self-report inflation can therefore only WIDEN the downstream question list, never exempt a claim from it.
  - **Which claims carry a tag**: the ones whose falsity would change the plan — what code does, capacity/performance figures, "X already exists", "Y is unused", "this is the only caller". A structural fact you looked at (the file exists, the symbol is defined) needs none.
  - The tag is metadata, not code — the no-code prohibition in `## Absolute Rules [PLANNING]` above, and its delivered copy at `agents/glass-atrium-intel-planner.md` → `## Design Expression Rules (No Code — Zero Tolerance)`, are untouched.
- **`## Open Questions` section of the plan body**: every `[UNCHECKED:]` question appears there once, verbatim, each entry naming the task ids that rest on it. This is the list the Stage-2 team reads.
  - **An empty section is a valid value and is written as such** — deleting the section is not how you have none.
- **Load-bearing marking inside Open Questions**: each entry additionally carries `load-bearing: yes|no` + a one-line reason, judged by the operational test defined ONCE at `scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`. Pointer only — cross-read at review, restated here never.
- **Consultation while authoring — two lawful routes, in this order**:
  - **Self-settle first**: you hold `Read`, `Glob`, `Grep`, `Bash`. A claim those can settle, you settle — then it is `[SELF-CHECKED: <instrument>]`. Converting your own assumption is cheaper than routing it.
  - **Domain consult second**: a claim needing a domain agent's judgment you cannot supply → emit `needs_domain_consult: <agent-type> — <the question>` in your `[COMPLETION]`, mirroring the `needs_devfront_markup:` signal precedent at `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract`.
    - The orchestrator judges it in its Monitoring phase and composes a pre-authoring consultation; the lawful shapes already exist (`skills/glass-atrium-ops-orchestrator.md` → Pipeline Acceptance Criteria, 3-phase Discovery hatches (a) and (b)).
  - **FORBIDDEN — spawning an agent yourself**: your `tools:` array is frozen at spawn [LLM06] and carries no Agent/SendMessage tool, and MAX_DEPTH=2 forbids the nesting.
    - Stated explicitly because "the planner just calls the domain agent" is otherwise re-proposed as though it were an option.
- **Pre-commitment against this mechanism's own growth**: when the Open Questions list grows past what the plan can carry, do NOT extend the list — that is the Ambiguity Gate `< 0.6` clarification-interview band and the plan is not ready to be written. The existing score bands are the bound; no new cap, no count.
- **Honest backing**: all of the above is honor-system — nothing checks that a `[SELF-CHECKED:]` instrument was run, and nothing checks that marking is complete.
  - The only structural property is the unmarked-is-UNCHECKED default above, which makes under-marking widen the downstream question list instead of shrinking it. Do NOT describe claim marking as verification.

## CQRS Exception [META+PLANNING+DESIGN]

> Detailed rules: See `scope-meta.md` CQRS Exception section (read+write allowed; self-review mandatory)

**Reader**: the maintainer following `scoped/scope-meta.md`, whose own cross-file register names this file as a pointer holder for that rule. This line states no rule of its own.
