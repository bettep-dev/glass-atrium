# Type Safety Rules (Cross-Cutting Concern)

Each rule binds only on the construct it names: where a language lacks it, the rule is inert, never generalized to a near-equivalent.

## Core Principles

- **Escape-hatch type (`any`)** — the `glass-atrium-dev-patterns` skill forbids it; the replacement is `unknown` plus a type guard at the boundary, never a widened signature.
- **Type assertion (`as`)** — minimize, prefer inference.
  - Unavoidable → a comment stating why the assertion holds is REQUIRED; the comment-density ceiling does not delete it.
- **Force unwrap / non-null assertion (`!`)** — a runtime check MUST precede its use.
