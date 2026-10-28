# Hook Event Capability Contract (Cross-Cutting Concern)

Read this file when the task writes or modifies a hook under `~/.glass-atrium/hooks/`, or when the task reviews a hook change or analyses a hook failure. It binds nothing on any other task — it is a reference to open on that trigger, never a standing duty.

Per-event capability contract for Claude Code lifecycle hooks: what each event can observe, what it can mutate, and which block channel it may use. Consult it before assuming an event can read prose, mutate output, or block — a capability this file does not list for an event is absent until you verify it against that event's existing hooks, `hook-utils.sh` and `settings.json`.

## Per-Event Capability Table

Rows = lifecycle event · columns = capability surface. `mutate` = can change model-visible data through a documented mechanism · `observe-only` = read + block/append but no mutation of the model-visible payload. The channel column names the block mechanism the event supports (see Block Channels below).

| Event | Mutate-capable surface | Observe surface | Block channel | Notes |
|-------|------------------------|-----------------|---------------|-------|
| PreToolUse | `tool_input` only (via `updatedInput`) | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `agent_id` | channel-a for every block here (measured) · stdout `hookSpecificOutput.permissionDecision`, not `decision` (docs-only) | Cannot read the agent's prose/reasoning. Agent calls: `PreToolUse(Agent) measured record`. |
| PostToolUse | none — observe-only (no `updatedOutput`) | `tool_name`, `tool_response`/output, `tool_input` | channel-a (`exit 2`) or channel-b (stdout `{"decision":"block"}` only — `"advisory"` is rejected, see Block Channels) | Cannot mutate model-visible tool output. May only block, or advise via stderr, after the tool ran. |
| `Stop` / `SubagentStop` | none — observe-only | terminal turn / subagent transcript metadata | none (advisory lifecycle; `exit 2` does not rewind a finished turn) | Post-completion accounting only (`cost-tracker.sh`, `track-outcome.sh`). No payload to mutate. |
| `SessionStart` | injects turn-0 context via stdout (additive, never a mutation) | drained stdin (payload unused by current hooks) | none for the injection itself (`exit 0`); one audit-grade `exit 2` exists, see the note | `inject-session-context.sh` injects its stdout into session context. `validate-compliance-matrix.sh` exits 2 on a confirmed matrix inconsistency (its Layer B) while its Layer A drift check stays advisory — neither rewinds the session, which SessionStart cannot do. |
| `SubagentStart` | injects child context via stdout `hookSpecificOutput.additionalContext` (additive) | `agent_type`, `agent_id` | none (cannot block a spawn — context-injection only) | `inject-scope-rules.sh` delivers the marker blocks to its rostered children. Fail-open (`exit 0`) always. |
| `UserPromptSubmit` | injects context via stdout `hookSpecificOutput.additionalContext` (additive) | `prompt`, `transcript_path`, `prompt_id`; never `agent_id`; `source` absent on CLI 2.1.283 | `exit 2` erases the prompt — unused: the registered hook never blocks | `inject-reply-language.sh` adds one context line and always exits 0. See Event Registration Status. |

### PreToolUse(Agent) measured record

What a PreToolUse hook receives on an `Agent` tool call. Agent calls only: no other tool's envelope is claimed here, and the PreToolUse row above stays the general contract.

- **Provenance**: captured live 2026-10-23 by a temporary key-names-only capture in `hooks/enforce-foreground-harness.sh`, since removed, CLI 2.1.308.
  - Captured: three main-session Agent calls — `run_in_background` sent `true`, sent `false`, omitted — and one Workflow-tool `agent()` spawn.
- **`tool_input` keys** [measured]: `description`, `prompt`, `subagent_type` — on all three calls.
- **`run_in_background` is not delivered** [measured]: absent from `tool_input` on all three calls — sent `true`, sent `false`, omitted.
  - So a hook cannot read the field, whatever the model sends.
  - The capture records the field from a fixture envelope that carries it, so its absence is not a blind spot of the capture.
- **`false` does not keep a call in the foreground** [measured]: an explicit `run_in_background: false` call still launched as a background agent, as the call's return showed.
- **Envelope keys** [measured]: `agent_type`, `cwd`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`, `scratchpad_dir`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path` — on all three calls; none carried `agent_id`.
- **No key names the background mode** [measured]: no envelope or `tool_input` key on the three calls names the session's background mode.
- **Workflow `agent()` spawns do not reach PreToolUse(Agent)** [measured]: the Workflow spawn left no record, so no PreToolUse(Agent) hook sees a Workflow spawn.
- **Re-probe**: after a CLI upgrade, re-capture the Agent `tool_input` and envelope keys before a hook relies on any one of them.

