---
name: glass-atrium-ops-verify-gate
description: Pre-commit 6-stage sequential verification covering build, types, lint, tests, console cleanup, and git audit. Invoke with /verify.
---

## Overview

Sequentially verifies code quality in 6 stages before committing, enforcing evidence-based completion claims. No stage may be skipped, and failure at any stage halts the pipeline. This prevents "it should work" declarations and ensures every commit is backed by mechanical proof.

## When to Use

- Right before a commit, before creating a PR, after completing a feature implementation
- When any agent claims a task is "done" or "fixed"
- After refactoring to confirm no behavioral changes
- **Exclusions**: Documentation-only changes, configuration file edits with no code impact, memory/ file updates

## Core Process

### Stage 0: Pre-Define Success Criteria (Karpathy Goal-Driven)

Before entering code changes, agents MUST emit a measurable `Success Criteria:` block (≥1 item · noun-phrase form · measurement method explicit — shared-testing.md mechanical success metrics 정합):

```
Success Criteria:
- <noun-phrase outcome> — 측정: <command | metric | observation>
```

- Each criterion MUST specify HOW it will be verified (command output / test name / metric threshold / artifact diff) — `core-outcome-record.md` Field Input Guide `metric_pass` 와 정렬
- Stage 0 emission is REQUIRED before any Write/Edit operation in scope; missing emission → halt + redesign
- **Loop termination cap** (ADR 4-D-2 R1): "Loop until verified" intent absorbed, but bounded — same-stage 2 consecutive fail → immediate escalate to qa-debugger (Iron Law absolute · `glass-atrium-core-iron-laws` skill Debugger Escalation 정합 · Unbounded Consumption Stop 최우선) · Outcome Record emit: `result: fail` (qa-debugger escalation target per `core-outcome-record.md` result values)
- Rationale: pre-stated success criteria prevent "it should work" claims (Karpathy "Goal-Driven Execution") and provide the mechanical anchor Stages 1-6 verify against
- **Exclusions inheritance**: Stage 0 inherits the `## When to Use` Exclusion list (doc-only / config-only / memory/-only edits) — Karpathy Goal-Driven intent is code-change correctness, not documentation precision

### Verification Order (halt on failure)

1. **Build**: `npm run build` / `pnpm build` / `./gradlew build` — on failure, report error and **halt**
2. **Types**: `npx tsc --noEmit` / `./gradlew compileKotlin` — on failure, **halt**
3. **Lint**: `npm run lint` / `npx biome check .` / `./gradlew detekt` — report warnings, on error **halt**
4. **Tests**: `npm test` / `./gradlew test` — on failure, report failure list and **halt**
5. **Console.log residuals**: Grep across `*.ts/*.tsx/*.js` — warn if found
6. **Git status**: `git status` + `git diff --stat` — report commit-readiness status

### Result Format

```
VERIFICATION: [PASS/FAIL]
Build/Types/Lint/Tests/Console/Git: [OK/FAIL/WARN/SKIP]
```

### Project Detection

- Auto-detect build/lint/test from `package.json` scripts
- Switch to Gradle if `build.gradle.kts` exists
- If detection fails, ask the user for the commands

### Red Flag Language Detection

**MUST NOT declare completion without evidence**: "Should work now", "probably", "seems to", "I think this fixes", "I'm confident", "Great!", "Perfect!", "Done!"

- On detection → **MUST present** verification evidence (test results, build logs, exit codes)
- Rationalization rejection: "Just this once", "Linter passed" (linting != compilation), "Agent said success" (independent verification required)

**Gate Function**: IDENTIFY (determine proof command) → RUN (execute) → READ (check result) → VERIFY (confirm expected match) → THEN (declare completion)

See [red-flag.md](references/red-flag.md) for the full pattern list and rebuttal table.

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "Linter passed, so the build is fine" | Linting checks style/patterns, not compilation — a file can lint clean and fail to build |
| "I only changed one line, no need to run the full suite" | One-line changes cause regressions — the verification loop exists precisely for small changes |
| "Tests are slow, I'll run them after the commit" | Post-commit test failure means a broken commit in history — run before, not after |
| "The type checker is too strict, this `any` is fine for now" | Type failures are real errors masked by `any` — fix the type, don't skip the stage |
| "Console.logs are just for debugging, I'll remove them later" | "Later" is never — stage 5 catches them now so they don't ship to production |

## Red Flags

- Completion declared with words like "should", "probably", "I think" without accompanying tool output
- Verification stages executed out of order (e.g., tests run before build)
- A stage marked SKIP without a documented reason
- Build output not read after execution (command run but result ignored)
- Exit code not checked — only partial output scanned for "success" keywords
- Agent declares "Done!" immediately after a code change with no verification commands in between
- Console.log warnings dismissed without removal
- Git diff shows uncommitted changes not addressed in the verification report

## Verification

- [ ] **Sequential execution**: All 6 stages ran in order — no stage skipped without documented reason
- [ ] **Exit code evidence**: Each stage's exit code (0 or non-zero) is explicitly reported
- [ ] **Failure halt**: If any stage failed, subsequent stages were not executed
- [ ] **Result format**: Final output matches the `VERIFICATION: [PASS/FAIL]` template with per-stage status
- [ ] **No red-flag language**: Completion declaration is accompanied by tool output evidence, not speculative language
