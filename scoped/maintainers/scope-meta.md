# Maintainer note — `scoped/scope-meta.md`

Maintainer-facing material for that rule file. Nothing here binds either META agent; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file's one pointer to this note sits under `## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance`, the heading the Compliance Matrix cites.

## Delivery — what actually reads this file

- Both META agents receive the file whole at spawn: each row's `rules.scope` in `agent-registry.json` names it, and the part slots deliver it (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership declaration and SubagentStart channels`).
  - `python3 hooks/lib/inject_chunk.py --audit` reports the parts per agent.
- **Consequence for authors**: a duty stated in the rule file binds both META agents; no conditional-load line in a body is needed.
- **Consequence for editors**: a passage in either META body that mirrors the rule file is a duplicate of delivered text. The rule file is the site that survives; the body keeps only its agent-specific delta.
- What breaks each reader, the delivery channel included: `## Readers, coupled tests, and operational constraints`.

## Authoring hygiene — where the rules live

- Both META rows carry `scoped/shared-authoring-hygiene.md` in `rules.shared`.
- Their maintainer material is `scoped/maintainers/shared-authoring-hygiene.md`:
  - delivery and the no-body-copy rule → `## Delivery — how the rules reach their agents`;
  - the provenance carve-out under `No history-type content` and the reasoning that accepted it → `## Decisions taken, with their reasoning`.
- No hook checks authored text against these rules; adherence is honor-system.

## Decisions taken on review, with their reasoning

- **`## Absolute Rules [META]` — the preamble defers to its citee.**
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution` makes the assigned scope file the final authority, the whole file and never a named section inside it.
  - So the preamble states that this file governs and the section concentrates that authority, and sends the precedence order to the charter anchor — the shape `scoped/scope-planning.md` → `## Absolute Rules [PLANNING]` carries.
- **Tag**: `Absolute Rules` carries `[META]` only — no DEV rule file holds that heading or a matching pointer, so a DEV half would name no counterpart.
- **Add-review routing resolves every target class to an existing agent** — no owner review, no exempt class.
  - The ORCHESTRATOR pair and `rules/glass-atrium/core-compliance-matrix.md` take the Tier-1 reviewer: the pair's only member is the main session, and the matrix is neither a Tier-1 rule nor a scope file, so neither has a member agent.
  - A `shared-*` file with no member agent takes the same reviewer: its policy SoT is a Tier-1 rule and its text reaches several agents.
  - Templates and references route by citer: the agent whose body cites the file is the one the added text reaches.
- **A rejected add that carries an owner-adopted option goes back to its author, never to `flag`.**
  - A reviewer may correct an owner decision's wording but cannot undo it, so a second rejection is the owner's call.
- **Decided-keep records are named in the pass delegation, never pointed to from the rule file.**
  - `## Companion-citation convention` bars rule-file prose from citing a companion; a delegation prompt is not a corpus file, so the convention stays intact.
  - The delegation can also name the keeps a plan settled, which no corpus pointer could reach.
  - Backing: honor-system — a record the composer leaves unnamed lets its keep be reopened.

## Heading-citation register — do not rename these

| Heading | Cited from |
|---|---|
| `Absolute Rules` | nothing cites it by name — kept because the heading names the content beneath it |
| `CQRS Exception` | `scoped/scope-planning.md` and `scoped/scope-design.md`, both by pointer into its grant and checklist |
| `Outcome-Driven Rewrite Policy` | `skills/glass-atrium-ops-delegation-contracts/references/decision-phase-probes.md` → Capability Probe — detail |
| `DEV Rule Inheritance` | `rules/glass-atrium/core-compliance-matrix.md` → Tier-3 META-inheritance bullet |
| `Prompt Authoring Hygiene` | nothing cites it by name — a pointer section to the Tier-3 home |
| `Prompt Deliverable Team Rule` | the citer list under this table |

