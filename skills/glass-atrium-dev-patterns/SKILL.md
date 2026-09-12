---
name: glass-atrium-dev-patterns
description: Code structure (member ordering, section separation, Stepdown), function design (SLAP, CQS, complexity), type design (Union, Branded, Narrowing, DTO/Entity), module structure (barrel, import direction, cycle prevention), cohesion/coupling (LCOM4, ISP, DI warnings) for DEV agents
---

## When to Use

Writing new classes, functions, modules, types · refactoring for structure/complexity · code review for structural compliance. Excludes configs, build scripts, test fixtures.

> Structural core relocated: the Newspaper/SRP/cohesion principles and the quick-rule thresholds now live in `scoped/shared-code-structure.md`. What stays here is the on-demand lookup detail below.

## References (Progressive Disclosure)

- **[references/CODE-STRUCTURE.md](references/CODE-STRUCTURE.md)** — Newspaper metaphor, 8-category member ordering with accessibility, Stepdown/Feature Sections/Section Comments, file/directory conventions
- **[references/FUNCTION-DESIGN.md](references/FUNCTION-DESIGN.md)** — SRP, size/complexity criteria, SLAP, Guard Clause, parameters, CQS, async (fire-and-forget, floating promise, catch-OR-rethrow)
- **[references/TYPE-DESIGN.md](references/TYPE-DESIGN.md)** — Discriminated Union (exhaustive never-check), Branded Types, Narrowing Guards, Generic Constraints, DTO vs Entity, Readonly comparison
- **[references/MODULE-COHESION.md](references/MODULE-COHESION.md)** — Import direction, barrel criteria, circular dependency prevention, LCOM4, class split signals, ISP, DI rules, Common Rationalizations, Red Flags, Verification checklist
