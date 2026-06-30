---
name: glass-atrium-dev-patterns
description: Code structure (member ordering, section separation, Stepdown), function design (SLAP, CQS, complexity), type design (Union, Branded, Narrowing, DTO/Entity), module structure (barrel, import direction, cycle prevention), cohesion/coupling (LCOM4, ISP, DI warnings) for DEV agents
---

## When to Use

Writing new classes, functions, modules, types · refactoring for structure/complexity · code review for structural compliance. Excludes configs, build scripts, test fixtures.

## Core Principles

- **Newspaper Metaphor** — top = high-level public API, bottom = low-level private implementation
- **SRP** — if described with "and", split it
- **High cohesion + low coupling** — split on violation

**Quick rules**:

- Member ordering: type sigs → static → decorated → instance → constructors → accessors → static methods → instance methods. Within each: public → protected → private. `readonly` first.
- **Stepdown Rule**: callee directly below caller
- Function cap: **20 lines OR cyclomatic complexity 10** → Extract Method
- **SLAP**: one abstraction level per function ("And-Then test")
- **CQS**: Commands → void · Queries → T · no mixing
- Type safety: `any`/`dynamic`/`Object` forbidden · nested generics ≤ 2 levels · extract when reused 2+ times or 3+ properties
- Import direction: Controller → Service → Repository · reverse forbidden
- Barrels: library entry points only · app-internal forbidden
- DI: depend on interfaces · 7+ constructor deps = God Class · circular DI forbidden (forwardRef = design flaw)

## References (Progressive Disclosure)

- **[references/CODE-STRUCTURE.md](references/CODE-STRUCTURE.md)** — Newspaper metaphor, 8-category member ordering with accessibility, Stepdown/Feature Sections/Section Comments, file/directory conventions
- **[references/FUNCTION-DESIGN.md](references/FUNCTION-DESIGN.md)** — SRP, size/complexity criteria, SLAP, Guard Clause, parameters, CQS, async (fire-and-forget, floating promise, catch-OR-rethrow)
- **[references/TYPE-DESIGN.md](references/TYPE-DESIGN.md)** — Discriminated Union (exhaustive never-check), Branded Types, Narrowing Guards, Generic Constraints, DTO vs Entity, Readonly comparison
- **[references/MODULE-COHESION.md](references/MODULE-COHESION.md)** — Import direction, barrel criteria, circular dependency prevention, LCOM4, class split signals, ISP, DI rules, Common Rationalizations, Red Flags, Verification checklist
