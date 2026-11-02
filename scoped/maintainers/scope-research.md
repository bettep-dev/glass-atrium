# Maintainer note — `scoped/scope-research.md`

Maintainer-facing material for that source file and for `agents/glass-atrium-intel-researcher.md`, plus the record of what the cut-and-restructure pass removed.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: both surviving headings carry rules rather than stubs, so the source file took no pointer back to this note.

## Status in the corpus

- Tier 2 (Scope), membership `agent_scope ∈ {glass-atrium-intel-researcher}`, inheriting Tier 1. Declared at `rules/glass-atrium/core-compliance-matrix.md` → the Tier 2 table and the Compliance Matrix `scope-research.md` row.
- **Delivery is by the part slots.** This file is the researcher's `rules.scope` in `agent-registry.json`, so it arrives whole at spawn (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).
  - Never copy this file's text into the researcher body, and never point the body at it.
- **DEV citers**: none. dev-rag's codebase-exploration pointer targets `shared-search-first.md`, recorded at `scoped/maintainers/shared-search-first.md`.

## What the cut removed, and why

- **The `> **Loading**: … auto-loads when agent_scope ∈ {…}` stanza** — the selector lives on the registry row, not in the file (`## Status in the corpus`); the reader is `hooks/lib/inject_chunk.py`.
- **`> **Inherits**` · `> **See**` matrix link · `Rules specific to RESEARCH agents: …`** — corpus bookkeeping addressed to an editor, not to the researcher.
- **The whole `## Absolute Rules [RESEARCH]` section.**
  - Its cross-verification bullet is carried in the agent body: `## Absolute Rules` → Cross-verification.
  - Its Wiki-first bullet ordered `~/.glass-atrium/scripts/wiki-query.sh`, which this agent cannot run — `Bash` is outside its frozen grant.
  - The Grep-over-notes path that replaces it is stated by Tier-1 `rules/glass-atrium/core-wiki-reference.md` → `## Knowledge Utilization` → the non-Bash fallback, which names this agent. Rewriting the bullet would have duplicated that canonical, so it was deleted instead.
- **`## Absolute Rules [RESEARCH]` stays deleted.**
  - The final authority on an ambiguous rule is the whole scope file, never a named section: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution`.
  - An `## Absolute Rules [RESEARCH]` heading over the retrieval rules would state no rule of its own and would label the wrong content, which is the signpost convention's failure case rather than its use case.
- **`Wiki false-negative handling`** — same unavailable instrument. `rules/glass-atrium/core-wiki-reference.md` → `## Search Failure Handling` states the retry-with-a-synonym procedure, and that Tier-1 file reaches the researcher on the host channel.
- **`Corrective pass trigger`** — the body's `## Corrective Pass Decision Tree (Failure Prevention)` carries the triggers, and `## Pre-Execution Checkpoint` already flags `[Single Source — Unverified]`.
- **The `[Date Unknown]` half of the recency-label bullet** — body `### Single Source Verification Checklist` carries the date check, and the Tier-1 wiki rule carries the label.
  - What survived is the residue neither carries:
    - the `URL + collected_at(YYYY-MM-DD)` citation form (`collected_at`: zero hits in the body);
    - the 3-year trigger for `[Dated: YYYY]` (the body's `Recency` reliability row ranks `3+yr` but sets no labelling trigger).
- **The Stop-RAG cap rationale** (arxiv 2510.14337) — provenance of a decision, addressed to whoever might change the cap rather than to the agent applying it.
  - The finding: beyond 3 iterations the marginal precision gain falls below the additional token cost. That is why the cap is 3 (**Loop**), and why **Inconclusive exit** surfaces ambiguity to the caller instead of extending the loop.
- **The scored loop** — the `### EVALUATE rubric` table, the per-hit mean and cycle median, the 0.7 threshold and the per-round `[ECC cycle N]` status line.
  - Why: each made the model compute a score or narrate every round; hits are now ranked by judgment on the same four criteria (`## Iterative Codebase Retrieval [RESEARCH]` → **Judge the hits**).
  - Kept: the entry condition, the three-round cap (**Loop**) and the `[Codebase Inconclusive]` return with its top-3 hits (**Inconclusive exit**).

## Two unexecutable instruments, and how each landed

- **`wiki-query.sh`** — deleted with its bullets, above.
- **The rubric's `Recency` row** anchored on `git status touched` and on 30-day / 1-year mtime windows. The researcher's frozen grant is `[Read, Glob, Grep, WebSearch, WebFetch, Write]`: no shell, and no mtime surface.
  - Landed as a removal: the row went with the whole rubric (`## What the cut removed, and why` → **The scored loop**).
  - **Judge the hits** keeps recency as a criterion with no anchor.
  - Re-anchoring it: use the one recency signal the grant holds — `Glob` returns matching paths sorted by modification time — never `git status` or an mtime window.

## Readers and coupled tests

- No test reads this file's TEXT. The path is asserted by `scripts/test/test_agent_lifecycle_overhaul.py` (`rules["scope"] == "scoped/scope-research.md"`) and mirrored in `agent-registry.json` and `scripts/agent_lifecycle/registry_ops.py` — rename or move the file and those break.
- `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` excerpts this file for the daemon's rule-improvement verify prompt, keyed on the basename. Its C3 axis fails the verdict when the file reads empty, so never diet a scope file to zero bytes.
- `rules/glass-atrium/core-compliance-matrix.md` carries the path in inline code, which `monitor/src/server/architecture/governance-membership.ts` treats as a declared document and reports absent if the file stops existing.

## Agent body — `agents/glass-atrium-intel-researcher.md`

- No test pins the body's prose; the suites name the agent only as a roster or fixture literal.
- **Cited by name**: `### Raw Source Storage Pipeline` — `rules/glass-atrium/core-wiki-reference.md` → `## Wiki Write Operations`, `skills/glass-atrium-ops-orchestrator.md` (with the Schema/Workflow-mode persistence clause), `hooks/validate-pre-write-raw.sh` header.
- **Raw-store write gate**: `hooks/validate-pre-write-raw.sh` enforces what that section states; a mismatch leaves every suite green.
  - The body names the codes the agent can act on before the write: SCOPE-001 · SCOPE-002 · SCOPE-005 · SCOPE-006.
  - Left out: SCOPE-007 (`Edit` is outside the grant) · SCOPE-008 (nothing to do before the write; the hook's message states the fix).
  - Pins live in `hooks/test/` (grep `SCOPE-00N`); SCOPE-002 has none.
- **Turn-budget stop**: `### Tool Budget & Curation-First` → **Budget** is this agent's only copy of the ~65% stop.
  - `hooks/inject-scope-rules.sh` excludes the agent from `BUDGET_ANALYSIS_AGENTS` as a daemon carrier, and `hooks/test/inject-scope-rules.bats` asserts no budget block arrives, so deleting the bullet leaves no such instruction and no suite goes red.
  - State no static turn number there: the auto-injected turn meter reports the ceiling.
