# Hook Event Capability Contract (Cross-Cutting Concern)

> **Loading**: Tier 3 (Cross-cutting) — reference for DEV/QA agents that author or modify hooks under `~/.glass-atrium/hooks/`
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Authoritative per-event capability contract for Claude Code lifecycle hooks. A hook author MUST consult this before assuming an event can read prose, mutate output, or block via a given channel. Capability claims here are verified against the actual hooks in `~/.glass-atrium/hooks/` + `hook-utils.sh` + `settings.json` (do NOT infer beyond what the event actually exposes).

## Why This Exists

- Hook events differ in what they can **observe**, what they can **mutate**, and **which block channel** they may use — these are NOT uniform across events.
- `PostToolUse` cannot mutate model-visible tool output — observe + block/append only, no `updatedOutput`.
- The two block channels are **non-substitutable** (stderr `emit_error`+`exit 2` vs. stdout `{"decision":...}`) — picking the wrong one silently no-ops the block.

## Per-Event Capability Table

Rows = lifecycle event · columns = capability surface. `mutate` = can change model-visible data via a documented mechanism · `observe-only` = read + block/append but NO mutation of model-visible payload. Channel column names the block mechanism the event supports (see Block Channels below).

| Event | Mutate-capable surface | Observe surface | Block channel | Notes |
|-------|------------------------|-----------------|---------------|-------|
| PreToolUse | `tool_input` only (via `updatedInput` mechanism) | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `agent_id` | channel-a (stderr `emit_error`+`exit 2`) AND/OR channel-b (stdout `{"decision":"block"}`) | mutate-capable: ONLY `tool_input`. CANNOT read the agent's prose/reasoning — only `tool_input`/`session_id`/`agent_id` are visible. |
| PostToolUse | none — observe-only (no `updatedOutput`) | `tool_name`, `tool_response`/output, `tool_input` | channel-a (`exit 2`) OR channel-b (stdout `{"decision":"block"}` ONLY — the PostToolUse decision schema REJECTS `"advisory"`; a non-blocking advisory instead emits a stderr `emit_error` + `exit 0`, no stdout JSON) | CANNOT mutate model-visible tool output. May only block, or advise via stderr, after the tool ran. |
| `Stop` / `SubagentStop` | none — observe-only | terminal turn / subagent transcript metadata | none (advisory lifecycle; `exit 2` does not rewind a finished turn) | post-completion accounting only (e.g. `cost-tracker.sh`, `track-outcome.sh`). No payload to mutate. |
| `SessionStart` | injects turn-0 context via stdout (additive, not a mutation of existing data) | drained stdin (payload unused by current hooks) | context-injection is `exit 0`; `validate-compliance-matrix.sh` Layer B emits a sanctioned audit-grade `exit 2` on a CONFIRMED matrix inconsistency (does NOT rewind the session — SessionStart cannot un-inject context) | stdout text is injected into session context (`inject-session-context.sh`). `validate-compliance-matrix.sh` Layer A drift check is advisory (`exit 0`), but its Layer B matrix-internal inconsistency check exits with the audit-grade non-zero code (`exit ${layer_b_rc}`). |
| `SubagentStart` | injects child context via stdout `hookSpecificOutput.additionalContext` (additive) | `agent_type`, `agent_id` | none (cannot block a spawn — context-injection only) | `inject-scope-rules.sh` delivers the comment-rule block to DEV/QA children. Fail-open (`exit 0`) always. |
| `UserPromptSubmit` | (not currently registered — see Event Registration Status) | n/a | n/a | NO `UserPromptSubmit` hook exists in `settings.json`. Prompt-injection screening runs at `PreToolUse(Write\|Edit)` via `validate-prompt.sh`, NOT at prompt-submit time. |

## Block Channels (Two Non-Interchangeable Mechanisms)

Both channels exist · they are NOT substitutable · a hook MUST pick the channel its consumer expects. `exit 2` alone does NOT imply a stdout decision, and a stdout decision without the matching exit does NOT block.

