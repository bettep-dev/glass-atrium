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
| `Stop` / `SubagentStop` | none — observe-only | `Stop` stdin payload (measured 2.1.322 `-p`, 2026-11-13: `background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path`); `stop_hook_active` is `false` on the first fire and `true` on the fire that follows a block (measured, same run); `SubagentStop` adds `agent_id`, `agent_type`, `agent_transcript_path` (docs-only) · `Stop` session env (measured, same run, parent session ids unset before launch): `CLAUDE_CODE_SESSION_ID` set and equal to the payload `session_id`; `CLAUDE_PID` set, the session's own `claude` process (its nearest `claude` ancestor); `CLAUDE_CODE_MESSAGING_SOCKET` and the messaging token set; `CLAUDE_CONFIG_DIR` set; the session id and pid equal the Bash tool env of the same session | channel b at `exit 0` keeps Claude from stopping and continues the turn: the `reason` reaches the model as a user-role text `Stop hook feedback:` + the reason, and the model answered it in the same turn — a continuation, never a rewind (measured 2.1.322 `-p`, 2026-11-13) · `exit 2` + stderr: docs-only · unmeasured: `--bg` (refused for an untrusted workspace; trust is a profile write) and interactive sessions | `Stop` fires for the main agent only, never on a user interrupt (an API error fires `StopFailure`) — docs-only; the interrupt case needs the owner at an interactive terminal. `queue-turn-end-check.sh` is the one blocking `Stop` hook: it reads `stop_hook_active` and its own stamp, because the host's eight-continuation cap resets on every tool call. `cost-tracker.sh`, `advisory-preedit-facts.sh`, `post-edit-typecheck.sh` and `track-outcome.sh` only account or advise, and a continued turn runs them again. Source: `https://code.claude.com/docs/en/hooks` → `### Stop`, `### Stop input`, `### Stop decision control`. |
| `SessionStart` | injects turn-0 context via stdout (additive, never a mutation) | stdin payload (measured 2.1.319: `cwd`, `hook_event_name`, `session_id`, `source`, `transcript_path`, plus `model` on interactive and `--bg` starts; no `permission_mode`): `queue-session-register.sh` reads `cwd` and `session_id` for the register and `permission_mode` as a display hint only, should a version send it; the other hooks drain it unused · session env `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` (measured: the session's own process), `CLAUDE_CODE_MESSAGING_SOCKET` (measured: set), `CLAUDE_CONFIG_DIR` | none — an `exit 2` here is an audit signal that rewinds nothing | `inject-session-context.sh` injects; `validate-compliance-matrix.sh` exits 2 on a confirmed matrix or roster mismatch; `queue-session-register.sh` registers the session with the owner queue and adds one count-only pointer line, fail-open, always `exit 0` |
| `SessionEnd` | none — observe-only | stdin payload (measured 2.1.319: `cwd`, `hook_event_name`, `prompt_id`, `reason`, `session_id`, `transcript_path`): `queue-session-deregister.sh` reads `session_id` · session env `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` (measured: set, the ending session's own process), `CLAUDE_CODE_MESSAGING_SOCKET` and the messaging token (measured: both unset) | none (docs-only: the session is already ending) | `queue-session-deregister.sh` deregisters the session and removes its token file, fail-open, always `exit 0`. Fires on `-p` exit and `claude stop` (`reason` `other`) and on interactive `/exit` (`reason` `prompt_input_exit`) (measured 2.1.319); other exits (Ctrl-D, a closed terminal, a kill) are unprobed, and a missed run is covered by the monitor's dead-session rule |
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

- Every block this section names pairs its channel with `exit 2`, except the `Stop` use of channel b at `exit 0` (measured on `-p`, CLI 2.1.322; the `Stop` row above).
- **Non-substitutability**: never swap one channel for the other without re-verifying the registering event's contract.
  - Why: each block shows the model one reason text, and the event plus the JSON content decide which surface supplies it (**What the model sees at `exit 2`**, below).
- **Channel a — stderr `emit_error` JSON + `exit 2`**: the hook writes a structured JSON error to stderr (`hook-utils.sh` → `hook_emit_error`), then exits 2.
  - Used by `validate-secret-scan.sh`, `block-dangerous-commands.sh`, `enforce-commit-guard.sh`, `enforce-delegation.sh`, `validate-pre-write-raw.sh`, `lint-workflow-template-literal.sh` (plain-text reason), and the no-progress brake of `advisory-subagent-budget.sh` (`NOPROGRESS-001`).
  - A plain-text stderr reason + `exit 2` with silent stdout is the same channel.
- **Channel b — stdout `{"decision":"block"}` + exit**: the hook prints a JSON object carrying `"decision":"block"` to stdout, then exits — no registered PostToolUse hook uses it.
  - On `Stop` the object at `exit 0` keeps Claude from stopping, and its required `reason` tells Claude why it should continue (measured on `-p`, CLI 2.1.322; source: `https://code.claude.com/docs/en/hooks` → `### Stop decision control`); `queue-turn-end-check.sh` uses it.
- **`"advisory"` is not a channel-b form**: the PostToolUse decision schema rejects it (`"Hook JSON output validation failed"`), so a non-blocking advisory emits a stderr `emit_error` + `exit 0` instead — `validate-output.sh`'s LLM07 path is the worked case.
- **Discriminator is the stdout `"decision"` JSON, never the exit code**: channel-a hooks carry no stdout `decision` at all, while a channel-b block emits a stdout decision and `exit 2` together.
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

- **exception**: the blocking hooks — `validate-secret-scan.sh` · `block-dangerous-commands.sh` · `enforce-commit-guard.sh` · `enforce-delegation.sh`'s sensitive-file block · `validate-pre-write-raw.sh` · `lint-workflow-template-literal.sh`.
  - Also an exception: the no-progress brake of `advisory-subagent-budget.sh` (`NOPROGRESS-001`, armed by default) — the one block in an otherwise advisory hook.
- **fix**: the post-write repair hooks — `post-edit-format.sh` · `post-edit-typecheck.sh`.
- **filter**: the resilient-workflow join `.filter(Boolean)` dropping a null agent result · `track-outcome.sh` synthesizing a fallback `done_with_concerns` record on a degraded `[COMPLETION]` parse.
- **noop**: the advisory budget/cost hooks — `advisory-context-budget.sh` · `advisory-spawn-cost.sh` · `advisory-subagent-budget.sh` · `validate-edit-syntax.sh`.
  - `advisory-subagent-budget.sh` is a noop for its tool-use nudges only; its no-progress brake is listed under **exception**.
  - Also noop: the `enforce-verification-gate.sh` and `enforce-workflow-verify-stage.sh` warnings.
  - Also noop: a `track-outcome.sh` parse advisory that only warns and records the block unchanged.
- **reask**: `robustAgent`'s retry-once-on-null re-spawn in schema-mode workflows · the Failure Recovery Loop retry at the delegation layer · `queue-turn-end-check.sh`'s one `Stop` continuation naming the queue wait command.

### Picking a disposition

- **Disposition is event-capability-bound**: an event with no block channel (`SessionStart`/`SessionEnd`/`SubagentStart`) can only `filter`, `fix`, `noop`, or `reask` (via a later spawn) — never `exception`.
  - A `Stop`/`SubagentStop` block continues the turn that just finished, so it is a `reask` of the same model, never an `exception`: nothing it blocks is undone.
  - A SessionStart audit `exit 2` stops nothing, so it is not an `exception`.
  - Naming a disposition grants no capability the registering event lacks.

## Event Registration Status (file-verified)

- Events with at least one registered hook in `settings.json`: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`.
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
- **Fail-open default**: a lifecycle hook (`SessionStart`, `SessionEnd`, `SubagentStart`, `Stop`/`SubagentStop`) MUST `exit 0` on internal error — never break a session on hook failure.
  - A `Stop` hook blocks only on a condition it decided, never on an error it hit, and checks `stop_hook_active` so it blocks at most once per turn end.
  - Exception: `~/.glass-atrium/autoagent/` pipeline hooks follow the loud-fail principle (`rules/glass-atrium/shared-self-improve-hygiene.md` → `## Precondition Loud-Fail Principle`).
- **No secret/PII in hook output**: hook stdout/stderr is session-visible — never echo `.env` contents, tokens, or PII.

## Hook Operation Policy

- **Default behavior**: `exit 0` by default · return non-zero only when blocking is intended; a SessionStart audit `exit 2`, which blocks nothing, is the sanctioned exception.
- **Timeout**: the host's command-hook default is 600 seconds, but a hook runs on every matching event, so design it to finish fast.
- **Rollback**: identify the problematic hook → remove its entry from `settings.json` → restart the session.
- **Pre-deployment verification**: confirm blocking behavior with an intentional-violation probe before treating rollout as complete.
  - Claude Code snapshots the hook config at session start, so a `settings.json` binding added mid-session stays inert in every running session (and any pre-warmed background process) until restart.
  - Envelope injection (`echo '{...}' | hook.sh`) tests the script in isolation, not live dispatch — rollout is complete only after a restart plus a live intentional-violation tool-call probe in a fresh session.
