# Performance Rules (Cross-Cutting Concern)

Applies to all DEV agents.

## Frontend

- **Bundling**: use named imports · dynamic imports (lazy loading) · verify tree-shaking
- **Rendering**: prevent unnecessary re-renders (apply memo only after measuring) · avoid inline object/array props
- **Images**: use next/image or WebP/AVIF · specify width/height explicitly (prevent CLS)
- **Fonts**: apply `font-display: swap` · use preload

## Backend

- **DB queries**: N+1 queries are FORBIDDEN (use JOIN/include) · optimize based on EXPLAIN ANALYZE · define index strategy upfront
- **Caching**: cache frequently queried data (Redis/in-memory) · set HTTP Cache-Control headers
- **Async**: run independent tasks in parallel with Promise.all · sequential await is FORBIDDEN
- **Connections**: connection pooling is REQUIRED · configure timeout/limits

## Mobile

- **Compose**: ensure stability with @Stable/@Immutable · specify keys for LazyColumn/LazyRow · prevent unnecessary recomposition
- **Memory**: resize large Bitmaps · leverage WeakReference · release resources in onCleared

## General

- **Measure first**: speculative optimization is FORBIDDEN · only profiler/benchmark-driven optimization is permitted
- **Lazy loading**: defer loading of modules/data not needed for initial render
- **Pagination**: infinite loading of large datasets is FORBIDDEN · prefer cursor-based pagination

> See the central **Rationalization Rejection Table** in [[GLASS_ATRIUM_GLOBAL_RULES#Rationalization Rejection Table (Central)]]
