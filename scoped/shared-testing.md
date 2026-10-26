# Testing Rules (Cross-Cutting Concern)

- **Authoring scope** (`## Test Quality` · `## Test Structure` · `## Test Depth and Upkeep`): these rules bind the tests a change adds or edits, and the tests it makes stale, obsolete or wrong (**Coupled-test check**).
  - Every edit stays inside the change's declared file set (`scoped/scope-dev.md` → `## Modification Scope Constraint (Surface Area Constraint) [DEV]`).
  - A pre-existing violation in a test the change does not touch, or an owning file outside that set, goes into `concerns` and is never edited.

## Test Quality

### What makes a test a test

- **Relationship over enumeration**: a test asserts a relationship that holds across an input class — not one hand-picked input/output pair.
  - A test suite is sensitive to behavior change and insensitive to structure change.
- **The one question that decides a test's worth**: "if I broke the implementation in the smallest way that matters, would this test fail?" No → it is not a test.
- **Watch it fail**: write the test before the code exists, or apply the deliberate-break exception (`## Rationalization Rejection (Testing)` → **Qualifier on the last row**). A test never observed to fail has not been verified.
  - Make the code correct for every valid input, not just the test's inputs — never hard-code a test's values.
  - Never edit, skip or delete a failing test until you know why it failed.
- **Behavioral testing**: verify behavior a caller can observe (input → output), not implementation details — a source-text or line-order pin is a prohibited shape (`### Meaningless-Test Prohibitions`).
- **Independence**: each test stands on its own.
  - Shared state between tests is FORBIDDEN.
  - Execution order MUST NOT matter.
  - The result MUST NOT depend on timing (sleeps, wall-clock races).
  - Why: a flaky test stops being an oracle.

### Decision procedure — run it before writing the SECOND test of the same behavior

Each step builds on the previous.

1. Name the relationship in one sentence — an invariant, a round-trip, or a metamorphic relation ("output is always sorted" · "decode of encode is identity" · "total never exceeds the cap").
2. Pick the cheapest form that expresses it: a property assertion only where a real invariant exists (round-trip, idempotence, a whole-class invariant) > one table of named rows over the equivalence class plus its boundaries (`### Table form per stack`) > a single example.
3. An Nth case is admissible only when it crosses an equivalence-class boundary the existing cases do not. Same class as an existing case → do NOT add it; strengthen the existing assertion instead.
4. Cannot name the relationship → the behavior is not understood yet. Stop and clarify; enumerating cases is not a substitute for understanding.

### Meaningless-Test Prohibitions

- **Every row is reviewer-applied**: no row below is enforced by a gate — apply each one yourself. A hand-run advisory auditor reports shapes for a subset and never adjudicates whether a shape is a defect.

#### The prohibited shapes

| Prohibited | Smell |
|---|---|
| A test with no assertion, or whose only claim is "it did not throw" | assertion-free test |
| An assertion that cannot fail | tautological test |
| Asserting back the value a mock was configured to return | tautological test — mock-echo sub-case |
| An expected value copied from observed output | change-detector test |
| An assertion on the source text or line order of the code under test | change-detector test — source-pin sub-case |
| Near-duplicate cases that one property or one parameterized table would cover | test code duplication |
| A test whose target has no branch and no logic | trivial getter/setter/constructor test |
| A test written per file, class or function by reflex, or to reach a count or coverage figure | coverage-driven test |
| Control flow that can SKIP an assertion | conditional test logic |

#### Rules spanning the whole table

- **DAMP carve-out (MUST — this is why duplication alone is never the trigger)**: repetition in arrange/setup is legitimate and often better than a shared helper. The prohibition targets duplicated assertion intent inside one equivalence class, never duplicated setup.
  - The one exception is a large byte-identical fixture (`### Names, comments and test data` → **Shared fixture**).
  - A duplication-percentage metric MUST NOT be used as the trigger.
- **Deletion duty**: when a relationship test subsumes existing example tests of the same behavior, delete the subsumed tests in the same change. Adding without deleting is how a suite inflates — a coding agent has no deletion pressure of its own.
  - Name every test a change removes, with its reason, in `concerns` — a subsumed test here, or a stale or obsolete one under **Coupled-test check**.

### Detection signature per row, keyed by the Prohibited literal above

- **A test with no assertion, or whose only claim is "it did not throw"**
  - **xUnit / JS**: zero assertion nodes in the test body.
  - **Bats / shell**: a bare command whose non-zero exit fails the test is the assertion — the signature is instead `run <cmd>` invoked with neither `$status` nor `$output` / `${lines[` examined afterwards in the same body.
- **An assertion that cannot fail** — the asserted value is a literal compared to itself, or is the same variable the test set, with no call into the code under test between set and assert.
- **Asserting back the value a mock was configured to return** — a literal or variable handed to a mock's return-configuration reappears untransformed in the same test's assertion.
  - JS/Python shapes only: the shell corpus has no mock-configuration form.
