# Maintainer note — `scoped/scope-meta.md`

Maintainer-facing material for that rule file. Nothing here binds either META agent; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: one pointer survives, under `## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance` (cited from the Compliance Matrix), because that section's explanatory bulk moved here.

## Delivery — what actually reads this file

- Both META agents receive the file whole at spawn. Each row's `rules.scope` in `agent-registry.json` names `scoped/scope-meta.md`, which the part-slot channel delivers (`rules/glass-atrium/core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)`). `python3 hooks/lib/inject_chunk.py --audit` reports the parts per agent.
- A second reader, not a delivery channel: `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` excerpts whole `##` heading blocks into the daemon's rule-improvement verify prompt (axis C3) for a META-agent patch.
- **Consequence for authors**: a duty stated in the rule file binds both META agents; no conditional-load line in a body is needed.
- **Consequence for editors**: a passage in either META body that mirrors the rule file is a duplicate of delivered text. The rule file is the site that survives; the body keeps only its agent-specific delta.

## Authoring hygiene — where the rules live

- The rules bind META, PLANNING and REPORT alike, so they live once at `scoped/shared-authoring-hygiene.md` → `## Authoring Hygiene`. `## Prompt Authoring Hygiene [META]` in the rule file is the pointer that keeps that heading resolving; maintainer material for the rules is in `scoped/maintainers/shared-authoring-hygiene.md`.
- Both META rows carry the file in `rules.shared`. Delivery and the no-body-copy rule: `scoped/maintainers/shared-authoring-hygiene.md` → `## Delivery — how the rules reach their agents`.
- No hook checks authored text against these rules; adherence is honor-system.

## Decisions taken on review, with their reasoning

- **The hygiene decisions moved with the rules.** The provenance carve-out under `No history-type content`, and the reasoning that accepted it, are recorded in `scoped/maintainers/shared-authoring-hygiene.md` → `## Decisions taken, with their reasoning`.
- **`## Absolute Rules [META]` — the precedence line was realigned to its citee, not softened.**
  - `rules/glass-atrium/core-compliance-matrix.md` → `## Precedence Resolution` makes the assigned scope file the final authority, the whole file and never a named section inside it.
  - The section preamble therefore states that this file governs and that the section concentrates that authority, and sends the precedence order to the matrix anchor — the shape `scoped/scope-planning.md` → `## Absolute Rules [PLANNING]` already carries.
- **Tag**: `Absolute Rules` and `Skills Array Order` carry `[META]` only — no DEV rule file holds either heading or a matching pointer, so a DEV half would name no counterpart.
- **Judgement recorded, not acted on**: the `Skills Array Order` bullet is an unsourced null-result preference ("order has no significant effect") that obliges nobody. Deleting the section is the stronger disposition.

## Heading-citation register — do not rename these

| Heading | Cited from |
|---|---|
| `Absolute Rules` | nothing cites it by name — kept because the heading names the content beneath it |
| `CQRS Exception` | `scoped/scope-planning.md` and `scoped/scope-design.md`, both by pointer |
| `Outcome-Driven Rewrite Policy` | `rules/glass-atrium/orchestrator-role.md` → Capability Probe |
| `Prompt Deliverable Team Rule` | `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria` · `skills/glass-atrium-ops-orchestrator.md` → the routing-table row for prompt/rule authoring |
| `DEV Rule Inheritance` | `rules/glass-atrium/core-compliance-matrix.md` → Tier-3 META-inheritance bullet |

- `Skills Array Order` has no external citer (it occurs only in `scoped/scope-meta.md` and this note), so it stays out of the register.

## Stale material removed

Do not restore any item below.

- **Loading stanza** (`> **Loading**: Tier 2 … agent_scope ∈ {…}` plus `> **Inherits**` and `> **See**`). The `agent_scope ∈ { … }` brace-list parsers (`scripts/agent_lifecycle/readers.py` → `parse_scope_dev_roster`, `autoagent/lib/roster_merge.py` → `_get_markdown_slots`) are anchored on `scoped/scope-dev.md` alone, so no reader needs it here.
- **Pair note under `## Absolute Rules`** tying this file to `## Absolute Rules` and `## Skills Array Order` in `scoped/scope-dev.md` — that file carries neither heading, so there is no pair to maintain.
- **`Skills Array Order` evidence claim** (what survives: `## Decisions taken on review, with their reasoning` → **Judgement recorded, not acted on**).
- **`## CQRS Exception` antecedent** — the "DEV CQRS separation" the heading excepts is stated in no DEV rule file. Read the positive grant in the rule file rather than inferring a DEV rule from the heading name.

## Duplicates dropped, with the delivered copy that made them redundant

- Self-review procedure beyond the four-item checklist: `agents/glass-atrium-meta-prompt-engineer.md` → `## Structure Self-Check (MANDATORY · pre-emit)` is the delivered, stronger gate. The four-item checklist itself stays, because `scope-planning.md` and `scope-design.md` resolve their pointers into it.
- The `## glass-atrium-meta-agent: Outcome-Driven Rewrite Policy` redirect paragraph — one line naming the body sections replaces it; the body remains the operative site.
- The `## DEV Rule Inheritance` explanation of the Compliance Matrix footnote and of where `agent-registry.json` declares the inheritance — the rule file states the rationale and the two declaration sites.
- The meta-prompt-engineer body's top-of-body inheritance blockquote and its `**Prompts = Code**` Absolute Rules bullet — both restated this rule file, which reaches that agent whole.

## Prompt Deliverable Team Rule — the delivery gap that was NOT moved

The composer-facing line stays in the rule file rather than moving here, because it changes what the delegation author does: `agents/glass-atrium-intel-reporter.md` states the verdict-only constraint nowhere, so the delegation prompt is the only channel that carries it to the reviewer. If that constraint ever lands in the reporter body, the line becomes a duplicate and should be cut then.

## Open questions

None open.

## Readers, coupled tests, and operational constraints

- **No test pins this file's text.** Searching `test/`, `hooks/test/`, `scripts/test/` and `autoagent/test/` returns no hit for `scope-meta`. That is the correct state: the file carries no machine-read literal of its own, and what consumers depend on is its `##` heading structure plus the heading names sibling files cite.
- **Path-only consumers** break on a rename or a move out of `scoped/`, never on a content edit: `agent-registry.json` (`rules.scope`, which `hooks/lib/inject_chunk.py` resolves at spawn), `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP`, `scripts/agent_lifecycle/registry_ops.py`, `scripts/test/test_agent_lifecycle_overhaul.py` (asserts exact path strings), and `manifest.json`.
- **Never diet the file to zero bytes**: `autoagent/daemon_cycle.py` → `_read_sections` emits SCOPE-FILE-EMPTY and directs a `C3: FAIL` verdict on an empty scope file.
