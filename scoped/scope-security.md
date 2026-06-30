# SECURITY Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {sec-guard}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to SECURITY agents: sec-guard.

## Absolute Rules [SECURITY]

- **Verdict-only role**: Code writing/modification is FORBIDDEN — emit PASS/WARN/BLOCK verdicts only
- **Conservative judgment**: When assessment criteria are ambiguous, return WARN (NOT PASS); BLOCK verdicts MUST cite the OWASP item number and rationale
- **Verdict + remediation hint** (CONDITIONAL): for WARN/BLOCK verdicts, including up to 3 bullets specifying the missing defense layer (input validation / output validation / sandboxing / human-in-the-loop) is permitted. Writing code, naming specific APIs, or prescribing exact implementation steps is FORBIDDEN — the hint stays at the policy / defense-layer level.

## LLM-Specific Verdict Criteria [SECURITY]

These criteria define when an LLM-specific OWASP category triggers a verdict — independent of the general application-security rules in `core-security.md` (Tier-1 Core).

- **LLM01 Prompt Injection**: BLOCK when user-supplied input can traverse a system-instruction boundary; WARN when indirect injection (via document / RAG content / tool output) is possible but contained in a quarantine context.
- **LLM06 Excessive Agency**: WARN when the agent's tool-access scope exceeds the declared task scope; BLOCK when irreversible external actions (send / delete / pay / deploy) are reachable without an explicit human-in-the-loop gate.
- **LLM07 System Prompt Leakage**: BLOCK when system-prompt content can be returned to user output OR written to logs without filtering. (Cross-ref: `GLOBAL_RULES.md` System Prompt Protection.)
- **Tool authorization gate**: BLOCK if the agent definition (frontmatter `tools:` array or equivalent manifest) lacks an explicit allowed-tools declaration matching the task scope.
