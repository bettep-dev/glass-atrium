# Hook Event Capability Contract (Cross-Cutting Concern)

Read this file when the task writes or modifies a hook under `~/.glass-atrium/hooks/`, or when the task reviews a hook change or analyses a hook failure. It binds nothing on any other task — it is a reference to open on that trigger, never a standing duty.

Per-event capability contract for Claude Code lifecycle hooks: what each event can observe, what it can mutate, and which block channel it may use. Consult it before assuming an event can read prose, mutate output, or block — a capability this file does not list for an event is ABSENT until you verify it against that event's existing hooks, `hook-utils.sh` and `settings.json`.

## Per-Event Capability Table

Rows = lifecycle event · columns = capability surface. `mutate` = can change model-visible data through a documented mechanism · `observe-only` = read + block/append but no mutation of the model-visible payload. The channel column names the block mechanism the event supports (see Block Channels below).

| Event | Mutate-capable surface | Observe surface | Block channel | Notes |
|-------|------------------------|-----------------|---------------|-------|
| PreToolUse | `tool_input` only (via `updatedInput`) | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `agent_id` | channel-a (stderr `emit_error`+`exit 2`) AND/OR channel-b (stdout `{"decision":"block"}`) | CANNOT read the agent's prose/reasoning — only `tool_input`/`session_id`/`agent_id` are visible. |
| PostToolUse | none — observe-only (no `updatedOutput`) | `tool_name`, `tool_response`/output, `tool_input` | channel-a (`exit 2`) OR channel-b (stdout `{"decision":"block"}` only — `"advisory"` is rejected, see Block Channels) | CANNOT mutate model-visible tool output. May only block, or advise via stderr, after the tool ran. |
| `Stop` / `SubagentStop` | none — observe-only | terminal turn / subagent transcript metadata | none (advisory lifecycle; `exit 2` does not rewind a finished turn) | Post-completion accounting only (`cost-tracker.sh`, `track-outcome.sh`). No payload to mutate. |
| `SessionStart` | injects turn-0 context via stdout (additive, never a mutation) | drained stdin (payload unused by current hooks) | none for the injection itself (`exit 0`); one audit-grade `exit 2` exists, see the note | `inject-session-context.sh` injects its stdout into session context. `validate-compliance-matrix.sh` exits 2 on a CONFIRMED matrix inconsistency (its Layer B) while its Layer A drift check stays advisory — neither rewinds the session, which SessionStart cannot do. |
| `SubagentStart` | injects child context via stdout `hookSpecificOutput.additionalContext` (additive) | `agent_type`, `agent_id` | none (cannot block a spawn — context-injection only) | `inject-scope-rules.sh` delivers the marker blocks to its rostered children. Fail-open (`exit 0`) always. |
| `UserPromptSubmit` | not registered — see Event Registration Status | n/a | n/a | No `UserPromptSubmit` hook exists in `settings.json`. Prompt-injection screening runs at `PreToolUse(Write\|Edit)` via `validate-prompt.sh`, NOT at prompt-submit time. |

## Block Channels (Two Non-Interchangeable Mechanisms)

Both channels exist, they are NOT substitutable, and a hook MUST pick the one its registering event's consumer expects. `exit 2` alone does not imply a stdout decision, and a stdout decision without the matching exit does not block.

- **Channel a — stderr `emit_error` JSON + `exit 2`**: `emit_error` writes a structured JSON error to stderr (`hook-utils.sh` `hook_emit_error` → `>&2`), then the hook exits 2. No stdout `decision` field. Used by `validate-secret-scan.sh`, `block-dangerous-commands.sh`, `enforce-commit-guard.sh`, `block-no-verify.sh`, `block-md-creation.sh`, `enforce-delegation.sh`, `enforce-harness-critical.sh`.
- **Channel b — stdout `{"decision":"block"}` + exit**: the hook prints a JSON object carrying `"decision":"block"` to stdout, then exits. Used by `validate-output.sh` (its blocking LLM05 path) and `enforce-foreground-harness.sh`.
- **`"advisory"` is not a channel-b form**: the PostToolUse decision schema rejects it (`"Hook JSON output validation failed"`), so a non-blocking advisory emits a stderr `emit_error` + `exit 0` instead — `validate-output.sh`'s LLM07 path is the worked case.
- **Discriminator is the stdout `"decision"` JSON, never the exit code**: `exit 2` is not exclusive to channel a — `validate-output.sh` and `enforce-foreground-harness.sh` emit a stdout decision AND `exit 2` together. Channel-a hooks carry no stdout `decision` at all.
- **Non-substitutability**: do NOT swap a channel-a `emit_error`+`exit 2` for a stdout `decision`, or the reverse, without verifying the registering event's contract — the consumer reads exactly one surface.

