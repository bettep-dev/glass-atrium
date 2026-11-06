# Red Flag Language Detection Details

## Common Failure Patterns

| Claim | Required Evidence | Insufficient |
|-------|-------------------|--------------|
| Tests pass | Output: 0 failures | Previous run, "should pass" |
| Linter clean | Output: 0 errors | Partial check |
| Build success | Exit code: 0 | Linter pass alone |
| Bug fixed | Original symptom test passes | Code change only |
| No regression | Red-green cycle | Single pass run |

## Gate Function Details

1. **IDENTIFY**: Determine the command to prove the claim (which test? which build?)
2. **RUN**: Execute the full command in a fresh run this session
3. **READ**: Review entire output, check exit code, count failures
4. **VERIFY**: Confirm output matches the claim
5. **THEN**: Declare completion with evidence

No step may be skipped.
