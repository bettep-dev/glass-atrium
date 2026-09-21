# Type Safety Rules (Cross-Cutting Concern)

Each rule names the construct it binds on. Where the language has no such construct, that rule is inert — it is never generalized to a near-equivalent.

## Core Principles

- **Escape-hatch type (`any`)** — the `glass-atrium-dev-patterns` skill forbids it; the replacement is `unknown` plus a type guard at the boundary, never a widened signature.
- **Type assertion (`as`)** — minimize, prefer inference. Unavoidable → a comment stating why the assertion holds is REQUIRED, and that comment is a sanctioned non-obvious "why" the comment-density ceiling does not delete.
- **Force unwrap / non-null assertion (`!`)** — a runtime check MUST precede its use.
