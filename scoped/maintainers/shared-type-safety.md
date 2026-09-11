# Maintainer note — `scoped/shared-type-safety.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- Membership is declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`. The rule file's former opening sentence restated it a third time and was dropped rather than moved into a fourth site.
- The rule file's own opening line now states the CONSTRUCT condition instead: each rule binds where the language has the construct it names. That is the agent-facing form of the "TypeScript-only" scoping observation — written as a per-rule condition so a Swift force-unwrap or a Kotlin cast is covered without enumerating languages.

## Why the `any` prohibition is not restated in full

- `skills/glass-atrium-dev-patterns/SKILL.md` states `Type safety: any/dynamic/Object forbidden · nested generics ≤ 2 levels · extract when reused 2+ times or 3+ properties`, and `references/TYPE-DESIGN.md` repeats the ban. That form is broader than the rule file's was.
- What the rule file keeps is the part the skill does not carry: the `unknown` + type-guard replacement. The skill is named in that line so a reader does not read the remedy as the whole rule.

## Readers and coupled tests

- No code reads this file's TEXT. The path is pinned in two places: the `RULE_FILES` closed frozenset in `scripts/agent_lifecycle/registry_ops.py`, pinned by exact equality in `scripts/test/test_agent_lifecycle_overhaul.py`, and the manifest hash. Renaming the file is therefore a three-site edit.
- Prose citations of the file by name live in `agents/glass-atrium-dev-react.md` and `agents/glass-atrium-dev-nestjs.md`; both cite the file, not a heading, and both still resolve.
- The `## Core Principles` heading is unchanged.
