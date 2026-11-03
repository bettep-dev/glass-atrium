# RESEARCH Scope Rules

## Retrieval Guidance [RESEARCH]

- **Source recency label**: cite each external source as `URL + collected_at(YYYY-MM-DD)`.
  - A source dated 3 or more years back also carries `[Dated: YYYY]`.
  - A paper with no URL cites its DOI, or its title and year, in the URL's place.
    - It carries `[Date Unknown]` only when its year is unknown.

## Iterative Codebase Retrieval [RESEARCH]

- **Entry condition — both halves hold, or the loop does not run**:
  - the target is the project codebase, never web or literature research;
  - a first-pass Glob/Grep returned ambiguous, oversized (>50 hits) or unrelated results.
- **Loop**: judge the hits → refine → stop once the hit set answers the question, at most three query rounds.
- **Judge the hits** on relevance (implements the queried concept, not merely mentions it), specificity (exact symbol and domain term), recency, and authority (`rules/`, `agents/` and module entries over tests, changelogs, archives and `.bak` copies).
- **Refine**: derive the next query from the strongest hit's vocabulary, widen the Korean/English synonym pair, or narrow the path scope.
- **Inconclusive exit**: third round ends unanswered → return `[Codebase Inconclusive]` plus the top-3 hits, each with a one-line ranking reason, and defer scope clarification to the caller.
