# Hook Event Capability Contract (Cross-Cutting Concern)

Read this file when the task writes or modifies a hook under `~/.glass-atrium/hooks/`, or when the task reviews a hook change or analyses a hook failure. It binds no other task.

What each Claude Code lifecycle event can observe, what it can mutate, and which block channel it may use.

## Per-Event Capability Table

- `mutate` = changes model-visible data through a documented mechanism.
- `observe-only` = reads, and may block or append, but never mutates the model-visible payload.
- `docs-only` = stated by the published reference (`https://code.claude.com/docs/en/hooks`), never probed.

| Event | Mutate-capable surface | Observe surface | Block channel | Notes |
|-------|------------------------|-----------------|---------------|-------|
| PreToolUse | `tool_input` only (via `updatedInput`) | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `agent_id` | channel a for every block here (measured) · stdout `hookSpecificOutput.permissionDecision`, not `decision` (docs-only) | Cannot read the agent's prose/reasoning. Agent calls: `PreToolUse(Agent) measured record`. |
| PostToolUse | none — observe-only (no `updatedOutput`) | `tool_name`, `tool_response`/output, `tool_input` | channel a, or channel b (stdout `{"decision":"block"}` only) | May only block, or advise via stderr, after the tool ran. |
| `Stop` / `SubagentStop` | none — observe-only | terminal turn / subagent transcript metadata | none (advisory lifecycle; `exit 2` does not rewind a finished turn) | Post-completion accounting only (`cost-tracker.sh`, `track-outcome.sh`). |
| `SessionStart` | injects turn-0 context via stdout (additive, never a mutation) | drained stdin (payload unused by current hooks) | none — an `exit 2` here is an audit signal that rewinds nothing | `inject-session-context.sh` injects; `validate-compliance-matrix.sh` exits 2 on a confirmed matrix or roster mismatch |
| `SubagentStart` | injects child context via stdout `hookSpecificOutput.additionalContext` (additive) | `agent_type`, `agent_id` | none (cannot block a spawn — context-injection only) | `inject-scope-rules.sh` delivers the marker blocks to its rostered children; fail-open, always `exit 0`. |
| `UserPromptSubmit` | injects context via stdout `hookSpecificOutput.additionalContext` (additive) | `prompt`, `transcript_path`, `prompt_id`; never `agent_id`; `source` absent on CLI 2.1.283 | `exit 2` erases the prompt — unused: the registered hook never blocks | `inject-reply-language.sh` — see Event Registration Status. |

### PreToolUse(Agent) measured record

What a PreToolUse hook receives on an `Agent` tool call. Agent calls only: no other tool's envelope is claimed here, and the PreToolUse row above stays the general contract.

- **Provenance**: a live key-names-only capture on CLI 2.1.308; every item below is measured on its sample.
  - Sample: three main-session Agent calls — `run_in_background` sent `true`, sent `false`, omitted — and one Workflow-tool `agent()` spawn.
- **`tool_input` keys**: `description`, `prompt`, `subagent_type` — on all three calls.
- **`run_in_background` is not delivered**: absent from `tool_input` on all three calls, so a hook cannot read the field, whatever the model sends.
  - Not a capture blind spot: the capture records the field from a fixture envelope that carries it.
- **`false` does not keep a call in the foreground**: an explicit `run_in_background: false` call still launched as a background agent, as the call's return showed.
- **Envelope keys**: `agent_type`, `cwd`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`, `scratchpad_dir`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path` — on all three calls; none carried `agent_id`.
- **No key names the background mode**: no envelope or `tool_input` key on the three calls does.
- **Workflow `agent()` spawns do not reach PreToolUse(Agent)**: the Workflow spawn left no record, so no PreToolUse(Agent) hook sees a Workflow spawn.
- **Re-probe**: after a CLI upgrade, re-capture the Agent `tool_input` and envelope keys before a hook relies on any one of them.

## Block Channels (Two Non-Interchangeable Mechanisms)

