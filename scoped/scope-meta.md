# META Scope Rules

> **Loading**: Tier 2 (Scope) — assigned to `agent_scope = META` (glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent)
> **Inherits**: Tier 1 (Core) — glass-atrium-meta-prompt-engineer additionally inherits part of Tier 3, per `## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance` below
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to META agents: glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent.

## Reach and Consumers

**This file reaches no agent at spawn.** Tier-2 membership is an assignment, not a delivery — a spawned subagent receives the parent session's project-instruction set, which does not include the scope file named for its own scope (measured 2026-09-10; the instruments are in `core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).

- **Who does read it**: humans and the orchestrator, as the maintained governance statement for META scope.
- **What machine reads it**: `autoagent/daemon_cycle.py` excerpts it as whole `##` heading blocks into the daemon's rule-improvement verify prompt (axis C3), for any patch targeting a META agent.
- **Consequence for authors**: a duty that must actually bind either META agent has to live in that agent's own body under `agents/` — stating it only here binds nobody.
- **Consequence for editors**: a passage in either META body that looks like a redundant mirror of this file is that agent's ONLY copy; never cut it on the grounds that this file has it.
- **No test pins this file's text** — searched `test/`, `hooks/test/`, `scripts/test/` and `autoagent/test/`: nothing names the file or quotes a literal from it.
  - That unpinned state is correct. The file carries no machine-read literal of its own; what a consumer depends on is its `##` heading structure (the C3 excerpt splits on it) and the four heading names sibling files cite.

| Heading cited elsewhere — do not rename | Cited from |
|---|---|
| `CQRS Exception` | `scope-design.md`, `scope-planning.md` |
| `Outcome-Driven Rewrite Policy` | `orchestrator-role.md` |
| `Prompt Deliverable Team Rule` | `orchestrator-role.md`, `skills/glass-atrium-ops-orchestrator.md` |
| `DEV Rule Inheritance` | `core-compliance-matrix.md` |

## Absolute Rules [DEV+META]

- Follow **Read → Analyze → Plan → Approve → Execute** order
- **Read entire target file** before modification · **Understand existing patterns** before new files
- **Prompts = Code**: subject to version control, review, and testing

> Pair note: this section and `## Skills Array Order [DEV+META]` below are also stated at `scoped/scope-dev.md` under the same two headings. Both are `[DEV+META]`, and neither file reaches its agents, so the pair is deliberate — each file is its own scope's governance statement. Edit them together; do not collapse either into a pointer.

## CQRS Exception [META+PLANNING+DESIGN]

> **Canonical source**: this file. `scope-planning.md` and `scope-design.md` point here rather than duplicate.

glass-atrium-meta-prompt-engineer, glass-atrium-intel-planner and glass-atrium-design-designer may both read and write their own deliverables — no reader/writer split applies to them.

- **Self-review is therefore mandatory**: run the deliverable self-checklist after writing, because no second party sits between authoring and delivery by default.
- **Self-checklist**: structure compliance · meaning preservation · token budget · consistency with existing patterns.
- glass-atrium-meta-prompt-engineer additionally runs the separate `## Structure Self-Check` in its own body, and ships the result through `## Prompt Deliverable Team Rule` below — that pipeline is an addition to this self-review, not a replacement for it.
- Honest note: the "DEV CQRS separation" this heading excepts is stated in no DEV rule file — the exception has no located antecedent, so read the positive rule above rather than inferring a DEV rule from the heading.

## Prompt Evolution Loop [META]

Binds glass-atrium-meta-prompt-engineer when it modifies a target agent's prompt. Evidence first, then a targeted edit:

- **Evidence**: work from the target agent's recent outcome signals — `directive_hint` patterns and `revision_count ≥ 2` entries.
- **Edit shape**: a targeted edit at the signalled section, never a full rewrite.
  - Why: incremental textual-gradient patching (ProTeGi-style) converges faster than wholesale replacement.
