# Maintainer note — `scoped/shared-hook-capability-contract.md`

Maintainer-facing material for that rule file. Nothing here binds a hook author; the rule file carries the contract.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Loading and membership

- Task-conditional, never standing: the rule file opens with its own trigger line, phrased to match the `when` strings in `scripts/agent_lifecycle/registry_ops.py` — `_HOOK_AUTHORING_CONDITION` (DEV) · `_HOOK_REVIEW_CONDITION` (QA).
  - Keep those strings and the rule file's trigger line in step.
- Membership sits on the `agent-registry.json` `rules.conditional` entries and in `rules/glass-atrium/core-compliance-matrix.md` (¶ footnote, which names each trigger).
- Keep it conditional: as a standing member the rule file would take more than one part slot's chunk (`hooks/lib/inject_chunk.py` → `CHUNK_MAX_UNITS`) on every spawn, for a condition that fires on a small minority of turns.

## on_fail vocabulary source

- **Taxonomy provenance**: the action names are borrowed from guardrails-ai's `OnFailAction` enum (`guardrails/types/on_fail.py`); Atrium names only the ones its hooks exercise.
- **Unmapped members (gap register)**:
  - `REFRAIN` — suppresses the whole output, where `FILTER` strips one element; Atrium's `filter` covers both because no hook needs the split.
  - `FIX_REASK` — auto-fix, reverify, reask if still failing; no Atrium hook chains all three, so it is a candidate hardening.
  - `CUSTOM` — arbitrary user callback, out of scope for a fixed vocabulary.

## on_fail taxonomy shape

- Keep the on_fail taxonomy's shape — one table, carve-out bullets, then a worked-case list:
  - the carve-outs are not uniform rows;
  - the worked cases name live hooks and workflow constructs, which would push a "Used by" table cell past the 120-char cell cap.

## UserPromptSubmit wrapper list

- **Corpus-maintenance duty (`UserPromptSubmit`)**: the wrapper-shape list in `hooks/inject-reply-language.sh` → `get_prompt_kind` and its fixtures in `hooks/test/inject-reply-language.bats` move together — one prefix, one fixture per shape.
- **Known gap (agent-context prompts)**: `get_prompt_kind` silences only frame-shaped agent prompts; a frameless machine prompt (a task notification, a "Background agent" notice) in an agent context still gets the pointer.
  - The envelope carries no `agent_id`, so no static signal exists; a live probe of a background-task notification inside a teammate or background-agent context is what settles it.
- **`source` recheck**: CLI 2.1.283 documents `source` on `UserPromptSubmit` and leaves it out of the payload.
  - Recheck on every CLI upgrade; once a CLI fills it, the wrapper list is only the fallback for a payload without it.
- Whoever adds another hook on a prompt event records its verified capabilities in the capability table.

## Rule-file boundaries

- **Hook-specific output detail stays in the hook**: the rule file names only the channel and the exit code.
- **Measured-record capture site**: `hooks/enforce-foreground-harness.sh` holds no capture for the `### PreToolUse(Agent) measured record`, so a re-probe needs a key-names-only capture of its own.

## Readers and coupled tests

- No code reads the rule file's text. The path is pinned in `registry_ops.py` (`_HOOK_AUTHORING_CONDITION` / `_HOOK_REVIEW_CONDITION`, and through them `RULE_FILES`), exact-equality pinned by `scripts/test/test_agent_lifecycle_overhaul.py`, plus the manifest.
- Keep the rule file's headings unrenamed: a rename dangles the citations to them — nothing breaks mechanically, and nothing catches it.
  - Grep the rule file's name and the bare heading text first.
- Hook headers that depend on rule-file text:
  - `hooks/enforce-config-protection.sh` cites "Block Channels" for the non-substitutability rule, so that rule must stay reachable from that heading;
  - `hooks/advisory-preedit-facts.sh` cites the "Per-Event table" and the Stop-lifecycle row — keep that row's `observe-only`, "advisory" and "accounting" wording.
