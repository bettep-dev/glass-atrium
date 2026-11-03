---
name: glass-atrium-dev-patterns
description: Code structure (member ordering, section separation, Stepdown), function design (SLAP, CQS, complexity), type design (Union, Branded, DTO/Entity), module structure (barrel, import direction, cycle prevention), cohesion/coupling (LCOM4, ISP, DI) for DEV agents
---

> Core rules: `scoped/shared-code-structure.md` holds the member-ordering, Newspaper/Stepdown, SRP/SLAP, size/complexity, import-direction, cohesion and DI principles and the quick-rule thresholds.

## References (Progressive Disclosure)

| Looking up | Open |
|---|---|
| Framework-specific ordering, Feature Sections, Section Comments, NestJS Service order, file/directory conventions | `references/CODE-STRUCTURE.md` |
| Guard Clause, parameters, CQS, async (fire-and-forget, floating promise, catch-OR-rethrow) | `references/FUNCTION-DESIGN.md` |
| Discriminated Union (exhaustive never-check), Branded Types, Generic Constraints, DTO vs Entity, Readonly comparison | `references/TYPE-DESIGN.md` |
| Barrel criteria, circular dependencies, LCOM4, class split signals, ISP, rationalizations, verification checklist | `references/MODULE-COHESION.md` |
