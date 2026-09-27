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
