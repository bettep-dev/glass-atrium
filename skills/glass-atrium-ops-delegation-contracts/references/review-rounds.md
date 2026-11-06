# Review rounds and reviewer prompts

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Review rounds and reviewer prompts`.

## Non-convergence routing

| Condition | Action |
|---|---|
| a lens or review round returns no measurements | mark it "not exercised" and report it as a coverage gap; it never counts toward convergence |
| a control cannot be tested adversarially, or keeps producing new bypass classes | take it to the user as a direction question before re-specifying it |
| a revision loop that `##### Stage gates` caps, the Stage-2 revision included, does not converge | follow the cap and escalation route it sets for that loop |
| any other review loop does not converge | take it to the user — no round cap |

- `##### Stage gates`: `skills/glass-atrium-ops-orchestrator.md`.
- Why no round cap: a cap turns non-convergence into a stop the user never sees.

## What a reviewer prompt carries

- No severity bar, finding cap or convergence note.
  - Why: a reviewer follows such text literally and reports less than the rule set finds.
- From earlier rounds, only the list of settled items, each with its settlement record.
