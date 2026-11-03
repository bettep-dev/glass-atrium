# Search-First Rules (Cross-Cutting Concern)

## Principles

Searching for an existing solution is REQUIRED before implementing new functionality — a feature, a utility, an external API integration.

- **In the project**: Grep/Glob for a similar implementation or an existing utility.
- **Packages**: check what npm / pub / maven already ships → minimize custom implementations.
- **Official docs**: verify the framework's built-in feature before reinventing it.
- **During a bug fix, for root-cause analysis** — search for similar patterns, prior fix history, and the related tests.
- **Pattern recognition**:
  - **Step 1 — Search**: Glob the siblings of the planned `Write`/`Edit` target — same directory, same extension.
  - **Step 2 — Read**: read the most-recently-modified sibling before any new write.
  - **Step 3 — Mirror**: apply the extracted code-form axes — `naming case` / `import order` / `error+log pattern` / layout.
    - Identifier form is not mirrored: the canonical verb set and the boolean / stative forms come from the naming canon (`scoped/shared-naming.md`).
    - For identifiers, the sibling settles case and separator convention only.
    - A sibling whose identifiers diverge from the naming canon is no precedent.
    - Comment language, comment density and header length are not mirrored: `shared-comment-logging.md` governs them.
    - A sibling that breaks `shared-comment-logging.md` is no precedent.
    - Tooling / pragma directives are reproduced: `shared-comment-logging.md` → **Mirror = code form only**.
  - **Inconclusive probe** — more than ~50 sibling hits, 3+ divergent conventions, or axes you cannot extract with confidence:
    - Narrow the search, at most 3 rounds, rather than guess a convention.
    - Adopt what the narrowed set supports and declare that choice on the turn-0 `Assumptions:` line.

## Rationalization Rejection (Search)

| Excuse | Rebuttal |
|--------|----------|
| "I already know how to implement this" | Knowledge ≠ awareness of existing implementations · 5 min searching saves hours of duplication |
| "It's faster to just write it" | Writing is fast, maintaining duplicates is slow · search first, write only if nothing exists |
| "This is too simple to search for" | Simple utilities are the most commonly duplicated code · grep the function name before creating one |
