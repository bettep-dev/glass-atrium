# Maintainer note — `scoped/shared-code-structure.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- DEV takes the file as a scope default (`scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES`), so a newly added DEV agent inherits it.
- `glass-atrium-qa-code-reviewer` takes it by a per-agent hand-add to its `rules.shared`: no scope label derives a one-agent subset.

## Delivery — how the rule reaches its agents

- The rule file is the only delivered copy of the core: no agent preloads `glass-atrium-dev-patterns` in frontmatter `skills:`, so a rule moved out to the skill reaches no member at spawn.

## Readers and coupled tests

- No code pins this file's text.
- Renaming or moving the file breaks every hit of a corpus grep for the basename `shared-code-structure`, these among them:
  - `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES`.
  - `scripts/test/test_agent_lifecycle_overhaul.py` → exact list equality in `test_when_build_entry_dev_then_rules_carry_scope_shared_conditional`.
  - `agent-registry.json` → the `rules.shared` entry on every DEV row and the reviewer row.
  - `manifest.json` → the file's entries.
- `rules/glass-atrium/core-compliance-matrix.md` declares the path, so the file and its matrix entries land together:
  - `hooks/validate-compliance-matrix.sh` Layer A reports filename drift between matrix rows and `scoped/`.
  - Other readers: `scoped/maintainers/core-compliance-matrix.md` → `## Machine readers`.
- Citers to fix in the same pass as a rename:
  - The `Function cap` label and its figures: `scoped/shared-comment-logging.md` → **One-line sufficiency gate**.
  - The `## Core Principles` heading and the `Member ordering` label: `skills/glass-atrium-dev-patterns/references/MODULE-COHESION.md` → `## Verification` → **Member ordering**.
  - The `7+ constructor deps = God Class` bullet: `skills/glass-atrium-dev-patterns/references/FUNCTION-DESIGN.md` → **Parameters**.
- Outbound citations from the rule file:
  - `scoped/shared-type-safety.md`, named for the escape-hatch ban instead of restating it: a second copy in a peer Tier-3 file would drift.
  - `skills/glass-atrium-dev-patterns/SKILL.md` and its `references/`, the lookup half.

## Open

- Invocation by a holder is untested: no holder is granted `Skill`, and the rule file's `## On-demand detail` asserts nothing about invocation.
