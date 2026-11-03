# Maintainer note — `scoped/scope-research.md`

Corpus-maintenance companion to that scope file; no agent receives this note at spawn.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Status in the corpus

- **Delivery is by the part slots.** The scope file is the researcher's Tier-2 `rules.scope` in `agent-registry.json`, so it arrives whole at spawn (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).
  - Never copy its text into the researcher body.
- **Reserved anchors**: `agents/glass-atrium-intel-researcher.md` → **Codebase target** cites `## Iterative Codebase Retrieval [RESEARCH]` by full name, suffix included, and a rename breaks a pointer the agent is told to follow.

## What the cut removed, and why

- **The `> **Loading**` · `> **Inherits**` · `> **See**` stanza and `Rules specific to RESEARCH agents: …`** — the selector lives on the registry row, read by `hooks/lib/inject_chunk.py`; the rest is bookkeeping addressed to an editor.
- **The whole `## Absolute Rules [RESEARCH]` section.**
  - Its cross-verification bullet is carried twice in the agent body: `## Absolute Rules` → Cross-verification, and `### Reference Numbering`.
  - Its Wiki-first bullet ordered `~/.glass-atrium/scripts/wiki-query.sh`, outside the frozen grant (no `Bash`).
    - The replacement path is Tier-1 `rules/glass-atrium/core-wiki-reference.md` → `## Knowledge Utilization` → **Non-Bash fallback**, which names this agent.
  - No signpost heading: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution` makes the whole scope file the authority, never a named section.
    - An `## Absolute Rules [RESEARCH]` heading over the retrieval rules would state no rule of its own and label the wrong content.
- **`Wiki false-negative handling`** — `rules/glass-atrium/core-wiki-reference.md` → `## Search Failure Handling` states the retry-with-a-synonym procedure, and that Tier-1 file reaches the researcher on the host channel.
- **`Corrective pass trigger`** — the body's `## Corrective Pass Decision Tree (Failure Prevention)` carries the triggers, and `## Pre-Execution Checkpoint` already flags `[Single Source — Unverified]`.
- **The `[Date Unknown]` half of the recency-label bullet** — body `### Single Source Verification Checklist` carries the date check, and the Tier-1 wiki rule carries the label.
  - **Source recency label** keeps the residue neither carries:
    - the `URL + collected_at(YYYY-MM-DD)` citation form;
    - the 3-year trigger for `[Dated: YYYY]` (the body's `Recency` reliability row scores `3+yr +0` but sets no labelling trigger);
    - the citation form for a paper with no URL, which the body's **Sources mandatory** allows, and which reads the label's unknown date as an unknown year.
- **The scored loop** — the `### EVALUATE rubric` table, the per-hit mean and cycle median, the 0.7 threshold and the per-round `[ECC cycle N]` status line.
  - Why: each made the model compute a score or narrate every round; **Judge the hits** ranks by judgment on the same four criteria.
  - The rubric's `Recency` row anchored on `git status touched` and 30-day / 1-year mtime windows; the frontmatter `tools:` grant holds neither.
  - Re-anchoring recency: use the one signal the grant holds — `Glob` returns matching paths sorted by modification time — never `git status` or an mtime window.
- **The Stop-RAG cap rationale** (arxiv 2510.14337v1) — the three-round cap (**Loop**) has no verified measurement behind it.
  - A word grep of the v1 HTML found no 3-iteration threshold statement.
  - The fixed-iteration baseline results in v1 were not read.
  - v1 states that each iteration costs latency and tokens, and that its own pipeline allows a maximum of 10 iterations.
  - Changing the cap needs its own measurement.

## Readers and coupled tests

- No test reads the scope file's text.
  - The path is asserted by `scripts/test/test_agent_lifecycle_overhaul.py` (`rules["scope"] == "scoped/scope-research.md"`) and mirrored in `agent-registry.json` and `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_RULE_FILES` — rename or move the file and those break.
- `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` excerpts the scope file for the daemon's rule-improvement verify prompt, keyed on the basename.
  - Its C3 axis fails the verdict when the file reads empty, so never diet a scope file to zero bytes.
- `rules/glass-atrium/core-compliance-matrix.md` carries the path in inline code, which `monitor/src/server/architecture/governance-membership.ts` treats as a declared document and reports absent if the file stops existing.
