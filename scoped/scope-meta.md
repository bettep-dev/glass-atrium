# META Scope Rules

> **Loading**: Tier 2 (Scope) — assigned to `agent_scope ∈ {glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent}`
> **Inherits**: Tier 1 (Core) — glass-atrium-meta-prompt-engineer additionally inherits part of Tier 3, per `## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance` below
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to META agents: glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent.

## Reach and Consumers

**This file reaches no agent at spawn.** Tier-2 membership is an assignment, not a delivery — a spawned subagent receives the parent session's project-instruction set, which does not include the scope file named for its own scope (measured 2026-09-10; the instruments are in `core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).

**So this is a governance file, not an instruction file.** What it holds is the META-scope statements whose reader is a human maintainer, the orchestrator composing a META delegation, or a sibling file's pointer. A duty that must actually bind either META agent is not here — it lives in that agent's own body under `agents/`.

| Reader | Reads this file for |
|---|---|
| human maintainer / editor | the META-scope governance statement, and the heading-citation table below |
| orchestrator | the two-agent routing rule, and what a META delegation has to carry |
| sibling rule files | the headings they cite as canonical — the table below |
| `autoagent/daemon_cycle.py` | whole `##` heading blocks, excerpted as axis C3 of the daemon's verify prompt for a META-agent patch |

- **Consequence for authors**: a duty stated only here binds nobody — put it in the agent body.
- **Consequence for editors**: a passage in either META body that looks like a redundant mirror of this file is that agent's ONLY copy; never cut it on the grounds that this file has it.
- **One duty here is knowingly undelivered**: `## Prompt Authoring Hygiene` binds prompt-authoring work and sits in no META agent body — that section carries its own note.
- **No test pins this file's text** — searched `test/`, `hooks/test/`, `scripts/test/` and `autoagent/test/`: nothing names the file or quotes a literal from it.
  - That unpinned state is correct. The file carries no machine-read literal of its own; what a consumer depends on is its `##` heading structure (the C3 excerpt splits on it) and the heading names sibling files cite.

