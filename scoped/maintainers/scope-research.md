# Maintainer note — `scoped/scope-research.md`

Maintainer-facing material for that source file, plus the record of what the cut-and-restructure pass removed from it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: both surviving headings carry rules rather than stubs, so the source file took no pointer back to this note.

## Status in the corpus

- Tier 2 (Scope), membership `agent_scope ∈ {glass-atrium-intel-researcher}`, inheriting Tier 1. Declared at `rules/glass-atrium/core-compliance-matrix.md` → the Tier 2 table and the Compliance Matrix `scope-research.md` row. That membership statement is not a delivery claim — read `### Membership vs. Delivery (per tier)` in the same file before relying on it.
- **Delivery is by on-demand Read, and this file is the corpus's working example of it.** `agents/glass-atrium-intel-researcher.md` routes the agent here twice by ABSOLUTE path — the top-of-body stanza, and `## Goal` → Codebase target.
  - Both pointers now name their heading in full — `## Retrieval Guidance [RESEARCH]` and `## Iterative Codebase Retrieval [RESEARCH]`. Both anchors are load-bearing: a rename here breaks a pointer the agent is told to follow.
  - **Stanza repair LANDED**: its parenthetical listed two guidance items this pass deleted and now names only the surviving source-recency label.
  - The `does not reach this agent at spawn` clause was KEPT, against the disposition that called it stale. `rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)` still states that no Tier-2 body reaches its scope's agent, so the clause is true and is the WHY for the imperative Read beside it.
  - The duplicate went where it actually sat: `## Goal` → Codebase target restated `it is not injected into your context` one screen below the stanza, and that restatement is gone.
- Third citing site: `agents/glass-atrium-dev-rag.md` → its codebase-exploration bullet cites `scope-research.md` → `## Iterative Codebase Retrieval` as the canonical spec for the Stop-RAG loop. That agent is not a member of this scope and reaches the file only through that pointer.
  - That citation names the heading by prefix, without the `[RESEARCH]` suffix — resolvable today, silently wrong the day the suffix changes. Unrepaired: that body is outside every track's file list this wave.

## What the cut removed, and why

- **The `> **Loading**: … auto-loads when agent_scope ∈ {…}` stanza** — the selector it describes does not exist; no code resolves an agent to a scope file at spawn. The membership fact it was carrying is recorded above.
- **`> **Inherits**` · `> **See**` matrix link · `Rules specific to RESEARCH agents: …`** — corpus bookkeeping addressed to an editor, not to the researcher.
- **The whole `## Absolute Rules [RESEARCH]` section.** Its cross-verification bullet is carried twice in the agent body (`## Absolute Rules` → Cross-verification, and `### Reference Numbering`). Its Wiki-first bullet ordered `~/.glass-atrium/scripts/wiki-query.sh`, which this agent cannot run — `Bash` is outside its frozen grant — and both the Tier-1 `rules/glass-atrium/core-wiki-reference.md` non-Bash fallback (which names this agent) and the body's `### Wiki Pre-Check` already state the Grep-over-notes path that replaces it. Rewriting the bullet would have made a third copy, so it was deleted instead.
- **The trade taken on that deleted heading, and the generic citer that named it.** `rules/glass-atrium/core-compliance-matrix.md` → Precedence Resolution used to make "the relevant scope file's Absolute Rules section" each scope's final authority, so the deletion left that citation resolving to nothing here.
  - Repaired at the citer, not by keeping the anchor: the clause now makes the assigned scope file itself the authority — the whole file, never a named section — and names this file as one of the two carrying no such section.
  - Why no signpost heading was kept: an `## Absolute Rules [RESEARCH]` heading over the retrieval rules would state no rule of its own and would label the wrong content, which is the signpost convention's failure case rather than its use case.
  - Why no bullet needed to survive: each was either duplicated in the delivered body or ordered an instrument outside the frozen grant, so the deletion moved no authority away from the agent.
- **`Wiki false-negative handling`** — same unavailable instrument, and the body's `## Corrective Pass Decision Tree` states the same retry-once-with-a-synonym-pair procedure over the tool the agent actually holds.
- **`Corrective pass trigger`** — the body's `## Corrective Pass Decision Tree (Failure Prevention)` carries four triggers where this carried two, and `## Pre-Execution Checkpoint` already flags `[Single Source — Unverified]`.
- **The `[Date Unknown]` half of the recency-label bullet** — body `### Single Source Verification Checklist` carries the date check, and the Tier-1 wiki rule carries the label. What survived is the residue neither carries: the `URL + collected_at(YYYY-MM-DD)` citation form (`collected_at`: zero hits in the body) and the 3-year trigger for `[Dated: YYYY]` (the body's `Recency` reliability row scores `3+yr +0` but sets no labelling trigger).
- **The Stop-RAG cap rationale** (arxiv 2510.14337) — provenance of a decision, addressed to whoever might change the cap rather than to the agent applying it.
  - The finding: beyond 3 iterations the marginal precision gain falls below the additional token cost. That is why the cap is 3, and why the cap-reached fallback surfaces ambiguity to the caller instead of extending the loop.

## Two unexecutable instruments, and how each landed

- **`wiki-query.sh`** — deleted with its bullets, above.
- **The rubric's `Recency` row** anchored on `git status touched` and on 30-day / 1-year mtime windows. The researcher's frozen grant is `[Read, Glob, Grep, WebSearch, WebFetch, Write]`: no shell, and no mtime surface. It was rewritten against the one recency signal the agent does hold — `Glob` returns matching paths sorted by modification time — so the anchors are now positions in that ordering rather than absolute ages, and the skip-a-dimension escape was widened past its greenfield-only example to cover a hit set obtained without an ordering.
  - **Accepted by the orchestrator at wave-5 verify — the row stands, do not revert it.** The grant above was re-verified in the body frontmatter; the old anchors were a duty the rubric's own agent could never discharge.
- Both edits change what the agent reads, because this file is on-demand-Read by that agent. Do not generalise that to the sibling scope files: `scope-wiki.md` and `scope-security.md` have no such route.

## Readers and coupled tests

- No test reads this file's TEXT. The path is asserted by `scripts/test/test_agent_lifecycle_overhaul.py` (`rules["scope"] == "scoped/scope-research.md"`) and mirrored in `agent-registry.json` and `scripts/agent_lifecycle/registry_ops.py` — rename or move the file and those break.
- `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` excerpts this file for the daemon's rule-improvement verify prompt, keyed on the basename. Its C3 axis fails the verdict when the file reads empty, so never diet a scope file to zero bytes.
- `rules/glass-atrium/core-compliance-matrix.md` carries the path in inline code, which `monitor/src/server/architecture/governance-membership.ts` treats as a declared document and reports absent if the file stops existing.
