---
name: glass-atrium-ops-token-audit
description: Static token-cost audit for ~/.claude/ ecosystem (agents/rules/skills/MCP). Use when token-budget pressure investigation, before agent description compression sprint, or after major rule cascade.
---

## When to Use

- Token-budget pressure suspected: slow turn-0 ingestion, ceiling-hit reports
- Before a description or rule compression sprint, to establish the baseline
- After a major rule cascade, to detect regression
- Periodic hygiene snapshot
- Excludes runtime token measurement, per-prompt cost tracking, change-scope inspection

## Invocation

```bash
~/.glass-atrium/scripts/audit-context.sh      # file-ecosystem pass (agents/rules/skills)
~/.claude/skills/glass-atrium-ops-token-audit/mcp-scan.sh   # MCP-server pass
```

- Run both for a full audit, `audit-context.sh` first.
  - `mcp-scan.sh` merges an `mcp_servers` block into the same daily file (`--out` defaults to today's `context-budget.json`).
  - Order-independent for correctness, but file-first keeps a single combined artifact.
- Output written to `~/.claude/data/audit/YYYY-MM-DD-context-budget.json`.
- Stdout = compact summary; the JSON holds every row.
- Exit codes (both scripts): `0` = all under warn · `1` = any alert breached · `2` = measurement failure.

## MCP Server Scan

- `mcp-scan.sh` reads servers from `claude mcp list`, which covers the per-project and plugin scopes the top-level `mcpServers` key misses.
- It emits per server:
  - `est_tokens` — `tool_count_estimate × 500 tok/tool`; 0 for a non-connected server, which consumes no context
  - `wraps_free_cli` — the server wraps an otherwise-free CLI, e.g. a `gh`-backed GitHub server reachable via the Bash tool at zero context cost
  - `bucket` — exactly one row below

| `bucket` | When |
|---|---|
| `remove` | not connected (configured-but-inert), or wraps a free CLI |
| `lazy-load` | connected + heavy (≥ median connected cost) → defer via ToolSearch bulk-load |
| `keep` | connected + light |

- **Self-consistency**: the scan captures `claude mcp list` once, and `scanned_count` equals the server count parsed from that snapshot.
  - MCP health is time-dependent, so a separate invocation can disagree.
- `CLAUDE_MCP_LIST_FIXTURE=<file>` overrides the live call for deterministic verification and offline runs.
- **Tool-count heuristic**: the count is an estimate — an override map for known toolkits, conservative default (8) otherwise.
  - Edit the map in `mcp-scan.sh` as servers' tool surfaces change.

## Thresholds

- Edit each key's `warn:` and `alert:` values in `thresholds.yaml`.
- Its header records the baseline, its date and the derivation.
- A key on another basis records it in its own comment block.
- Re-anchor on a fresh baseline when the ecosystem count drifts materially.

## Methodology

- Tokenizer: tiktoken `cl100k_base` approximation, ~10% error vs Anthropic `count_tokens`, trend-only.
- Emits per-file tokens with a frontmatter / body split, plus a rolled-up summary.
