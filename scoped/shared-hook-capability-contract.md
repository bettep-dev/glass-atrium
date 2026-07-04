# Hook Event Capability Contract (Cross-Cutting Concern)

> **Loading**: Tier 3 (Cross-cutting) — reference for DEV/QA agents that author or modify hooks under `~/.claude/hooks/`
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Authoritative per-event capability contract for Claude Code lifecycle hooks. A hook author MUST consult this before assuming an event can read prose, mutate output, or block via a given channel. Capability claims here are verified against the actual hooks in `~/.claude/hooks/` + `hook-utils.sh` + `settings.json` (do NOT infer beyond what the event actually exposes — a wrong capability assumption is the root cause this contract prevents).

## Why This Exists

- Hook events differ in what they can **observe**, what they can **mutate**, and **which block channel** they may use — these are NOT uniform across events.
- A prior design error assumed `PostToolUse` could mutate model-visible tool output (it cannot — observe + block/append only, no `updatedOutput`). This contract pins the gap so it is not re-derived.
- The two block channels are **non-substitutable** (stderr `emit_error`+`exit 2` vs. stdout `{"decision":...}`) — picking the wrong one silently no-ops the block.

## Per-Event Capability Table

Rows = lifecycle event · columns = capability surface. `mutate` = can change model-visible data via a documented mechanism · `observe-only` = read + block/append but NO mutation of model-visible payload. Channel column names the block mechanism the event supports (see Block Channels below).

| Event | Mutate-capable surface | Observe surface | Block channel | Notes |
|-------|------------------------|-----------------|---------------|-------|
| PreToolUse | `tool_input` only (via `updatedInput` mechanism) | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `agent_id` | channel-a (stderr `emit_error`+`exit 2`) AND/OR channel-b (stdout `{"decision":"block"}`) | mutate-capable: ONLY `tool_input`. CANNOT read the agent's prose/reasoning — only `tool_input`/`session_id`/`agent_id` are visible. |
| PostToolUse | none — observe-only (no `updatedOutput`) | `tool_name`, `tool_response`/output, `tool_input` | channel-a (`exit 2`) OR channel-b (stdout `{"decision":"block"\|"advisory"}`) | CANNOT mutate model-visible tool output. May only block/append/advise after the tool ran. This is the prior-design-error gap. |
| `Stop` / `SubagentStop` | none — observe-only | terminal turn / subagent transcript metadata | none (advisory lifecycle; `exit 2` does not rewind a finished turn) | post-completion accounting only (e.g. `cost-tracker.sh`, `track-outcome.sh`). No payload to mutate. |
| `SessionStart` | injects turn-0 context via stdout (additive, not a mutation of existing data) | drained stdin (payload unused by current hooks) | none (advisory — `exit 0` contract) | stdout text is injected into session context (`inject-session-context.sh`). `validate-compliance-matrix.sh` is advisory-only here. |
| `SubagentStart` | injects child context via stdout `hookSpecificOutput.additionalContext` (additive) | `agent_type`, `agent_id` | none (cannot block a spawn — context-injection only) | `inject-scope-rules.sh` delivers the comment-rule block to DEV/QA children. Fail-open (`exit 0`) always. |
| `UserPromptSubmit` | (not currently registered — see Event Registration Status) | n/a | n/a | NO `UserPromptSubmit` hook exists in `settings.json`. Prompt-injection screening runs at `PreToolUse(Write\|Edit)` via `validate-prompt.sh`, NOT at prompt-submit time. |

## Block Channels (Two Non-Interchangeable Mechanisms)

Both channels exist · they are NOT substitutable · a hook MUST pick the channel its consumer expects. `exit 2` alone does NOT imply a stdout decision, and a stdout decision without the matching exit does NOT block.

- **Channel a — stderr `emit_error` JSON + `exit 2`**: the `emit_error` helper writes a structured JSON error to **stderr** (`hook-utils.sh` `hook_emit_error` → `>&2`), then the hook calls `exit 2`. No stdout `decision` field is emitted. Used by: `validate-secret-scan.sh`, `block-dangerous-commands.sh`, `enforce-commit-guard.sh`, `block-no-verify.sh`, `block-md-creation.sh`, `enforce-delegation.sh`.
- **Channel b — stdout `{"decision":"block"|"advisory"}` + exit**: the hook prints a JSON object with a `"decision"` key to **stdout**, then exits. Used by: `validate-output.sh` (emits `{"decision":"block"|"advisory"}`), `enforce-foreground-harness.sh` (emits `{"decision":"block",...}`).
- **Channel overlap caveat (file-verified)**: `exit 2` is NOT exclusive to channel a — `validate-output.sh` and `enforce-foreground-harness.sh` use a stdout `decision` block AND `exit 2` together. The discriminator is therefore the **presence of the stdout `"decision"` JSON**, not the exit code. Channel-a hooks emit error JSON on stderr only and carry no stdout `decision`.
- **Non-substitutability rule**: do NOT replace a channel-a `emit_error`+`exit 2` with a stdout `decision`, or vice versa, without verifying the registering event's expected contract — the consumer reads exactly one surface.

## Event Registration Status (file-verified)

Events with at least one registered hook in `settings.json`: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`.

- **`UserPromptSubmit` — NOT registered**: no hook is wired to this event. Any contract claim about it is hypothetical until a hook is added. `validate-prompt.sh` (prompt-injection + zero-width Unicode screening) runs at `PreToolUse(Write|Edit)`, i.e. it screens content being written to files, not raw user prompts.
- Authors adding a `UserPromptSubmit` hook MUST update this table with its verified capabilities at that time.

## Authoring Rules

- **Verify before assuming**: read the target event's existing hooks + `hook-utils.sh` before assuming a capability. A capability not listed here for an event is assumed ABSENT until file-verified.
- **Mutation discipline**: only `PreToolUse` mutates model-visible data, and only `tool_input`. Do NOT design a `PostToolUse` hook that expects to rewrite tool output.
- **Channel discipline**: pick channel a OR channel b per the registering event's contract; document which in the hook header. Mixing is allowed only where an existing hook already does so (`validate-output.sh`) and is intentional.
- **Fail-open default**: lifecycle hooks that cannot block (`SessionStart`, `SubagentStart`, `Stop`/`SubagentStop`) MUST `exit 0` on internal error — never break a session on hook failure (`GLASS_ATRIUM_GLOBAL_RULES.md` Hook Operation Policy). Exception: `~/.claude/autoagent/` self-improvement pipeline hooks follow the loud-fail principle (`shared-self-improve-hygiene.md`).
- **No secret/PII in hook output**: hook stdout/stderr is session-visible — never echo `.env`, tokens, or PII (`core-security.md` Secret Management, LLM07).

## Cross-References

- `~/.claude/hooks/hook-utils.sh` — `hook_emit_error` (channel a), `hook_read_input`, `hook_get_field`, `hook_get_tool_input`, `hook_is_subagent`
- `~/.claude/settings.json` — event → hook registration (the authority for which events are wired)
- `~/.claude/rules/core-security.md` — LLM01 tool-input trust boundary · LLM06 tool authorization · LLM07 system-prompt leakage
- `~/.claude/rules/orchestrator-role.md` — Harness Path Protection (the `enforce-foreground-harness.sh` channel-b rationale)
- `~/.claude/rules/shared-self-improve-hygiene.md` — Precondition Loud-Fail (the autoagent-pipeline exception to fail-open)