## Block Channels (Two Non-Interchangeable Mechanisms)

Both channels exist, they are not substitutable, and a hook MUST pick the one its registering event's consumer expects. `exit 2` alone does not imply a stdout decision.

- Every hook this section names pairs its channel with `exit 2`. A stdout decision at `exit 0` is a documented path none of them uses, and it is unmeasured.
- **Channel a — stderr `emit_error` JSON + `exit 2`**: `emit_error` writes a structured JSON error to stderr (`hook-utils.sh` `hook_emit_error` → `>&2`), then the hook exits 2. No stdout `decision` field. Used by `validate-secret-scan.sh`, `block-dangerous-commands.sh`, `enforce-commit-guard.sh`, `block-no-verify.sh`, `block-md-creation.sh`, `enforce-delegation.sh`, `enforce-harness-critical.sh`.
  - A plain-text stderr reason + `exit 2` with silent stdout is the same channel: `enforce-foreground-harness.sh` writes its reason to stderr as plain text — a candidate or cap block puts its cause ahead of the Rule 2 text (`skills/glass-atrium-ops-orchestrator-role.md` → `## Harness Path Protection`).
- **Channel b — stdout `{"decision":"block"}` + exit**: the hook prints a JSON object carrying `"decision":"block"` to stdout, then exits. Used by `validate-output.sh` (its blocking LLM05 path, on PostToolUse).
- **`"advisory"` is not a channel-b form**: the PostToolUse decision schema rejects it (`"Hook JSON output validation failed"`), so a non-blocking advisory emits a stderr `emit_error` + `exit 0` instead — `validate-output.sh`'s LLM07 path is the worked case.
- **Discriminator is the stdout `"decision"` JSON, never the exit code**: `exit 2` is not exclusive to channel a — `validate-output.sh` emits a stdout decision and `exit 2` together. Channel-a hooks carry no stdout `decision` at all.
  - On PreToolUse that stdout field is `hookSpecificOutput.permissionDecision`; top-level `decision` is deprecated there (published reference only, `https://code.claude.com/docs/en/hooks`).
- **What the model sees at `exit 2`**: stdout JSON is not ignored at `exit 2` on PreToolUse or PostToolUse — it is parsed. Which text reaches the model differs per event, per the table below.
  - Recheck the two live-probe rows after a CLI upgrade — the published reference does not say which PostToolUse JSON fields apply at `exit 2`.

| Event and stdout JSON at `exit 2` | Basis | Tool | Model sees |
|---|---|---|---|
| PreToolUse, JSON `allow` | live probe, CLI 2.1.308 | does not run — the JSON cannot override the block | stderr, in the error tool_result; `permissionDecisionReason` is not shown |
| PreToolUse, JSON blocking decision | published reference only (`https://code.claude.com/docs/en/hooks`), not probed | does not run | that decision's reason, in place of stderr |
| PostToolUse, `decision:"block"` + `reason` + `additionalContext` | live probe, CLI 2.1.308 | already ran; its tool_result is unchanged, and the turn continues | the `reason` in place of stderr, plus the `additionalContext`; stderr does not reach it |

- **Non-substitutability**: do NOT swap a channel-a `emit_error`+`exit 2` for a stdout `decision`, or the reverse, without verifying the registering event's contract.
  - Why: each block shows the model one reason text, and the event plus the JSON content decide which surface supplies it (**What the model sees at `exit 2`** above).

## on_fail Action Taxonomy (validation-failure disposition vocabulary)

A failed check has one of five dispositions. This is a shared vocabulary for describing a hook's behaviour in one word — docs-only, no library import and no dependency.

