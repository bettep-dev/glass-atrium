# Testing Rules (Cross-Cutting Concern)

- **Authoring scope** (`## Test Quality` · `## Test Structure`): these rules bind the tests a change adds or edits, and every edit stays inside the change's declared file set (`scoped/scope-dev.md` → `## Modification Scope Constraint (Surface Area Constraint) [DEV]`).
  - A violation in a test the change does not touch, or an owning file outside that set, goes into `concerns` and is never edited.

## Test Quality

### What makes a test a test

- **Relationship over enumeration**: a test asserts a RELATIONSHIP that holds across an input class — not one hand-picked input/output pair. A test suite is sensitive to behavior change and insensitive to structure change.
- **The one question that decides a test's worth**: "if I broke the implementation in the smallest way that matters, would THIS test fail?" No → it is not a test.
- **Watch it fail**: write the test before the code exists, or apply the deliberate-break exception (`## Rationalization Rejection (Testing)` → **Qualifier on the last row**). A test never observed to fail has not been verified.
  - Never edit a failing test to make it pass until you know why it failed.
- **Behavioral testing**: verify behavior a caller can observe (input → output), not implementation details — a source-text or line-order pin is a prohibited shape (`### Meaningless-Test Prohibitions`).
- **Independence**: shared state between tests is FORBIDDEN · execution order MUST NOT matter · the result MUST NOT depend on timing (sleeps, wall-clock races) — a flaky test stops being an oracle.

### Decision procedure — run it before writing the SECOND test of the same behavior

Each step builds on the previous.

1. Name the relationship in one sentence — an invariant, a round-trip, or a metamorphic relation ("output is always sorted" · "decode of encode is identity" · "total never exceeds the cap").
2. Pick the cheapest form that expresses it: a property assertion only where a real invariant exists (round-trip, idempotence, a whole-class invariant) > ONE table of named rows over the equivalence class plus its boundaries (`### Table form per stack`) > a single example.
3. An Nth case is admissible only when it crosses an equivalence-class boundary the existing cases do not. Same class as an existing case → do NOT add it; strengthen the existing assertion instead.
4. Cannot name the relationship → the behavior is not understood yet. Stop and clarify; enumerating cases is not a substitute for understanding.

### Legitimate example tests (this is NOT a ban on examples)

Each kind is legitimate when the stated purpose IS the whole reason the test exists.

| Kind | Legitimate when |
|---|---|
| regression pin | it reproduces one reported defect, is named for the behavior it protects, and lives in that behavior's home file |
| characterization test | it pins observed legacy behavior before a refactor — deliberately structure-sensitive, deliberately temporary, rewritten or deleted once the refactor lands |
| executable-specification example | it is the one canonical worked example documenting the contract |

- **Boundary**: an example test is never a SUBSTITUTE for the relationship test of the same behavior. Three examples of one behavior with no named relationship is enumeration, not coverage.

### Meaningless-Test Prohibitions

- **Every row is reviewer-applied**: no row below is enforced by a gate — apply each one yourself. A hand-run advisory auditor reports shapes for a subset and never adjudicates whether a shape is a defect.
- Detection signatures are ECOSYSTEM-SPECIFIC where the ecosystem changes what an assertion is.

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
| Control flow that can SKIP an assertion | conditional test logic |

#### Detection signature per row, keyed by the Prohibited literal above

- **A test with no assertion, or whose only claim is "it did not throw"**
  - **xUnit / JS**: zero assertion nodes in the test body.
  - **Bats / shell**: a bare command whose non-zero exit fails the test IS the assertion, so "no assertion node" is meaningless here — the signature is instead `run <cmd>` invoked with neither `$status` nor `$output` / `${lines[` examined afterwards in the same body.
- **An assertion that cannot fail** — the asserted value is a literal compared to itself, or is the same variable the test set, with no call into the code under test between set and assert.
- **Asserting back the value a mock was configured to return** — a literal or variable handed to a mock's return-configuration reappears untransformed in the same test's assertion.
  - JS/Python shapes only: the shell corpus has no mock-configuration form.
- **An expected value copied from observed output** — full-object or snapshot equality over internal state; an expected literal nobody can derive from the spec.
  - **Carve-out — a characterization test (Test Quality → Legitimate example tests) is EXEMPT**: copying observed output is its whole purpose, bounded by that carve-out's own expiry condition. A snapshot with no stated expiry is not a characterization test and is not exempt.
