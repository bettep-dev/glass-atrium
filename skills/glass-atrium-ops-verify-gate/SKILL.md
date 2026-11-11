---
name: glass-atrium-ops-verify-gate
description: Pre-commit 6-stage sequential verification covering build, types, lint, tests, console cleanup, and git audit. Invoke with /verify.
---

## Overview

Sequentially verifies code quality in 6 stages before committing, enforcing evidence-based completion claims.

- No stage is skipped without a documented reason.
- A failed check at any stage halts the pipeline.
  - So does a stage that still cannot run after its retry: `### Verification Order (halt on failure)`.

## When to Use

- Right before a commit, before creating a PR, after completing a feature implementation
- When any agent claims a task is "done" or "fixed"
- After refactoring to confirm no behavioral changes
- **Exclusions**: Documentation-only changes, configuration file edits with no code impact, memory/ file updates

## Core Process

### Stage 0: Pre-Define Success Criteria (Karpathy Goal-Driven)

Before entering code changes, agents MUST emit a measurable `Success Criteria:` block (≥1 item · noun-phrase form):

```
Success Criteria:
- <noun-phrase outcome> — measured by: <command | metric | observation>
```

- Each criterion MUST specify how it will be verified (command output / test name / metric threshold / artifact diff)
- Missing emission before any Write/Edit operation in scope → halt + redesign
- **Loop termination cap**: same-stage 2 consecutive fail → immediate escalate to glass-atrium-qa-debugger · Outcome Record emit: `result: fail`
  - Escalation per `skills/glass-atrium-ops-orchestrator-role.md` → `### Failure Recovery Loop`; bound per `rules/glass-atrium/core-security.md` → Unbounded consumption.
- Rationale: pre-stated success criteria are the mechanical anchor Stages 1-6 verify against
- **Exclusions inheritance**: Stage 0 inherits the `## When to Use` Exclusions — it targets code-change correctness, not documentation precision

### Verification Order (halt on failure)

1. **Build**: `npm run build` / `pnpm build` / `./gradlew build` — on failure, report error and **halt**
2. **Types**: `npx tsc --noEmit` / `./gradlew compileKotlin` — on failure, **halt**
3. **Lint**: `npm run lint` / `npx biome check .` / `./gradlew detekt` — report warnings, on error **halt**
4. **Tests**: `npm test` / `./gradlew test` — on failure, report failure list and **halt**
5. **Console.log residuals**: Grep across `*.ts/*.tsx/*.js` — warn if found
6. **Git status**: `git status` + `git diff --stat` — report commit-readiness status

- A stage that could not run — a missing command, a timeout, a locked file — is an ordinary obstacle, not a failed check: diagnose it and run the stage again (`agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Obstacles and Blockers [ALL]`).
  - The retry is bounded: each attempt that ends without the stage running counts as a fail toward the Stage 0 **Loop termination cap**.
    - A stage that still cannot run when the cap is reached halts the pipeline: report it as FAIL with its cause, never as SKIP or OK.
  - A stage a deliberate blocker stops is not retried: it halts the pipeline, reported as FAIL with its cause.
    - Outcome Record emit: `result: blocked`, never `fail` — FAIL here is the `### Result Format` stage status only.
      - Why: the orchestrator reports a `blocked` deliberate blocker to the user, while a `fail` enters Retry and Fallback, which route around the control.

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

- **MUST NOT declare completion without evidence**: "Should work now", "probably", "seems to", "I think this fixes", "I'm confident", "Great!", "Perfect!", "Done!"
  - On detection → **MUST present** verification evidence (test results, build logs, exit codes)
  - Rationalization rejection: "Just this once", "Agent said success" (independent verification required)
- **Gate Function**: IDENTIFY (determine proof command) → RUN (execute) → READ (check result) → VERIFY (confirm expected match) → THEN (declare completion)

See [red-flag.md](references/red-flag.md) for the evidence each claim requires and the gate function's step detail.

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "Linter passed, so the build is fine" | Linting checks style/patterns, not compilation — a file can lint clean and fail to build |
| "I only changed one line, no need to run the full suite" | One-line changes cause regressions — the verification loop exists precisely for small changes |
| "Tests are slow, I'll run them after the commit" | Post-commit test failure means a broken commit in history — run before, not after |
| "The type checker is too strict, this `any` is fine for now" | Type failures are real errors masked by `any` — fix the type, don't skip the stage |
| "Console.logs are just for debugging, I'll remove them later" | "Later" is never — stage 5 catches them now so they don't ship to production |

## Red Flags

- A stage marked SKIP without a documented reason
- A stage that could not run reported as SKIP or OK
- Build output not read after execution (command run but result ignored)
- Exit code not checked — only partial output scanned for "success" keywords
- Console.log warnings dismissed without removal
- Git diff shows uncommitted changes not addressed in the verification report

## Verification

- [ ] **Sequential execution**: All 6 stages ran in order — no stage skipped without documented reason
- [ ] **Exit code evidence**: Each stage's exit code (0 or non-zero) is explicitly reported
- [ ] **Failure halt**: If any stage failed, or still could not run, subsequent stages were not executed
- [ ] **Result format**: Final output matches the `VERIFICATION: [PASS/FAIL]` template with per-stage status
- [ ] **No red-flag language**: Completion declaration is accompanied by tool output evidence, not speculative language
