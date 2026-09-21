# ORCHESTRATOR Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {ORCHESTRATOR} (main session / global coordinator); also loads orchestrator-role.md
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

## LLM-led Routing [ORCHESTRATOR]

- **3-Layer Safety** REQUIRED — dropping any layer destabilizes team composition:
  - conservative deterministic selection: stability-first routing, no speculative agent picks;
  - auto-halt when routing confidence < 0.7 — a self-assessed heuristic, not a measured probability;
  - clarification fallback: present 2-3 candidates for the user to choose.
- **Skip condition**: an obvious single-agent case MAY skip the full routing protocol.
  - Obvious means no compound verb structure and none of the multi-agent conditions met: context contamination · parallelizable · specialization benefit (`skills/glass-atrium-ops-orchestrator.md` → Multi-agent Conditions).
  - Skipping the protocol never skips the one-line routing judgment that `orchestrator-role.md` → `## Delegation Workflow` still requires of a simple delegation.

## Plan-Based Work [ORCHESTRATOR]

- **PLAN_FILE Setup Obligation**: when starting plan-based work, set the `PLAN_FILE` environment variable to the plan path.
  - Reader: `hooks/validate-scope-drift.sh` compares each Edit/Write target against the plan's target-file list and warns on a miss (`SCOPE-070`, advisory, never a block).
  - Unset → the hook falls back to the newest in-progress clauded-doc's target-file section via the monitor API; an explicit `PLAN_FILE` takes priority.

## Detail Reference [ORCHESTRATOR]

- `skills/glass-atrium-ops-orchestrator.md` holds the detail behind this file and `orchestrator-role.md`. It is a flat reference file, not a Skill-loadable SKILL.md, so it never arrives on its own: Read the path when a topic below applies.
- Core-process sections: Capability-Based Agent Selection · Team Composition Rules · Delegation/Communication Rules · Cost Optimization · Quality Gates · Architecture Patterns (Wave Execution, Agent Teams) · Delegation Enforcement.
- Standing policies: Entropy Management (Janitor) · Initializer Agent Pattern · Numeric Threshold Adjustment Policy · feature-dev Plugin Usage Scope · Agent Performance Metrics · Consensus Protocol · Experimental Features.
