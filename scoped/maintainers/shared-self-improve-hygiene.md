# Maintainer note — `rules/glass-atrium/shared-self-improve-hygiene.md`

Maintainer-facing material for that rule file. Nothing here binds a pipeline author; the rule file carries the contract.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file's one link to this note is the HTML comment after its frontmatter.
  - It addresses the editor of text that code comments cite, not a machine-extracted block. That departs from the exemption; it stays as the one resolvable pointer to this note.

## Loading and membership

- The header's DEV-subset bullet is phrased to match the `when` string of `scripts/agent_lifecycle/registry_ops.py` → `_HYGIENE_CONDITION`, and the matrix's § footnote names that header as its scope declaration: keep the bullet and the `when` string in step.

## Readers and coupled tests

- No code reads the rule file's body specifically; `scripts/test/startup-budget.bats` → `has_paths_key` reads its `paths:` key, so removing the key pulls the file into the startup budget.
- Its path is pinned in `registry_ops.py` → `_HYGIENE_CONDITION`, exact-equality pinned by `scripts/test/test_agent_lifecycle_overhaul.py`, and used as a fixture path by `hooks/test/inject-scope-chunker.bats`.
- Cited by name in code comments and other files — grep the corpus before renaming or rewording one:
  - `## Precondition Loud-Fail Principle` — comments across the repository, `agents/glass-atrium-dev-python.md` and `scoped/shared-hook-capability-contract.md`.
  - `### Exit-code discipline` — `agents/glass-atrium-dev-python.md`.
  - `### Auditor` and its **Census rule** lead — `scripts/audit-test-smells.sh`, which defers both its promotion condition and its census lesson to that section.
  - `## Prose-Only-Add Patch Classification` — `autoagent/daemon_cycle.py` and `autoagent/test/test_dead_reference_guard.py`, by its `Prose-Only-Add` prefix.
  - `## Apply-Side Rollback Contract` — `scripts/agent_lifecycle/transaction.py`.
- **Leg order**: ordinal citers include `autoagent/daemon_cycle.py` (second and third legs) and `autoagent/daemon-apply.sh` (third).
- **Annotation literals**: `# GA-ABSORB[benign]:`, `# GA-ABSORB[handled@<where>]:` and `# GA-CONVERTED:` are the grammar `scripts/audit-absorption.sh` enforces; change them only together with the auditor.

## Editing the absorption sections

- Do not collapse the annotation rules into one rule about line numbers: the label, the `<where>` field, the physical placement and the reason text govern different objects.

## Auditor promotion record

- **CI**: the comment above `.github/workflows/ci.yml` → `Audit silent-fail absorption annotations (blocking)` holds the step-order why and the change-conditional residual.
- **Rollback**: revert the exit semantics, usage line, CI step and the rule file's `### Auditor` surface-split bullet together, or pass `--advisory` in CI; either restores advisory mode and leaves the verbatim promotion condition intact.

## Cross-references the rule file omits

- `## Cross-References` lists no Tier-1 file: those reach every reader.
- The orchestrator reaches `skills/glass-atrium-ops-orchestrator.md` → `### Self-Improvement User-Approval Trigger` through Tier-1 `core-learning-log.md` → Instruction Improvement Approval Tier.
- It reaches `skills/glass-atrium-ops-orchestrator-role.md` → `## Harness Path Protection` through the heading index that `scoped/orchestrator-core.md` prints at SessionStart.
