# Performance Rules (Cross-Cutting Concern)

## General

- **Lazy loading**: defer modules / data not needed for the initial render.
- **Pagination**: fetching an unbounded record set (no LIMIT / page size) is FORBIDDEN · prefer cursor-based pagination · the bound is on the FETCH, not the UI — infinite-scroll UX is permitted as long as each page request is bounded.

## Frontend

- **Bundling**: use named imports · dynamic imports (lazy loading) · verify tree-shaking.
- **Rendering**: prevent unnecessary re-renders — apply `memo` only after measuring · avoid inline object / array props.
- **Images**: `next/image` or WebP/AVIF · width and height explicit, to prevent CLS.
- **Fonts**: `font-display: swap` · preload.

## Backend

- **DB queries**: N+1 queries are FORBIDDEN (use JOIN / include) · optimize against EXPLAIN ANALYZE · define the index strategy upfront.
- **Caching**: cache data whose query frequency you measured, not assumed (Redis / in-memory) · set HTTP `Cache-Control` headers.
- **Async**: run independent tasks in parallel with `Promise.all` · sequential `await` of independent tasks is FORBIDDEN (an await chain on genuine dependencies is correct).
- **Connections**: connection pooling REQUIRED · configure timeout / limits.

## Android

- **Memory**: resize large Bitmaps · use `WeakReference` where the reference may outlive the owner · release resources in `onCleared`.

## Rationalization Rejection (Performance)

| Excuse | Rebuttal |
|--------|----------|
| "This optimization is obvious, no measurement needed" | Obvious optimizations are often wrong · CPU-bound assumptions fail when I/O is the bottleneck · profile first |
| "We can optimize later if it's slow" | Performance debt compounds · N+1 fine at 10 rows, outages at 10K · fix known anti-patterns now |
| "Premature optimization is the root of all evil" | Full Knuth quote adds "in 97% of cases" · known anti-patterns (N+1, missing indexes) = the other 3% · fix immediately |
