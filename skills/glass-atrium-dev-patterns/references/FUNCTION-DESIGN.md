# Function Design — Detailed Rules

Companion reference for `glass-atrium-dev-patterns/SKILL.md`. Load when writing or refactoring functions.

## Function Design [DEV]

**SRP** — If described with "and", split it.

## Dual Criteria: Size/Complexity

| Criterion | Upper Limit | When Exceeded |
|-----------|-------------|---------------|
| **Line count** | 20 lines | Extract Method |
| **Cyclomatic complexity** | 10 (McCabe) | Extract Method required |

If either is exceeded → extraction target.

## Core Principles

| Principle | Description |
|-----------|-------------|
| **SLAP** | All calls within a function = same abstraction level. Detect violations with "And-Then test" |
| **Guard Clause** | Error handling at the top → happy path last. Prefer early return |
| **Parameters** | 3 or fewer (exceeds → use object). Explicitly state side effects |

## CQS (Command-Query Separation)

| Aspect | Command | Query |
|--------|---------|-------|
| **Purpose** | Mutate state | Return data |
| **Return** | void | T |
| **Side effects** | Yes | None |

- Mixing forbidden — only idiomatic patterns like `stack.pop` are exceptions

## async Design

| Pattern | Rule |
|---------|------|
| **fire-and-forget** | `void fn().catch(handler)` — use void to express intent |
| **floating promise** | Forbidden — ESLint `no-floating-promises` |
| **catch-OR-rethrow** | Choose one (both causes duplicate logs) |
