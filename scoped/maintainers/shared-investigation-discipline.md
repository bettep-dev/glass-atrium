# Maintainer note — `scoped/shared-investigation-discipline.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- DEV and QA take the file as scope defaults (`scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES`), so a newly added DEV or QA agent inherits it without a hand-add.

## Delivery

- The part slots pack this file: `python3 hooks/lib/inject_chunk.py --audit`, run with `GA_CHUNK_RULES_ROOT` set to the tree under test, must report `events=none`.

## Readers and coupled tests

- No code pins this file's text.
- Renaming or moving the file breaks each of these:
  - `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES`.
  - `scripts/test/test_agent_lifecycle_overhaul.py` → exact list equality in `test_when_build_entry_dev_then_rules_carry_scope_shared_conditional` and `test_when_build_entry_scope_lowercase_then_mapped`.
  - `agent-registry.json` → the `rules.shared` entry on every DEV and QA row.
  - `manifest.json` → the file's entries.
- `rules/glass-atrium/core-compliance-matrix.md` declares the path, so the file and its matrix entries land together:
  - `hooks/validate-compliance-matrix.sh` Layer A reports filename drift between matrix rows and `scoped/`.
  - Other readers: `scoped/maintainers/core-compliance-matrix.md` → `## Machine readers`.
