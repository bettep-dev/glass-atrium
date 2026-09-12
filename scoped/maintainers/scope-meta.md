# Maintainer note — `scoped/scope-meta.md`

Maintainer-facing material for that rule file. Nothing here binds either META agent; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: one pointer survives, under `## glass-atrium-meta-prompt-engineer: DEV Rule Inheritance` (cited from the Compliance Matrix), because that section's explanatory bulk moved here.

## Delivery — what actually reads this file

- No spawn path delivers it. `hooks/inject-scope-rules.sh` sources exactly three files under `scoped/` (`shared-comment-logging.md`, `scope-dev.md` for the STYLE-REF / MINIMALISM / PLAN-GATE blocks, `shared-turn-budget.md`), and `scope-meta.md` is not one of them; no hook reads the registry's `rules.scope` array at spawn time.
- The only agent→scope-file map in the tree is `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP`, which excerpts whole `##` heading blocks into the daemon's rule-improvement verify prompt (axis C3) for a META-agent patch. That is a daemon reader, not a delivery channel.
- **Consequence for authors**: a duty stated only in the rule file binds nobody at spawn. The corpus's one working pattern is a conditional-load line in the agent's own body naming the absolute path and the heading — `agents/glass-atrium-intel-researcher.md` carries the precedent.
- **Consequence for editors**: a passage in either META body that looks like a redundant mirror of the rule file is that agent's ONLY copy. Never cut it on the grounds that the rule file has it.
- The former `## Reach and Consumers` section stated this inside the rule file, addressed to a maintainer who does not read it there. It is retired; this section replaces it.

## Open item — the one duty with no delivery route

The hygiene rules bind prompt-authoring work, sit in no META agent body, and are checked by no hook, so the behaviour they prevent is live: an authored rule or agent body that carries provenance and edit-history narration, which the corpus then has to be cleaned of.

- The rules themselves are no longer in this file. They bind META, PLANNING and REPORT alike, so they live once at `scoped/shared-authoring-hygiene.md` → `## Authoring Hygiene`, and `## Prompt Authoring Hygiene [META]` here is the pointer that keeps the heading resolving. Maintainer material for the rules moved with them, to `scoped/maintainers/shared-authoring-hygiene.md`.
- The gap is unchanged by the move and is accepted: no Tier-3 body reaches an agent at spawn either, so until the injector selects `scoped/` bodies by membership, a delegation has to carry these rules. Do NOT close it by copying the bullets into an agent body.

## Decisions taken on review, with their reasoning

- **The hygiene decisions moved with the rules.** The provenance carve-out under `No history-type content`, and the reasoning that accepted it, are recorded in `scoped/maintainers/shared-authoring-hygiene.md` → `## Decisions taken, with their reasoning`.
- **`## Absolute Rules [DEV+META]` — the precedence line was realigned to its citee, not softened.**
  - `rules/glass-atrium/core-compliance-matrix.md` → `## Precedence Resolution` now makes the assigned scope file the final authority, the whole file and never a named section inside it.
  - The section preamble therefore states that this file governs and that the section concentrates that authority, and sends the precedence order to the matrix anchor — the shape `scoped/scope-planning.md` → `## Absolute Rules [PLANNING]` already carries.

## Heading-citation register — do not rename these

| Heading | Cited from |
|---|---|
| `Absolute Rules` | nothing cites it by name — kept because the heading names the content beneath it |
| `CQRS Exception` | `scoped/scope-planning.md` and `scoped/scope-design.md`, both by pointer |
| `Outcome-Driven Rewrite Policy` | `rules/glass-atrium/orchestrator-role.md` → Capability Probe |
| `Prompt Deliverable Team Rule` | `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria` · `skills/glass-atrium-ops-orchestrator.md` → the routing-table row for prompt/rule authoring |
| `DEV Rule Inheritance` | `rules/glass-atrium/core-compliance-matrix.md` → Tier-3 META-inheritance bullet |

- A sixth row claimed `Skills Array Order` was cited from `scope-dev.md`. Grep over `scoped/` this pass returns that string only inside `scope-meta.md`, so the row protected a citation that does not exist; it is dropped, and the heading stays out of the register.
- **`Skills Array Order` retagged `[DEV+META]` → `[META]`** — the DEV half named a `scope-dev.md` pointer that `32a0685` deleted, so it claimed a scope with no member.
  - Safe as a heading edit: `Skills Array Order` occurs only in `scoped/scope-meta.md` and in this note, `core-compliance-matrix.md` names the file and never the section, and no `.bats` / `.py` / `.ts` suite pins the heading or the `DEV+META` literal.
