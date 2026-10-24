# Review rounds and reviewer prompts

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `### Quality Gates [ORCHESTRATOR]` → `#### Review rounds and reviewer prompts` — which rounds this binds.

## Non-convergence routing

| Condition | Action |
|---|---|
| a lens or review round returns no measurements | mark it "not exercised" and report it as a coverage gap; it never counts toward convergence or as a dry round |
| a control cannot be tested adversarially, or keeps producing new bypass classes | take it to the user as a direction question before re-specifying it again |
| a revision loop that `##### Stage gates` caps, the Stage-2 revision included, does not converge | follow the cap and escalation route `##### Stage gates` sets for that loop |
| any other review loop does not converge | take it to the user — no round cap |

- `##### Stage gates`: `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria [ORCHESTRATOR]` → `##### Stage gates`.
- Why the user and no round cap on every other loop: a cap turns non-convergence into a stop the user never sees.

## What a reviewer prompt carries

- A reviewer prompt carries no severity bar, finding cap or convergence note.
  - Why: a reviewer follows such text literally and reports less than the rule set finds.
- A reviewer prompt's only carry-over from earlier rounds is the list of settled items, each with its settlement record.
