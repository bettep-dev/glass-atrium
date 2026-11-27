# Type Design — Detailed Rules

## Type Design [DEV]

- **any/dynamic/Object forbidden**
  - Scope: each one used as a type, written or inferred, in a language that has it.
    - Inferred: a value the checker types that way with no annotation, such as an un-annotated parameter or an untyped `JSON.parse` result.
  - Why: such a type switches checking off for every value it types, and the gap spreads to each caller.
- Nullable → express in function name and type

## Discriminated Union

- Branch on a shared literal field (`kind`/`type`)
- exhaustive check: `const _: never = val` in switch `default` clause

## Branded Types

- Pattern: `type UserId = number & { __brand: 'UserId' }`
- Distinguishes identical base types (UserId vs ProductId) at zero runtime cost

## Generic Constraints

- Over-constraining forbidden — reduces reusability

## DTO vs Entity

| Aspect | DTO | Entity |
|--------|-----|--------|
| Location | HTTP boundary | Business logic |
| Validation | Per stack (`rules/glass-atrium/core-security.md` → **All external input MUST be validated**); class-validator on NestJS | Invariants |
| Exposure | External allowed | Direct HTTP exposure forbidden |

## Readonly Comparison

| Pattern | Depth | Use Case |
|---------|-------|----------|
| `as const` | Deep immutability + literal types | Config objects, enum replacement |
| `Readonly<T>` | Shallow immutability | Function parameters |
| `readonly T[]` | Array immutability | Function parameters |