- **Open, deliberately not taken here: `## Absolute Rules [DEV+META]` carries the identical dead DEV half** — `scoped/scope-dev.md` holds no `## Absolute Rules` heading either.
  - Either retag it on the same finding or record why that one keeps DEV; retagging it was outside this pass's disposition.
- **Judgement recorded, not acted on**: the surviving `Skills Array Order` bullet is an unsourced null-result preference ("order has no significant effect") that obliges nobody.
  - The A/B evidence behind it died with the deleted `scope-dev.md` pointer, so deleting the section and keeping the null result here is the stronger disposition. The retag does not make the bullet load-bearing.

## Stale material removed in this pass

- **Loading stanza** (`> **Loading**: Tier 2 … agent_scope ∈ {…}` plus `> **Inherits**` and `> **See**`). It described a selection mechanism that does not select this file. Safe to remove: the `agent_scope ∈ { … }` brace-list parsers (`scripts/agent_lifecycle/readers.py` → `parse_scope_dev_roster`, `autoagent/lib/roster_merge.py` → `_get_markdown_slots`) are anchored on `scoped/scope-dev.md` alone, so no roster reader loses a match.
- **Pair note under `## Absolute Rules`** — it instructed an editor to edit this file together with `## Absolute Rules` and `## Skills Array Order` in `scoped/scope-dev.md`, and to keep the two `Absolute Rules` bodies deliberately different. `scope-dev.md` carries neither heading (grep this pass), so the pair had one member.
- **The `Skills Array Order` self-correction** ("the `scope-dev.md` pointer overstates this section … WITH the A/B evidence behind it"). It corrected a pointer that no longer exists; the surviving line is an unsourced advisory and is stated as a plain preference, with no evidence claim attached.
- **`## CQRS Exception` honest note** — the "DEV CQRS separation" the heading excepts is stated in no DEV rule file, so the exception has no located antecedent. Read the positive grant in the rule file rather than inferring a DEV rule from the heading name.

## Duplicates dropped, with the delivered copy that made them redundant

- Self-review procedure beyond the four-item checklist: `agents/glass-atrium-meta-prompt-engineer.md` → `## Structure Self-Check (MANDATORY · pre-emit)` is the delivered, stronger gate, and the rule file no longer narrates how the two compose. The four-item checklist itself stays, because `scope-planning.md` and `scope-design.md` resolve their pointers into it.
- The `## glass-atrium-meta-agent: Outcome-Driven Rewrite Policy` redirect paragraph. One line naming the three body sections replaces it; the body remains the operative site.
- The `## DEV Rule Inheritance` explanation of the Compliance Matrix footnote and of where `agent-registry.json` declares the inheritance. The rule file now states the rationale and the two declaration sites in three bullets.

## Prompt Deliverable Team Rule — the delivery gap that was NOT moved

The composer-facing line stays in the rule file rather than moving here, because it changes what the delegation author does: `agents/glass-atrium-intel-reporter.md` states the verdict-only constraint nowhere, so the delegation prompt is the only channel that carries it to the reviewer. If that constraint ever lands in the reporter body, the line becomes a duplicate and should be cut then.

## Readers, coupled tests, and operational constraints

- **No test pins this file's text.** Searching `test/`, `hooks/test/`, `scripts/test/` and `autoagent/test/` returns no hit for `scope-meta`. That is the correct state: the file carries no machine-read literal of its own, and what consumers depend on is its `##` heading structure plus the heading names sibling files cite.
- **Path-only consumers** break on a rename or a move out of `scoped/`, never on a content edit: `agent-registry.json` (`rules.scope`), `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP`, `scripts/agent_lifecycle/registry_ops.py`, `scripts/test/test_agent_lifecycle_overhaul.py` (asserts exact path strings), and `manifest.json`.
- **Never diet the file to zero bytes**: `autoagent/daemon_cycle.py` → `_read_sections` emits SCOPE-FILE-EMPTY and directs a `C3: FAIL` verdict on an empty scope file.
