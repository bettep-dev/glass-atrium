# Code Structure — Detailed Rules

Companion reference for `glass-atrium-dev-patterns/SKILL.md`. Load when ordering class members, organizing files, or laying out directories.

## Code Structure [DEV]

**Newspaper Metaphor** — Top of file = high-level public API, bottom = low-level private implementation.

## Member Ordering

| # | Category | Accessibility Order |
|---|----------|---------------------|
| 1 | type signatures / interfaces | - |
| 2 | static fields | public → protected → private |
| 3 | decorated fields (`@Inject` etc.) | public → protected → private |
| 4 | instance fields | public → protected → private |
| 5 | constructors | - |
| 6 | accessors (get/set) | public → protected → private |
| 7 | static methods | public → protected → private |
| 8 | instance methods | public → protected → private |

- **readonly** fields SHOULD be placed first within the same category
- **Framework-specific**: Component ordering follows the respective style guide (Angular/React etc.)

## Ordering Principles

| Principle | Description |
|-----------|-------------|
| **Stepdown Rule** | Place callee directly below caller — "caller-before-callee" |
| **Feature Sections** | Group related public + dependent private together |
| **Section Comments** | `// ===== Section =====` format. Use in classes with 10+ methods |
| **NestJS Service** | CRUD → domain-specific operations → private helpers |

## Files/Directories

- **Single responsibility per file** — 1 file = 1 class / 1 module
- **Import order**: standard → external → internal (separated by blank lines)
- **Directories**: lowercase + dashes (`components/auth-wizard`)
- **Large classes**: 500+ lines → consider splitting first (SRP violation signal)
