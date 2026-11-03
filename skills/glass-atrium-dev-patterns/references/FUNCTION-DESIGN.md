# Function Design — Detailed Rules

## Function Shape

| Principle | Description |
|-----------|-------------|
| **Guard Clause** | Error handling at the top → happy path last. Prefer early return |
| **Parameters** | 3 or fewer (exceeds → use object) |
| **Side effects** | State them explicitly |

## CQS (Command-Query Separation)

- Exception to the no-mixing rule: idiomatic mutate-and-return operations such as `stack.pop`.

## async Design

| Pattern | Rule |
|---------|------|
| **fire-and-forget** | `void fn().catch(handler)` — use void to express intent |
| **floating promise** | Forbidden — ESLint `no-floating-promises` |
