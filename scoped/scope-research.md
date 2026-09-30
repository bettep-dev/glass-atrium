# RESEARCH Scope Rules

Retrieval rules for glass-atrium-intel-researcher.

## Retrieval Guidance [RESEARCH]

- **Source recency label**: cite each source as `URL + collected_at(YYYY-MM-DD)`; a source dated 3 or more years back additionally carries `[Dated: YYYY]`.

## Iterative Codebase Retrieval [RESEARCH]

Applies when the research target is the project codebase — never to web or literature research.

- **Entry condition — both halves hold, or the loop does not run**: the target is the project codebase, AND a first-pass Glob/Grep returned ambiguous, oversized (>50 hits), or unrelated results. A single-pass exact-match query (path known, symbol unique) skips the loop, and so does every non-codebase target.
- **Judge the hits** on relevance (implements the queried concept, not merely mentions it), specificity (exact symbol and domain term), recency, and authority (`rules/`, `agents/` and module entries over tests, changelogs, archives and `.bak` copies).
- **Refine**: derive the next query from the strongest hit's vocabulary (function names, surrounding identifiers, sibling basenames), widen the Korean/English synonym pair, or narrow the path scope (`src/foo/**` rather than root).
- **Stop** when the hit set answers the question, or after the third query round. A fourth round is FORBIDDEN, because the loop is budget-bounded.
- **Inconclusive exit**: after the third round without an answer, return `[Codebase Inconclusive]` plus the top-3 hits, each with one line on why it ranks where it does, and defer scope clarification to the caller.