- **Signal source**: `rules/glass-atrium/core-learning-log.md` → `## Correction Signal Capture`.
- **Signals are SUPPLIED with the task, never fetched**: outcomes live only in PostgreSQL `core.outcomes` (`core-outcome-record.md` → `## Core`; the per-outcome `.md` files are retired), and neither META agent holds Bash, so neither can query them.
  - No signals supplied → request them; proceeding on guesswork is FORBIDDEN.

## glass-atrium-meta-agent: Outcome-Driven Rewrite Policy [META]

Binds glass-atrium-meta-agent when it rewrites an agent instruction file. The evidence rule and the supplied-signal fact of `## Prompt Evolution Loop` above apply unchanged. The delta:

- Derive the change direction from `directive_hint` + `evaluative_signal` + `revision_count` together.
- **Rewriting without Outcome-Record evidence is FORBIDDEN** — the daemon dry-run gate rejects an evidence-less patch.

## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance [META]

Because prompts are code (`## Absolute Rules` above), glass-atrium-meta-prompt-engineer additionally inherits these Tier-3 DEV cross-cutting rules:

| Rule file | What it governs for prompt work |
|---|---|
| `shared-comment-logging.md` | logging and comment discipline for prompt artifacts |
| `shared-performance.md` | measure-first discipline: no optimization without a profiler/benchmark |
| `shared-search-first.md` | search existing prompts/skills before creating new ones |
| `shared-testing.md` | prompt testing and TDD discipline (Red → Green → Refactor) |
| `shared-type-safety.md` | the `any` / `as` / `!` discipline: no untyped escape hatches |

`glass-atrium-meta-agent` does **not** inherit them — instruction rewrite is not general code authoring.

## Prompt Authoring Hygiene [META]

Binds every prompt, agent instruction, rule and skill authored or edited under this scope.

- **Instruction-only**: state what the agent should DO plus the current functional references it needs — never why a rule was added or how it evolved.
- **No unclear-source citations**: do not write a provenance label whose source is vague or unverifiable.
  - Omit: a `(src: …)` pointing at an internal session artifact · a derivation note · a "3-angle review" · a research claim with no checkable reference.
  - Keep: functional Atrium-internal references — a rule file the agent must follow, a hook/script/API the rule invokes, a canonical-SoT pointer.
  - The test: a reference the reader must FOLLOW to act = keep · a note explaining where a rule CAME FROM = omit.
- **No history-type content**: no Wave / ADR provenance tags, correlation IDs, `doc NNNN` / `plan doc` references, edit-history dates, changelog narration, "(NEW)", "(was X before)". Version history lives in git, not the prompt body.
  - Carve-out: provenance that changes what the reader DOES stays — an honest-backing note stating what is and is not enforced, or a delivery fact such as `## Reach and Consumers` above. That is a current functional reference, not history.

## Prompt Deliverable Team Rule [META]

Every prompt, agent body, rule or skill deliverable authored by glass-atrium-meta-prompt-engineer ships through a two-agent pipeline — author, then an independent structure verdict — and is complete only on an all-`pass` verdict.

| Step | Actor | Rule |
|---|---|---|
| Author | glass-atrium-meta-prompt-engineer | runs `## Structure Self-Check` in its own body (`agents/glass-atrium-meta-prompt-engineer.md`), then writes |
| Structure verdict | glass-atrium-intel-reporter | returns `pass`/`revise` per Structure Self-Check row — verdict-only; rewriting the deliverable is FORBIDDEN |
| Revise | glass-atrium-meta-prompt-engineer | takes every `revise` finding back and re-delivers |

- Orchestrator-side routing for the pair sits at `orchestrator-role.md` → `## Delegation Criteria` and `skills/glass-atrium-ops-orchestrator.md`; both cite this section by name.
- **Delivery gap**: the author half is also stated in the prompt-engineer's own body, but the reviewer half is stated in no `agents/glass-atrium-intel-reporter.md` passage — so the verdict-only constraint reaches the reviewer only when the delegation prompt carries it.

## Skills Array Order [DEV+META]

- Skills array order has no significant impact on model behavior — order optimization is unnecessary.
- Sort for readability and logical grouping (core → supplementary); spend the effort on content quality instead.
