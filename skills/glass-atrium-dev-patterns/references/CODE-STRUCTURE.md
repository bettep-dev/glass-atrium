# Code Structure — Detailed Rules

## Ordering Principles

| Principle | Description |
|-----------|-------------|
| **Framework-specific** | Component ordering follows the framework's style guide (Angular, React, etc.) |
| **Feature Sections** | Group related public + dependent private together |
| **Section Comments** | A one-line `// <Section>` label. Use in classes with 10+ methods |
| **NestJS Service** | CRUD → domain-specific operations → private helpers |

## Files/Directories

- **Single responsibility per file** — 1 file = 1 class / 1 module
- **Import order**: standard → external → internal (separated by blank lines)
- **Directories**: lowercase + dashes (`components/auth-wizard`)
