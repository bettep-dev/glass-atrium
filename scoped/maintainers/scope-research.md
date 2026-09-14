# Maintainer note — `scoped/scope-research.md`

Maintainer-facing material for that source file, plus the record of what the cut-and-restructure pass removed from it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: both surviving headings carry rules rather than stubs, so the source file took no pointer back to this note.

## Status in the corpus

- Tier 2 (Scope), membership `agent_scope ∈ {glass-atrium-intel-researcher}`, inheriting Tier 1. Declared at `rules/glass-atrium/core-compliance-matrix.md` → the Tier 2 table and the Compliance Matrix `scope-research.md` row.
- **Delivery is by the part slots.** This file is the researcher's `rules.scope` in `agent-registry.json`, so it arrives whole at spawn (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).
  - A researcher-body line saying this file does not reach the agent at spawn, or telling the agent to Read it itself, is false. Correct it at the body; it is never a reason to copy this file's text into the body.
- **Reserved anchor**: `## Iterative Codebase Retrieval [RESEARCH]` is cited by full name, suffix included, from `agents/glass-atrium-intel-researcher.md` → `## Goal` → Codebase target. A rename here breaks that citation.
- **No DEV body cites this file.** `agents/glass-atrium-dev-rag.md` → Codebase exploration points at `scoped/shared-search-first.md` → Pattern recognition → **Inconclusive probe**, which every DEV row holds; `scoped/maintainers/shared-search-first.md` records the same state.

## What the cut removed, and why

- **The `> **Loading**: … auto-loads when agent_scope ∈ {…}` stanza** — the selector is the registry row's `rules.scope`, read at spawn by `hooks/lib/inject_chunk.py`, not a stanza inside the file. The membership fact it carried is recorded above.
- **`> **Inherits**` · `> **See**` matrix link · `Rules specific to RESEARCH agents: …`** — corpus bookkeeping addressed to an editor, not to the researcher.
- **The whole `## Absolute Rules [RESEARCH]` section.**
  - Its cross-verification bullet is carried twice in the agent body: `## Absolute Rules` → Cross-verification, and `### Reference Numbering`.
  - Its Wiki-first bullet ordered `~/.glass-atrium/scripts/wiki-query.sh`, which this agent cannot run — `Bash` is outside its frozen grant.
  - The Grep-over-notes path that replaces it is stated by Tier-1 `rules/glass-atrium/core-wiki-reference.md` → `## Knowledge Utilization` → the non-Bash fallback, which names this agent. Rewriting the bullet would have duplicated that canonical, so it was deleted instead.
- **The trade taken on that deleted heading, and the generic citer that named it.** `rules/glass-atrium/core-compliance-matrix.md` → Precedence Resolution used to make "the relevant scope file's Absolute Rules section" each scope's final authority, so the deletion left that citation resolving to nothing here.
  - Repaired at the citer, not by keeping the anchor: the clause now makes the assigned scope file itself the authority — the whole file, never a named section.
  - Why no signpost heading was kept: an `## Absolute Rules [RESEARCH]` heading over the retrieval rules would state no rule of its own and would label the wrong content, which is the signpost convention's failure case rather than its use case.
  - Why no bullet needed to survive: each was either duplicated in text the agent already holds or ordered an instrument outside the frozen grant, so the deletion moved no authority away from the agent.
- **`Wiki false-negative handling`** — same unavailable instrument. `rules/glass-atrium/core-wiki-reference.md` → `## Search Failure Handling` states the retry-once-with-a-synonym procedure, and that Tier-1 file reaches the researcher on the host channel.
- **`Corrective pass trigger`** — the body's `## Corrective Pass Decision Tree (Failure Prevention)` carries four triggers where this carried two, and `## Pre-Execution Checkpoint` already flags `[Single Source — Unverified]`.
- **The `[Date Unknown]` half of the recency-label bullet** — body `### Single Source Verification Checklist` carries the date check, and the Tier-1 wiki rule carries the label.
  - What survived is the residue neither carries: the `URL + collected_at(YYYY-MM-DD)` citation form (`collected_at`: zero hits in the body).
  - And the 3-year trigger for `[Dated: YYYY]`: the body's `Recency` reliability row scores `3+yr +0` but sets no labelling trigger.
- **The Stop-RAG cap rationale** (arxiv 2510.14337) — provenance of a decision, addressed to whoever might change the cap rather than to the agent applying it.
  - The finding: beyond 3 iterations the marginal precision gain falls below the additional token cost. That is why the cap is 3, and why the cap-reached fallback surfaces ambiguity to the caller instead of extending the loop.

## Two unexecutable instruments, and how each landed

- **`wiki-query.sh`** — deleted with its bullets, above.
- **The rubric's `Recency` row** anchored on `git status touched` and on 30-day / 1-year mtime windows. The researcher's frozen grant is `[Read, Glob, Grep, WebSearch, WebFetch, Write]`: no shell, and no mtime surface.
  - Rewritten against the one recency signal the agent does hold — `Glob` returns matching paths sorted by modification time — so the anchors are positions in that ordering rather than absolute ages.
  - The skip-a-dimension escape was widened past its greenfield-only example to cover a hit set obtained without an ordering.
  - **Accepted by the orchestrator — the row stands, do not revert it.** The grant above was re-verified in the body frontmatter; the old anchors were a duty the rubric's own agent could never discharge.
- Both edits change what the agent reads, because this file arrives whole through the researcher's `rules.scope`. `scope-wiki.md` and `scope-security.md` arrive the same way through their own agents' rows; the wiki daily-compile batch call, which passes the curator body as a system prompt, receives no scope file.

## Readers and coupled tests

- No test reads this file's TEXT. The path is asserted by `scripts/test/test_agent_lifecycle_overhaul.py` (`rules["scope"] == "scoped/scope-research.md"`) and mirrored in `agent-registry.json` and `scripts/agent_lifecycle/registry_ops.py` — rename or move the file and those break.
- `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` excerpts this file for the daemon's rule-improvement verify prompt, keyed on the basename. Its C3 axis fails the verdict when the file reads empty, so never diet a scope file to zero bytes.
- `rules/glass-atrium/core-compliance-matrix.md` carries the path in inline code, which `monitor/src/server/architecture/governance-membership.ts` treats as a declared document and reports absent if the file stops existing.
