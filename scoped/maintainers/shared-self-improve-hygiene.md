# Maintainer note — `rules/glass-atrium/shared-self-improve-hygiene.md`

Maintainer-facing material for that rule file. Nothing here binds a pipeline author; the rule file carries the contract. Read it before editing the rule file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file's one link to this note is the HTML comment after its frontmatter.
  - It addresses the editor of text that code comments cite, not a machine-extracted block. That departs from the exemption; it stays as the one resolvable pointer to the text this note received.

## Loading and membership

- Path-scoped: the `paths:` globs decide when the host loads the file (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)` → **Path-scoped delivery**).
- The header's DEV-subset bullet is phrased to match the `when` string of `scripts/agent_lifecycle/registry_ops.py` → `_HYGIENE_CONDITION`, and the matrix's § footnote names that header as its scope declaration. Keep the two in step.

## Readers and coupled tests

- No code reads the rule file's text. The path is pinned in `registry_ops.py` → `_HYGIENE_CONDITION`, exact-equality pinned by `scripts/test/test_agent_lifecycle_overhaul.py`, and used as a fixture path by `hooks/test/inject-scope-chunker.bats`.
- Cited by name in code comments and other files — grep the corpus before renaming or rewording one:
  - `## Precondition Loud-Fail Principle` — many hook, script, `lib/` and `autoagent/` comments, `agents/glass-atrium-dev-python.md` and `scoped/shared-hook-capability-contract.md`.
  - `### Exit-code discipline` — `agents/glass-atrium-dev-python.md`.
  - `### Auditor` and its **Census rule** lead — `scripts/audit-test-smells.sh`, which defers both its promotion condition and its census lesson to that section.
  - `## Prose-Only-Add Patch Classification` — `autoagent/daemon_cycle.py` and `autoagent/test/test_dead_reference_guard.py`, by its `Prose-Only-Add` prefix.
  - `## Apply-Side Rollback Contract` — `scripts/agent_lifecycle/transaction.py`.
- **Leg order**: comments cite the remedy triad's legs by ordinal (`Precondition Loud-Fail's third leg`, "second and third legs" in `autoagent/daemon_cycle.py`), so the rule file states the order as a reserved anchor.
- **Annotation literals**: `# GA-ABSORB[benign]:`, `# GA-ABSORB[handled@<where>]:` and `# GA-CONVERTED:` are the grammar `scripts/audit-absorption.sh` enforces; change them only together with the auditor.

## Editing the absorption sections

- Do not collapse the annotation rules into one rule about line numbers: the label, the `<where>` field, the physical placement and the reason text govern different objects.
- Worked shapes are anchored by shape and function-relative description, never by a raw line number (`agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Verified References`).

## Auditor promotion record

- **CI step order**: the blocking auditor step runs on the `scripts/test` leg of the `test-bash` matrix in `.github/workflows/ci.yml`, ordered before the bats step.
  - Why: a step-level `if:` defaults to `success()`, so an appended step would skip exactly when the leg is already red.
- **Residual**: `test-bash` is gated on the `detect-changes` bash filter, so a PR touching no shell file skips the auditor. The scope is shell-only, so no non-shell change can introduce a site; the gate is change-conditional, not unconditional.
- **Rollback**: the promotion is a revertable meaning-unit set — exit semantics, usage line, CI step and the rule file's `### Auditor` surface-split bullet.
  - Reverting it, or passing `--advisory` in CI, restores advisory mode; the verbatim promotion condition stays intact.

## Cross-references the rule file omits

- The rule file names no Tier-1 file in a cross-reference table: `core-git-workflow.md`, `core-learning-log.md` and `core-security.md` reach every reader as Tier 1.
- The orchestrator reaches `skills/glass-atrium-ops-orchestrator.md` → `### Self-Improvement User-Approval Trigger` through Tier-1 `core-learning-log.md` → Instruction Improvement Approval Tier.
- It reaches `skills/glass-atrium-ops-orchestrator-role.md` → `## Harness Path Protection` through the heading index that `scoped/orchestrator-core.md` prints at SessionStart.
