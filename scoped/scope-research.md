# RESEARCH Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-intel-researcher}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to RESEARCH agents: glass-atrium-intel-researcher.

## Absolute Rules [RESEARCH]

- **3+ source cross-verification REQUIRED**: Single-source claims are FORBIDDEN; cite ≥3 independent sources and reconcile contradictions
- **Wiki-first**: Run `~/.glass-atrium/scripts/wiki-query.sh "keyword"` before web search; reuse existing wiki knowledge to prevent duplicate research

## Retrieval Guidance [RESEARCH]

- **Wiki false-negative handling**: `wiki-query.sh` returns 0 results → retry once with partial keyword OR Korean/English synonym pair → only after the retry yields nothing, treat as "no existing knowledge" and proceed to web search.
- **Source recency label**: cite each source with `URL + collected_at(YYYY-MM-DD)`; sources older than 3 years → label `[Dated: YYYY]`; date-unknown sources → label `[Date Unknown]` and never treat as current information (aligns with `core-wiki-reference.md` Search Failure Handling).
- **Corrective pass trigger**: when sources contradict each other OR a conclusion rests on a single source → run a 3rd-source corrective pass; if 2 corrective passes still fail to resolve, deliver with `[Single Source — Unverified]` label rather than asserting confidence.

## Iterative Codebase Retrieval [RESEARCH]

Codebase-domain specialization of the Deep Research 2026 iterative refinement loop — applies when research target is the project codebase (not web/literature). Loop pattern: **Retrieve → Evaluate → Refine → Stop**, capped at 3 cycles per Stop-RAG empirical ceiling.

- **Trigger**: codebase exploration tasks where first-pass Glob/Grep returns ambiguous, oversized (>50 hits), or unrelated results — straight reading would inflate token cost without sharpening the search target. Single-pass exact-match queries (file path known, symbol name unique) do NOT require this loop.
- **Loop steps**:
  - **Retrieve**: issue Glob/Grep with current query → collect path list + ≤3-line snippet per hit
  - **Evaluate**: score each hit on the 4-dimension rubric below; aggregate to a single 0-1 relevance score
  - **Refine**: if aggregate < 0.7 → derive next query from highest-scoring hit's vocabulary (function names, surrounding identifiers, sibling file basenames) OR widen synonym set (Korean/English pair) OR narrow path scope (`src/foo/**` vs root)
  - **Stop**: aggregate ≥ 0.7 OR cycle count = 3 (Stop-RAG cap) — whichever fires first
- **EVALUATE rubric** (4 dimensions × 4 anchor exemplars):

| Dimension | 1.0 anchor | 0.7 anchor | 0.3 anchor | 0 anchor |
|-----------|------------|------------|------------|----------|
| **Relevance** | hit directly implements the queried concept (function body + tests) | hit references the concept in comments / imports | hit is in same module but unrelated function | hit is in unrelated module / vendored code |
| **Specificity** | exact symbol match + same domain term | partial symbol match (e.g., prefix) + same domain | generic utility shared across domains | matches keyword only as substring in docstring |
| **Recency** | file modified within current task scope (git status touched) | file modified within last 30 days | file modified within last year | file untouched > 1 year / generated / archived |
| **Authority** | canonical source (`rules/`, `agents/`, primary module entry) | secondary reference (test fixtures, examples) | tangential mention (changelog, README) | archive / `.bak` / pre-refactor copy |

  - **Aggregate**: arithmetic mean of 4 dimensions per hit → take median across all hits as cycle score. Skip dimensions when N/A (e.g., greenfield = no Recency baseline → average remaining 3).
- **Stop-RAG cap=3 rationale**: arxiv 2510.14337 empirical finding — beyond 3 iterations, marginal precision gain falls below additional token cost (diminishing returns curve flattens). Forces the agent to surface ambiguity to the user via clarification rather than burning context on a 4th cycle.
- **Cycle exit reporting**: each cycle MUST emit a 1-line `[ECC cycle N]` log — `query / hit count / aggregate score / next action (refine OR stop)`. Final cycle = stop reason (threshold met / cap reached).
- **Cap-reached fallback**: cycle 3 finishes with aggregate < 0.7 → STOP loop, return `[Codebase Inconclusive]` label + top-3 hits with individual scores, defer scope clarification to caller — never silently extend to cycle 4.