- **An assertion on the source text or line order of the code under test** — a `grep`, regex or file read over the source file under test, or a comparison of two source lines' positions.
  - **Carve-out — a static fact that is itself the contract** (a file listed in the manifest) is asserted, in the file that owns that contract.
- **Near-duplicate cases that one property or one parameterized table would cover** — 3+ test bodies differing only in literals, all inside ONE equivalence class.
  - The DAMP carve-out below decides whether a given cluster is this smell.
- **A test whose target has no branch and no logic** — the production target is a single assignment or return with no branch, and the test only sets then gets. Resolve that target by reading it; no tool resolves it for you.
- **Control flow that can SKIP an assertion** — `if` / `while` / `try` inside a test body where the assertion sits on only one branch, so a run can finish having asserted nothing.
  - **Carve-out — data-driven iteration over a fixture table is NOT this smell**: a loop whose body asserts on EVERY element is the idiomatic parameterized form Decision procedure step 2 prefers. The trigger is a skippable assertion, never the presence of a loop keyword.

#### Rules spanning the whole table

- **DAMP carve-out (MUST — this is why duplication alone is never the trigger)**: repetition in arrange/setup is legitimate and often better than a shared helper. The prohibition targets duplicated ASSERTION intent inside one equivalence class, never duplicated setup. A duplication-percentage metric MUST NOT be used as the trigger.
  - The one exception is a large byte-identical fixture (`### Names, comments and test data` → **Shared fixture**).
- **Deletion duty**: when a relationship test subsumes existing example tests of the same behavior, delete the subsumed tests in the SAME change. Adding without deleting is how a suite inflates — a coding agent has no deletion pressure of its own.
- **This list is defect-risk regulation, not style preference**: smelly tests carry measurably higher defect risk than clean ones.

## Mocking Rules

- **Mock only at boundaries**: external APIs, databases, file systems, time
- Internal module mocking SHOULD be minimized → excessive mocking signals a design problem
- **Mocking library**: use the one the sibling tests in the same directory already use; introducing a second one into a corpus needs a stated reason

## Test Structure

- **Arrange-Act-Assert**: keep the three phases visible, and never chain a second Act — a later action and its assertion belong in their own test. No `// Arrange` comment scaffold is required.
- **One behavior per test** — one relationship per test (`## Test Quality`); multiple asserts are allowed only as facets of that same relationship.
  - Each failure points to one cause: split the test, or give each assertion a message.

### Where a test lives

- **One home file per behavior**: a new case, a regression case included, goes into the file that already owns that behavior — never into a new file per incident, plan or task.
- **Grouping**: one `describe` block or test class per rule; each nesting level narrows exactly one condition. Split a file by behavior area, never by line count.
- **Check before adding**: search the owning file for a test that already asserts the behavior — found → strengthen that test instead of adding a second.
- **Fold-back**: when you edit a one-off incident file whose behavior has an owning file, fold its cases into that file — both files inside the **Authoring scope** bound at the head of this file.

### Names, comments and test data

- **Naming**: a readable sentence of behavior plus condition, in the form the sibling file already uses; it states the relationship asserted, not the input value used.
- **ID ban — the one hard naming rule**: no plan, task, incident or ticket ID (`AC-…`, `T19`, `P0-2`, `#14`) in a test name, test file name or helper name. The reference goes in the commit message.
  - Bad: `"T19/P2-T2: …"` · Good: `"update keeps a live model pin when the release omits it"`.
- **Comments**: a test comment states what the test protects, never how the code or the test got here — `scoped/shared-comment-logging.md` binds test files like any other code. A test that calls itself vacuous is fixed or deleted.
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

## Rationalization Rejection (Testing)

| Excuse | Rebuttal |
|--------|----------|
| "Too simple to need tests" | Even simple code regresses · sole exception: a test whose target has no branch and no logic (prohibited above) |
| "Will add tests later due to time constraints" | "Later" never comes · test debt = technical debt |
| "This part is hard to test" | Difficulty testing = design problem signal → fix the design |
| "I verified it manually" | Manual verification ≠ validation · non-reproducible = invalid |
| "Writing code first as a reference" | Code written before tests MUST be **deleted and rewritten** |

