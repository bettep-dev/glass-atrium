# `[SCOPE]` parser behaviour

- **Grammar SoT**: `skills/glass-atrium-ops-orchestrator-role.md` → `### Context Handoff Size` → `[SCOPE]`.
- **Declaration line**: a line the bare token opens — optional indentation and one list marker, then `[SCOPE]`, whitespace, and a `files=` value that is neither empty nor a `<placeholder>`.
  - The value may sit in backticks or `**`.
- **Parser behaviour**: which text each reader selects from, the shapes that fail open and the field-parse internals live in the comments above `hooks/lib/scope-match.sh` → `_SCOPE_DECL_OPEN`, `scope_decl_select`, `scope_decl_from_record0` and `scope_decl_files`.

## Author rules — detail

- Several declarations are never merged.
- A relay opening its own line in the bare form is selected over a later real line → write the real declaration first.
- **Space-in-path limit**: no form can express a path containing a space.

## Worked completeness case

- The grammar SoT's `files=` completeness duty: a change to a recorder-side token of the closed `review_flag` reason vocabulary moves these together, so all belong in `files=`:
  - `hooks/lib/review-flag-reasons.sh` · `hooks/track-outcome.sh` · `monitor/public/src/ui.jsx` · `monitor/test/ui.review-flag-reasons.unit.test.ts` · `hooks/test/track-outcome-flag-reasons.bats`.
