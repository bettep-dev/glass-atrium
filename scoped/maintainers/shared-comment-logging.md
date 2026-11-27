# Maintainer note — `scoped/shared-comment-logging.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- The member set → `rules/glass-atrium/core-compliance-matrix.md` → `### Tier 3 — Cross-cutting (conditional inheritance)` → the `scoped/shared-comment-logging.md` row; declared on each `agent-registry.json` row (`rules.shared`).

## Compressed core — edit rules

- **Delivery**: the whole rule file reaches every member through the part slots; it carries no `AGENT-INJECT` marker (`rules/glass-atrium/core-compliance-matrix.md` → **Slot 1 MUST carry no scope-file text**).
  - Precondition: `rules/glass-atrium/core-compliance-matrix.md` → **Overflow audit** passing for every member of the rule file.
- **The core is folded**: `## Agent Injection Core` holds only the two rules that bind every comment, whatever its kind — the essence / no-history rule and `Mirror = code form only`.
  - Every other rule lives once, in its own section.
  - Do not re-add a summary of the other sections to the core: a member would read each rule twice.
- **Keep the heading `## Agent Injection Core`**: it matches the `scoped/shared-naming.md` heading of the same role.
- **Keep exactly one line carrying `**Comment-rule core`**:
  - `hooks/test/inject-scope-single-delivery.bats` → `RETIRED_BLOCKS` names that anchor, and `get_needle` matches it as a substring (`grep -F`), never at line start.
  - The whole matching line becomes the needle, asserted once per member and zero times otherwise.
  - `hooks/test/inject-scope-rules-nodrop.bats` → `RETIRED_NEEDLES` asserts the phrase `Comment-rule core` absent from slot 1; the check proves nothing once the phrase is gone from the source.
- **Keep the Reach line** under **Single Source of Truth**: the rest of the rule file governs comments and logs only, so without it a reviewer reads README prose as out of scope.

## Removed as redundant — do not re-add

- A sensitive-data logging pointer under `## Prohibitions`: Tier 1 carries the rule to every member.
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Absolute Rules [ALL]` → "sensitive info in logs MUST be masked".
  - Code authoring: `rules/glass-atrium/core-security.md` → `## OWASP Top 10` → Logging Failures (A09).
- An identifiers-keep-their-form sentence under `## Comment Language & Style`: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language` → **Names and identifiers** reaches every member.
- A `// SECURITY:` prefix bullet under `## Inline Comments`: `rules/glass-atrium/core-security.md` → `## OWASP Top 10` → "annotate with `// SECURITY:` comment" reaches every member as Tier 1.
- A header author / date / bug-ID / change-history item: the core's history rule binds every comment, the header included.
- Under `## Comments That MUST NOT Be Written`, an over-narration entry, a positive-form line or "comments restating code": the density gate and the core lead state them.

## Pair classifications

- `Mirror = code form only` ↔ `scoped/shared-search-first.md` → **Step 3 — Mirror** (comment sub-bullet): canonical (the rule file) + mirror.
  - Search-first reaches DEV and META but not QA, so both stay.
  - Both name the same code-form axes, layout included; report any later drift.

## Platform-Specific Rules — kept, with the reason

- Each branch names its own platform, so the condition travels with the duty.
- Not redundant: no `agents/glass-atrium-dev-*.md` body carries `LoggingInterceptor`, `assumenosideeffects`, `DebugTree` or `no-console`.
