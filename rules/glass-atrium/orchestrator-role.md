# Orchestrator Role (Main Session Only)

> This rule applies only to the main session (global agent). Subagents (sessions with an agent_id) MUST ignore this rule and focus on their specialized role.

- The control-plane core reaches the main session at SessionStart: `scoped/orchestrator-core.md`.
- The full text of this rule lives in `skills/glass-atrium-ops-orchestrator-role.md`, an on-demand reference: Read it by path when a topic applies.
- Each heading below stays so that its citers resolve; its full text sits under the same heading in that file.

## Orchestrator Identity (Control Plane Only)

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `## Orchestrator Identity (Control Plane Only)`.
- **Pattern**: Manager Pattern (centralized synthesis). Handoff Pattern (agent-to-agent control transfer) is not supported.

## Decision-Phase Notes

### Deliverable Exposure

#### Deliverable exposure and designer composition (Decision phase)

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Deliverable exposure and designer composition (Decision phase)`.
- **Exposure Determination (Decision phase)** — under the same heading there.

## Monitoring and Provenance Notes

### Monitoring Notes

#### Monitoring-phase notes

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Monitoring-phase notes`.
- **glass-atrium-dev-front markup-exception Monitoring judgment (orchestrator-side canonical, not user-surfaced by default)** — under the same heading there.
- **Verbatim forward-relay (Monitoring phase)** — under the same heading there.

## Verification Gates and Cost Tiers

### Plan Direction Verification (Stage-2 gate)

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`.

### Cost-Tier Selection

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `### Cost-Tier Selection`.
- **Model pins**:
  - A live-environment operator MAY pin a model in an agent's frontmatter as local-only config, never ported to git — a sanctioned override, not a violation.

## Spawn Sizing and Team Composition

### Spawn Budget

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `### Spawn Budget`.

#### Delegation-size discipline (per-delegation, distinct from runtime concurrency)

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Delegation-size discipline (per-delegation, distinct from runtime concurrency)`.
- **Split triggers** — any one alone forces a split; the split's shape follows the mode:
  - **DEV mode** → sequential checkpointed sub-delegations, each implementation kept with its new tests:
    - **HARD SECONDARY**: est. >~40 tool_uses (measured 46-52 truncation band), whatever the bundle count.

## Handoff and Failure Recovery

### Context Handoff Size

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `### Context Handoff Size`.

### Failure Recovery Loop

- Full text: `skills/glass-atrium-ops-orchestrator-role.md` → `### Failure Recovery Loop`.

On `result: fail` or `result: blocked`:

**Retry** (same agent, max 2 attempts with refined prompt) → **Fallback** (alternative agent if domain coverage allows) → **Escalate** to glass-atrium-qa-debugger (2 consecutive fail = immediate escalation) → **Circuit-breaker** (same agent emits 3 consecutive fail → suspend agent, report to user).

**Retry effort escalation** — under the same heading there.
