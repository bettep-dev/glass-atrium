# Maintainer note — `scoped/shared-hook-capability-contract.md`

Maintainer-facing material for that rule file. Nothing here binds a hook author; the rule file carries the contract.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Loading and membership

- Task-conditional, never standing: the rule file opens with its own trigger line, phrased to match the two `when` strings in `scripts/agent_lifecycle/registry_ops.py` — `_HOOK_AUTHORING_CONDITION` ("the task writes or modifies a hook under ~/.glass-atrium/hooks/") for DEV and `_HOOK_REVIEW_CONDITION` ("the task reviews a hook change or analyses a hook failure") for QA. Keep those strings and the rule file's trigger line in step; do not invent a third phrasing.
- Membership sits on the `agent-registry.json` `rules.conditional` entries and in `rules/glass-atrium/core-compliance-matrix.md` (¶ footnote, which already names the three triggers). `glass-atrium-meta-prompt-engineer` does NOT take it — hook authoring is not "prompts = code".
- Standing delivery of this file was rejected on size: its duty text is roughly the whole SubagentStart channel budget, spent on a condition that fires on a small minority of turns.

## Maintainer material moved out of the rule file

- **Taxonomy provenance**: the five action names are borrowed from guardrails-ai's `OnFailAction` enum so a hook's behaviour is describable in one word. Guardrails ships eight members (`REASK`, `FIX`, `FILTER`, `REFRAIN`, `NOOP`, `EXCEPTION`, `FIX_REASK`, `CUSTOM` — `guardrails/types/on_fail.py`); Atrium names the five its hooks exercise. Docs-only, no import and no dependency.
- **Unmapped members (gap register)**: `REFRAIN` — suppress the WHOLE output, where `FILTER` strips one element; guardrails implements them as separate `apply_refrain` / `apply_filters` functions, and Atrium conflates both under `filter` because no hook needs the split. `FIX_REASK` — auto-fix, reverify, reask if still failing; no Atrium hook chains all three, so it is a candidate hardening. `CUSTOM` — arbitrary user callback, out of scope for a fixed vocabulary.
- **Naming history**: the read-side `track-outcome.sh` parse tiers previously had both exit-0 dispositions called `filter`. The rule file now states the current mapping (synthesis = `filter`, warn-only = `noop`) without the history.
- **Corpus-maintenance duty**: whoever adds a `UserPromptSubmit` hook updates the capability table with its verified capabilities at that time. This is an instruction to an editor of the rule file, which is why it lives here.
- **Cross-references**: `hooks/hook-utils.sh` (`hook_emit_error` = channel a, `hook_read_input`, `hook_get_field`, `hook_get_tool_input`, `hook_is_subagent`) · `settings.json` (the authority for which events are wired) · `rules/glass-atrium/core-security.md` (LLM01 tool-input trust boundary, LLM06 tool authorization, LLM07 prompt leakage) · `rules/glass-atrium/orchestrator-role.md` Harness Path Protection (the `enforce-foreground-harness.sh` channel-b rationale) · `rules/glass-atrium/shared-self-improve-hygiene.md` Precondition Loud-Fail (the autoagent exception to fail-open, still named inline in the rule file's Authoring Rules).
- **Why This Exists** section: dropped. Its three facts — events differ, PostToolUse cannot mutate, the channels are non-substitutable — are each stated where they bind, in the capability table and the channel rules.

## Follow-up fix pass — on_fail taxonomy shape

The five dispositions were five long prose bullets repeating the same three facets. They are now one table (Disposition | Mechanism | Used by | Reserved for), heading and disposition names unchanged, with the two non-uniform carve-out sentences kept as bullets below it (the `fix` no-silent-loop fall-through, and `noop` never being labelled `filter`).

- No hook name, worked case or reservation clause was dropped — the facets were transposed, not cut.
- **Accepted shape-cap overage**: the `exception` and `noop` "Used by" cells run past the 120-char cell guide. The alternative was abbreviating live hook filenames, which are the cells' whole value; the overage is the cheaper trade.

## Readers and coupled tests

- No code reads this file's TEXT. The path is pinned in `registry_ops.py` (`_HOOK_AUTHORING_CONDITION` / `_HOOK_REVIEW_CONDITION`, and through them `RULE_FILES`), exact-equality pinned by `scripts/test/test_agent_lifecycle_overhaul.py`, plus the manifest.
- Eight hook headers cite this file in comments, two of them by heading: `hooks/enforce-config-protection.sh` cites "Block Channels" and `hooks/advisory-preedit-facts.sh` cites the "Per-Event table" and the Stop-lifecycle row. Both headings survive this pass unchanged, as do `## on_fail Action Taxonomy (validation-failure disposition vocabulary)`, `## Event Registration Status (file-verified)` and `## Authoring Rules`. A heading rename here dangles those comments — nothing breaks mechanically, and nothing catches it either.
