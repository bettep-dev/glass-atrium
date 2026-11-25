# Architecture patterns — pipeline combinations and Agent Teams

- **Pointer sites**: `skills/glass-atrium-ops-orchestrator.md` → `#### Explicit Pipeline Combinations [ORCHESTRATOR]` · `#### Agent Teams Hybrid [ORCHESTRATOR]`, which state each trigger.

## Explicit Pipeline Combinations

- `glass-atrium-intel-researcher` → `glass-atrium-intel-planner` → domain agents → `glass-atrium-intel-reporter` — research results → plan design → domain-expert section authoring → report synthesis.
  - Domain agents (DEV, glass-atrium-design-designer, etc.) are selected by content relevance.
- **Stage ordering**: create a successor stage only after its predecessor completes.
  - Within the domain-agents stage, several domain agents may run in parallel on independent sections.
- **Workflow-mode mapping**: under ultracode the combination is a `pipeline()` sequence, so the engine enforces stage order.
  - The acceptance criteria stay orchestrator-authored verify-stages, never inferred by the engine: `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria [ORCHESTRATOR]`.

## Agent Teams Hybrid

### Application criteria

| Task Type | Pattern |
|-----------|------|
| Parallel research exploration | Agent Teams |
| Independent module parallel development (front+back) | Agent Teams + worktree |
| Builder-Validator (code+review simultaneously) | Agent Teams |
| Large-scale refactoring (directory splitting) | Agent Teams + worktree |
| Sequential dependent pipeline | Sub-agent |
| Single file/module modification | Single sub-agent |
| Concurrent modification of same file, or two index mutators in one worktree | Sub-agent (sequential) |

### Operational rules

- **Team size** — 2-3 members for the pure Agent Teams pattern.
  - Overall delegation team size has no fixed-number gate: `skills/glass-atrium-ops-orchestrator.md` → `#### Team Size`.
- **Model tiering** — assign Lead and Teammate tiers per `skills/glass-atrium-ops-orchestrator-role.md` → `### Cost-Tier Selection`, as natural-language instructions, never a hardcoded tier or version string.
- Control Wave execution (parallel → sequential) via the `blockedBy` field.
- **Clean up idle Teammates immediately** — close out every finished delegation this session started: a teammate, a sub-agent or a workflow agent, not only an Agent Teams member.
  - Fires once a delegation's result is accepted, and again at `skills/glass-atrium-ops-orchestrator.md` → **Team termination**.
  - **Stop the delivered agent**: stop the agent once its task is delivered, together with every background shell it started.
  - **Stop its orphaned processes**: stop any process, whatever its kind, whose cwd is inside a finished delegation's worktree and whose spawning agent has stopped.
    - Reach: this session's own delegations' worktrees only — never another session's process. This limit is the orchestrator's own, not part of the owner's answer.
  - **Remove its worktree when the safe test passes** — no per-batch question; all four must hold:
    - its branch is contained in main or in the deployed commit;
    - no uncommitted or untracked change, apart from ignored build output;
    - no live writer lock (`hooks/lib/worktree-lock.sh`);
    - no process runs with its cwd inside it (the orphan step runs first).
  - Remove only by `git worktree remove` without `--force`, the path a guarded variable (`agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### File Deletion Policy [ALL]`).
    - A failed test or a git refusal leaves the worktree for a later close-out — after its merge or deploy.
  - **Report what went**: name every agent and process stopped (its command and cwd) and every worktree removed; in a background job session, inside the end report.
  - The owner's answers (queue items 451, 452): "기준을 통과하면 에이전트가 바로 삭제" · "기준에 맞으면 모두 종료하고 보고".
  - Honest backing: honor-system — no hook sees "delivered", and none ties a delivered result to a stop or a removal.
- Deactivate unused MCP servers.

### Anti-patterns

- Unspecified file ownership
- Lead directly participating in implementation

### Rule conflict priority

Prohibition rules > Security > Quality gates > Cost limits > Team size

- Why quality outranks cost: `skills/glass-atrium-ops-orchestrator.md` → `### Cost Optimization [ORCHESTRATOR]` → **Quality over cost**.
- Scope: this ordering resolves conflicts inside the Agent Teams pattern; cross-tier conflicts follow `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution`.
