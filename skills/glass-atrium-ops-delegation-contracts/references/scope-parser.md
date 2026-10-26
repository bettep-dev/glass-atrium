# `[SCOPE]` parser behaviour

The shape of a `[SCOPE]` declaration line, its `files=` separators, the author-rule detail and a worked `files=` completeness case; how each reader selects and parses the line lives in the code comments **Parser behaviour** names.

- **Grammar SoT**: `rules/glass-atrium/orchestrator-role.md` → `### Context Handoff Size` → `[SCOPE]` — the grammar line and its placement, completeness and honest-backing duties.
  - The same site's **Author rules** lines: the ` · ` separators, first wins with relaying.
  - The space-in-path limit is stated in this file only.

- **Declaration line**: a line the bare token opens — optional indentation and one list marker, then `[SCOPE]`, whitespace, and a `files=` value that is neither empty nor a `<placeholder>`. The value may sit in backticks or `**`.
  - Separators: the `files=` field ends at the next `·`, `|`, or end of line; its entries split on commas and on whitespace.
- **Parser behaviour**: which text each reader selects from, the shapes that fail open and the field-parse internals live once in the comments above `hooks/lib/scope-match.sh` → `_SCOPE_DECL_OPEN`, `scope_decl_select`, `scope_decl_from_record0` and `scope_decl_files`.

## Author rules — detail

- First wins, the block-quote or mid-line relay, and the absent-line fail-open: the grammar SoT's **Author rules** and honest-backing lines. This section adds only:
  - Several declarations are never merged.
  - A relay neither block-quoted nor kept mid-line → write the real declaration first.
    - Why: a relay opening its own line in the bare form is selected and wins over a later real line.
  - **Space-in-path limit**: no form can express a path containing a space.
  - On an absent line the comparison is skipped, never blocked.

## Worked completeness case

- **Duty**: the grammar SoT's `files=` completeness duty.
- Worked case: a change to the closed `review_flag` reason vocabulary forces four files to move together — so all four belong in `files=`:
  - `hooks/lib/review-flag-reasons.sh` · `monitor/public/src/ui.jsx` · `monitor/test/ui.review-flag-reasons.unit.test.ts` · `hooks/test/track-outcome-flag-reasons.bats`.
