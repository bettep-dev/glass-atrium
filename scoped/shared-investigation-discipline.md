# Investigation Discipline Rules (Cross-Cutting Concern)

Binds any bug fix, error resolution or unexpected-behaviour investigation, and every code change intended to fix a defect — including a bug discovered mid-refactor. New feature development, a refactor that fixes no defect, and typo or formatting fixes are out of scope.

This is a PROCESS rule: `[default, adjustable]` only through a documented escalation path. It is not one of the three `[hardcoded]` safety laws — Prompt Injection Refusal, Excessive Agency Refusal, Unbounded Consumption Stop — which no operator or user instruction can override and which stay in `skills/glass-atrium-core-iron-laws/SKILL.md`. Confusing the two layers is the most common source of incident.

## Investigation Discipline [DEV+QA]

Mandatory bug fix sequence: **Confirm symptoms → Formulate cause hypothesis → Verify via code tracing + automated tests → Begin fix**.

- Confirm symptoms — error message, reproduction steps, impact scope
- Formulate cause hypothesis — specific, testable explanation of why the bug occurs
- Verify via code tracing + automated tests — manual confirmation alone is insufficient
- Begin fix — only after the prior three steps are complete

- "Just try fixing it" / hypothesis-free fixes are forbidden
- 1st failure → reformulate hypothesis + retry
- 2nd failure → STOP and hand the bug to glass-atrium-qa-debugger. Stopping is your duty; routing the escalation, and rejecting a debugger conclusion that carries no logs, reproduction or code reference, is the orchestrator's — that half stays in `skills/glass-atrium-core-iron-laws/SKILL.md` → `### Debugger Escalation [ORCHESTRATOR]`.

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "It's an obvious fix, no investigation needed" | Obvious fixes have the highest regression rate — confirm with a test first |
| "I'll investigate after I try this quick change" | Fixing before understanding = guessing. The fix may mask the real cause |
| "The stack trace points directly to the line" | Stack traces show where it crashed, not why — trace the data flow to the root cause |
| "I've seen this exact bug before" | Prior experience is a hypothesis, not a diagnosis — verify it applies to this instance |
| "Manual testing confirms it works now" | Manual confirmation alone is insufficient — automated test required per the verify step |

## Red Flags

- Code change committed with a message like "try fix" or "attempt to resolve" without a stated hypothesis
- Fix applied without a corresponding test that reproduces the original failure
- Multiple sequential fix attempts on the same bug without reformulating the hypothesis
- Bug marked as resolved but the original error can still be triggered
- Fix addresses a symptom (e.g., suppressing an error) rather than the root cause

## Verification

- [ ] **Hypothesis documented**: Bug fix PR/commit references a specific cause hypothesis (not just "fixed X")
- [ ] **Reproduction test exists**: A test that fails before the fix and passes after exists in the test suite
- [ ] **Root cause addressed**: Fix targets the cause, not the symptom — the same class of bug cannot recur
