# Code Structure — Detailed Rules

## Ordering Principles

| Principle | Description |
|-----------|-------------|
| **Framework-specific** | Component ordering follows the framework's style guide (Angular, React, etc.) |
| **Feature Sections** | Group related public + dependent private — the named exception to accessibility order, in a class using sections |
| **Section Comments** | One-line `// <Section>`, only if members hide the group's why (`scoped/shared-comment-logging.md` → **Density gate**) |
| **NestJS Service** | CRUD → domain-specific operations → private helpers |

## Files/Directories

- **Single responsibility per file** — 1 file = 1 class / 1 module
- **Import order**: by default standard → external → internal (separated by blank lines); a sibling's form wins (`scoped/shared-search-first.md` → **Step 3 — Mirror**)
- **Directories**: by default lowercase + dashes (`components/auth-wizard`); a sibling's form wins (`scoped/shared-search-first.md` → **Step 3 — Mirror**)
