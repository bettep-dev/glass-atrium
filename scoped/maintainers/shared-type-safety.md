# Maintainer note — `scoped/shared-type-safety.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- Declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`; the rule file states it nowhere, since a third site would only drift.
- The rule file's opening line scopes by construct instead: a rule binds where the language has the construct it names, so a Swift force-unwrap or a Kotlin cast is covered without enumerating languages.

## Why the `any` prohibition is not restated in full

- `skills/glass-atrium-dev-patterns/references/TYPE-DESIGN.md` → `## Type Design [DEV]` holds the full ban (`any/dynamic/Object forbidden`).
- The rule file keeps what that section lacks, the `unknown` + type-guard replacement, and names the skill so the remedy is not read as the whole rule.

## Readers and coupled tests

- No test or hook pins the rule file's text; the part slots deliver it whole to each `rules.shared` member (`hooks/lib/inject_chunk.py`).
- `## Core Principles` keeps its name: `agents/glass-atrium-dev-angular.md` and `scoped/maintainers/shared-code-structure.md` cite it by heading.
- A rename edits every site naming the path (bare grep `shared-type-safety`), among them:
  - `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES["DEV"]`, and so `RULE_FILES`
  - `scripts/test/test_agent_lifecycle_overhaul.py`, by exact list equality on the DEV `rules.shared`
  - every member row of `agent-registry.json`, the delivery selector
  - `manifest.json`, which lists and hashes the path
  - both rows of `rules/glass-atrium/core-compliance-matrix.md`; `hooks/validate-compliance-matrix.sh` Layer A reconciles only the `## Compliance Matrix` row against `scoped/` basenames, not the `### Tier 3` row
