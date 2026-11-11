# Decision-phase probes — detail

- **Pointer site**: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Decision-phase probes`.
- **Who makes a remediation**: ruled at the pointer site → "Treat a failed probe as a deliberate blocker".
  - That rule covers every remediation in this file that changes a grant or starts a service: an FDA grant · a permission allow · a `chmod` · a `tools:` edit · a daemon start.

## Permission Probe — detail

| EPERM cause | Remediation |
|---|---|
| macOS TCC | FDA grant |
| Claude tool-auth | permission allow |
| POSIX perm | chmod |

- Why: a subagent spawned on an unreadable path is guaranteed to emit `result: blocked`, wasting Failure-Recovery retries.

## Capability Probe — detail

- Tools to enumerate, e.g.: Bash · Write · `mcp__*`.
- Gap report: agent file + missing tool + one remediation: update the agent body `tools:` array · pair a different agent · surface to the user.
- A `tools:` edit applies from the next spawn: the allowlist is frozen at spawn time.

## Compatibility Probe — detail

- Remediation example: "monitor daemon down — start `monitor` then retry".
- Worked case: glass-atrium-intel-reporter's gate covers all monitor POSTs, the user-requested HTML primary and the agent-only record alike, so agent-only mode is not a pass-through.
