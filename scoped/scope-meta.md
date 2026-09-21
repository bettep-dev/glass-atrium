# META Scope Rules

## Absolute Rules [META]

Final authority on an ambiguous META rule is this file, whole; this section concentrates that authority rather than narrowing it to itself. Corpus-wide precedence order: `rules/glass-atrium/core-compliance-matrix.md` → `## Precedence Resolution`.

- **Prompts = Code**: a prompt, agent body, rule or skill you author is version-controlled, reviewed and tested like source.

## CQRS Exception [META+PLANNING+DESIGN]

glass-atrium-meta-prompt-engineer, glass-atrium-intel-planner and glass-atrium-design-designer may both read and write their own deliverables — no reader/writer split applies to them.

- Self-review after writing is therefore mandatory: no second party sits between authoring and delivery by default.
- Self-checklist: structure compliance · meaning preservation · token budget · consistency with existing patterns.

## glass-atrium-meta-agent: Outcome-Driven Rewrite Policy [META]

- **Outcome signals are SUPPLIED with the task, never fetched.** They live only in PostgreSQL `core.outcomes` and neither META agent holds Bash, so a delegation that names signals without attaching them cannot be executed as written — report that rather than attempting a fetch.
- **A rewrite with no Outcome-Record evidence behind it is refused downstream** by the daemon dry-run gate: it costs a cycle instead of landing.
- Which signal state warrants which response is stated in `agents/glass-atrium-meta-agent.md` — `## Signal Thresholds`, `## Modification Principles`, `## Hard Constraints`.

## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance [META]

- Because prompts are code, glass-atrium-meta-prompt-engineer inherits the Tier-3 DEV cross-cutting rules that govern code authoring — comment and logging discipline, measure before optimizing, search before creating, Red → Green → Refactor, no untyped escape hatches.
- glass-atrium-meta-agent inherits none of them: rewriting an instruction from outcome signals is not general code authoring.
- The file set is declared once in `rules/glass-atrium/core-compliance-matrix.md` (Tier-3 table, † footnote) and per-agent in `agent-registry.json` (`rules.shared`) — a second list would diverge from it silently. Provenance: `scoped/maintainers/scope-meta.md`.

## Prompt Authoring Hygiene [META]

Pointer only. The rules bind META, PLANNING and REPORT alike, so they live once as a Tier-3 file: `scoped/shared-authoring-hygiene.md` → `## Authoring Hygiene`.

## Prompt Deliverable Team Rule [META]

Every prompt, agent body, rule or skill deliverable authored by glass-atrium-meta-prompt-engineer ships through a two-agent pipeline — author, then an independent structure verdict — and is complete only on an all-`pass` verdict.

| Step | Actor | Rule |
|---|---|---|
| Author | glass-atrium-meta-prompt-engineer | runs `## Structure Self-Check` from its own body, then writes |
| Structure verdict | glass-atrium-intel-reporter | returns `pass`/`revise` per Structure Self-Check row — verdict-only; rewriting the deliverable is FORBIDDEN |
| Revise | glass-atrium-meta-prompt-engineer | takes every `revise` finding back and re-delivers |

- The composer states the verdict-only constraint inside the delegation prompt: `agents/glass-atrium-intel-reporter.md` states it nowhere, so no other channel carries it to the reviewer.

## Skills Array Order [META]

- When authoring an agent's frontmatter `skills:` array, sort it for readability and logical grouping (core → supplementary). Order has no significant effect on model behaviour, so spend the effort on content quality instead.
