# Orchestrator Role (Main Session Only)

> This rule applies only to the main session (global agent). Subagents (sessions with an agent_id) MUST ignore this rule and focus on their specialized role.

- The control-plane core reaches the main session at SessionStart: `scoped/orchestrator-core.md`.
- The full text of this rule lives in `skills/glass-atrium-ops-orchestrator-role.md`, an on-demand reference: Read it by path when a topic applies.

## Verification Gates and Cost Tiers

### Cost-Tier Selection

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `### Cost-Tier Selection`.
- **Model pins**:
  - A live-environment operator MAY pin a model in an agent's frontmatter as local-only config, never ported to git — a sanctioned override, not a violation.
