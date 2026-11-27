# Completion signals — evidence detail behind the three signals

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Completion signals`.

## Signal (i) — the returned payload

- That the engine returns only after its agents terminate is observed engine behaviour, not a contract.

## Signal (ii) — the terminal on-disk record

- **Location**: the host writes a per-subagent transcript at `<projects-root>/<project-slug>/<session-uuid>/subagents/agent-<id>.jsonl`, with an `agent-<id>.meta.json` sidecar beside it.
  - The path is host-internal and may move: confirm the current location before relying on it.
- **Identification works on the manual path, never on the ultracode path**:
  - manual sidecar — directly under `subagents/`, carrying `agentType` and `description`.
    - `agentType` is often the task name, with the real type in `customAgentType`, so read both.
  - workflow sidecar — under `subagents/workflows/wf_<id>/`, carrying `agentType`, `spawnDepth` and a `description` label that can repeat within one run.
- **Read the tail, not the file**: a full read is itself a budget event.
- **Terminality is structural**: there is no sentinel record.

| Last record, skipping `attachment` entries | State |
|---|---|
| `assistant` entry, `stop_reason: end_turn`, no unmatched `tool_use` | terminated |
| `stop_reason: tool_use`, no matching result | not terminated |

## Signal (iii) — the liveness ledger

- `core.agent_events` is written by `hooks/agent-tracker.sh` on SubagentStart and SubagentStop.
- (i) and (ii) enumerate only the terminations you observed, which is why only (iii) answers absence.
- The ledger carries no cwd or worktree column.

## Why each proxy fails

- File-mtime quiet: a reading or reasoning agent writes nothing for many minutes.
- An `idle` listing entry: it does not separate finished from waiting, and may list peer sessions.
- A commit appearing: an agent may finish without committing, and a commit may belong to another track.