- Every block this section names pairs its channel with `exit 2`; a stdout decision at `exit 0` is documented, unused by these hooks, and unmeasured.
- **Non-substitutability**: never swap one channel for the other without re-verifying the registering event's contract.
  - Why: each block shows the model one reason text, and the event plus the JSON content decide which surface supplies it (**What the model sees at `exit 2`**, below).
- **Channel a — stderr `emit_error` JSON + `exit 2`**: the hook writes a structured JSON error to stderr (`hook-utils.sh` → `hook_emit_error`), then exits 2.
  - Used by `validate-secret-scan.sh`, `block-dangerous-commands.sh`, `enforce-commit-guard.sh`, `block-no-verify.sh`, `block-md-creation.sh`, `enforce-delegation.sh`, `enforce-harness-critical.sh`.
  - A plain-text stderr reason + `exit 2` with silent stdout is the same channel — `enforce-foreground-harness.sh` is the worked case.
- **Channel b — stdout `{"decision":"block"}` + exit**: the hook prints a JSON object carrying `"decision":"block"` to stdout, then exits — `validate-output.sh`'s blocking LLM05 path, on PostToolUse.
- **`"advisory"` is not a channel-b form**: the PostToolUse decision schema rejects it (`"Hook JSON output validation failed"`), so a non-blocking advisory emits a stderr `emit_error` + `exit 0` instead — `validate-output.sh`'s LLM07 path is the worked case.
- **Discriminator is the stdout `"decision"` JSON, never the exit code**: channel-a hooks carry no stdout `decision` at all, while `validate-output.sh` emits a stdout decision and `exit 2` together.
- **What the model sees at `exit 2`**: on PreToolUse and PostToolUse, stdout JSON at `exit 2` is parsed, not ignored; which text reaches the model differs per event, per the table below.
  - Recheck the two live-probe rows after a CLI upgrade — the published reference does not say which PostToolUse JSON fields apply at `exit 2`.

| Event and stdout JSON at `exit 2` | Basis | Tool | Model sees |
|---|---|---|---|
| PreToolUse, JSON `allow` | live probe, CLI 2.1.308 | does not run — the JSON cannot override the block | stderr, in the error tool_result; `permissionDecisionReason` is not shown |
| PreToolUse, JSON blocking decision | docs-only | does not run | that decision's reason, in place of stderr |
| PostToolUse, `decision:"block"` + `reason` + `additionalContext` | live probe, CLI 2.1.308 | already ran; its tool_result is unchanged, and the turn continues | the `reason` in place of stderr, plus the `additionalContext`; stderr does not reach it |

## on_fail Action Taxonomy (validation-failure disposition vocabulary)

A one-word vocabulary for a failed check's disposition — a description only, never a library import or a dependency.

| Disposition | Mechanism | Reserved for |
|---|---|---|
| **exception** | Hard block: emit on the block channel + `exit 2` (channel a or b) — the offending action does not proceed | a decidable, high-confidence violation — never fail-open uncertainty |
| **fix** | Auto-correct the content in place and continue, with no block and no data loss | a mechanically-decidable correction |
| **filter** | Drop or strip the offending element, or degrade to a fallback, and continue | an operation that stays correct with the bad part removed or substituted |
| **noop** | Pure telemetry: warn/log on stderr + `exit 0`, leaving the operation unchanged | an observation that changes nothing about the operation |
| **reask** | Re-prompt the producer with a tightened instruction rather than blocking or dropping | a producer that can plausibly succeed on a second, tightened attempt |

- **`fix` has no silent-loop form**: an unresolvable case falls through to `exception` or `filter`, never back into the fix.
- **A `noop` MUST NOT be labelled `filter`** — it strips and degrades nothing.

Worked cases, keyed by disposition:

