# Code Structure — Detailed Rules

Companion reference for `glass-atrium-dev-patterns/SKILL.md`. Load when ordering class members, organizing files, or laying out directories.

The principles — Newspaper Metaphor, Stepdown Rule, the member-order and `readonly` summary — are in `scoped/shared-code-structure.md` → `## Core Principles`. This file keeps the lookup detail.

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

- **Framework-specific**: component ordering follows the framework's style guide (Angular, React, etc.).

## Ordering Principles

| Principle | Description |
|-----------|-------------|
| **Feature Sections** | Group related public + dependent private together |
| **Section Comments** | A one-line `// <Section>` label, no banner or ASCII decoration (`scoped/shared-comment-logging.md` → `## Comment Language & Style`). Use in classes with 10+ methods |
| **NestJS Service** | CRUD → domain-specific operations → private helpers |

## Files/Directories

- **Single responsibility per file** — 1 file = 1 class / 1 module
- **Import order**: standard → external → internal (separated by blank lines)
- **Directories**: lowercase + dashes (`components/auth-wizard`)
