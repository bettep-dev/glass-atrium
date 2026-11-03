# Maintainer note — `scoped/scope-design.md`

Maintainer-facing material for that rule file. Nothing here binds glass-atrium-design-designer; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Token versioning — dropped, and why

- The rule-file duty `**Token versioning**` (branch isolation, rollback path before merging) was dropped, not reworded.
  - **Role, not capability**: glass-atrium-design-designer holds Bash, but it authors specs and does not land token changes, so the line named an act it never performs.
  - **Already delivered**: `rules/glass-atrium/core-git-workflow.md` (Tier 1) carries the branch-naming and PR/merge rules; a token-scoped copy could only diverge.
  - **Surviving residue**: the rollback-path bullet under `## LLM Output Validation`, a form the designer can discharge.

## Duplicates dropped, with the delivered copy that made them redundant

Each copy is in `agents/glass-atrium-design-designer.md`:

| Dropped from the rule file | Delivered copy |
|---|---|
| `**No AI-generated aesthetics**` font list · `Verify no prohibited fonts` | `### AI Slop Tropes` → `Overused fonts` line · `### Typography` (fallback vs. primary) |
| vendor-routing sane-default and cross-vendor-parity bullets | `### Figma Make + MCP Integration Guardrails` → `Vendor-Routing:` line |
| the WCAG AA ratios | `## Pre-Execution Verification` → `Contrast` row · `## Red Flags` → **Color & contrast** |

- The vendor routing-rationale bullet had no counterpart, so only it survives in the rule file.

## Why the contrast item was kept despite being a duplicate

- `skills/glass-atrium-design-contrast-check/SKILL.md` cites `## LLM Output Validation` as the contrast verification gate before DEV handoff; deleting the item would leave that citation describing absent content.
- So the rule file keeps a one-line item with no numbers.

## Headings and their citers

| Heading | Cited from |
|---|---|
| `Absolute Rules` | nothing |
| `Platform Design Token Policy` | `scoped/maintainers/shared-design-token-consumption.md` → Cross-references |
| `LLM Output Validation` | the citer list under this table |
| `Vendor-Routing Awareness` | nothing; `scoped/scope-dev.md` has its own same-named section |
| `CQRS Exception` | nothing; its self-checklist bullet mirrors `scoped/scope-meta.md` → `## CQRS Exception`, the canonical site |

- `LLM Output Validation` is cited from:
  - `skills/glass-atrium-design-contrast-check/SKILL.md`, and `skills/glass-atrium-design-md-lint/SKILL.md` as the pre-emit gate family that lint joins;
  - `agents/glass-atrium-design-designer.md` → `### Figma Make + MCP Integration Guardrails`;
  - `scoped/maintainers/shared-design-token-consumption.md` → Cross-references.

## Stale material removed

- **Loading stanza** (`> **Loading**: Tier 2 …`, `> **Inherits**`, `> **See**`) and the `Rules specific to DESIGN agents` line.
  - No machine reader needs them: the registry row's `rules.scope` selects the rule file, and the `agent_scope ∈ { … }` parsers (`scripts/agent_lifecycle/readers.py` → `parse_scope_dev_roster`, `autoagent/lib/roster_merge.py` → `_get_markdown_slots`) anchor on `scoped/scope-dev.md` alone.

## Delivery — what actually reads this file

- `scoped/scope-design.md` reaches glass-atrium-design-designer whole at spawn through the part slots, selected by its `agent-registry.json` row (`rules.scope`). No other agent row names it.
- The rule file is the designer's only delivered copy of the three platform facts: Material Web in maintenance mode, M3 Expressive via Compose, HIG semantic-role tokens.

## Readers, coupled tests, and operational constraints

- **No test quotes the rule file's text**: a bare `scope-design` grep over `test/`, `hooks/test/`, `scripts/test/`, `monitor/test/` and `autoagent/test/` returns no hit; `hooks/test/inject-scope-chunker.bats` → T-CAP-1 reads it through the registry and asserts only the per-part cap.
- **Whole-text readers** quote no literal, so a wording edit breaks neither: `hooks/lib/inject_chunk.py` and `autoagent/daemon_cycle.py` → `_read_sections` (the C3 excerpt).
- **Path-only consumers** break on a rename or a move out of `scoped/`:
  - `agent-registry.json` (`rules.scope`);
  - `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP`;
  - `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_RULE_FILES`;
  - `rules/glass-atrium/core-compliance-matrix.md` (read by `hooks/validate-compliance-matrix.sh`);
  - `manifest.json`.
- **Never diet the file to zero bytes**: `autoagent/daemon_cycle.py` → `SCOPE_EMPTY_SIGNAL` (`SCOPE-FILE-EMPTY`) directs a `C3: FAIL` verdict on an empty scope file.
- **Manifest**: `manifest.json` carries a sha256 row for this note and for the rule file, so an edit to either needs a manifest regeneration — a whole-tree barrier step.
