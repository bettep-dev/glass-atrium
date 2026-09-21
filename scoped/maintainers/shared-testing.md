# Maintainer notes — `scoped/shared-testing.md`

Corpus-maintenance companion to `scoped/shared-testing.md`. Nothing here binds a running agent: it is the retention ledger, the tooling-status commentary, the academic provenance and the delivery bookkeeping that were removed from the rule file when it was cut to agent-facing duties. Read it before editing that file; do not inject it, and cite it only as the convention below allows.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- `scoped/shared-testing.md` has no such stub heading and therefore carries no pointer to this note.

## Membership

- The rule file applies to all DEV agents, plus glass-atrium-meta-prompt-engineer (prompts = code); glass-atrium-meta-agent does NOT inherit it.
- Membership is declared on the registry row (`agent-registry.json` → the agent's `rules` array) and in `rules/glass-atrium/core-compliance-matrix.md`. The rule file itself no longer restates it.
- A delivery-status paragraph ("nothing injects it at spawn, so a duty homed HERE reaches no running agent") was DROPPED rather than moved: it is false once the body is delivered, so keeping a copy would preserve a claim a future editor could act on.

## Retention ledger — who reads each section

Every section kept in the rule file is kept because a NAMED reader outside the file resolves to it. A section nothing in this table points at should be deleted rather than kept for completeness; a new section with no reader here has no place to be read from.

| Section | Established reader | Where the inbound pointer lives |
|---|---|---|
| Test Quality (with Meaningless-Test Prohibitions) | whoever adjudicates a hand-run `audit-test-smells.sh` finding — it reports a shape, never a defect | `scripts/audit-test-smells.sh` header (Convention SoT) · `scripts/test/audit-test-smells.bats` header |
| Mocking Rules · Test Structure | glass-atrium-qa-code-reviewer — its delivered checklist cites this file and it must cite a governing rule | `agents/glass-atrium-qa-code-reviewer.md` → 7-Perspective Checklist, Testing row |
| Rationalization Rejection (Testing) | every agent — the charter names testing as a home file for the excuse→rebuttal pairs | `GLASS_ATRIUM_GLOBAL_RULES.md` → Rationalization Rejection |
| 3-Tier Test Hierarchy | every agent — the delivered commit rule defers its which-tests-when half to here | `core-git-workflow.md` → Commits |
| Destructive-Path Suite Safety | the operator or session about to run a suite that can reach the live database — not an agent at spawn | `orchestrator-role.md` → Document-Driven Workflow step 6 |
| Mechanical Success Metrics | every agent — a pointer stub resolving an inbound Tier-1 reference back to its canonical | `core-outcome-record.md` → Automatic Verification Criteria |

- **Heading stability**: `### Meaningless-Test Prohibitions`, `## Destructive-Path Suite Safety (live-postgres reach)` and `## Mechanical Success Metrics` are named verbatim by the pointers above. Renaming one dangles its inbound pointer even though no suite reads the body.

## Backing honesty — Test Quality

- The `## Test Quality` section is an adherence-layer convention with **no runtime backstop** — no hook or gate verifies that the decision procedure was run, and none can. Its only mechanical companion is the three-signal advisory auditor below, which never inspects the relationship claim itself.

## Tooling status of the prohibited-shape rows

The rule file states only that every row is reviewer-applied. The mapping below is for whoever adjudicates an auditor finding.

- MECHANICAL means decidable-in-principle by a script — NOT that a script exists. **No row on that table is enforced.**
- Only signals (a) and (b) of `scripts/audit-test-smells.sh` back any row, and that auditor is **ADVISORY**: it exits 0 on findings, is **NOT wired into CI**, and is run by hand.
- That auditor carries a THIRD signal no row states — (c) count-pin: an assertion comparing a non-zero integer literal against a census the same assertion derives by counting the tree or a source file. A signal-(c) finding therefore maps to no row, and is in particular not the tooling for the change-detector row.
- A row marked `[no tooling]` below has no implementation at all and is reviewer-applied exactly like a JUDGMENT row.

| Prohibited row (keyed by its literal in the rule file) | Smell source | Check |
|---|---|---|
| A test with no assertion, or whose only claim is "it did not throw" | the `expect-expect` lint rule family | MECHANICAL — tooling: signal (a) |
| An assertion that cannot fail | Pereira 2010 | MECHANICAL — tooling: signal (b) |
| Asserting back the value a mock was configured to return | — (mock-echo sub-case) | MECHANICAL `[no tooling]` |
| An expected value copied from observed output | Google Testing Blog 2015 | JUDGMENT `[no tooling]` |
| Near-duplicate cases that one property or one parameterized table would cover | van Deursen et al. 2001 | JUDGMENT `[no tooling]` |
| A test whose target has no branch and no logic | — (trivial getter/setter/constructor test) | JUDGMENT `[no tooling]` |
| Control flow that can SKIP an assertion | Meszaros 2007 | JUDGMENT `[no tooling]` |

- **Trivial-target row**: resolving the production target from the test is not implemented; the rule file now states the read as the reviewer's own duty instead.
- **Conditional-logic row**: deliberately excluded from the auditor, because its carve-out requires reading which branch the assertion sits on. The same reasoning is recorded in the `scripts/audit-test-smells.sh` header.
- **DAMP carve-out source**: Google Testing Blog, *Tests Too DRY? Make Them DAMP!*, 2019.
- **Empirical backing for the list as a whole**: smelly tests carry measurably higher defect risk than clean ones (Palomba et al., ASE 2016; corroborated ICSME 2018).

## Rationalization Rejection — reconciliations

- **Test-first duty**: it binds at `core-outcome-record.md` → Field Input Guide → `metric_pass`, which is delivered to every agent and states both the observed-failure bar and the deliberate-break exception. The rule file keeps only the qualifier that reconciles that exception with the "Writing code first as a reference" rebuttal.
- **"Too simple to need tests" row**: the rebuttal is qualified against the prohibited shape *a test whose target has no branch and no logic*, so it no longer collides with the injected minimalism carve-out that exempts a trivial one-liner. The two ends are worded alike on purpose — change them together.

## Destructive-Path Suite Safety — provenance

- **Same-shell rule, PROBED rather than inferred, both halves**: a two-body bats file whose first body defines a function and whose second asserts `declare -F` does not find it — the second body passes, so nothing leaked; and a file defining the same name in `setup` instead — both bodies see it.
- The section is single-sited here by `orchestrator-role.md` → Document-Driven Workflow step 6, which calls it "pointer only, the procedure is single-sited there". Splitting it across a second heading would move content out from under that pointer.
- It is the largest section in the rule file and the only task-conditional one; its condition is now stated in its own opening line rather than in a delivery note.

## Follow-up fix pass — Destructive-Path step structure

`### Step 1` through `### Step 4` each opened with one wrapper bullet that pushed all real content to depth 3-4. In each, the wrapper's children were promoted to top level and the wrapper's own non-restating clause was kept as the step's unbolded lead line — none of the four merely restated its heading:

- Step 1 carries "a command-word pattern is FORBIDDEN as the enumeration step";
- Step 2 names the executing / naming / neutralized vocabulary;
- Step 3 names the read target and "the pid question is not answerable from the test file alone";
- Step 4 carries "all of them resolving".

`### Step 5` had no wrapper bullet and was left untouched. Net effect is dedentation only: no step lost a clause, and the section's byte size falls slightly rather than growing — which matters because this H2 is already the largest in the rule file and sits marginally over the 8 KB shape-cap guide, an overage accepted so the procedure stays single-sited under its inbound pointer.

## Mechanical Success Metrics — code pointer

- Promotion rule SoT for `grader_verdict: verified_pass` on a code-type row: `hooks/lib/code-based-grader.sh` → `_cbg_files_test_evidence`.

## What reads the rule file mechanically

- Nothing reads its body. The only mechanical couplings are the path spelling `scoped/shared-testing.md` in `agent-registry.json` rules arrays (permitted values are the closed frozenset in `scripts/agent_lifecycle/registry_ops.py`, pinned by `scripts/test/test_agent_lifecycle_overhaul.py`), the manifest hash, and the basename-to-matrix-row check in `hooks/validate-compliance-matrix.sh` (a `-maxdepth 1` enumeration, which is why this companion needs no matrix row).
- Renaming the file is therefore a three-site edit (registry frozenset, its pin, the compliance matrix), not a rule edit.
