# Type Safety Rules (Cross-Cutting Concern)

Applies to all DEV agents.

## Core Principles

- Using the `any` type is **FORBIDDEN** — replace with `unknown` + type guards
- `as` type assertions SHOULD be minimized — prefer type inference; when unavoidable, a justifying comment is REQUIRED
- Leverage generics — apply type parameters to reusable functions and components
- `!` non-null assertion — a runtime check MUST precede its use

## Framework-Specific Rules

- **Angular**: `any` / `as` are completely FORBIDDEN · prefer type guards and unknown + narrowing
- **React/Next.js**: Props interfaces are REQUIRED for components · children type MUST be explicit
- **NestJS**: DTOs MUST use class-validator decorators · enums SHOULD be separated by feature