| Disposition | Mechanism | Used by | Reserved for |
|---|---|---|---|
| **exception** | Hard block: emit on the block channel + `exit 2` (channel a or b) — the offending action does not proceed | the fail-closed hooks: `validate-secret-scan.sh` · `block-dangerous-commands.sh` · `enforce-harness-critical.sh` · `enforce-foreground-harness.sh` · `enforce-workflow-verify-stage.sh` block verdicts | a decidable, high-confidence violation — never fail-open uncertainty |
| **fix** | Auto-correct the content in place and continue, with no block and no data loss | the post-write repair hooks: `post-edit-format.sh` · `post-edit-typecheck.sh` | a mechanically-decidable correction |
| **filter** | Drop or strip the offending element, or degrade to a fallback, and continue | the resilient-workflow join `.filter(Boolean)` dropping a null agent result · `track-outcome.sh` synthesizing a fallback `done_with_concerns` record on a degraded `[COMPLETION]` parse | an operation that stays correct with the bad part removed or substituted |
| **noop** | Pure telemetry: warn/log on stderr + `exit 0`, leaving the operation unchanged | the advisory budget/cost hooks: `advisory-context-budget.sh` · `advisory-spawn-cost.sh` · `advisory-subagent-budget.sh` · `validate-edit-syntax.sh`'s advisory-first path | an observation that changes nothing about the operation |
| **reask** | Re-prompt the producer with a tightened instruction rather than blocking or dropping | `robustAgent`'s retry-once-on-null re-spawn in schema-mode workflows · the Failure Recovery Loop retry at the delegation layer | a producer that can plausibly succeed on a second, tightened attempt |

- **`fix` has no silent-loop form**: an unresolvable case falls through to `exception` or `filter`, never back into the fix.
- **A `noop` MUST NOT be labelled `filter`** — it strips and degrades nothing.

### Picking a disposition

- **Disposition is event-capability-bound**: an event with no block channel (`Stop`/`SubagentStop`/`SessionStart`/`SubagentStart`) can only `filter`, `fix`, `noop`, or `reask` (via a later spawn) — it can NEVER `exception`. Pick the disposition the registering event actually supports; naming one does not grant a capability the event lacks.
- **Read-side counterpart**: `track-outcome.sh`'s `[COMPLETION]` parse tiers use the same vocabulary — a tier miss that synthesizes a fallback record is a `filter` (a substituting action), while an advisory that only warns and records the block unchanged is a `noop`.

## Event Registration Status (file-verified)

- Events with at least one registered hook in `settings.json`: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`, `UserPromptSubmit`.
- **`UserPromptSubmit` carries one hook, `inject-reply-language.sh`** — a context line only, never a block:
  - it recognises a machine-written prompt by `source` first, then by the prompt's wrapper shape; a typed slash command is the user's own prompt, never recognised by its leading slash;
  - it screens nothing: `validate-prompt.sh` (prompt-injection + zero-width Unicode screening) runs at `PreToolUse(Write|Edit)` on content written to files, not on raw user prompts.

## Authoring Rules

- **Verify before assuming**: read the target event's existing hooks and `hook-utils.sh` before assuming a capability.
- **Mutation discipline**: only `PreToolUse` mutates model-visible data, and only `tool_input`. Do NOT design a `PostToolUse` hook that expects to rewrite tool output.
- **Channel discipline**: pick channel a or channel b per the registering event's contract, and document which in the hook header. Mixing is allowed only where an existing hook already does so deliberately (`validate-output.sh`).
- **Fail-open default**: a lifecycle hook that cannot block (`SessionStart`, `SubagentStart`, `Stop`/`SubagentStop`) MUST `exit 0` on internal error — never break a session on hook failure. Exception: `~/.glass-atrium/autoagent/` pipeline hooks follow the loud-fail principle (`shared-self-improve-hygiene.md` → Precondition Loud-Fail Principle).
- **No secret/PII in hook output**: hook stdout/stderr is session-visible — never echo `.env` contents, tokens, or PII.

## Hook Operation Policy

- **Default behavior**: `exit 0` by default · return non-zero only when blocking is intended.
- **Timeout**: the host's command-hook default is 600 seconds, but a hook runs on every matching event, so design it to finish fast.
- **Rollback**: identify the problematic hook → remove its entry from `settings.json` → restart the session.
- **Pre-deployment verification**: confirm blocking behavior with an intentional-violation probe before treating rollout as complete.
  - Claude Code snapshots the hook config at session start, so a `settings.json` binding added mid-session stays inert in every running session (and any pre-warmed background process) until restart.
  - Envelope injection (`echo '{...}' | hook.sh`) tests the script in isolation, not live dispatch — rollout is complete only after a restart plus a live intentional-violation tool-call probe in a fresh session.
