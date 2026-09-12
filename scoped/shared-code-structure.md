# Code Structure Rules (Cross-Cutting Concern)

Binds the authoring of new classes, functions, modules and types, any refactor undertaken for structure or complexity, and code review for structural compliance. Configs, build scripts and test fixtures are out of scope.

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
- Type safety: nested generics ≤ 2 levels · extract a type when reused 2+ times or carrying 3+ properties. The escape-hatch ban on `any`/`dynamic`/`Object` is owned by `scoped/shared-type-safety.md` and is not restated here.
- Import direction: Controller → Service → Repository · reverse forbidden
- Barrels: library entry points only · app-internal forbidden
- DI: depend on interfaces · 7+ constructor deps = God Class · circular DI forbidden (forwardRef = design flaw)

## On-demand detail

`skills/glass-atrium-dev-patterns/SKILL.md` and its `references/` keep the lookup half: the 8-category member-ordering table with accessibility, guard-clause and async prose, discriminated-union and branded-type recipes, the LCOM4 method, the barrel decision table, and the rationalization, red-flag and verification lists. Whether a subagent can still invoke that skill once its frontmatter no longer lists it is an open question this file does not settle.
