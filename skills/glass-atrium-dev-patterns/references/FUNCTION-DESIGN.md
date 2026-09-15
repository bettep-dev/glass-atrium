# Function Design — Detailed Rules

Companion reference for `glass-atrium-dev-patterns/SKILL.md`. Load when writing or refactoring functions.

The principles — SRP, the size/complexity function cap, SLAP with its And-Then test, and CQS's void-vs-T split with no mixing — are in `scoped/shared-code-structure.md` → `## Core Principles`. This file keeps the lookup detail.

## Function Shape

| Principle | Description |
|-----------|-------------|
| **Guard Clause** | Error handling at the top → happy path last. Prefer early return |
| **Parameters** | 3 or fewer (exceeds → use object). Explicitly state side effects |

## CQS (Command-Query Separation)

| Aspect | Command | Query |
|--------|---------|-------|
| **Purpose** | Mutate state | Return data |
| **Side effects** | Yes | None |

- Exception to the no-mixing rule: idiomatic mutate-and-return operations such as `stack.pop`.

## async Design

| Pattern | Rule |
|---------|------|
| **fire-and-forget** | `void fn().catch(handler)` — use void to express intent |
| **floating promise** | Forbidden — ESLint `no-floating-promises` |
| **catch-OR-rethrow** | Log or rethrow, never both in one catch — rule in `scoped/shared-comment-logging.md` → `## Prohibitions` |