- **An expected value copied from observed output** — full-object or snapshot equality over internal state; an expected literal nobody can derive from the spec.
  - **Carve-out — a characterization test (Test Depth and Upkeep → Legitimate example tests) is exempt**: copying observed output is its whole purpose, bounded by that carve-out's own expiry condition. A snapshot with no stated expiry is not exempt.
- **An assertion on the source text or line order of the code under test** — a `grep`, regex or file read over the source file under test, or a comparison of two source lines' positions.
  - **Carve-out — a static fact that is itself the contract** (a file listed in the manifest) is asserted, in the file that owns that contract.
- **Near-duplicate cases that one property or one parameterized table would cover** — 3+ test bodies differing only in literals, all inside one equivalence class.
  - **DAMP carve-out** decides whether a given cluster is this smell.
- **A test whose target has no branch and no logic** — the production target is a single assignment or return with no branch, and the test only sets then gets. Resolve that target by reading it.
- **A test written per file, class or function by reflex, or to reach a count or coverage figure** — its relationship cannot be stated beyond "X runs" or "X calls Y" (one test per method of each new file · only internal-collaborator call assertions).
  - A call asserted on a boundary mock (`## Mocking Rules`) is observable behavior and is exempt.
- **Control flow that can SKIP an assertion** — `if` / `while` / `try` inside a test body where the assertion sits on only one branch, so a run can finish having asserted nothing.
  - **Carve-out — data-driven iteration over a fixture table is not this smell**: a loop whose body asserts on every element is the idiomatic parameterized form Decision procedure step 2 prefers. The trigger is a skippable assertion, never the presence of a loop keyword.

## Mocking Rules

- **Mock only at boundaries**: external APIs, databases, file systems, time
- Internal module mocking SHOULD be minimized → excessive mocking signals a design problem
- **Mocking library**: use the one the sibling tests in the same directory already use; introducing a second one into a corpus needs a stated reason

## Test Structure

- **Arrange-Act-Assert**: a test runs the three phases in order.
  - Keep the three phases visible.
  - Never chain a second Act — a later action and its assertion belong in their own test.
  - No `// Arrange` comment scaffold is required.
- **One behavior per test** — one relationship per test (`## Test Quality`); multiple asserts are allowed only as facets of that same relationship.
  - Each failure points to one cause: split the test, or give each assertion a message.

### Where a test lives

- **One home file per behavior**: a new case, a regression case included, goes into the file that already owns that behavior — never into a new file per incident, plan or task.
- **Grouping**: one `describe` block or test class per rule.
  - Each nesting level narrows exactly one condition.
  - Split a file by behavior area, never by line count.
- **Check before adding**: search the owning file for a test that already asserts the behavior — found → strengthen that test instead of adding a second.
- **Fold-back**: when you edit a one-off incident file whose behavior has an owning file, fold its cases into that file — both files inside the **Authoring scope** bound at the head of this file.

### Names, comments and test data

- **Naming**: a readable sentence of behavior plus condition, in the form the sibling file already uses; it states the relationship asserted, not the input value used.
  - No sibling file to mirror → write the same sentence in the stack's test-name slot, e.g. `rejects a withdrawal that exceeds the balance`; the example shows content, never a template to copy.
- **ID ban — the one hard naming rule**: no plan, task, incident or ticket ID (`AC-…`, `T19`, `P0-2`, `#14`) in a test name, test file name or helper name. The reference goes in the commit message.
  - Bad: `"T19/P2-T2: …"` · Good: `"update keeps a live model pin when the release omits it"`.
- **Comments**: a test comment states what the test protects, never how the code or the test got here — `scoped/shared-comment-logging.md` binds test files like any other code.
  - A test that calls itself vacuous is fixed or deleted.
- **Test data**: inline the few realistic values the assertion depends on; a placeholder (`'x'`, `'a@b.c'`) hides what matters.
- **Shared fixture**: a large fixture repeated byte-for-byte across tests or files, whose copies can drift, becomes one named fixture — or a builder with safe defaults once its variants multiply. Small readable setup stays inline.

### Table form per stack

Every table row carries a name stating its condition — an unnamed row fails with no meaning. Only the syntax differs per stack.

| Stack | Table form | Row name |
|---|---|---|
| bats | an array of rows looped inside one `@test` | a row label printed on that row's failure |
| pytest | `@pytest.mark.parametrize` | `ids=[…]` or `pytest.param(…, id=…)` — never auto-generated IDs on non-trivial values |
| TypeScript, `node:test` | a `rows` array looped inside one `describe`, one `test()` per row | `test(row.name, …)` |
| TypeScript, Vitest | `test.each(rows)` | `$prop` (object rows) or `%s` (array rows) in the title |
| Kotlin, JUnit 5 | `@ParameterizedTest` + `@CsvSource` / `@ValueSource` / `@MethodSource` | `name = "…{0}…"` |
| Swift Testing | `@Test("…", arguments: …)` — each argument reports as its own case, no loop | the display string plus the argument |

