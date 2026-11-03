# Maintainer note — `scoped/shared-type-safety.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- Membership is declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`.
- The rule file's opening line states the construct condition: each rule binds where the language has the construct it names, so a Swift force-unwrap or a Kotlin cast is covered without enumerating languages.

## Why the `any` prohibition is not restated in full

- `skills/glass-atrium-dev-patterns/references/TYPE-DESIGN.md` → `## Type Design [DEV]` states **any/dynamic/Object forbidden**, the full statement of the ban.
- What the rule file keeps is the part the skill does not carry: the `unknown` + type-guard replacement. The skill is named in that line so a reader does not read the remedy as the whole rule.

## Readers and coupled tests

- No code reads this file's text.
- Renaming the file edits every site that pins its path:
  - `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES` (and therefore the `RULE_FILES` closed frozenset)
  - `scripts/test/test_agent_lifecycle_overhaul.py`, by exact equality
  - `agent-registry.json` → the `rules.shared` entry on each member row
  - `rules/glass-atrium/core-compliance-matrix.md` → its rows for the file
  - `manifest.json`, which lists and hashes the path
- Prose citers to repoint on a rename:
  - `agents/glass-atrium-dev-angular.md` — the one agent body citing the file by name, through the `## Core Principles` heading
  - `scoped/shared-code-structure.md` → the `Type safety` bullet
  - `scoped/maintainers/shared-code-structure.md`
  - `scoped/maintainers/glass-atrium-dev-python.md`
  - `scoped/maintainers/glass-atrium-dev-react.md`
