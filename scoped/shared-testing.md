# Testing Rules (Cross-Cutting Concern)

Applies to all DEV agents, plus glass-atrium-meta-prompt-engineer (prompts = code); glass-atrium-meta-agent does NOT inherit it.

## Test Quality

- **Relationship over enumeration**: a test asserts a RELATIONSHIP that holds across an input class — not one hand-picked input/output pair. Anchor: Kent Beck, *Programmer Test Principles* (2019) — a test suite is sensitive to behavior change and insensitive to structure change.
- **The one question that decides a test's worth**: "if I broke the implementation in the smallest way that matters, would THIS test fail?" No → it is not a test. A test never observed to fail has not been verified.
- **Decision procedure — run it before writing the SECOND test of the same behavior**:
  1. Name the relationship in one sentence — an invariant, a round-trip, or a metamorphic relation ("output is always sorted" · "decode of encode is identity" · "total never exceeds the cap").
  2. Pick the cheapest form that expresses it: property/invariant assertion > ONE parameterized table over an equivalence class plus its boundaries > a single example.
  3. An Nth case is admissible only when it crosses an equivalence-class boundary the existing cases do not. Same class as an existing case → do NOT add it; strengthen the existing assertion instead.
  4. Cannot name the relationship → the behavior is not understood yet. Stop and clarify; enumerating cases is not a substitute for understanding.
- **Legitimate example tests (this is NOT a ban on examples)** — each is legitimate when the stated purpose IS the whole reason the test exists:
  - **regression pin** — one test reproducing one reported defect, named for that defect;
  - **characterization test** — pins observed legacy behavior before a refactor; deliberately structure-sensitive, deliberately temporary, and rewritten or deleted once the refactor lands (Feathers);
  - **executable-specification example** — one canonical worked example documenting the contract.
  - Boundary: an example test is never a SUBSTITUTE for the relationship test of the same behavior. Three examples of one behavior with no named relationship is enumeration, not coverage.
- **Behavioral testing**: verify external behavior (input → output), not implementation details.
- **Independence**: shared state between tests is FORBIDDEN · execution order MUST NOT matter.
- **Naming**: prefer `should_expectedBehavior_when_condition` or readable `describe/it` blocks — and make the name state the RELATIONSHIP asserted, not the input value used.
- **Backing honesty**: this whole section is an adherence-layer convention with **no runtime backstop** — no hook or gate verifies that the decision procedure was run, and none can. Its only mechanical companion is the three-signal advisory auditor named below, which never inspects the relationship claim itself.

### Meaningless-Test Prohibitions

**How to read the Check column (backing honesty).** MECHANICAL means **decidable-in-principle by a script — NOT that a script exists**. **No row on this table is enforced.**

- Of the rows below, exactly TWO have tooling: signals (a) and (b) of `scripts/audit-test-smells.sh` — an **ADVISORY** auditor, exiting 0 on findings, **NOT wired into CI**, run by hand.
- That auditor carries a THIRD signal **no row below states** — (c) count-pin: an assertion comparing a non-zero integer literal against a census the same assertion derives by counting the tree or a source file. A signal-(c) finding therefore maps to no row here, and is in particular not the tooling for the change-detector row.
- Every row tagged `[no tooling]` has no implementation at all and is reviewer-applied exactly like a JUDGMENT row.
- Detection signatures are ECOSYSTEM-SPECIFIC where the ecosystem changes what an assertion is.

| Prohibited | Smell (source) | Detection signature | Check |
|---|---|---|---|
| A test with no assertion, or whose only claim is "it did not throw" | assertion-free test (the `expect-expect` lint rule family) | **xUnit / JS**: zero assertion nodes in the test body. **Bats / shell**: a bare command whose non-zero exit fails the test IS the assertion, so "no assertion node" is meaningless here — the signature is instead `run <cmd>` invoked with neither `$status` nor `$output` / `${lines[` examined afterwards in the same body. | MECHANICAL — tooling: signal (a) |
| An assertion that cannot fail | tautological test (Pereira 2010) | the asserted value is a literal compared to itself, or is the same variable the test set, with no call into the code under test between set and assert | MECHANICAL — tooling: signal (b) |
| Asserting back the value a mock was configured to return | tautological test — mock-echo sub-case | a literal or variable handed to a mock's return-configuration reappears untransformed in the same test's assertion | MECHANICAL `[no tooling]` — JS/Python shapes only; the shell corpus has no mock-configuration form |
| An expected value copied from observed output | change-detector test (Google Testing Blog 2015) | full-object or snapshot equality over internal state; an expected literal nobody can derive from the spec. **Carve-out — a characterization test (see Test Quality) is EXEMPT**: copying observed output is its whole purpose, bounded by that carve-out's own expiry condition. A snapshot with no stated expiry is not a characterization test and is not exempt. | JUDGMENT `[no tooling]` |
| Near-duplicate cases that one property or one parameterized table would cover | test code duplication (van Deursen et al. 2001) | 3+ test bodies differing only in literals, all inside ONE equivalence class | JUDGMENT `[no tooling]` — see the DAMP carve-out |
| A test whose target has no branch and no logic | trivial getter/setter/constructor test | the production target is a single assignment or return with no branch, and the test only sets then gets | JUDGMENT `[no tooling]` — resolving the production target from the test is not implemented |
| Control flow that can SKIP an assertion | conditional test logic (Meszaros 2007) | `if` / `while` / `try` inside a test body where the assertion sits on only one branch, so a run can finish having asserted nothing. **Carve-out — data-driven iteration over a fixture table is NOT this smell**: a loop whose body asserts on EVERY element is the idiomatic parameterized form Test Quality step 2 prefers. The trigger is a skippable assertion, never the presence of a loop keyword. | JUDGMENT `[no tooling]` — deliberately excluded from the auditor (the carve-out requires reading which branch the assertion sits on) |

