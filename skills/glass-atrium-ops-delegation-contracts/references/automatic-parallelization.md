# Automatic Parallelization (standing default — fan out WITHOUT waiting for a per-task user request)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Automatic Parallelization`.

## Fan-out obligation — notes

- **Independent, defined**: no shared-file write, no output-as-input dependency.

## Guardrail (a) — orchestrator-side rules

- **Three sanctioned isolation paths**:
  - a pre-created worktree passed as `cwd` in the delegation prompt, unaffected by Issue #33045;
    - Why the pointer requires target paths rooted in that worktree: a `cwd` is a default, not a container, and an absolute path resolves past it.
  - `isolation: worktree` on the manual Agent path — never with `background: true` (Issue #33045);
  - `opts.isolation:'worktree'` on the ultracode `agent()`/`parallel()` path — background interaction unverified, so do not assume parity.
- **Deciding "at a time"**: whether another index mutator is still live is answered by `skills/glass-atrium-ops-orchestrator.md` → `#### Completion signals`, signal (iii).
- Attestation: the isolation-unit field of a per-track `// [OWNERSHIP]` line is `worktree: <path|isolated>` — author-attested, engine-unverified.
- **Honest backing**: honor-system orchestrator discipline plus an honor-system prompt contract. No hook enforces one index-mutator per worktree, the regeneration barrier or the entry precondition.

## Guardrail (c) — notes

- **Premise-true edges**: a predecessor that makes the dependent's premise true (removing a truncation so its text survives, landing a schema it writes against) is an edge though nothing flows between them.
