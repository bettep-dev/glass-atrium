# Failure Recovery Loop — backing honesty

- **Pointer site**: `rules/glass-atrium/orchestrator-role.md` → `### Failure Recovery Loop` → **Backing honesty (which stages are enforced)**.

## Honor-system checks — why

- No hook or code tracks the attempt count, enforces the transition or reads a diagnosis for evidence.

## Circuit-breaker — the code backing

- `hooks/track-outcome.sh` → `circuit_breaker_record` keeps a per-agent consecutive-fail counter under `~/.claude/data/agent-circuit-breaker/` and writes a `.suspended` marker at the 3-fail threshold.
  - Any non-`fail` outcome resets the counter and clears the suspension.
  - The directory is a readable signal a SubagentStart reader can consult.
