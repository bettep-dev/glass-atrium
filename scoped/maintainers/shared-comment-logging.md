# Maintainer note — `scoped/shared-comment-logging.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent; the rule file itself carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

DEV + QA agents, plus glass-atrium-meta-prompt-engineer under the "prompts = code" Tier-3 inheritance. The authoritative membership lives on the registry row (`agent-registry.json` → each agent's `rules.shared`) and in the compliance matrix; the rule file states it nowhere.

## Compressed core — edit rules

- **Delivery**: the whole rule file reaches every member through the part slots, selected by each agent's `agent-registry.json` → `rules.shared`. `hooks/inject-scope-rules.sh` extracts nothing from it, and the file carries no `AGENT-INJECT` marker.
- **The core is folded**: `## Agent Injection Core` holds only the two rules that bind every comment, whatever its kind — the essence / no-history rule and `Mirror = code form only`. Every other rule lives once, in its own section.
  - Do not re-add a summary of the other sections to the core: a member would read each rule twice within one part.
- **Keep the heading `## Agent Injection Core`**: it matches the `scoped/shared-naming.md` heading of the same role, and no rename is owed.
- **Keep exactly one line carrying `**Comment-rule core`**:
  - `hooks/test/inject-scope-single-delivery.bats` → `RETIRED_BLOCKS` names that anchor, and `get_needle` matches it as a substring (`grep -F`), never at line start.
  - The whole matching line becomes the needle, asserted once per member and zero times otherwise.
  - `hooks/test/inject-scope-rules-nodrop.bats` → `RETIRED_NEEDLES` asserts the phrase `Comment-rule core` absent from slot 1; the check proves nothing once the phrase is gone from the source.
- **Precondition the retirement rests on**: `python3 hooks/lib/inject_chunk.py --audit` MUST report `events=none` for every member. An OVERFLOW displaces a member band, and no slot-1 copy remains behind it.

## Where each folded core rule lives

| Rule | Single site |
|---|---|
| density gate | `## Comment Principles` → **Density gate (ceiling, not floor)** |
| stale comments | `## Comment Principles` → **Stale comments** |
| one essence line · docblock on overflow · idiomatic block where `/** */` is absent · no stacked `//` (wrap rule) | `## Inline Comments` → **One-line sufficiency gate (form, not whether)** |
| `//`-form demotion: a one-line-sufficient internal note stays `//` | `## Inline Comments` → **One-line sufficiency gate (form, not whether)** |
| TODO owner + ticket | `## Inline Comments` → **TODO** |
| comment language | `## Comment Language & Style` → **Language precedence** |
| JSDoc semantics, never types | `## Public API Comments (Block)` → **Params & returns** |
| header limit | `## File / Module Header Comments` |
| commented-out dead code | `## Comments That MUST NOT Be Written` |
| `console.*` ban, test files exempt | `## Log Message Composition` → **Logger** |
| log levels, error-log elements | `## Log Level Criteria` · `## Log Message Composition` |

## Removed as redundant — do not re-add

- The sensitive-data logging pointer under `## Prohibitions`: Tier 1 carries the rule to every member.
  - Tier-1 site: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Absolute Rules [ALL]` → "sensitive info in logs MUST be masked".
  - Code-authoring backing: `rules/glass-atrium/core-security.md` → `## OWASP Top 10` → Logging Failures (A09).
- The identifiers-keep-their-form sentence under `## Comment Language & Style`: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language` → **Names and identifiers** reaches every member.
- The header's author / date / bug-ID / change-history item: the core's history rule binds every comment, the header included.
- The over-narration entry and the positive-form line under `## Comments That MUST NOT Be Written`: the density gate and the core lead state them.
- "Comments restating code" under `## Comments That MUST NOT Be Written`: the core lead's "never … a paraphrase of the code" states it.
- The `// SECURITY:` prefix bullet under `## Inline Comments`: `rules/glass-atrium/core-security.md` → `## OWASP Top 10` → "annotate with `// SECURITY:` comment" reaches every member as Tier 1.
- The `**Essence over sprawl**` bullet under `## Comment Principles`: the one-line rule lives in `## Inline Comments` → **One-line sufficiency gate (form, not whether)**, and its BAD/GOOD example moved there.
- The `**JSDoc lines**` bullet under `## Comment Language & Style`: folded into **Form** as its scope ("docblock lines included").

## Pair classifications

- `Mirror = code form only` ↔ `scoped/shared-search-first.md` → **Step 3 — Mirror** (comment sub-bullet): canonical + mirror.
  - Search-first reaches DEV and META but not QA, so both stay.
  - The mirror names this file as canonical.
  - Both name the same code-form axes, layout included; report any later drift.

## Platform-Specific Rules — kept, with the reason

Each branch names its own platform, so the condition travels with the duty; only two of the three were confirmed to be restated in the body of the agent they bind, which is not enough to call the section redundant.
