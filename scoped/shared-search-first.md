# Search-First Rules (Cross-Cutting Concern)

## Principles

Searching for an existing solution is REQUIRED before implementing new functionality.

- **In the project**: Grep/Glob for a similar implementation or an existing utility before writing one.
- **Packages**: check what npm / pub / maven already ships → minimize custom implementations.
- **Official docs**: verify the framework's built-in feature before reinventing it.
- **Pattern recognition** (Search → Read → Mirror):
  - **Step 1 — Search**: Glob the siblings of the planned `Write`/`Edit` target — same directory, same extension.
  - **Step 2 — Read**: read the most-recently-modified sibling before any new write.
  - **Step 3 — Mirror**: apply the extracted CODE-FORM axes — `naming case` / `import order` / `error+log pattern` / layout.
    - Identifier FORM is not a mirrored axis. The canonical verb set and the boolean / stative forms come from the naming canon (`scoped/shared-naming.md`), and a sibling whose identifiers diverge from it is NOT a precedent — the sibling settles case and separator convention only.
    - Comment language, comment density and header length are not mirrored either: `shared-comment-logging.md` governs them, and a sibling's non-compliant comment block is never a precedent — author compliant comments instead.
    - Tooling / pragma directives ARE code-form and ARE reproduced (`// @ts-expect-error`, `/* eslint-disable */`, prettier-ignore, region / fold / codegen anchors).
  - **Inconclusive probe** — more than ~50 sibling hits, 3+ divergent conventions, or axes you cannot extract with confidence: do NOT guess a convention. Narrow the search (retrieve → evaluate → refine, at most 3 rounds), adopt what the narrowed set supports, and declare that choice on the turn-0 `Assumptions:` line.

## When to Apply

- Adding a feature, writing a utility, or integrating an external API.
- **During a bug fix, for root-cause analysis** — search for similar patterns, prior fix history, and the related tests.

## Rationalization Rejection (Search)

| Excuse | Rebuttal |
|--------|----------|
| "I already know how to implement this" | Knowledge ≠ awareness of existing implementations · project may already have a utility · 5 min searching saves hours of duplication |
| "It's faster to just write it" | Writing is fast, maintaining duplicates is slow · search first, write only if nothing exists |
| "This is too simple to search for" | Simple utilities are the most commonly duplicated code · grep the function name before creating one |
