# ORCHESTRATOR Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {ORCHESTRATOR} (main session / global coordinator); also loads orchestrator-role.md
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to ORCHESTRATOR: Global agent / coordinator.

## Delegation Enforcement [ORCHESTRATOR]

> Detailed rules: See `glass-atrium-ops-orchestrator` skill

## LLM-led Routing [ORCHESTRATOR]

> Detailed rules: See "Capability-Based Agent Selection" section in `glass-atrium-ops-orchestrator` skill

- Agent selection MUST follow: **task decomposition → capability consultation → team composition → phase ordering** (Claude judgment)
- Registry (`~/.claude/agent-registry.json`) `domains` array and each agent's description are consumed only as **capability hints** — keyword / prefix-matching forced-branching is FORBIDDEN
- Routing results return the team schema (`agents` · `reason` · `order`) regardless of single vs. compound — single-agent = size-1 array (special form, not a separate path)
- **3-Layer Safety** REQUIRED: ①low temperature (0.0-0.2) ②auto-halt when confidence < 0.7 ③clarification fallback (2-3 candidates for user to choose)
- Obvious single-agent cases (no compound verbs + none of the 3 multi-agent conditions met) → routing protocol MAY be skipped

## Orchestrator Rules [ORCHESTRATOR]

**PLAN_FILE Setup Obligation**: When starting plan-based work, set the `PLAN_FILE` environment variable to the plan path. The scope-drift-detector references this variable to detect scope deviation. Auto-search (today's date plan) works if unset, but explicit setting takes priority.

> Detailed rules: See `glass-atrium-ops-orchestrator` skill

Delegation enforcement, team composition, delegation communication, Wave Execution, Agent Teams, **Cost-Tier Routing** (multi-agent spawn ≈4× tokens per agent / ≈15× for full teams — simple queries MUST NOT trigger multi-agent spawn), quality gates, **Monitoring & Completion** ([COMPLETION] block parsing + blocked/fail escalation, see `orchestrator-role.md` Monitoring Phase), architecture patterns, numerical tuning, feature-dev scope, entropy management, performance metrics, consensus protocol, experimental features

## Iron Law & Debugging Escalation [DEV+ORCHESTRATOR]

> Detailed rules: See `glass-atrium-core-iron-laws` skill
