# Testing Rules (Cross-Cutting Concern)

Applies to all DEV agents.

## Pre-Commit Verification

- All existing tests MUST pass before committing · committing with failures is FORBIDDEN
- New features → unit tests SHOULD accompany · bug fixes → a failing test MUST be written first

## Test Quality

- **Behavioral testing**: verify external behavior (input → output), not implementation details
- **Independence**: shared state between tests is FORBIDDEN · execution order MUST NOT matter
- **Naming**: prefer `should_expectedBehavior_when_condition` or readable `describe/it` blocks

## Mocking Rules

- **Mock only at boundaries**: external APIs, databases, file systems, time
- Internal module mocking SHOULD be minimized → excessive mocking signals a design problem
- Mocking libraries → follow existing project patterns

## Test Structure

- **Arrange-Act-Assert**: clearly separate into 3 phases
- **Single assertion per test** principle (multiple asserts allowed only for related properties)
- Test data → use factory/builder patterns · magic values are FORBIDDEN

## Self-Review

- After completing code changes → verify related test coverage as a habit
- Core business logic → check whether edge case tests are included

## TDD Discipline (Absolute Rules)

- **Writing or modifying code without tests is FORBIDDEN** — no exceptions
- **Red → Green → Refactor**: (1) write a failing test (2) write minimal code to pass (3) refactor. Violating this order is FORBIDDEN
- Bug fixes → a failing test MUST be written, executed, and confirmed BEFORE modifying code

> See the central **Rationalization Rejection Table** in [[GLASS_ATRIUM_GLOBAL_RULES#Rationalization Rejection Table (Central)]]

## 3-Tier Test Hierarchy

| Tier | Content | Cost | When to Run |
|------|---------|------|-------------|
| T1 Static | lint + typecheck | Free | After every change |
| T2 Unit | Related unit tests | Low | For changed files |
| T3 E2E/Integration | Full test suite | High | Before commit |

- Execute in T1 → T2 → T3 order (fast feedback first)
- Diff-based: run only T2 tests related to changed files first
- Full T3 pass REQUIRED before commit

## Mechanical Success Metrics

> Detailed per-task-type pass conditions: See `core-outcome-record.md` Field Input Guide → `metric_pass` (canonical source; `bug-fix` adds exit code 0 check)

- Metric results are recorded in the Outcome Record as a `metric_pass` (true/false) field
- Discrepancy between subjective evaluation (confidence) and mechanical evaluation (metric_pass) → triggers review

## Diff-Based Test Selection

- Automatically select related tests based on changed files: `src/foo.ts` → `test/foo.spec.ts` / `foo.test.ts`
- Selective execution (T2) → full execution before commit (T3): two-stage policy
- Mapping rules are applied per project test structure