- **Qualifier on the last row (the deliberate-break exception)**: a test written after its implementation is admissible when the implementation was deliberately broken, the test OBSERVED to fail, and the break reverted. Skip that step and the test is unproven, so the rebuttal applies unchanged.

## 3-Tier Test Hierarchy

| Tier | Content | Cost | When to Run |
|------|---------|------|-------------|
| T1 Static | lint + typecheck | Free | After every change |
| T2 Unit | Related unit tests | Low | For changed files |
| T3 E2E/Integration | Full test suite | High | Before commit |

- Execute in T1 → T2 → T3 order (fast feedback first).
- Diff-based: run the T2 tests related to changed files first, selected per that project's test structure (`src/foo.ts` → `test/foo.spec.ts` / `foo.test.ts`).
- A full T3 pass is REQUIRED before commit.

## Destructive-Path Suite Safety (live-postgres reach)

**Condition — this section binds only when you are about to RUN a suite file that executes one of two install-side shell functions**: `clear_unmanaged_pg_orphan` (`lib/ga-daemons.sh`) and its only caller `preflight_pg_utc_guard` (`lib/ga-tui-preflight.sh`) are exactly the functions that can reach a live postgres. No such run → skip to the next section. Otherwise clear the procedure below first: the steps build on each other, and a step you cannot complete is a FAIL rather than a judgement call.

### Before you start: do not re-derive the retired condition

- **The retired condition — do not re-derive it**: "safe once `kill`, `rm` and `lsof` are shadowed" is WRONG, not merely strict.
  - A shell-function shadow binds only in the shell that defines it, so a suite driving the function through a child shell satisfies that wording while the real command runs.

### Step 1 — Enumerate the occurrences

List every occurrence and classify by READING it; a command-word pattern is FORBIDDEN as the enumeration step.

- `grep -rn "clear_unmanaged_pg_orphan\|preflight_pg_utc_guard" test hooks/test scripts/test autoagent/test`
- Read every line it returns. Do not filter first: under-enumeration is the dangerous direction here, because a missed executing site is indistinguishable from a pass.
- Worked failure, why the shortcut is forbidden: a first-command-word regex over `test/poll-wallclock-ceiling.bats` returns the `@test` TITLE and MISSES the real call, which sits at the end of a `run_bounded` child-shell command string after a `;`. The pattern reported a naming site and hid the executing one.
- Derive the site list from the run; never carry a remembered count forward.

### Step 2 — Classify each occurrence

Classify each occurrence executing, naming, or neutralized — only executing sites continue.

- Executing: the name is a command word — bare at the start of a statement, after `run`, or after ANY command separator (`;`, `&&`, `||`, `|`, newline) INCLUDING inside a child-shell command string, where it is most often mid-string rather than leading.
- Naming: it sits inside `grep`, `awk`, `declare -f`, a `[[ ]]` comparison, a `@test` title, a comment, a string literal in a non-shell file, or an argument to a helper (`extract_launcher_fn <name>`); or it is the definition itself.
- Neutralized: a shadow definition (`<fn>() { return N; }`) that both precedes EVERY call it covers and sits in the SAME shell as that call — then those calls run the shadow, not the real function. Either half unproven → treat the calls as executing.
  - **In a bats file, "the SAME shell" is the SAME test body, and this is the rule, not a nuance**: each test body runs in its own shell, so a shadow defined in one body does NOT reach a call in any later body.
  - Therefore a call with no shadow inside its OWN body is EXECUTING even when a shadow of that name appears earlier in the file.
  - Reading the file top-down invites the opposite conclusion, which is the exact misclassification this bucket exists to prevent — it silently converts a real executing site into a pass.
  - The mirror of that rule, and the reason a control installed once still counts: whatever `setup` defines DOES reach every body, because it runs inside each one. A shadow or a PATH stub installed there covers the whole file; only a body-local one stops at its own body.

### Step 3 — Read the reached function body

Read the reached function body BEFORE answering — the pid question is not answerable from the test file alone. Open `clear_unmanaged_pg_orphan` in `lib/ga-daemons.sh` and read ONLY these:

- Every lookup that feeds the signal, and how each is reached: a socket-scoped lookup, plus a socket-blind port fallback that runs only when the first returns nothing.
  - COUNT them rather than assuming one — a substitute must cover every one, which a stub ignoring its arguments does in a single file.
