# Failure Recovery Loop — backing honesty

- **Pointer site**: `skills/glass-atrium-ops-orchestrator-role.md` → **Backing honesty (which stages are enforced)**.

## Honor-system checks — why

- No code tracks the attempt count, enforces the transition or reads a diagnosis for evidence.
- No code detects a regression chain either (`skills/glass-atrium-ops-orchestrator-role.md` → **Regression-chain trigger**).

## Circuit-breaker — the code backing

- `hooks/track-outcome.sh` → `circuit_breaker_record` keeps a per-agent consecutive-fail counter under `${HOOK_DATA_DIR}/agent-circuit-breaker/` and writes a `.suspended` marker at the 3-fail threshold.
  - Any non-`fail` outcome resets the counter and clears the suspension.
  - No hook reads the marker, so it blocks no spawn; the Monitor's `GET /api/agents/summary` reads it.
