# Performance Rules (Cross-Cutting Concern)

Applies to all DEV agents, plus glass-atrium-meta-prompt-engineer (prompts = code); glass-atrium-meta-agent does NOT inherit it.

## Frontend

- **Bundling**: use named imports · dynamic imports (lazy loading) · verify tree-shaking
- **Rendering**: prevent unnecessary re-renders (apply memo only after measuring) · avoid inline object/array props
- **Images**: use next/image or WebP/AVIF · specify width/height explicitly (prevent CLS)
- **Fonts**: apply `font-display: swap` · use preload

## Backend

- **DB queries**: N+1 queries are FORBIDDEN (use JOIN/include) · optimize based on EXPLAIN ANALYZE · define index strategy upfront
- **Caching**: cache data whose query frequency is measured, not assumed (Redis/in-memory) · set HTTP Cache-Control headers
- **Async**: run independent tasks in parallel with Promise.all · sequential await of independent tasks is FORBIDDEN (an await chain on genuine dependencies is correct)
- **Connections**: connection pooling is REQUIRED · configure timeout/limits

## Android

- **Memory**: resize large Bitmaps · leverage WeakReference · release resources in onCleared

## General

- **Measure first**: speculative optimization is FORBIDDEN · only profiler/benchmark-driven optimization is permitted
- **Lazy loading**: defer loading of modules/data not needed for initial render
- **Pagination**: fetching an unbounded record set (no LIMIT / page size) is FORBIDDEN · prefer cursor-based pagination · the bound is on the fetch, not the UI (infinite-scroll UX is permitted when each page request is bounded)

## Rationalization Rejection (Performance)

| Excuse | Rebuttal |
|--------|----------|
| "This optimization is obvious, no measurement needed" | Obvious optimizations are often wrong · CPU-bound assumptions fail when I/O is the bottleneck · profile first |
| "We can optimize later if it's slow" | Performance debt compounds · N+1 fine at 10 rows, outages at 10K · fix known anti-patterns now |
| "Premature optimization is the root of all evil" | Full Knuth quote adds "in 97% of cases" · known anti-patterns (N+1, missing indexes) = the other 3% · fix immediately |
