# RESEARCH Scope Rules

Retrieval rules for glass-atrium-intel-researcher.

## Retrieval Guidance [RESEARCH]

- **Source recency label**: cite each source as `URL + collected_at(YYYY-MM-DD)`; a source dated 3 or more years back additionally carries `[Dated: YYYY]`.

## Iterative Codebase Retrieval [RESEARCH]

Applies when the research target is the project codebase — never to web or literature research. Loop: **Retrieve → Evaluate → Refine → Stop**, capped at 3 cycles.

- **Entry condition — both halves hold, or the loop does not run**: the target is the project codebase, AND a first-pass Glob/Grep returned ambiguous, oversized (>50 hits), or unrelated results. A single-pass exact-match query (path known, symbol unique) skips the loop, and so does every non-codebase target.
- **Retrieve**: issue Glob/Grep with the current query → collect the path list plus a ≤3-line snippet per hit.
- **Evaluate**: score each hit on the rubric below → arithmetic mean of the scored dimensions per hit → median across hits is the cycle score.
  - Skip any dimension you cannot observe with the tools you hold and average the rest — greenfield leaves no Recency baseline, and a hit set you obtained without a Glob ordering leaves none either.
- **Refine** (cycle score < 0.7): derive the next query from the highest-scoring hit's vocabulary (function names, surrounding identifiers, sibling basenames) OR widen the synonym set (Korean/English pair) OR narrow the path scope (`src/foo/**` rather than root).
- **Stop**: cycle score ≥ 0.7, or cycle count reaches 3 — whichever fires first.
- **Cycle exit reporting**: each cycle emits one line — `[ECC cycle N] query / hit count / aggregate score / next action (refine OR stop)`. The final cycle names its stop reason (threshold met / cap reached).
- **Cap-reached fallback**: cycle 3 ends below 0.7 → stop, return `[Codebase Inconclusive]` plus the top-3 hits with their individual scores, and defer scope clarification to the caller. A 4th cycle is FORBIDDEN.

### EVALUATE rubric

| Dimension | 1.0 | 0.7 | 0.3 | 0 |
|---|---|---|---|---|
| **Relevance** | implements the queried concept (body + tests) | references it in comments / imports | same module, unrelated function | unrelated module / vendored code |
| **Specificity** | exact symbol match + same domain term | partial symbol match + same domain | generic utility shared across domains | keyword only as a docstring substring |
| **Recency** | among the newest paths in the Glob modification-time ordering | newer half of that ordering | older half of that ordering | oldest tail / generated / archived |
| **Authority** | canonical source (`rules/`, `agents/`, module entry) | secondary reference (tests, fixtures, examples) | tangential mention (changelog, README) | archive / `.bak` / pre-refactor copy |
