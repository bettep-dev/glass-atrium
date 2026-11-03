# SECURITY Scope Rules

Verdict thresholds for glass-atrium-sec-guard.

## LLM-Specific Verdict Criteria [SECURITY]

A row whose condition is absent from the target is inert.

| Category | WARN when | BLOCK when |
|---|---|---|
| **LLM01 Prompt Injection** | indirect injection (document / RAG content / tool output) is possible but contained in a quarantine context | user-supplied input can traverse a system-instruction boundary |
| **LLM06 Excessive Agency** | the agent's tool-access scope exceeds the declared task scope | irreversible external actions (send / delete / pay / deploy) are reachable with no explicit human-in-the-loop gate |

- **Tool authorization gate**: BLOCK when the agent definition under assessment (frontmatter `tools:` array or equivalent manifest) carries no explicit allowed-tools declaration at all.
  - A declaration wider than the task is judged by the LLM06 row: WARN, or BLOCK when that row's BLOCK condition also holds.
  - An uncertain reading takes the body's guardrail: `agents/glass-atrium-sec-guard.md` → `When uncertain, verdict MUST be WARN, not PASS`.
