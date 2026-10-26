# Decision-phase probes — detail

- **Pointer site**: `rules/glass-atrium/orchestrator-role.md` → `#### Decision-phase probes`.

## Permission Probe — detail

- Report on EPERM: the failing path + likely cause (macOS TCC / Claude tool-auth / POSIX perm) + remediation (FDA grant / permission allow / chmod).
- Why: a subagent spawned on an unreadable path is guaranteed to emit `result: blocked`, wasting Failure-Recovery retries.

## Capability Probe — detail

- Required tools to enumerate: Bash, Write, `mcp__*`, chrome-devtools / claude-in-chrome, and the like.
- Gap report: agent file + missing tool + remediation — update the agent body `tools:` array OR pair a different agent OR surface to the user.
- The allowlist is **frozen at spawn time** (`core-security.md` LLM06), so a body edit applies from the NEXT spawn (body rewrites: `scope-meta.md` Outcome-Driven Rewrite Policy).

## Compatibility Probe — detail

- The frontmatter field is canonical; the `agent-registry.json` entry mirrors it.
- Halting before the spawn replaces a runtime `result: blocked`. Remediation example: "monitor daemon down — start `monitor` then retry".
- Worked case: glass-atrium-intel-reporter's gate covers ALL monitor POSTs, the user-requested HTML primary AND the agent-only record alike, so agent-only mode is NOT a pass-through.

## Probe strength — backing

- `rules/glass-atrium/orchestrator-role.md` → `## Delegation Workflow` → the Forbidden table's Decision rows name the advisory probes' failures, but no hook verifies them.