- **Channel a — stderr `emit_error` JSON + `exit 2`**: the `emit_error` helper writes a structured JSON error to **stderr** (`hook-utils.sh` `hook_emit_error` → `>&2`), then the hook calls `exit 2`. No stdout `decision` field is emitted. Used by: `validate-secret-scan.sh`, `block-dangerous-commands.sh`, `enforce-commit-guard.sh`, `block-no-verify.sh`, `block-md-creation.sh`, `enforce-delegation.sh`.
- **Channel b — stdout `{"decision":"block"}` + exit**: the hook prints a JSON object with a `"decision":"block"` key to **stdout**, then exits. The PostToolUse decision schema REJECTS `"advisory"` (`"Hook JSON output validation failed"`), so a non-blocking advisory is NOT a channel-b form — it emits a stderr `emit_error` + `exit 0` (no stdout `decision`). Used by: `validate-output.sh` (blocking LLM05 path → `{"decision":"block"}` + `exit 2`; its non-blocking LLM07 advisory path → stderr `emit_error` + `exit 0`), `enforce-foreground-harness.sh` (emits `{"decision":"block",...}`).
- **Channel overlap caveat (file-verified)**: `exit 2` is NOT exclusive to channel a — `validate-output.sh` and `enforce-foreground-harness.sh` use a stdout `decision` block AND `exit 2` together. The discriminator is therefore the **presence of the stdout `"decision"` JSON**, not the exit code. Channel-a hooks emit error JSON on stderr only and carry no stdout `decision`.
- **Non-substitutability rule**: do NOT replace a channel-a `emit_error`+`exit 2` with a stdout `decision`, or vice versa, without verifying the registering event's expected contract — the consumer reads exactly one surface.

## on_fail Action Taxonomy (validation-failure disposition vocabulary)

When a hook — or a `[COMPLETION]` parse-tier validator — detects a failed check, its DISPOSITION falls into one of five named actions. This is a SHARED VOCABULARY only, **DOCS-ONLY — no library import, no new dependency** (naming borrowed from guardrails-ai's `OnFailAction` enum so a hook's behavior is describable in one word). Guardrails ships eight members (`REASK`, `FIX`, `FILTER`, `REFRAIN`, `NOOP`, `EXCEPTION`, `FIX_REASK`, `CUSTOM` — `guardrails/types/on_fail.py`); Atrium names the five its hooks actually exercise (`exception`, `filter`, `reask`, `fix`, `noop`) and documents the rest as gaps below. Every existing hook already implements one of these; the taxonomy just names them.

- **exception** — HARD-block the operation: emit on the block channel + `exit 2` (channel-a `emit_error`+`exit 2` OR channel-b `{"decision":"block"}`). The offending action does NOT proceed. Used by the fail-closed hooks (`validate-secret-scan.sh`, `block-dangerous-commands.sh`, `enforce-foreground-harness.sh`, `enforce-workflow-verify-stage.sh` block verdicts). Reserved for a decidable, high-confidence violation — never fail-open uncertainty.
- **fix** — AUTO-CORRECT the offending content in place and CONTINUE, no block and no data loss (distinct from `filter`, which drops/degrades rather than repairing). Used by the post-write repair hooks that reformat/normalize an edit after it lands (`post-edit-format.sh`, `post-edit-typecheck.sh`). Reserved for a mechanically-decidable correction; an unresolvable case must fall through to `exception` or `filter`, never a silent fix-loop.
- **filter** — DROP/strip the offending element (or degrade to a fallback) and CONTINUE, no block: the operation proceeds with the bad part removed or a substitute in its place. Example: the resilient-workflow join `.filter(Boolean)` dropping a null (failed) agent result and continuing with survivors (`glass-atrium-ops-orchestrator` → Resilient Workflow Authoring); `track-outcome.sh` synthesizing a fallback `done_with_concerns` record when the `[COMPLETION]` parse degrades. Distinct from `noop` — `filter` takes a corrective/substituting action, `noop` takes none.
- **noop** — PURE TELEMETRY, no enforcement and no correction: warn/log on stderr + `exit 0`, leaving the operation entirely unchanged. Used by the advisory-only budget/cost hooks (`advisory-context-budget.sh`, `advisory-spawn-cost.sh`, `advisory-subagent-budget.sh`) and the `validate-edit-syntax.sh` advisory-first path (it surfaces the checker diagnostic but neither blocks nor alters the write). A `noop` hook MUST NOT be mislabeled `filter` — it strips/degrades nothing.
- **reask** — RE-PROMPT/retry the producer with a tightened instruction rather than blocking or dropping. Example: the `robustAgent` retry-once-on-null re-spawn with a tightened re-prompt (schema-mode workflows); the Failure Recovery Loop retry (`orchestrator-role.md`) is a reask at the delegation layer.