- Which layer consumes each answer: the pid feeds the signal, and the resolved socket path feeds the removal. That mapping is what makes the Step 4 questions answerable rather than a guess.
- Then resolve the SITE's own controls the same way: a test file usually installs its stub through a helper defined elsewhere in that file, so follow the helper's definition — the call site shows only its name, which answers nothing.
- This READ is required, and it relaxes no criterion below.

### Step 4 — Answer the questions at every executing site

Answer every question below at every executing site, all of them resolving.

- **Pid control** — can every `lsof` the function reaches return a live postgres pid? It MUST NOT. No environment seam substitutes for this.
  - It is the load-bearing half: when the socket lookup returns nothing, the function falls back to a socket-BLIND `lsof -ti tcp:5432` port lookup that finds the live server wherever the socket path points.
  - Two substitute shapes resolve it: one reporting NO owner, and one reporting a pid that provably cannot name a live process (a literal above the platform pid ceiling — macOS wraps pids below 100000). A real `lsof` on PATH resolves neither, whatever the socket redirect says.
  - The fake-pid shape leaves `kill -INT <pid>` running the REAL `kill`; it is safe only because the pid cannot exist. A fake pid inside the live range fails this question.
- **Path control** — does `${PG_SOCKET}/.s.PGSQL.5432` resolve to a path OTHER than the live server's socket?
  - The object is that ONE path, not the tree containing it.
  - A unique per-run `mktemp -d` directory PASSES even when it sits under `/tmp`, and one suite is FORCED there — `test/uninstall-detached-daemons.bats`, because the AF_UNIX `sun_path` cap (~104 bytes on macOS) makes a `$TMPDIR` base (`/var/folders/…`, ~91 bytes) unbindable.
  - What FAILS is `PG_SOCKET` resolving to the live socket's OWN directory — unset (defaults to `/tmp`), or an explicit `/tmp`.
  - Which seam sets it depends on how the file loads the code:
    - `GA_PG_SOCKET`, read ONLY by `ga_init_env` (`lib/ga-env.sh`), which is where the `readonly PG_SOCKET="${GA_PG_SOCKET:-/tmp}"` sits. The freeze fires when `ga_init_env` is CALLED — as the launcher source does — NOT when `lib/ga-env.sh` is sourced.
    - a plain `PG_SOCKET=` assignment, which WORKS in a file that sources a domain lib directly and so never calls `ga_init_env`: nothing made the name readonly there, and exporting `GA_PG_SOCKET` in such a file is inert.
- **Mechanism binding** — which shell actually runs the function?
  - A same-shell `run <fn>` is bound by shell functions AND by PATH stubs; a child-shell driver is bound ONLY by PATH stubs and EXPORTED environment.

### Step 5 — Decide, and verify the decision after the run

- **Pass** requires pid control AND path control, each by a mechanism that binds under Mechanism binding. Shadowing the signal or the removal command is neither necessary nor sufficient.
- **Ambiguous means fail** — do not reason harder.
  - The one escape: prepend a scratch dir of record-only stubs to the PATH of the WHOLE invocation (a PATH stub binds in every child) and run that one file under it; unavailable → stop and report.
- **Post-condition, independent of all the reading**: record the live server's pid and its socket inode before the run and compare both after. A change in either means something reached it, whatever the file said.

### What this procedure does NOT cover

The hazard is a live pid plus a live path reaching a real signal or a real removal, so these shapes still slip past:

- a stub dir prepended inside a child command string while an earlier statement in that same child already ran the real tool;
- `GA_PG_SOCKET` set but never exported, so a child that calls `ga_init_env` itself freezes `PG_SOCKET` to the live default;
- a same-shell shadow definition that a child-shell driver in the same file does not inherit, so the child runs the real function while the parent reads as neutralized;
- path control alone, which leaves the port-lookup fallback free to find and signal the live pid;
- an executing site the enumeration misses because the function name is assembled from string fragments.

## Mechanical Success Metrics

- Per-task-type pass conditions are canonical in `core-outcome-record.md` → Field Input Guide → `metric_pass` (`bug-fix` adds an exit-code-0 check); the result is recorded there as the `metric_pass` boolean.
- `grader_verdict: verified_pass` on a code-type row is a PRESENCE signal, never a quality signal.
