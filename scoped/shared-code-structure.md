# Code Structure Rules (Cross-Cutting Concern)

- Binds authoring new classes, functions, modules and types · any refactor for structure or complexity · code review for structural compliance.
- Out of scope: configs, build scripts, test fixtures.

## Core Principles

- **Newspaper Metaphor** — top = high-level public API, bottom = low-level private implementation
- **Stepdown Rule**: callee directly below caller, among module-level functions and within one member-ordering group at one accessibility level
- Member ordering: type sigs → static → decorated → instance → constructors → accessors → static methods → instance methods
  - Within each: public → protected → private
    - Exception: a class using sections follows `skills/glass-atrium-dev-patterns/references/CODE-STRUCTURE.md` → **Feature Sections**
  - `readonly` first
- **SRP** — if described with "and", split it
- Function cap: **20 lines OR cyclomatic complexity 10** → Extract Method
- **SLAP**: one abstraction level per function ("And-Then test")
- **CQS**: Commands → void · Queries → T · no mixing
- **High cohesion + low coupling** — split on violation
- **One owner per derived fact** — a derived domain fact copied into a second place is semantic duplication: it takes its one owner at the second copy, not the third.
  - A comment keeping two derivations in step marks a missing owner and is forbidden in new code.
  - An allow-list, enum list or guard written by hand from a generated or DB source (schema, migration, CHECK) is such a copy — derive it from that source, or bind the two with a test that fails when they differ.
  - A limit enforced in more than one layer (request validation, model, DB column or CHECK) is one fact, counted in one unit across every layer (characters vs bytes, seconds vs milliseconds).
- Import direction: Controller → Service → Repository · reverse forbidden
- Barrels: library entry points only · app-internal forbidden
- DI:
  - depend on interfaces
  - 7+ constructor deps = God Class
  - circular DI forbidden (forwardRef = design flaw)
- Type safety:
  - nested generics ≤ 2 levels
  - extract a type when reused 2+ times or carrying 3+ properties
  - escape-hatch ban on `any`/`dynamic`/`Object` → `scoped/shared-type-safety.md`

## On-demand detail

- `skills/glass-atrium-dev-patterns/SKILL.md` and its `references/` keep the lookup half:
  - the ordering principles and file/directory conventions
  - guard-clause and async prose
  - discriminated-union and branded-type recipes
  - the LCOM4 method and the barrel decision table
  - the rationalization and verification lists
- No agent frontmatter preloads that skill: when a topic in this file applies, open its `SKILL.md` by path with Read.
