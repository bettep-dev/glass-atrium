# Red Flag Language Detection Details

## Immediate Stop-Trigger Expressions

| Expression | Problem |
|------------|---------|
| "Should work now" | Speculation-based declaration |
| "probably" / "seems to" | Admitting uncertainty = unverified |
| "I think this fixes" | Thinking ≠ evidence |
| "I'm confident" | Confidence ≠ evidence |
| "Great!" / "Perfect!" / "Done!" | Satisfaction expressed before verification |

## Rationalization Rejection Table

| Excuse | Rebuttal |
|--------|----------|
| "Just this once" | No exceptions |
| "Linter passed" | Linting ≠ compilation ≠ testing |
| "Agent said success" | Agent report ≠ independent verification |
| "I'm tired" | Fatigue ≠ valid excuse |
| "It's a minor change" | Minor changes can still cause regressions |

## Common Failure Patterns

| Claim | Required Evidence | Insufficient |
|-------|-------------------|--------------|
| Tests pass | Output: 0 failures | Previous run, "should pass" |
| Linter clean | Output: 0 errors | Partial check |
| Build success | Exit code: 0 | Substituting linter pass alone |
| Bug fixed | Original symptom test passes | Code change only |
| No regression | Red-green cycle | Single pass run |

## Gate Function Details

1. **IDENTIFY**: Determine the command to prove the claim (which test? which build?)
2. **RUN**: Execute the full command (fresh run in this session required)
3. **READ**: Review entire output, check exit code, count failures
4. **VERIFY**: Confirm output matches the claim
5. **ONLY THEN**: Declare completion with evidence

No step may be skipped.
