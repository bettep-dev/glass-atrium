# Type Design — Detailed Rules

Companion reference for `glass-atrium-dev-patterns/SKILL.md`. Load when designing types, interfaces, discriminated unions, or DTO/Entity boundaries.

## Type Design [DEV]

**any/dynamic/Object forbidden** — nullable → express in function name and type.

- Used 2+ times or has 3+ properties → extract into a separate type
- Nested generics **2 levels max**

## Discriminated Union

- Branch on a shared literal field (`kind`/`type`)
- exhaustive check: `const _: never = val` in switch `default` clause

## Branded Types

- Pattern: `type UserId = number & { __brand: 'UserId' }`
- **Semantic distinction** of identical base types (UserId vs ProductId). Zero runtime cost

## Narrowing Guard Selection

| Guard | Target | Use Case |
|-------|--------|----------|
| `typeof` | primitive | `string`/`number`/`boolean` |
| `instanceof` | class | Class instances |
| `in` | object shape | Property existence check |
| `is` (type predicate) | custom | Complex type guard functions |
| `asserts` | assertion | Guards that throw exceptions |

## Generic Constraints

| Pattern | Purpose |
|---------|---------|
| `K extends keyof T` | Type-safe key access |
| `T extends object` | Exclude primitives |
| Over-constraining | Forbidden — reduces reusability |

## DTO vs Entity

| Aspect | DTO | Entity |
|--------|-----|--------|
| **Location** | HTTP boundary | Business logic |
| **Validation** | class-validator | Invariants |
| **Exposure** | External allowed | Direct HTTP exposure forbidden |

## Readonly Comparison

| Pattern | Depth | Use Case |
|---------|-------|----------|
| `as const` | Deep immutability + literal types | Config objects, enum replacement |
| `Readonly<T>` | Shallow immutability | Function parameters |
| `readonly T[]` | Array immutability | Function parameters |
