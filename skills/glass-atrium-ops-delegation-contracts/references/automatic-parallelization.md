# Automatic Parallelization (standing default — fan out WITHOUT waiting for a per-task user request)

- **Pointer site**: `rules/glass-atrium/orchestrator-role.md` → `### Spawn Budget` → `#### Automatic Parallelization`.
- **Agent-binding half of guardrail (a)**: `rules/glass-atrium/core-git-workflow.md` → Commits → **Concurrent worktree** — the SoT for the index-mutation class, the index-owner rule, the regeneration barrier, the entry precondition, the delegation-side contract, who commits and read-only.

## Fan-out obligation — notes

- **Independent, defined**: no shared-file write, no output-as-input dependency.

## Guardrail (a) — mechanisms

- Disjoint file ownership is the floor, not the ceiling.
- The shared index and whole-tree regeneration sit beside the rules that answer them: `rules/glass-atrium/core-git-workflow.md` → Commits → **Concurrent worktree** → **Shared index** · **Whole-tree regeneration**.

## Guardrail (a) — orchestrator-side rules

- **Three sanctioned isolation paths**:
  - a PRE-CREATED worktree passed as `cwd` in the delegation prompt, unaffected by Issue #33045;
    - Why the pointer requires target paths rooted in that worktree: a `cwd` is a default, not a container, and an absolute path resolves past it.
  - `isolation: worktree` on the manual Agent path — never with `background: true` (Issue #33045);
  - `opts.isolation:'worktree'` on the ultracode `agent()`/`parallel()` path — background interaction unverified, so do not assume parity.
- **Deciding "at a time"**: whether another index mutator is still live is answered by `skills/glass-atrium-ops-orchestrator.md` → Completion signals, signal (iii) — the liveness ledger is the only signal that answers ABSENCE.
- Attestation: the isolation-unit field of a per-track `// [OWNERSHIP]` line is `worktree: <path|isolated>` — author-attested, engine-unverified.
- **HONEST BACKING**: honor-system orchestrator discipline plus an honor-system prompt contract. No hook enforces one index-mutator per worktree, the barrier or the entry precondition.

## Guardrail (c) — notes

- **Why sequential**: a shared-file write is exactly the race disjoint ownership exists to prevent.
- **Premise-true edges**: a predecessor that makes the dependent's premise true (removing a truncation so its text survives, landing a schema it writes against) is an edge though nothing flows between them.
- **Reach of the no-shared-wave rule**: it binds a whole-plan fan-out exactly as it binds a subset.