- **exception**: the fail-closed hooks — `validate-secret-scan.sh` · `block-dangerous-commands.sh` · `enforce-harness-critical.sh` · `enforce-foreground-harness.sh` · `enforce-workflow-verify-stage.sh` block verdicts.
- **fix**: the post-write repair hooks — `post-edit-format.sh` · `post-edit-typecheck.sh`.
- **filter**: the resilient-workflow join `.filter(Boolean)` dropping a null agent result · `track-outcome.sh` synthesizing a fallback `done_with_concerns` record on a degraded `[COMPLETION]` parse.
- **noop**: the advisory budget/cost hooks — `advisory-context-budget.sh` · `advisory-spawn-cost.sh` · `advisory-subagent-budget.sh` · `validate-edit-syntax.sh`'s advisory-first path · a `track-outcome.sh` parse advisory that only warns and records the block unchanged.
- **reask**: `robustAgent`'s retry-once-on-null re-spawn in schema-mode workflows · the Failure Recovery Loop retry at the delegation layer.

### Picking a disposition

- **Disposition is event-capability-bound**: an event with no block channel (`Stop`/`SubagentStop`/`SessionStart`/`SubagentStart`) can only `filter`, `fix`, `noop`, or `reask` (via a later spawn) — never `exception`.
  - A SessionStart audit `exit 2` stops nothing, so it is not an `exception`.
  - Naming a disposition grants no capability the registering event lacks.

## Event Registration Status (file-verified)

- Events with at least one registered hook in `settings.json`: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`, `UserPromptSubmit`.
- **`UserPromptSubmit` carries one hook, `inject-reply-language.sh`**, which adds one context line:
  - it recognises a machine-written prompt by `source` first, then by the prompt's wrapper shape; a typed slash command is the user's own prompt, never recognised by its leading slash;
  - it screens nothing: `validate-prompt.sh` (prompt-injection + zero-width Unicode screening) runs at `PreToolUse(Write|Edit)` on content written to files, not on raw user prompts.

## Authoring Rules

- **Verify before assuming**:
  - Read the target event's existing hooks and `hook-utils.sh` before assuming any capability.
  - A capability this file does not list for an event is absent until verified against those hooks, `hook-utils.sh` and `settings.json`.
- **Mutation discipline**: design no hook that rewrites model-visible data other than PreToolUse `tool_input` — a `PostToolUse` hook cannot rewrite tool output.
- **Channel discipline**: pick channel a or channel b per the registering event's contract, and document which in the hook header.
  - Never swap them unverified: `## Block Channels` → **Non-substitutability**.
  - Mixing is allowed only where an existing hook already does so deliberately (`validate-output.sh`).
- **Fail-open default**: a lifecycle hook that cannot block (`SessionStart`, `SubagentStart`, `Stop`/`SubagentStop`) MUST `exit 0` on internal error — never break a session on hook failure.
  - Exception: `~/.glass-atrium/autoagent/` pipeline hooks follow the loud-fail principle (`rules/glass-atrium/shared-self-improve-hygiene.md` → `## Precondition Loud-Fail Principle`).
- **No secret/PII in hook output**: hook stdout/stderr is session-visible — never echo `.env` contents, tokens, or PII.

## Hook Operation Policy

- **Default behavior**: `exit 0` by default · return non-zero only when blocking is intended; a SessionStart audit `exit 2`, which blocks nothing, is the sanctioned exception.
- **Timeout**: the host's command-hook default is 600 seconds, but a hook runs on every matching event, so design it to finish fast.
- **Rollback**: identify the problematic hook → remove its entry from `settings.json` → restart the session.
- **Pre-deployment verification**: confirm blocking behavior with an intentional-violation probe before treating rollout as complete.
  - Claude Code snapshots the hook config at session start, so a `settings.json` binding added mid-session stays inert in every running session (and any pre-warmed background process) until restart.
  - Envelope injection (`echo '{...}' | hook.sh`) tests the script in isolation, not live dispatch — rollout is complete only after a restart plus a live intentional-violation tool-call probe in a fresh session.
