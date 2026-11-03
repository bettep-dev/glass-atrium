# Code Structure Rules (Cross-Cutting Concern)

- Binds authoring new classes, functions, modules and types · any refactor for structure or complexity · code review for structural compliance.
- Out of scope: configs, build scripts, test fixtures.

## Core Principles

- **Newspaper Metaphor** — top = high-level public API, bottom = low-level private implementation
- **Stepdown Rule**: callee directly below caller
- Member ordering: type sigs → static → decorated → instance → constructors → accessors → static methods → instance methods
  - Within each: public → protected → private
  - `readonly` first
- **SRP** — if described with "and", split it
- Function cap: **20 lines OR cyclomatic complexity 10** → Extract Method
- **SLAP**: one abstraction level per function ("And-Then test")
- **CQS**: Commands → void · Queries → T · no mixing
- **High cohesion + low coupling** — split on violation
- Import direction: Controller → Service → Repository · reverse forbidden
- Barrels: library entry points only · app-internal forbidden
- DI:
  - depend on interfaces
  - 7+ constructor deps = God Class
  - circular DI forbidden (forwardRef = design flaw)
- Type safety:
  - nested generics ≤ 2 levels
  - extract a type when reused 2+ times or carrying 3+ properties
  - the escape-hatch ban on `any`/`dynamic`/`Object` is owned by `scoped/shared-type-safety.md`

## On-demand detail

- `skills/glass-atrium-dev-patterns/SKILL.md` and its `references/` keep the lookup half: member ordering with accessibility · guard clauses and async · discriminated-union and branded-type recipes · the LCOM4 method · the barrel decision table · the rationalization, red-flag and verification lists.
- No agent frontmatter preloads that skill: when a topic in this file applies, open its `SKILL.md` by path with Read.