- **bats — every row fails on its own iteration**: assert each row as `<check> || { echo "<row name>"; return 1; }`. A bare `[[ ]]` in the loop body is exempt from errexit on bash 3.2, so an earlier failing row goes unseen.
- **bats — a status assertion prints the output**: a failing status check prints the output its run captured before the test fails; in a row loop, echo the row name too.
  - bats `run`: `<status check> || { echo "${output}"; return 1; }`.
  - bats `run --separate-stderr`: echo `${stderr}` as well — `${output}` then holds stdout only.
  - A direct call redirected to files: print those files on a nonzero status — once in the capturing helper, or at each call site.
  - Uncaptured output already reaches the bats failure report, so a status check on it needs nothing.

## Test Depth and Upkeep

- **Depth follows risk**: test depth tracks what a break would cost and how likely one is — never a coverage figure or a test count.
  - Core logic, auth, validation, data-loss and money paths → the relationship plus its boundaries (`### Decision procedure`).
  - Glue, wiring and config → one check of the behavior a caller relies on; none only when the target has no branch and no logic.
  - Coverage may point at an untested risky branch; it never decides that a test is needed or that testing is enough.
  - Keep a project's existing coverage gate; never add one.
  - Why: a coverage target buys tests that execute code without checking it.
- **Coupled-test check**: on every change, check the tests and CI jobs that exercise or read what the change touched — a green run reveals none of the classes below.
  - Find them by grepping the test and CI trees for each symbol, string literal, heading or path the change removed or renamed, then reading every hit.
  - Stale: its subject remains, but it asserts or names the old text or behavior and still passes.
  - Obsolete: exercises nothing the change left, or now skips silently.
  - Wrong: its subject remains, but it fails because it expects the old text or behavior.
  - Fix each inside the declared file set; outside it → name the test and its class in `concerns`.
  - Remove only a test this change made stale or obsolete, named with its reason per **Deletion duty**; never delete, skip or loosen a test to turn a red run green.
  - Why: agents fix what fails and miss what stays green, so a stale test survives every run.

### Legitimate example tests (this is NOT a ban on examples)

Each kind is legitimate when the stated purpose is the whole reason the test exists.

| Kind | Legitimate when |
|---|---|
| regression pin | it reproduces one reported defect, is named for the behavior it protects, and lives in that behavior's home file |
| characterization test | it pins legacy behavior before a refactor, is structure-sensitive by design, and is rewritten or deleted post-refactor |
| executable-specification example | it is the one canonical worked example documenting the contract |
| one-off verification test (a probe, an incident repro, a change check) | it is kept as a regression pin in the behavior's home file, or deleted in the change that wrote it |

- **One-off disposition** (the one-off verification test row): keep one only when deleting it could let a real break through later; equal coverage is never the reason to keep or delete a test (**Deletion duty**).
- **Boundary**: an example test is never a substitute for the relationship test of the same behavior. Three examples of one behavior with no named relationship is enumeration, not coverage.

## Rationalization Rejection (Testing)

| Excuse | Rebuttal |
|--------|----------|
| "Too simple to need tests" | Even simple code regresses · sole exception: a test whose target has no branch and no logic (prohibited above) |
| "Will add tests later due to time constraints" | "Later" never comes · test debt = technical debt |
| "This part is hard to test" | Difficulty testing = design problem signal → fix the design |
| "I verified it manually" | Manual verification ≠ validation · non-reproducible = invalid |
| "Writing code first as a reference" | Code written before tests MUST be **deleted and rewritten** |

- **Qualifier on the last row (the deliberate-break exception)**: a test written after its implementation is admissible when it was observed to fail against a deliberately broken copy of the implementation. Skip that step and the test is unproven, so the rebuttal applies unchanged.
  - Break a temporary copy, never the real tree: a fresh `mktemp -d` directory, with the test run's cwd inside it.
    - Why: a broken script run from the real tree can damage that tree; a broken copy is discarded, never reverted.
  - The copy carries everything the run loads, in its original relative layout — the implementation, the test, and its helpers, fixtures and config; for a built stack, the project and its build config.
  - Run the test in the copy once before the break and see it pass, so the failure observed afterwards comes from the break alone.

## 3-Tier Test Hierarchy

| Tier | Content | Cost | When to Run |
|------|---------|------|-------------|
| T1 Static | lint + typecheck | Free | After every change |
| T2 Unit | Related unit tests | Low | For changed files |
| T3 E2E/Integration | Full test suite | High | Before commit |

- Execute in T1 → T2 → T3 order (fast feedback first).
- Diff-based: run the T2 tests related to changed files first, selected per that project's test structure (`src/foo.ts` → `test/foo.spec.ts` / `foo.test.ts`).
- A full T3 pass is REQUIRED before commit.

## Mechanical Success Metrics

- `grader_verdict: verified_pass` on a code-type row is a presence signal, never a quality signal.