- `Prompt Deliverable Team Rule` is cited from:
  - `skills/glass-atrium-ops-orchestrator-role.md` → `## Delegation Criteria` and step 6 of `## Document-Driven Workflow`;
  - `skills/glass-atrium-ops-delegation-contracts/references/agent-selection.md` → `## Compound Task Examples` (the prompt/rule row);
  - `skills/glass-atrium-ops-orchestrator.md` → `##### Stage gates`;
  - `scoped/shared-authoring-hygiene.md` → `## Prompt-Audit Overrides`.
- Its bolded lead **Prompt-audit pass** keeps its exact form: `scoped/shared-authoring-hygiene.md` → **Decided diet keeps** cites it with its Input bullet, and `scoped/maintainers/orchestrator-role.md` cites it by name.

## Stale material removed

Do not restore any item below.

- **Loading stanza** (`> **Loading**: Tier 2 … agent_scope ∈ {…}` plus `> **Inherits**` and `> **See**`).
  - The `agent_scope ∈ { … }` brace-list parsers (`scripts/agent_lifecycle/readers.py` → `parse_scope_dev_roster`, `autoagent/lib/roster_merge.py` → `_get_markdown_slots`) are anchored on `scoped/scope-dev.md` alone, so no reader needs it here.
- **Pair note under `## Absolute Rules`** tying this file to `## Absolute Rules` in `scoped/scope-dev.md` — that file carries no such heading, so there is no pair to maintain.
- **`## CQRS Exception` antecedent** — the "DEV CQRS separation" the heading excepts is stated in no DEV rule file. Read the positive grant in the rule file rather than inferring a DEV rule from the heading name.

## Duplicates dropped, with the delivered copy that made them redundant

- Self-review procedure beyond the four-item checklist: `agents/glass-atrium-meta-prompt-engineer.md` → `## Structure Self-Check (MANDATORY · pre-emit)` is the delivered, stronger gate.
  - The checklist itself stays: `scope-planning.md` and `scope-design.md` resolve their pointers into it.
- The Outcome-Driven Rewrite Policy redirect paragraph — the rule file's one line names the body sections, and the body stays the operative site.
- The DEV Rule Inheritance explanation of the matrix footnote and of the `agent-registry.json` declaration — the rule file states the rationale and both declaration sites.
- In the meta-prompt-engineer body, the top-of-body inheritance blockquote and the `**Prompts = Code**` Absolute Rules bullet — both restated this rule file, which reaches that agent whole.

## Prompt Deliverable Team Rule — the delivery gap that was NOT moved

- The rule file's structure-verdict composer line stays there: it changes what the delegation author does, and its reason sits beside it.
  - Cut it once `agents/glass-atrium-intel-reporter.md` states the verdict-only constraint itself.
- The add-review composer line under **Add review** stays for the same reason; cut it once every reviewer the add-review table names carries the constraint in its own body.

## Readers, coupled tests, and operational constraints

| Reader | Reads | Breaks on |
|---|---|---|
| both META agents, at spawn | the whole file — `rules.scope`, resolved by `hooks/lib/inject_chunk.py` | a rename or a move out of `scoped/` |
| `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` | the path, as each META agent's axis-C3 scope file | a rename or a move out of `scoped/` |
| `autoagent/daemon_cycle.py` → `_read_sections` | whole heading blocks, the C3 excerpt in a META-agent patch's verify prompt | an empty file: `SCOPE-FILE-EMPTY`, and C3 is directed to `FAIL` |
| `scripts/agent_lifecycle/registry_ops.py` | the path, as the META scope file | a rename or a move |
| `manifest.json` | the path and its hash | a rename or a move |
| heading pointers in `scoped/`, `skills/` and `rules/` | a heading by name | a rename — `## Heading-citation register` |

- **Never diet the file to zero bytes** — the `_read_sections` row.
- **No test pins this file's text**: a bare `scope-meta` grep over `test/`, `hooks/test/`, `scripts/test/` and `autoagent/test/` returns no hit.
- A rename also edits every corpus site naming the path (bare grep `scope-meta.md`).