## on_fail Action Taxonomy (validation-failure disposition vocabulary)

A failed check has one of five dispositions. This is a shared vocabulary for describing a hook's behaviour in one word — docs-only, no library import and no dependency.

| Disposition | Mechanism | Used by | Reserved for |
|---|---|---|---|
| **exception** | HARD-block: emit on the block channel + `exit 2` (channel a or b) — the offending action does not proceed | the fail-closed hooks: `validate-secret-scan.sh` · `block-dangerous-commands.sh` · `enforce-harness-critical.sh` · `enforce-foreground-harness.sh` · `enforce-workflow-verify-stage.sh` block verdicts | a decidable, high-confidence violation — never fail-open uncertainty |
| **fix** | AUTO-CORRECT the content in place and continue, with no block and no data loss | the post-write repair hooks: `post-edit-format.sh` · `post-edit-typecheck.sh` | a mechanically-decidable correction |
| **filter** | DROP or strip the offending element, or degrade to a fallback, and continue | the resilient-workflow join `.filter(Boolean)` dropping a null agent result · `track-outcome.sh` synthesizing a fallback `done_with_concerns` record on a degraded `[COMPLETION]` parse | an operation that stays correct with the bad part removed or substituted |
| **noop** | PURE TELEMETRY: warn/log on stderr + `exit 0`, leaving the operation unchanged | the advisory budget/cost hooks: `advisory-context-budget.sh` · `advisory-spawn-cost.sh` · `advisory-subagent-budget.sh` · `validate-edit-syntax.sh`'s advisory-first path | an observation that changes nothing about the operation |
| **reask** | RE-PROMPT the producer with a tightened instruction rather than blocking or dropping | `robustAgent`'s retry-once-on-null re-spawn in schema-mode workflows · the Failure Recovery Loop retry at the delegation layer | a producer that can plausibly succeed on a second, tightened attempt |

- **`fix` has no silent-loop form**: an unresolvable case falls through to `exception` or `filter`, never back into the fix.
- **A `noop` MUST NOT be labelled `filter`** — it strips and degrades nothing.

### Picking a disposition

- **Disposition is event-capability-bound**: an event with no block channel (`Stop`/`SubagentStop`/`SessionStart`/`SubagentStart`) can only `filter`, `fix`, `noop`, or `reask` (via a later spawn) — it can NEVER `exception`. Pick the disposition the registering event actually supports; naming one does not grant a capability the event lacks.
- **Read-side counterpart**: `track-outcome.sh`'s `[COMPLETION]` parse tiers use the same vocabulary — a tier miss that SYNTHESIZES a fallback record is a `filter` (a substituting action), while an advisory that only warns and records the block unchanged is a `noop`.

## Event Registration Status (file-verified)

- Events with at least one registered hook in `settings.json`: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`.
- **`UserPromptSubmit` is NOT registered**: no hook is wired to it, so any capability claim about it is hypothetical until one exists. `validate-prompt.sh` (prompt-injection + zero-width Unicode screening) runs at `PreToolUse(Write|Edit)` — it screens content being written to files, not raw user prompts.

## Authoring Rules

- **Verify before assuming**: read the target event's existing hooks and `hook-utils.sh` before assuming a capability.
- **Mutation discipline**: only `PreToolUse` mutates model-visible data, and only `tool_input`. Do NOT design a `PostToolUse` hook that expects to rewrite tool output.
- **Channel discipline**: pick channel a OR channel b per the registering event's contract, and document which in the hook header. Mixing is allowed only where an existing hook already does so deliberately (`validate-output.sh`).
- **Fail-open default**: a lifecycle hook that cannot block (`SessionStart`, `SubagentStart`, `Stop`/`SubagentStop`) MUST `exit 0` on internal error — never break a session on hook failure. Exception: `~/.glass-atrium/autoagent/` pipeline hooks follow the loud-fail principle (`shared-self-improve-hygiene.md` → Precondition Loud-Fail Principle).
- **No secret/PII in hook output**: hook stdout/stderr is session-visible — never echo `.env` contents, tokens, or PII.
