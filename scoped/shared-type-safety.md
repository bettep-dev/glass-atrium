# Type Safety Rules (Cross-Cutting Concern)

Applies to all DEV agents, plus glass-atrium-meta-prompt-engineer (prompts = code); glass-atrium-meta-agent does NOT inherit it.

## Core Principles

- Using the `any` type is **FORBIDDEN** — replace with `unknown` + type guards
- `as` type assertions SHOULD be minimized — prefer type inference; when unavoidable, a justifying comment is REQUIRED
- `!` non-null assertion — a runtime check MUST precede its use
