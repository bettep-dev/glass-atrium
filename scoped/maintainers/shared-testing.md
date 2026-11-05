# Maintainer notes — `scoped/shared-testing.md`

Corpus-maintenance companion to `scoped/shared-testing.md`: its readers, backing, provenance and couplings. Nothing here binds a running agent; read it before editing the rule file, never inject it, and cite it only as the convention below allows.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- `scoped/shared-testing.md` has no such stub heading and therefore carries no pointer to this note.

## Membership

- Membership is declared on the registry row (`agent-registry.json` → the agent's `rules` array) and in `rules/glass-atrium/core-compliance-matrix.md`; neither the rule file nor this note restates it.
- Add no delivery-status claim ("nothing injects it at spawn") to either file: the body is delivered at spawn, so the claim is false and an editor could act on it.

## Retention ledger — who reads each section

- A section stays in the rule file only while a named reader outside it resolves to it; a section nothing in this table points at should be deleted rather than kept for completeness, and a new section needs a reader here.
- Each name in the table is cited verbatim from outside the file, unless its row says it is cited by path or by domain word: before renaming or deleting one, grep the corpus for it and fix every hit in the same pass.

| Cited name in the rule file | Reader | Pointer site |
|---|---|---|
| `## Test Quality` · `### Meaningless-Test Prohibitions` | adjudicator of a hand-run auditor finding — a shape, never a defect | `scripts/audit-test-smells.sh` header (Convention SoT) |
| `### Detection signature per row, keyed by the Prohibited literal above` | the same adjudicator — the conditional-logic carve-out | `scripts/test/audit-test-smells.bats` header, by its `Detection signature per row` prefix |
| `### Meaningless-Test Prohibitions` · **Deletion duty** · **Coupled-test check** | glass-atrium-qa-code-reviewer — the High risk trigger's named-removal exemption | `scoped/scope-qa.md` → `## Regression Risk Estimation [QA]` |
| **Authoring scope** | glass-atrium-qa-code-reviewer grading a change's tests | `agents/glass-atrium-qa-code-reviewer.md` → `### Testing Checks` |
| `## Rationalization Rejection (Testing)` | every agent — the charter's excuse→rebuttal home-file list, cited by the domain word `testing` only | `GLASS_ATRIUM_GLOBAL_RULES.md` → Rationalization Rejection |
| **Qualifier on the last row (the deliberate-break exception)** | every agent — the `feature` bar's exception | `core-outcome-record.md` → the `feature` note |
| `## 3-Tier Test Hierarchy` | every agent — the commit rule's which-tests-when half, cited by path only | `core-git-workflow.md` → Commits |
| `## 3-Tier Test Hierarchy` | glass-atrium-dev-shell — its affected-paths-per-commit override | `agents/glass-atrium-dev-shell.md` → `### Bats + test-run discipline` |
| `## Mechanical Success Metrics` | every agent — the `grader_verdict` presence-signal line | `core-outcome-record.md` → Automatic Verification Criteria |
| **Depth follows risk** | every DEV agent sizing its tests | `scoped/scope-dev.md` → **YAGNI applies to tests too** |
| **Depth follows risk** | the DEV body that carries a local test-size line | `agents/glass-atrium-dev-nestjs.md` → **Tests** |
| **Depth follows risk** | the orchestrator, reading its skill on demand | `skills/glass-atrium-ops-orchestrator.md` → `### Quality Gates [ORCHESTRATOR]` |
| **Coupled-test check** | the orchestrator, declaring a delegation's `[SCOPE] files=` | `skills/glass-atrium-ops-orchestrator-role.md` → **`files=` completeness duty** |
| **Coupled-test check** | glass-atrium-intel-planner, listing a plan's target files | `agents/glass-atrium-intel-planner.md` → "Also list the coupled tests" |
| `### Where a test lives` | DEV and QA agents — the reproduction-test checklist item | `scoped/shared-investigation-discipline.md` → **Reproduction test exists** |
| `### Names, comments and test data` | every agent bound by the naming rules — the test-name exclusion | `scoped/shared-naming.md` scope lines |

- Also stable — cited by reviewer findings as the governing rule, or by in-file pointers; grep before renaming:
  - headings: `## Test Quality` · `## Mocking Rules` · `## Test Structure` · `### What makes a test a test` · `#### The prohibited shapes` · `### Table form per stack` · `## Test Depth and Upkeep`;
  - bolded leads: **Grouping** · **Fold-back** · **ID ban** · **DAMP carve-out**.

## Backing honesty — Test Quality

- `## Test Quality` is an adherence-layer convention with **no runtime backstop**: no hook or gate verifies that the decision procedure was run, and none can.
  - Its one mechanical companion, the advisory auditor (`## Tooling status of the prohibited-shape rows`), never inspects the relationship claim.
- The home-file, grouping, test-data and table-form rules have no tooling; reviewers apply them.
- The ID-ban and comment rules are CI-blocking for new findings only: `scripts/naming-ratchet.sh` fails the `test-naming-ratchet` job on an `id_title` or `incident_header` finding absent from its committed baseline `scripts/naming-ratchet-baseline.txt`, and on baseline growth.
  - Not blocked: a finding already in the baseline, and a stale entry's exact text until `naming-ratchet.sh --write` drops it.
  - Not blocked: baseline growth on a push whose `github.event.before` is all-zeros or cannot be fetched — that run omits `--base`, so the growth check is skipped.

## Test-authoring delta — provenance

- Sources: Kent Beck's Test Desiderata (isolation, determinism) · Khorikov, *You are naming your tests wrong* (behavior names) · Google Testing Blog on change-detector tests (2015) and *Tests Too DRY? Make Them DAMP!* (2019) · the bats-core FAQ (loop table form).
  - **Depth follows risk** and the reflex row: Google SWE book ch.12 (a test per behavior) · Fowler, *Test Coverage* · Petrovic et al. (mutation testing at Google) · Hora & Robbes (over-mocking).
  - **Coupled-test check**: TEBench (agents miss green-but-stale tests).
  - Test-gaming guard under **Watch it fail**: the Anthropic prompting guide's hard-coding paragraph · ImpossibleBench · EvilGenie.
- Placement — keep each where it is:
  - The home-file, naming/data and per-stack H3s sit under `## Test Structure`, so `## Test Quality` stays under the 8 KB H2 shape cap.
  - `## Test Depth and Upkeep` is its own H2: depth also governs a behavior's first test, which `### Decision procedure` excludes, and a numbered lead step there would renumber steps other text cites.
  - `### Legitimate example tests` sits under it for the same byte reason; its in-file pointer is the change-detector carve-out.
  - **One-off disposition** sits under that table as the last row's keep criterion, so the row and the criterion are stated once each.
  - The scope bound sits in the file lead because it governs every H2 it names.
- **The file-lead Authoring scope bullet** exists because the home-file and fold-back rules otherwise collide with `scoped/scope-dev.md` → **Everything outside that set is surfaced, never performed**. Change the two together.
  - Its coupled-test reach stays consistent with that line: a fix lands only inside the declared file set, and the rest is surfaced in `concerns` (**Coupled-test check**).
- Do not reintroduce, each works against readable tests: a regression pin named for its defect · a DAMP carve-out that covers byte-identical fixtures across files · a property-first ranking with no real-invariant bound · a fixed naming template or regex naming grammar.
  - A greenfield file is no exception: the **Naming** example shows content, never a template.
- Honour the research's exclusions: no comment scaffold, no assertion-count cap, no numeric trigger (duplication percentage, line count, rows per table, builder variants, a coverage figure or test count), no blanket property or mutation mandate.
- **Table form per stack**:
  - TypeScript lists `node:test` first because `monitor/test` imports it and not Vitest.
  - JUnit `name` placeholder and `@CsvSource` / `@ValueSource` / `@MethodSource`: the JUnit user guide, *Parameterized Classes and Tests* (docs.junit.org, 6.1.3).
  - Swift Testing `@Test("…", arguments: …)`: the swift-testing DocC article *ParameterizedTesting.md* (swiftlang/swift-testing).
  - The bats row's `|| { echo …; return 1; }` form shares its bash 3.2 errexit reason with `agents/glass-atrium-dev-shell.md` → `### Bats + test-run discipline`, not its form — that section prescribes `&&` chains ending in the assertion.

## Tooling status of the prohibited-shape rows

The rule file states only that every row is reviewer-applied; this mapping serves whoever adjudicates an auditor finding.

- MECHANICAL means decidable in principle by a script, not that one exists. **No row on the table is enforced.**
- Only signals (a) and (b) of `scripts/audit-test-smells.sh` back a row; the auditor is advisory — it exits 0 on findings — and no CI job reads its signals.
  - The naming ratchet runs it only for its `id_title` and `incident_header` counts; those back the **ID ban** and **Comments** rules, not a row, and the ratchet carries the failing exit (`## Backing honesty — Test Quality`).
- Its signal (c), count-pin — a non-zero integer literal compared against a census the same assertion derives by counting the tree or a source file — maps to no row, and in particular is not the change-detector row's tooling.
- A row marked `[no tooling]` has no implementation at all and is reviewer-applied exactly like a JUDGMENT row.

| Prohibited row (keyed by its literal in the rule file) | Smell source | Check |
|---|---|---|
| A test with no assertion, or whose only claim is "it did not throw" | the `expect-expect` lint rule family | MECHANICAL — tooling: signal (a) |
| An assertion that cannot fail | Pereira 2010 | MECHANICAL — tooling: signal (b) |
| Asserting back the value a mock was configured to return | — (mock-echo sub-case) | MECHANICAL `[no tooling]` |
| An expected value copied from observed output | Google Testing Blog 2015 | JUDGMENT `[no tooling]` |
| An assertion on the source text or line order of the code under test | Google Testing Blog 2015 (source-pin sub-case) | MECHANICAL `[no tooling]` |
| Near-duplicate cases that one property or one parameterized table would cover | van Deursen et al. 2001 | JUDGMENT `[no tooling]` |
| A test whose target has no branch and no logic | — (trivial getter/setter/constructor test) | JUDGMENT `[no tooling]` |
| A test written per file, class or function by reflex, or to reach a count or coverage figure | Google SWE book ch.12 (per-behavior tests) | JUDGMENT `[no tooling]` |
| Control flow that can SKIP an assertion | Meszaros 2007 | JUDGMENT `[no tooling]` |

- **Conditional-logic row**: excluded from the auditor on purpose — its carve-out requires reading which branch the assertion sits on; the `scripts/audit-test-smells.sh` header records the same reason.
- **Empirical backing for the list as a whole**: smelly tests carry measurably higher defect risk (Palomba et al., ASE 2016; corroborated ICSME 2018).
  - Contested by Panichella et al., EMSE 2022 (smells rarely track maintainability flaws), so the rule file does not state it; its rows rest on **The one question that decides a test's worth** instead.

## Rationalization Rejection — reconciliations

- **Test-first duty**: it binds at `core-outcome-record.md` → Field Input Guide → `metric_pass`, delivered to every agent with the observed-failure bar; its `feature` note names the deliberate-break exception and points to the rule file for it.
  - The rule file's qualifier is the exception's one statement — when a test written after its implementation is admissible, and how and where the break is made — and it reconciles the exception with the "Writing code first as a reference" rebuttal.
- **"Too simple to need tests" row**: the rebuttal is qualified by the prohibited shape *a test whose target has no branch and no logic*, so it does not collide with `scoped/scope-dev.md` → **YAGNI applies to tests too**, which exempts the same target.
  - The two ends are worded alike on purpose — change them together.

## Mechanical Success Metrics — code pointer

- Promotion rule SoT for `grader_verdict: verified_pass` on a code-type row: `hooks/lib/code-based-grader.sh` → `_cbg_files_test_evidence`.

## What reads the rule file mechanically

- Nothing reads its body; its mechanical couplings are:
  - the spelling `scoped/shared-testing.md` in `agent-registry.json` rules arrays, whose permitted values are the closed frozenset in `scripts/agent_lifecycle/registry_ops.py`, pinned by `scripts/test/test_agent_lifecycle_overhaul.py`;
  - the manifest hash;
  - the basename-to-matrix-row check in `hooks/validate-compliance-matrix.sh` — a `-maxdepth 1` enumeration, which is why this companion needs no matrix row.
- Renaming the file is therefore an edit of the registry frozenset, its pin and the compliance matrix, not a rule edit.
