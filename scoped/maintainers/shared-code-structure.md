# Maintainer note — `scoped/shared-code-structure.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: no heading of the rule file is externally cited, so it carries no companion pointer at all. Its two outbound citations — `scoped/shared-type-safety.md` and `skills/glass-atrium-dev-patterns/SKILL.md` — are rule-file prose, permitted under the last bullet and recorded below.

## Provenance of the move

- The core came from `skills/glass-atrium-dev-patterns/SKILL.md` → `## Core Principles` through the `**Quick rules**` list. That span was the whole body between `## When to Use` and `## References`, so the split line is where the skill's own author already drew it: every one of the four `references/*.md` opens "Companion reference for `glass-atrium-dev-patterns/SKILL.md`. Load when …".
- No marker pair was needed and none was created. The patterns skill carried no `AGENT-INJECT` block, so nothing extracts from it and the move is a plain relocation; the rule file carries no marker either.
- The moved text is byte-identical to the skill's, with ONE deliberate exception recorded in the next section. The skill keeps a single `>` pointer line where the span was.

## The one bullet that did not move verbatim

- The skill's quick rule read `Type safety: any/dynamic/Object forbidden · nested generics ≤ 2 levels · extract when reused 2+ times or 3+ properties`. The rule file keeps the two thresholds and names `scoped/shared-type-safety.md` as the owner of the escape-hatch ban instead of restating it.
- Why: `scoped/shared-type-safety.md` → `## Core Principles` already carries the `any` prohibition as its first rule. Carrying it a second time in a peer Tier-3 file is the two-copies-drift shape, and both copies would bind the same agents.
- Deliberately not done: the thresholds were not absorbed INTO `scoped/shared-type-safety.md` — that is a content change to that file, not a relocation.
- `scoped/shared-type-safety.md` needs no repoint: its line cites "the `glass-atrium-dev-patterns` skill" for the ban, and `skills/glass-atrium-dev-patterns/references/TYPE-DESIGN.md` still states `any/dynamic/Object forbidden`.
- The companion of `scoped/shared-type-safety.md` needs none either: its "Why the `any` prohibition is not restated in full" section cites `skills/glass-atrium-dev-patterns/references/TYPE-DESIGN.md` → `## Type Design [DEV]`, which states the ban and carries both thresholds as its own bullets.

## Membership

- Every DEV agent unconditionally, plus `glass-atrium-qa-code-reviewer` as the review surface. `glass-atrium-qa-debugger` is excluded: it authors no code, so a structural authoring rule is inapplicable to it.
- Declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`.
- DEV membership is a scope default (`SCOPE_SHARED_RULE_FILES["DEV"]` in `scripts/agent_lifecycle/registry_ops.py`); the `glass-atrium-qa-code-reviewer` half is a per-AGENT hand-add, exactly like `shared-design-token-consumption.md`, because no scope label can derive a one-agent subset.
- The Compliance Matrix QA cell is a plain `✓` with no footnote marker, following `scoped/shared-naming.md`: the Tier-3 row names the single agent outright, which is more precise than a marker glyph, and no edit to `readonly FOOTNOTE_MARKERS` in `hooks/validate-compliance-matrix.sh` is needed.
  - Why not a new glyph: an unlisted glyph would not fail check B2. It would go unchecked, which is worse than a false failure.

## Delivery — how the rule reaches its agents

- Every DEV agent and `glass-atrium-qa-code-reviewer` receive the file whole at spawn: each of those `agent-registry.json` rows lists it in `rules.shared`, which the part-slot channel delivers (`rules/glass-atrium/core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)`).
- No agent preloads `glass-atrium-dev-patterns` in frontmatter `skills:`, so the rule file is the only delivered copy of the core.

## Readers and coupled tests

- No code reads this file's TEXT. Renaming the file edits every site that pins its path:
  - `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES["DEV"]` (and therefore `RULE_FILES`)
  - `scripts/test/test_agent_lifecycle_overhaul.py`, by exact list equality
  - every DEV row and the reviewer row of `agent-registry.json` (the delivery selector)
  - `manifest.json`, which lists and hashes the path
- `hooks/validate-compliance-matrix.sh` Layer A reconciles `scoped/` basenames against matrix rows, so the file and its row must land together or it reports a governance gap in one direction or a broken pointer in the other.
- `monitor/src/server/architecture/governance-membership.ts` treats every inline-code `scoped/…md` path in the matrix as a declared document and reports it absent when no such file exists.

## Open

- The rule file's closing paragraph says the skill's `references/` keep the lookup half.
  - **Read route**: settled — the rule file's path pointer reaches every holder.
  - **Invocation route**: unsettled — no agent grants `Skill` and no probe spawn has run; neither the rule file nor this note asserts it either way.
- Filename: `shared-code-structure.md` was chosen over `shared-patterns.md`. "Patterns" reads as a catch-all and collides with design patterns, and the matrix's Layer A check puts these basenames in front of a reader as bare filenames.