**Unmapped guardrails members (documented gaps, no Atrium hook yet)**: `REFRAIN` (suppress the WHOLE output vs `FILTER`/`filter` stripping ONE element — guardrails implements them as separate `apply_refrain`/`apply_filters` functions; Atrium conflates both under `filter` because no hook needs the split today — noted here rather than left silent) · `FIX_REASK` (auto-fix → reverify → reask-if-still-failing — no Atrium hook chains these three; a candidate hardening) · `CUSTOM` (arbitrary user callback — out of scope for the fixed hook vocabulary).

**parse-tier naming alignment**: `track-outcome.sh`'s multi-tier `[COMPLETION]` parse (`parse_tier` 1 = complete-block / inline-tolerance; higher tiers = degraded → synthesized) is the READ-side counterpart of this taxonomy — and it distinguishes two exit-0 dispositions that were previously both called `filter`: a tier miss that SYNTHESIZES a fallback `done_with_concerns` record is a `filter`-style degradation (a substituting action), whereas a pure advisory that only warns and records the raw block unchanged (no synthesis, no substitution) is a `noop`. Neither is ever an `exception`-block, because `Stop`/`SubagentStop` cannot rewind a finished turn (see the capability table). **Disposition is event-capability-bound**: an event with NO block channel (`Stop`/`SubagentStop`/`SessionStart`/`SubagentStart`) can only `filter` (substitute/degrade), `fix` (correct-in-place), `noop` (advise), or `reask` (via a later spawn) — it can NEVER `exception`. Pick the disposition the registering event actually supports; naming it does not grant a capability the event lacks.

## Event Registration Status (file-verified)

Events with at least one registered hook in `settings.json`: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`.

- **`UserPromptSubmit` — NOT registered**: no hook is wired to this event. Any contract claim about it is hypothetical until a hook is added. `validate-prompt.sh` (prompt-injection + zero-width Unicode screening) runs at `PreToolUse(Write|Edit)`, i.e. it screens content being written to files, not raw user prompts.
- Authors adding a `UserPromptSubmit` hook MUST update this table with its verified capabilities at that time.

## Authoring Rules

- **Verify before assuming**: read the target event's existing hooks + `hook-utils.sh` before assuming a capability. A capability not listed here for an event is assumed ABSENT until file-verified.
- **Mutation discipline**: only `PreToolUse` mutates model-visible data, and only `tool_input`. Do NOT design a `PostToolUse` hook that expects to rewrite tool output.
- **Channel discipline**: pick channel a OR channel b per the registering event's contract; document which in the hook header. Mixing is allowed only where an existing hook already does so (`validate-output.sh`) and is intentional.
- **Fail-open default**: lifecycle hooks that cannot block (`SessionStart`, `SubagentStart`, `Stop`/`SubagentStop`) MUST `exit 0` on internal error — never break a session on hook failure (`GLASS_ATRIUM_GLOBAL_RULES.md` Hook Operation Policy). Exception: `~/.glass-atrium/autoagent/` self-improvement pipeline hooks follow the loud-fail principle (`shared-self-improve-hygiene.md`).
- **No secret/PII in hook output**: hook stdout/stderr is session-visible — never echo `.env`, tokens, or PII (`core-security.md` Secret Management, LLM07).

## Cross-References

- `~/.glass-atrium/hooks/hook-utils.sh` — `hook_emit_error` (channel a), `hook_read_input`, `hook_get_field`, `hook_get_tool_input`, `hook_is_subagent`
- `~/.claude/settings.json` — event → hook registration (the authority for which events are wired)
- `~/.claude/rules/glass-atrium/core-security.md` — LLM01 tool-input trust boundary · LLM06 tool authorization · LLM07 system-prompt leakage
- `~/.claude/rules/glass-atrium/orchestrator-role.md` — Harness Path Protection (the `enforce-foreground-harness.sh` channel-b rationale)
- `~/.claude/rules/glass-atrium/shared-self-improve-hygiene.md` — Precondition Loud-Fail (the autoagent-pipeline exception to fail-open)
