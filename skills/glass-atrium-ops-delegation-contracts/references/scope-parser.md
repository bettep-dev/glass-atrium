# `[SCOPE]` parser behaviour

How the readers select a `[SCOPE]` declaration line and parse its `files=` list.

- **Grammar SoT**: `rules/glass-atrium/orchestrator-role.md` → `### Context Handoff Size` → `[SCOPE]` — the grammar line, its placement, completeness and honest-backing duties, and the author rules: write the ` · ` separators, first wins, relaying or quoting a declaration, the space-in-path limit.

- **Parser behaviour**: every reader (the drift advisory, the recorder, the verification gate) selects the line through `hooks/lib/scope-match.sh` → `scope_decl_select`, then reads its list through `scope_decl_files`.
  - **Transcript record**: the drift advisory and the recorder read only record 0 of the subagent transcript — the parent-authored delegation prompt.
  - **Declaration line**: a line the token OPENS — optional indentation and one list marker, then the token, whitespace, and a `files=` value that is neither empty nor a `<placeholder>`. The token anywhere else on a line declares nothing.
  - **Wrapped token** (`` `[SCOPE]` `` / `**[SCOPE]**`): selected only when its value list ends at end of line, or at whitespace before `·`, `|` or a grammar key, and no value ends in `.` `:` `;` `)`.
  - **Whole-line wrap** (a backtick or `**` opened before the token): selected only when it closes at end of line or never.
  - **Shapes that fail open** (no declaration → comparison skipped, never a false excess):
    - the token mid-line or behind a label · a block-quoted line · a space after `files=` · a field order not opening with `files=`;
    - a wrapped token whose value runs into prose past a space, or ends in `.` `:` `;` `)`;
    - a wrap closing mid-line · a whole-line wrap whose value holds its own wrap character;
    - recorder only: a declaration line past its 2000-char transport, dropped whole.
  - **Field parse**: the `files=` field ends at the next `·`, `|`, or end of line; backticks and `**` are stripped; entries split on commas AND whitespace.
    - A token keyed `files=` / `deliverable=` / `out=` (any case) marks a swallowed sibling field and is dropped; any other `=`-bearing token stays a path (`docs/a=b.md`).
    - Any other token carrying `<` or `>` refuses the whole list — an uninstantiated `<placeholder>`.
    - After a dropped key token, a token carrying neither `/` nor `.` is prose from that field and is dropped.
- Two tolerances follow, and **neither tolerance is the contract** (separators rule: **Grammar SoT** above):
  - A space-separated line still yields the right file list.
  - A literally-copied template degrades to NO signal (comparison skipped) rather than a false excess.

## Relay shapes still selected

- **Relay duty**: the grammar SoT's relaying rule.
- Wrapping is no safe relay: a wrapped-token relay whose tail reads as field text — `· deliverable=fix — too narrow`, one word glued by `·` `=` `—`, a value ending in `!` `?` `…` — is still selected, as is a line wrap closing at end of line or never with prose inside.
  - Wrapped-token and line-wrap selection: **Wrapped token** · **Whole-line wrap** above.

## Worked completeness case

- **Duty**: the grammar SoT's `files=` completeness duty.
- Worked case: a change to the closed `review_flag` reason vocabulary forces four files to move together — so all four belong in `files=`:
  - `hooks/lib/review-flag-reasons.sh` · `monitor/public/src/ui.jsx` · `monitor/test/ui.review-flag-reasons.unit.test.ts` · `hooks/test/track-outcome-flag-reasons.bats`.
