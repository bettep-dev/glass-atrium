---
name: glass-atrium-ops-token-audit
description: Static token-cost audit for ~/.claude/ ecosystem (agents/rules/skills/MCP). Use when token-budget pressure investigation, before agent description compression sprint, or after major rule cascade.
---

## When to Use

- Token-budget pressure suspected (slow turn-0 ingestion, ceiling-hit reports)
- Before launching a description / rule compression sprint (establish baseline)
- After major rule cascade (Wave NN) to detect regression
- Periodic hygiene (cron-driven snapshot)

Excludes runtime token measurement, per-prompt cost tracking, change-scope inspection.

## Invocation

```bash
~/.claude/scripts/audit-context.sh            # file-ecosystem pass (agents/rules/skills)
~/.claude/skills/glass-atrium-ops-token-audit/mcp-scan.sh   # MCP-server pass (merges into same daily JSON)
```

Run both for a full audit. `mcp-scan.sh` merges an `mcp_servers` block into the SAME daily file (`--out` defaults to today's `context-budget.json`), so run `audit-context.sh` first, then `mcp-scan.sh` — order-independent for correctness, but file-first keeps a single combined artifact.

Output written to `~/.claude/data/audit/YYYY-MM-DD-context-budget.json`. Stdout = compact summary (top-5 offenders per dimension + ecosystem total + threshold verdict for the file pass; per-server token cost + bucket + verdict for the MCP pass).

Exit codes (both scripts): `0` = all under warn · `1` = any alert breached · `2` = measurement failure.

## MCP Server Scan

`mcp-scan.sh` reads the connected/configured MCP servers from `claude mcp list` (the authoritative resolver across top-level / per-project / plugin scopes — the top-level `mcpServers` key alone is incomplete), then for each server emits:

- `est_tokens` — estimated context cost (`tool_count_estimate × 500 tok/tool`, ECC C4 baseline; 0 for non-connected servers, which consume no context)
- `wraps_free_cli` — flag for servers wrapping an otherwise-free CLI (e.g. a `gh`-backed GitHub server, reachable via the Bash tool at zero context cost)
- `bucket` — exactly one of `{keep, lazy-load, remove}`:
  - `remove` = not connected (configured-but-inert) OR wraps a free CLI
  - `lazy-load` = connected + heavy (≥ median connected cost) → defer via ToolSearch bulk-load
  - `keep` = connected + light, core workflow

**Self-consistency**: the scan captures `claude mcp list` ONCE; `scanned_count` equals the server count parsed from that exact snapshot (MCP health is time-dependent — two separate invocations can disagree, so the count is never hardcoded). `CLAUDE_MCP_LIST_FIXTURE=<file>` overrides the live call for deterministic verification / offline runs.

**Tool-count heuristic**: exact per-server tool counts require spawning each server (slow + needs network auth for remote HTTP servers), so the count is a documented estimate — an override map for known toolkits, conservative default (8) otherwise. Edit the map in `mcp-scan.sh` as servers' tool surfaces change.

## Thresholds

Computed from the baseline snapshot (`/tmp/context-budget-audit-2026-05-21.json`, 2026-05-21). Live ecosystem count (verified by `ls` on 2026-05-29): 23 agents / 26 rules / 15 skills. Mean+1σ → `warn`, mean+2σ → `alert`. Editable: `thresholds.yaml`. Re-anchor thresholds on a fresh baseline when the ecosystem count drifts materially.

`mcp_server_total_tokens` re-anchored (2026-05-27) to measured per-server estimates (6 connected servers, mean+1σ=12144 warn / mean+2σ=16954 alert; per-server worst-single semantic) — replaces the prior un-measured 5000/10000 placeholder. See `thresholds.yaml` header for the full derivation.

ECC C4 hardcoded numbers (30w / 300l) NOT applied — nearly all agents already >30w; verbatim = alert flood. See `thresholds.yaml` header for derivation.

## Methodology

Single-file tokenizer pass (tiktoken `cl100k_base` approximation; ~10% error vs Anthropic `count_tokens`, trend-only). Emits per-file token + frontmatter / body split, plus rolled-up summary. ECC C4 audit methodology citation only — implementation is independent.

## Sample Output

File pass (`audit-context.sh`):

```
Ecosystem total: 159,310 tokens (warn=200000 alert=250000) -> ok
Top agents (tokens): design-designer=8868 intel-reporter=7084 ...
Top rules   (lines): scope-report=176 compliance-matrix=149 ...
Verdict: 0 alert / 2 warn breached
```

MCP pass (`mcp-scan.sh`):

```
Scanned MCP servers: 14 (connected=6) -> keep=3 lazy-load=3 remove=8
Total connected MCP tokens: 44,000 (per-server warn=12,144 alert=16,954)
  [lazy-load] chrome-devtools=13000 (tools~26)
  [keep     ] plugin:context7:context7=1000 (tools~2)
  ...
Verdict (mcp worst-server): [WARN] chrome-devtools=13000
```
