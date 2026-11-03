# Performance Rules (Cross-Cutting Concern)

## General

- **Lazy loading**: defer modules / data not needed for the initial render.
- **Pagination**: fetching an unbounded record set (no LIMIT / page size) is FORBIDDEN.
  - Prefer cursor-based pagination.
  - The bound is on the fetch, not the UI: infinite-scroll UX is permitted while each page request is bounded.

## Frontend

- **Bundling**: use named imports.
  - Use dynamic imports for lazy-loaded modules.
  - Verify tree-shaking.
- **Rendering**: prevent unnecessary re-renders.
  - Apply `memo` only after measuring.
  - Avoid inline object / array props.
- **Images**: `next/image` or WebP/AVIF.
  - Set width and height explicitly, to prevent CLS.
- **Fonts**: `font-display: swap` + preload.

## Backend

- **DB queries**: N+1 queries are FORBIDDEN (use JOIN / include).
  - Optimize against EXPLAIN ANALYZE.
  - Define the index strategy upfront.
- **Caching**: cache data whose query frequency you measured, not assumed.
  - Set HTTP `Cache-Control` headers.
- **Async**: run independent tasks in parallel with `Promise.all`; sequential `await` of them is FORBIDDEN.
  - An `await` chain on genuine dependencies is correct.
- **Connections**: connection pooling REQUIRED.
  - Configure timeout / limits.

## Android

- **Memory**: resize large Bitmaps.
  - Use `WeakReference` where the reference may outlive the owner.
  - Release resources in `onCleared`.

## Rationalization Rejection (Performance)

| Excuse | Rebuttal |
|--------|----------|
| "This optimization is obvious, no measurement needed" | Obvious optimizations are often wrong · CPU-bound assumptions fail when I/O is the bottleneck · profile first |
| "We can optimize later if it's slow" | Performance debt compounds · N+1 fine at 10 rows, outages at 10K · fix known anti-patterns now |
| "Premature optimization is the root of all evil" | Full quote adds "about 97% of the time" · known anti-patterns (N+1, missing indexes) = the other 3% · fix immediately |
