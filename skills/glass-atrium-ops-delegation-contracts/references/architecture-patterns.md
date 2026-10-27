# Architecture patterns — pipeline combinations and Agent Teams

- **Pointer sites**: `skills/glass-atrium-ops-orchestrator.md` → `### Architecture Patterns [ORCHESTRATOR]` → `#### Explicit Pipeline Combinations [ORCHESTRATOR]` (when a Pipeline is enforced) and `#### Agent Teams Hybrid [ORCHESTRATOR]` (when Agent Teams apply) — each trigger lives there, not here.

## Explicit Pipeline Combinations

Combinations that meet the Pipeline trigger:

- `glass-atrium-intel-researcher` → `glass-atrium-intel-planner` → domain agents → `glass-atrium-intel-reporter` — research results → plan design → domain-expert section authoring → report synthesis.
  - Domain agents (DEV, glass-atrium-design-designer, etc.) are selected by content relevance.
- **Stage ordering**: create a successor stage only after its predecessor completes.
  - Within the domain-agents stage, several domain agents may run in parallel on independent sections.
- **Workflow-mode mapping**: under ultracode the combination is a `pipeline()` sequence; the engine enforces stage order and passes each stage's output to the next.
  - The acceptance criteria stay orchestrator-authored verify-stages, never inferred by the engine: `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria [ORCHESTRATOR]`.

## Agent Teams Hybrid

### Application criteria

| Task Type | Pattern |
|-----------|------|
| Parallel research exploration (2-3 members) | Agent Teams |
| Independent module parallel development (front+back) | Agent Teams + worktree |
| Builder-Validator (code+review simultaneously) | Agent Teams |
| Large-scale refactoring (directory splitting) | Agent Teams + worktree |
| Sequential dependent pipeline | Sub-agent |
| Single file/module modification | Single sub-agent |
| Concurrent modification of same file, or two index mutators in one worktree | Sub-agent (sequential) |

### Operational rules

- **Team size** — 2-3 members for the pure Agent Teams pattern; the cap is specific to this pattern, not a global limit.
  - Overall delegation team size has no fixed-number gate: `skills/glass-atrium-ops-orchestrator.md` → `#### Team Size`.
- **Model tiering** — assign Lead and Teammate tiers per `rules/glass-atrium/orchestrator-role.md` → `### Cost-Tier Selection`, as natural-language instructions, never a hardcoded tier or version string.
- Control Wave execution (parallel → sequential) via the `blockedBy` field.
- Clean up idle Teammates immediately.
- Deactivate unused MCP servers.

### Anti-patterns

- Unspecified file ownership
- Lead directly participating in implementation
- Using Delegate Mode (bug: Teammate loses all tools)

### Rule conflict priority

Prohibition rules > Security > Quality gates > Cost limits > Team size

- Why quality outranks cost: `skills/glass-atrium-ops-orchestrator.md` → `### Cost Optimization [ORCHESTRATOR]` never rejects a superior architecture on cost alone, and the charter orders Correctness → Safety → Quality → Speed.
- Scope: this ordering resolves conflicts inside the Agent Teams pattern; cross-tier conflicts follow `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution`.