| Heading cited elsewhere — do not rename | Cited from |
|---|---|
| `Absolute Rules` | `core-compliance-matrix.md` → Precedence Resolution (scope file's Absolute Rules = final authority) |
| `CQRS Exception` | `scope-design.md`, `scope-planning.md` |
| `Outcome-Driven Rewrite Policy` | `orchestrator-role.md` |
| `Prompt Deliverable Team Rule` | `orchestrator-role.md`, `skills/glass-atrium-ops-orchestrator.md` |
| `DEV Rule Inheritance` | `core-compliance-matrix.md` |
| `Skills Array Order` | `scope-dev.md` |

## Absolute Rules [DEV+META]

- **Prompts = Code**: subject to version control, review, and testing.
  - This is the antecedent `core-compliance-matrix.md` cites for the Tier-3 inheritance below, and this section is what that file's Precedence Resolution names as META scope's final authority on an ambiguous rule.

> Pair note: `scoped/scope-dev.md` carries this heading and `## Skills Array Order [DEV+META]` under the same `[DEV+META]` tag — edit the pair together, and do not collapse either into a pointer.
> The two `## Absolute Rules` bodies are deliberately NOT identical: the DEV copy adds agent-behaviour bullets this scope does not repeat, both META bodies already carrying them.

## CQRS Exception [META+PLANNING+DESIGN]

> **Canonical source**: this file. `scope-planning.md` and `scope-design.md` point here rather than duplicate. Reader: the maintainer and those two pointers — the operative self-review duty reaches glass-atrium-meta-prompt-engineer through `## Structure Self-Check` in its own body.

glass-atrium-meta-prompt-engineer, glass-atrium-intel-planner and glass-atrium-design-designer may both read and write their own deliverables — no reader/writer split applies to them.

- **Self-review is therefore mandatory**: run the deliverable self-checklist after writing, because no second party sits between authoring and delivery by default.
- **Self-checklist**: structure compliance · meaning preservation · token budget · consistency with existing patterns.
- glass-atrium-meta-prompt-engineer additionally runs the separate `## Structure Self-Check` in its own body, and ships the result through `## Prompt Deliverable Team Rule` below — that pipeline is an addition to this self-review, not a replacement for it.
- Honest note: the "DEV CQRS separation" this heading excepts is stated in no DEV rule file — the exception has no located antecedent, so read the positive rule above rather than inferring a DEV rule from the heading.

## glass-atrium-meta-agent: Outcome-Driven Rewrite Policy [META]

**The operative rule is not here.** It is in `agents/glass-atrium-meta-agent.md`, which carries it in three places — `## Signal Thresholds` (which signal state warrants which response), `## Modification Principles` (every change maps to a concrete signal), `## Hard Constraints` (do not fabricate signals; empty inputs mean a `no-op` report). That body reaches the agent; this file does not.

What remains here is what the delegation composer needs:

- **Outcome signals are SUPPLIED with the task, never fetched.** They live only in PostgreSQL `core.outcomes` (`core-outcome-record.md` → `## Core`) and neither META agent holds Bash, so a delegation naming signals without attaching them cannot be executed as written.
- **An evidence-less rewrite is rejected downstream** — the daemon dry-run gate refuses a patch with no Outcome-Record evidence behind it, so it costs a cycle rather than landing.

> Cited from `orchestrator-role.md` → Capability Probe, where the point is that a tool-grant change is a body edit applying on the NEXT spawn.

## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance [META]

**The rationale `core-compliance-matrix.md` cites this heading for**: prompts are code (`## Absolute Rules` above), so glass-atrium-meta-prompt-engineer inherits the Tier-3 DEV cross-cutting rules that govern code authoring — comment and logging discipline, measure-first before optimizing, search existing artifacts before creating new ones, Red → Green → Refactor test discipline, and no untyped escape hatches. `glass-atrium-meta-agent` does not inherit them: instruction rewrite is not general code authoring.

- **Membership is deliberately not restated here.** The exact file set is `core-compliance-matrix.md` → `### Tier 3 — Cross-cutting (conditional inheritance)`, footnote †; a second list here would diverge from it silently.
- **What reaches the agent** is the `> Rules:` header line in `agents/glass-atrium-meta-prompt-engineer.md`, which names the inherited files and the glass-atrium-meta-agent exclusion. The Tier-3 bodies themselves are pointer-referenced only, per that same matrix section.

## Prompt Authoring Hygiene [META]

Binds every prompt, agent instruction, rule and skill authored or edited under this scope.

> **Undelivered — the one duty in this file with a named wrong action.** No META agent body states it and no hook checks it, so the behaviour it prevents is live: an authored rule or agent body that carries provenance and edit-history narration, which the corpus then has to be cleaned of. Its home should be `agents/glass-atrium-meta-prompt-engineer.md`; until it moves there, a delegation has to carry it.

- **Instruction-only**: state what the agent should DO plus the current functional references it needs — never why a rule was added or how it evolved.
- **No unclear-source citations**: do not write a provenance label whose source is vague or unverifiable.
  - Omit: a `(src: …)` pointing at an internal session artifact · a derivation note · a "3-angle review" · a research claim with no checkable reference.
  - Keep: functional Atrium-internal references — a rule file the agent must follow, a hook/script/API the rule invokes, a canonical-SoT pointer.
  - The test: a reference the reader must FOLLOW to act = keep · a note explaining where a rule CAME FROM = omit.
- **No history-type content**: no Wave / ADR provenance tags, correlation IDs, `doc NNNN` / `plan doc` references, edit-history dates, changelog narration, "(NEW)", "(was X before)". Version history lives in git, not the prompt body.
  - Carve-out: provenance that changes what the reader DOES stays — an honest-backing note stating what is and is not enforced, or a delivery fact such as `## Reach and Consumers` above. That is a current functional reference, not history.

## Prompt Deliverable Team Rule [META]

**Reader: the orchestrator.** This is a routing rule — `orchestrator-role.md` → `## Delegation Criteria` and `skills/glass-atrium-ops-orchestrator.md` both cite it by name as the rule composing the two-agent team.

Every prompt, agent body, rule or skill deliverable authored by glass-atrium-meta-prompt-engineer ships through a two-agent pipeline — author, then an independent structure verdict — and is complete only on an all-`pass` verdict.

| Step | Actor | Rule |
|---|---|---|
| Author | glass-atrium-meta-prompt-engineer | runs `## Structure Self-Check` in its own body (`agents/glass-atrium-meta-prompt-engineer.md`), then writes |
| Structure verdict | glass-atrium-intel-reporter | returns `pass`/`revise` per Structure Self-Check row — verdict-only; rewriting the deliverable is FORBIDDEN |
| Revise | glass-atrium-meta-prompt-engineer | takes every `revise` finding back and re-delivers |

- **Delivery gap the composer must close**: the author half is stated in the prompt-engineer's own body, but `agents/glass-atrium-intel-reporter.md` states the reviewer half nowhere — so the verdict-only constraint reaches the reviewer only when the delegation prompt carries it.

## Skills Array Order [DEV+META]

- Skills array order has no significant impact on model behaviour — order optimization is unnecessary. Sort for readability and logical grouping (core → supplementary), and spend the effort on content quality instead.
- **The `scope-dev.md` pointer overstates this section**: it cites this file as carrying the finding "WITH the A/B evidence behind it", and no such evidence is recorded here or anywhere located in the corpus. Read the line above as an unsourced advisory.
