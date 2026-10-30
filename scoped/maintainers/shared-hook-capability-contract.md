# Maintainer note — `scoped/shared-hook-capability-contract.md`

Maintainer-facing material for that rule file. Nothing here binds a hook author; the rule file carries the contract.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Loading and membership

- Task-conditional, never standing: the rule file opens with its own trigger line, phrased to match the two `when` strings in `scripts/agent_lifecycle/registry_ops.py`.
  - `_HOOK_AUTHORING_CONDITION` ("the task writes or modifies a hook under ~/.glass-atrium/hooks/") for DEV.
  - `_HOOK_REVIEW_CONDITION` ("the task reviews a hook change or analyses a hook failure") for QA.
  - Keep those strings and the rule file's trigger line in step; do not invent a third phrasing.
- Membership sits on the `agent-registry.json` `rules.conditional` entries and in `rules/glass-atrium/core-compliance-matrix.md` (¶ footnote, which names each trigger).
  - `glass-atrium-meta-prompt-engineer` does not take it — hook authoring is not "prompts = code".
- Keep it conditional: standing delivery would spend roughly the whole SubagentStart channel budget on a condition that fires on a small minority of turns.

## Maintainer material moved out of the rule file

- **Taxonomy provenance**: the action names are borrowed from guardrails-ai's `OnFailAction` enum so a hook's behaviour is describable in one word; docs-only, no import and no dependency.
  - Guardrails members: `REASK`, `FIX`, `FILTER`, `REFRAIN`, `NOOP`, `EXCEPTION`, `FIX_REASK`, `CUSTOM` (`guardrails/types/on_fail.py`); Atrium names only the ones its hooks exercise.
- **Unmapped members (gap register)**:
  - `REFRAIN` — suppress the whole output, where `FILTER` strips one element; guardrails implements them as separate `apply_refrain` / `apply_filters` functions, and Atrium conflates both under `filter` because no hook needs the split.
  - `FIX_REASK` — auto-fix, reverify, reask if still failing; no Atrium hook chains all three, so it is a candidate hardening.
  - `CUSTOM` — arbitrary user callback, out of scope for a fixed vocabulary.
- **Corpus-maintenance duty (`UserPromptSubmit`)**: the wrapper-shape list in `hooks/inject-reply-language.sh` → `get_prompt_kind` and its fixtures in `hooks/test/inject-reply-language.bats` move together — one prefix, one fixture per shape.
- **Known gap (agent-context prompts)**: `get_prompt_kind` silences only frame-shaped agent prompts; a frameless machine prompt (a task notification, a "Background agent" notice) in an agent context still gets the pointer.
  - The UserPromptSubmit envelope carries no `agent_id`, so no static signal exists; a live probe of a background-task notification inside a teammate or background-agent context is what settles it.
  - Shapes that get the line: task notification · cross-session message or idle notice (peer) · channel message · compaction summary · hook feedback.
  - Agent frames that silence it: teammate message · workflow frame · coordinator message — the frame is the only signal.
  - Scheduled-task fires and `/loop` wakeups replay stored text with no frame: only `source` can name them.
  - **Switch to `source`**: CLI 2.1.283 documents `source` on `UserPromptSubmit` but leaves it out of the payload.
    - Once a CLI fills it, recognise machine-written prompts by it and keep the wrapper list only as the fallback for a payload without it.
    - Recheck on every CLI upgrade.
  - Whoever adds another hook on a prompt event records its verified capabilities in the capability table.
- **Cross-references**:
  - `hooks/hook-utils.sh` — `hook_emit_error` (channel a), `hook_read_input`, `hook_get_field`, `hook_get_tool_input`, `hook_is_subagent`.
  - `settings.json` — the authority for which events are wired.
  - `rules/glass-atrium/core-security.md` — LLM01 tool-input trust boundary, LLM06 tool authorization, LLM07 prompt leakage.
  - `skills/glass-atrium-ops-orchestrator-role.md` → `## Harness Path Protection` — the rule `enforce-foreground-harness.sh` enforces, blocking on channel a.
  - `rules/glass-atrium/shared-self-improve-hygiene.md` → `## Precondition Loud-Fail Principle` — the autoagent exception to fail-open, named inline in the rule file's Authoring Rules, where the exception binds.
- **Measured-record capture site**: the `### PreToolUse(Agent) measured record` capture was a temporary key-names-only probe in `hooks/enforce-foreground-harness.sh`, removed after the capture; a re-probe needs a capture of its own.
- **Hook-specific output detail stays in the hook**: what `enforce-foreground-harness.sh` prints ahead of its Rule 2 text, and the per-layer exit statuses of `validate-compliance-matrix.sh`, live in those hooks' headers; the rule file names only the channel and the exit code.

## on_fail taxonomy shape

- The on_fail taxonomy is one table (Disposition | Mechanism | Reserved for), two carve-out bullets, then a worked-case list keyed by the disposition literal.
- Keep that shape:
  - the carve-outs — the `fix` no-silent-loop fall-through, and `noop` never being labelled `filter` — are not uniform rows;
  - the worked cases name live hooks and workflow constructs, which would push a "Used by" table cell past the 120-char cell cap.

## Readers and coupled tests

- No code reads this file's TEXT. The path is pinned in `registry_ops.py` (`_HOOK_AUTHORING_CONDITION` / `_HOOK_REVIEW_CONDITION`, and through them `RULE_FILES`), exact-equality pinned by `scripts/test/test_agent_lifecycle_overhaul.py`, plus the manifest.
- Hook headers citing this file in comments: `enforce-config-protection.sh` · `block-doc-routing-leak.sh` · `validate-output.sh` · `validate-prompt.sh` · `advisory-preedit-facts.sh` · `enforce-foreground-harness.sh` · `enforce-harness-critical.sh` · `enforce-delegation.sh` · `agent-tracker.sh`.
- The headers citing a heading other than the measured record:
  - `hooks/enforce-config-protection.sh` cites "Block Channels" for the non-substitutability rule, so that rule must stay reachable from that heading;
  - `hooks/advisory-preedit-facts.sh` cites the "Per-Event table" and the Stop-lifecycle row — keep that row's `observe-only`, "advisory" and "accounting" wording.
- Keep those cited headings unrenamed, and also `## on_fail Action Taxonomy (validation-failure disposition vocabulary)`, `## Event Registration Status (file-verified)` and `## Authoring Rules`.
- `## Hook Operation Policy` is cited by name; keep it unrenamed too:
  - the `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Hook Operation Policy [ALL]` pointer;
  - `scoped/maintainers/glass-atrium-dev-shell.md`, in its conditional-membership line.
- A heading rename here dangles the comments citing it — nothing breaks mechanically, and nothing catches it either.
- These cite `### PreToolUse(Agent) measured record` by name; keep that heading unrenamed too:
  - `skills/glass-atrium-ops-orchestrator-role.md` → `### Reach of the gate`, as the record behind its Workflow-spawn item;
  - the `hooks/enforce-foreground-harness.sh` header, as the record of the measured Agent-call envelope.