- **DAMP carve-out (MUST — this is why duplication alone is never the trigger)**: repetition in arrange/setup is legitimate and often better than a shared helper (Google Testing Blog, *Tests Too DRY? Make Them DAMP!*, 2019). The prohibition targets duplicated ASSERTION intent inside one equivalence class, never duplicated setup. A duplication-percentage metric MUST NOT be used as the trigger.
- **Deletion duty**: when a relationship test subsumes existing example tests of the same behavior, delete the subsumed tests in the SAME change. Adding without deleting is how a suite inflates — a coding agent has no deletion pressure of its own.
- **Empirical backing**: smelly tests carry measurably higher defect risk than clean ones (Palomba et al., ASE 2016; corroborated ICSME 2018). This list is defect-risk regulation, not style preference.

## Mocking Rules

- **Mock only at boundaries**: external APIs, databases, file systems, time
- Internal module mocking SHOULD be minimized → excessive mocking signals a design problem
- Mocking libraries → follow existing project patterns

## Test Structure

- **Arrange-Act-Assert**: clearly separate into 3 phases
- **One behavior per test**: a test asserts ONE relationship (multiple asserts allowed only when they are facets of that same relationship)
- Test data → use factory/builder patterns · magic values are FORBIDDEN

## Self-Review

- After completing code changes → apply the Test Quality decision procedure to each related test; one whose relationship cannot be stated is not carrying its weight
- Core business logic → check that the equivalence classes and their boundaries are covered, not that more cases were added

## TDD Discipline (Absolute Rules)

- **Writing or modifying code without tests is FORBIDDEN** — no exceptions
- **Red → Green → Refactor**: (1) write a failing test (2) write minimal code to pass (3) refactor. Violating this order is FORBIDDEN
- **Deliberate-break confirmation** — the ONE bounded exception to that order: a test written after its implementation is admissible when the implementation was deliberately broken, the test OBSERVED to fail against the break, and the break reverted. The observed failure is what the Red step buys, so producing it late produces equivalent evidence; skipping it leaves an unproven test and the delete-and-rewrite rule below applies unchanged. How that evidence is reported is not restated here — SoT is `core-outcome-record.md` → Field Input Guide → `metric_pass`
- Bug fixes → a failing test MUST be written, executed, and confirmed BEFORE modifying code

## Rationalization Rejection (Testing)

| Excuse | Rebuttal |
|--------|----------|
| "Too simple to need tests" | Even simple code regresses · tests serve as documentation |
| "Will add tests later due to time constraints" | "Later" never comes · test debt = technical debt |
| "This part is hard to test" | Difficulty testing = design problem signal → fix the design |
| "I verified it manually" | Manual verification ≠ validation · non-reproducible = invalid |
| "Writing code first as a reference" | Code written before tests MUST be **deleted and rewritten** |

## 3-Tier Test Hierarchy

| Tier | Content | Cost | When to Run |
|------|---------|------|-------------|
| T1 Static | lint + typecheck | Free | After every change |
| T2 Unit | Related unit tests | Low | For changed files |
| T3 E2E/Integration | Full test suite | High | Before commit |

- Execute in T1 → T2 → T3 order (fast feedback first)
- Diff-based: run only T2 tests related to changed files first
  - Automatically select related tests based on changed files, per that project's test structure: `src/foo.ts` → `test/foo.spec.ts` / `foo.test.ts`
- Full T3 pass REQUIRED before commit

## Mechanical Success Metrics

> Detailed per-task-type pass conditions: See `core-outcome-record.md` Field Input Guide → `metric_pass` (canonical source; `bug-fix` adds exit code 0 check)

- Metric results are recorded in the Outcome Record as a `metric_pass` (true/false) field
- `grader_verdict: verified_pass` on a code-type row is a PRESENCE signal, never a quality signal. Promotion rule SoT: `hooks/lib/code-based-grader.sh` → `_cbg_files_test_evidence`.
