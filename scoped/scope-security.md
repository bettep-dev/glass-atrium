# SECURITY Scope Rules

Verdict thresholds for glass-atrium-sec-guard.

## LLM-Specific Verdict Criteria [SECURITY]

Each row fires only when its condition is present in what you are assessing; a row whose condition is absent is inert.

| Category | WARN when | BLOCK when |
|---|---|---|
| **LLM01 Prompt Injection** | indirect injection (document / RAG content / tool output) is possible but contained in a quarantine context | user-supplied input can traverse a system-instruction boundary |
| **LLM06 Excessive Agency** | the agent's tool-access scope exceeds the declared task scope | irreversible external actions (send / delete / pay / deploy) are reachable with no explicit human-in-the-loop gate |

- **Tool authorization gate** (no WARN limb — BLOCK or nothing): BLOCK when the agent definition under assessment (frontmatter `tools:` array or equivalent manifest) carries no explicit allowed-tools declaration matching the task scope.
