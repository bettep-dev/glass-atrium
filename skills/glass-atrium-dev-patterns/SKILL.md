---
name: glass-atrium-dev-patterns
description: Code structure (member ordering, section separation, Stepdown), function design (SLAP, CQS, complexity), type design (Union, Branded, DTO/Entity), module structure (barrel, import direction, cycle prevention), cohesion/coupling (LCOM4, ISP, DI warnings) for DEV agents
---

> Core rules: the member-ordering, Newspaper/Stepdown, SRP/SLAP, size/complexity, import-direction, cohesion and DI principles and the quick-rule thresholds are in `scoped/shared-code-structure.md`. This file is the on-demand lookup detail those rules defer to.

## References (Progressive Disclosure)

- **[references/CODE-STRUCTURE.md](references/CODE-STRUCTURE.md)** — Framework-specific ordering, Feature Sections/Section Comments, NestJS Service order, file/directory conventions
- **[references/FUNCTION-DESIGN.md](references/FUNCTION-DESIGN.md)** — Guard Clause, parameters, CQS, async (fire-and-forget, floating promise, catch-OR-rethrow)
- **[references/TYPE-DESIGN.md](references/TYPE-DESIGN.md)** — Discriminated Union (exhaustive never-check), Branded Types, Generic Constraints, DTO vs Entity, Readonly comparison
- **[references/MODULE-COHESION.md](references/MODULE-COHESION.md)** — Barrel criteria, circular dependency prevention, LCOM4, class split signals, ISP, Common Rationalizations, Verification checklist
