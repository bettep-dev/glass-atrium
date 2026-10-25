# `[SCOPE]` parser behaviour

The shape of a `[SCOPE]` declaration line, its `files=` separators, and a worked `files=` completeness case; how each reader selects and parses the line lives in the code comments **Parser behaviour** names.

- **Grammar SoT**: `rules/glass-atrium/orchestrator-role.md` → `### Context Handoff Size` → `[SCOPE]` — the grammar line, its placement, completeness and honest-backing duties, and the author rules: write the ` · ` separators, first wins, relaying or quoting a declaration, the space-in-path limit.

- **Declaration line**: a line the bare token opens — optional indentation and one list marker, then `[SCOPE]`, whitespace, and a `files=` value that is neither empty nor a `<placeholder>`. The value may sit in backticks or `**`.
  - Separators: the `files=` field ends at the next `·`, `|`, or end of line; its entries split on commas and on whitespace.
- **Parser behaviour**: which text each reader selects from, the shapes that fail open and the field-parse internals live once in the comments above `hooks/lib/scope-match.sh` → `_SCOPE_DECL_OPEN`, `scope_decl_select`, `scope_decl_from_record0` and `scope_decl_files`.

## Worked completeness case

- **Duty**: the grammar SoT's `files=` completeness duty.
- Worked case: a change to the closed `review_flag` reason vocabulary forces four files to move together — so all four belong in `files=`:
  - `hooks/lib/review-flag-reasons.sh` · `monitor/public/src/ui.jsx` · `monitor/test/ui.review-flag-reasons.unit.test.ts` · `hooks/test/track-outcome-flag-reasons.bats`.
