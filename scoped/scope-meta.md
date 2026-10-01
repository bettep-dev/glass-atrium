# META Scope Rules

## Absolute Rules [META]

Final authority on an ambiguous META rule is this file, whole; this section concentrates that authority rather than narrowing it to itself. Corpus-wide precedence order: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution`.

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
- **Prompt-audit pass**: every prompt-file cycle runs this pass.
  - Trigger class and position in the delivery tail: `rules/glass-atrium/orchestrator-role.md` → `## Document-Driven Workflow` step 6 → **Prompt-file tail**.
  - Actor: glass-atrium-meta-prompt-engineer.
  - Input: only the files the cycle modified.
    - On a code file, the audited span is the file's prompt surface as guide Step 1 inventories it; the file's other code is not audited.
    - Read beside them, never audited: the records of decided diet keeps, which the composer names in each pass delegation — the target file's maintainer note where one exists, and any plan that settled keeps.
  - Method: the bundled `/claude-api` prompt-audit guide, loaded through the Skill tool when the pass runs; no guide copy is written out for a run.
    - The pass is an instance of `agents/glass-atrium-meta-prompt-engineer.md` → `## Corpus Edit Pass`.
    - It also obeys that body's `## Corpus Transform Contract` → `tabulate-only-the-tabular` on every hunk, not only in a prose → outline restructure.
  - Output: an audit report carrying the guide's Step 5 fields, the diet component each finding matches, the add-review result and the override outcome.
    - Hunks follow guide Step 6, one finding per hunk.
  - Application: `remove`, `rewrite`, `move` and `add` findings at high or medium confidence are applied; `flag` and low-confidence findings stay in the report only.
    - A hunk an override keeps proposed-only is written into the report and left unapplied; the user takes or leaves it.
  - Probes: guide Step 7 behavioural probes are metered, so a cycle's probes run only on the user's approval for that cycle.
    - A contested hunk left without a probe is marked as a hypothesis.
  - The structure verdict on the audit hunks judges the override outcome; no other step judges it.
- **Add review**: after the pass applies its hunks and before the structure verdict, each target file carrying an `add` finding gets one verdict-only spawn on its add hunks.
  - The composer states the verdict-only constraint in each add-review delegation prompt, as for the structure verdict.
  - A rejected add drops to `flag`, so it stays in the report only.
    - A hunk the composer marks as carrying an owner-adopted option never drops: its author rewords it keeping the option, the same reviewer re-reviews once, and a second rejection goes to the owner.
  - The reviewer per target file:

| Target file | Add reviewer |
|---|---|
| an agent body | the agent that body instructs; the glass-atrium-meta-prompt-engineer body goes to glass-atrium-meta-agent |
| a scope or `shared-*` file | an agent that is a member of that file, matched to the domain the added text governs |
| a Tier-1 rule, a skill, a file of the ORCHESTRATOR pair, or `rules/glass-atrium/core-compliance-matrix.md` | glass-atrium-qa-code-reviewer |
| a `shared-*` file with no member agent | glass-atrium-qa-code-reviewer |
| a maintainer note under `scoped/maintainers/` | the reviewer its paired file's row names |
| a file under `agents/templates/` or `agents/references/` | the agent whose body cites it; several citers or a Tier-1 citer → glass-atrium-qa-code-reviewer |
| a code file — hook, script, Python module, test | the DEV agent whose domain covers it: glass-atrium-dev-shell for shell, glass-atrium-dev-python for Python |

## Skills Array Order [META]

- When authoring an agent's frontmatter `skills:` array, sort it for readability and logical grouping (core → supplementary).
