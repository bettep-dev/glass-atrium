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

## Destructive-Path Suite Safety (live-postgres reach)

Two install-side shell functions can reach a live postgres: `clear_unmanaged_pg_orphan` (`lib/ga-daemons.sh`) and its only caller `preflight_pg_utc_guard` (`lib/ga-tui-preflight.sh`). Clear the procedure below before running any suite file that EXECUTES either.

- **The retired condition — do not re-derive it**: "safe once `kill`, `rm` and `lsof` are shadowed" is WRONG, not merely strict.
  - A shell-function shadow binds only in the shell that defines it, so a suite driving the function through a child shell satisfies that wording while the real command runs.
- **Enumerate — list every occurrence and classify by READING it; a command-word pattern is FORBIDDEN as the enumeration step.**
  - `grep -rn "clear_unmanaged_pg_orphan\|preflight_pg_utc_guard" test hooks/test scripts/test autoagent/test`
  - Read every line it returns. Do not filter first: under-enumeration is the dangerous direction here, because a missed executing site is indistinguishable from a pass.
  - Worked failure, why the shortcut is forbidden: a first-command-word regex over `test/poll-wallclock-ceiling.bats` returns the `@test` TITLE and MISSES the real call, which sits at the end of a child-shell command string after a `;`. The pattern reported a naming site and hid the executing one.
  - Derive the site list from the run; never carry a remembered count forward.
- **Classify each occurrence executing, naming, or neutralized** — only executing sites continue.
  - Executing: the name is a command word — bare at the start of a statement, after `run`, or after ANY command separator (`;`, `&&`, `||`, `|`, newline) INCLUDING inside a child-shell command string, where it is most often mid-string rather than leading.
  - Naming: it sits inside `grep`, `awk`, `declare -f`, a `[[ ]]` comparison, a `@test` title, a comment, a string literal in a non-shell file, or an argument to a helper (`extract_launcher_fn <name>`); or it is the definition itself.
  - Neutralized: a shadow definition (`<fn>() { return N; }`) that both precedes EVERY call it covers and sits in the SAME shell as that call — then those calls run the shadow, not the real function. Either half unproven → treat the calls as executing.
- **Answer three questions at every executing site, all three resolving**:
  - **Pid control** — can every `lsof` the function reaches return a live postgres pid? It MUST NOT. No environment seam substitutes for this.
    - It is the load-bearing half: when the socket lookup returns nothing, the function falls back to a socket-BLIND `lsof -ti tcp:5432` port lookup that finds the live server wherever the socket path points.
    - Two substitute shapes resolve it: one reporting NO owner, and one reporting a pid that provably cannot name a live process (a literal above the platform pid ceiling — macOS wraps pids below 100000). A real `lsof` on PATH resolves neither, whatever the socket redirect says.
    - The fake-pid shape leaves `kill -INT <pid>` running the REAL `kill`; it is safe only because the pid cannot exist. A fake pid inside the live range fails this question.
  - **Path control** — does `${PG_SOCKET}/.s.PGSQL.5432` resolve to a path OTHER than the live server's socket?
    - The object is that ONE path, not the tree containing it. A unique per-run `mktemp -d` directory PASSES even when it sits under `/tmp`, and one suite is FORCED there: the AF_UNIX `sun_path` cap (~104 bytes on macOS) makes a `$TMPDIR` base (`/var/folders/…`, ~91 bytes) unbindable. What FAILS is `PG_SOCKET` resolving to the live socket's OWN directory — unset (defaults to `/tmp`), or an explicit `/tmp`.
    - Two seams set it, and which one is available depends on how the file loads the code:
      - `GA_PG_SOCKET`, read ONLY by `ga_init_env` (`lib/ga-env.sh`), which is where the `readonly PG_SOCKET="${GA_PG_SOCKET:-/tmp}"` sits. The freeze fires when `ga_init_env` is CALLED — as the launcher source does — NOT when `lib/ga-env.sh` is sourced.
      - a plain `PG_SOCKET=` assignment, which WORKS in a file that sources a domain lib directly and so never calls `ga_init_env`: nothing made the name readonly there, and exporting `GA_PG_SOCKET` in such a file is inert.
  - **Mechanism binding** — which shell actually runs the function?
    - A same-shell `run <fn>` is bound by shell functions AND by PATH stubs; a child-shell driver is bound ONLY by PATH stubs and EXPORTED environment.
- **Pass** requires pid control AND path control, each by a mechanism that binds under Mechanism binding. Shadowing the signal or the removal command is neither necessary nor sufficient.
- **Ambiguous means fail** — do not reason harder.
  - Prepend a scratch dir of record-only stubs to the PATH of the WHOLE invocation (a PATH stub binds in every child) and run that one file under it; unavailable → stop and report.
- **Post-condition, independent of all the reading**: record the live server's pid and its socket inode before the run and compare both after. A change in either means something reached it, whatever the file said.
- **What this does NOT cover** — the hazard is a live pid plus a live path reaching a real signal or a real removal, so these shapes still slip past:
  - a stub dir prepended inside a child command string while an earlier statement in that same child already ran the real tool;
  - `GA_PG_SOCKET` set but never exported, so a child that calls `ga_init_env` itself freezes `PG_SOCKET` to the live default;
  - a same-shell shadow definition that a child-shell driver in the same file does not inherit, so the child runs the real function while the parent reads as neutralized;
  - path control alone, which leaves the port-lookup fallback free to find and signal the live pid;
  - an executing site the enumeration misses because the function name is assembled from string fragments.

## Mechanical Success Metrics

> Detailed per-task-type pass conditions: See `core-outcome-record.md` Field Input Guide → `metric_pass` (canonical source; `bug-fix` adds exit code 0 check)

- Metric results are recorded in the Outcome Record as a `metric_pass` (true/false) field
- `grader_verdict: verified_pass` on a code-type row is a PRESENCE signal, never a quality signal. Promotion rule SoT: `hooks/lib/code-based-grader.sh` → `_cbg_files_test_evidence`.
