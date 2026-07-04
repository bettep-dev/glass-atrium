# META Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent}
> **Inherits**: Tier 1 (Core) — prompt-engineer-only: also inherits Tier 3 (Cross-cutting) per "glass-atrium-meta-prompt-engineer: DEV Rule Inheritance" below
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to META agents: glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent.

## Absolute Rules [DEV+META]

- Follow **Read → Analyze → Plan → Approve → Execute** order
- **Read entire target file** before modification · **Understand existing patterns** before new files
- **Prompts = Code**: Subject to version control, review, and testing

## CQRS Exception [META+PLANNING+DESIGN]

> **Canonical source**: this file. `scope-planning.md` and `scope-design.md` MUST reference here via pointer rather than duplicate.

- glass-atrium-meta-prompt-engineer, glass-atrium-intel-planner, glass-atrium-design-designer are **allowed both read and write** (DEV CQRS separation does not apply)
- Instead, **self-review is mandatory**: Perform deliverable self-checklist after writing
- Self-check: ①Structure compliance ②Meaning preservation ③Token budget ④Existing pattern consistency

## Prompt Evolution Loop [META]

For glass-atrium-meta-prompt-engineer when modifying a target agent's prompt:
- Read last 5 Outcome Records of the target agent before drafting changes.
- Identify `directive_hint` patterns + `revision_count ≥ 2` → targeted edit (NOT full rewrite).
- Rationale: ProTeGi / Local Prompt Optimization show incremental edits converge faster than wholesale replacement.
- See `core-learning-log.md` "Correction Signal Capture" for the signal source.

## glass-atrium-meta-agent: Outcome-Driven Rewrite Policy [META]

When glass-atrium-meta-agent rewrites an agent instruction file:
- MUST read the last 5 Outcome Records of the target agent before drafting changes.
- Derive change direction from `directive_hint` + `evaluative_signal` + `revision_count`.
- Rewriting without evidence from Outcome Records is FORBIDDEN — the daemon dry-run gate will reject evidence-less patches.

## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance [META]

Because prompts are treated as code (see "Prompts = Code" in Absolute Rules), **glass-atrium-meta-prompt-engineer** additionally inherits the following DEV cross-cutting rules:
- `shared-comment-logging.md` — logging and comment discipline for prompt artifacts
- `shared-performance.md` — token-budget awareness and lazy-evaluation for prompts
- `shared-search-first.md` — search existing prompts/skills before creating new ones
- `shared-testing.md` — prompt testing and TDD discipline (Red → Green → Refactor)
- `shared-type-safety.md` — type-safe schema definitions in structured prompt outputs

`glass-atrium-meta-agent` does **not** inherit these rules (instruction rewrite is not general code authoring).

## Prompt Authoring Hygiene [META]

When authoring or editing prompts, agent instructions, rules, or skills:
- **No unclear-source citations**: do NOT write provenance labels whose source is vague or unverifiable — a `(src: …)` pointing at an internal session artifact, a derivation note, a "3-angle review", or a research claim with no checkable reference. DISTINGUISH from functional Atrium-internal references, which ARE required: a rule file the agent must follow, a hook/script/API the rule invokes, a canonical-SoT pointer. The test — a reference the reader must FOLLOW to act = keep; a note explaining where a rule CAME FROM = omit.
- **No history-type content**: no Wave / ADR provenance tags, correlation IDs, `doc NNNN` / `plan doc` references, edit-history dates, changelog narration, "(NEW)", "(was X before)". Version history lives in git, not the prompt body.
- **Instruction-only**: a prompt states what the agent should DO plus the current functional references it needs — never why a rule was added or how it evolved.

## Skills Array Order [DEV+META]

- Skills order has no significant impact on model behavior (Primacy Effect not observed — verified via 3-round A/B testing)
- Order optimization unnecessary · Focus on **content quality** · Sort by readability and logical grouping (core → supplementary)
