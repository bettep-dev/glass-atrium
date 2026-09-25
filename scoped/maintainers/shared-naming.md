# Maintainer note — `scoped/shared-naming.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: two rule-file headings are externally cited — `## Agent Injection Core` and `## Core rules outside the delta-core` — so both are load-bearing and carry no companion pointer beside them. Every cited heading and bold lead, with its citers, is listed in `## Readers and coupled tests`.

## Membership

- DEV unconditionally, all 13, plus `glass-atrium-qa-code-reviewer` as the enforcement surface. `glass-atrium-qa-debugger` is excluded: read-only by its Guardrails, it authors no identifier.
- Declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`.
- The Compliance Matrix QA cell is a plain `✓` with NO footnote marker. The design called for a fifth marker glyph (`‖`) for the qa-code-reviewer-only subset; the Tier-3 row states that subset by naming the single agent outright, which is more precise than a marker and costs no edit to `readonly FOOTNOTE_MARKERS` in `hooks/validate-compliance-matrix.sh`. An unlisted glyph would not fail check B2 — it would go unchecked, which is worse than a false failure. If a later file needs a genuine multi-agent QA subset, introduce `‖` there, add it to that constant in the same edit, and this row may adopt it.

## The delta-core — edit rules

- **Delivery**: the whole rule file reaches every member through the part slots, selected by each agent's `agent-registry.json` → `rules.shared` (the `## Membership` set above, glass-atrium-dev-swift included). `hooks/inject-scope-rules.sh` extracts nothing from it, and the file carries no `AGENT-INJECT` marker or byte-budget comment.
- **No byte freeze applies**: the delta-core is ordinary content. Its closing line still lists boolean stative-first among the full skill's contents while `## Core rules outside the delta-core` states it as a rule; reconciling the two belongs to the fold in the next bullet.
- **Folding the delta-core and the three outside rules into one canonical list is open work**: it needs a per-bullet audit, since the delta-core is the file's canonical statement of the rules it lists.
- **Keep the delta-core's bold lead phrase** (the words before its em dash): `hooks/test/inject-scope-rules-nodrop.bats` → `RETIRED_NEEDLES` asserts it ABSENT from slot 1, and the check proves nothing once the phrase no longer exists in the source.
- **Precondition the retirement rests on**: `python3 hooks/lib/inject_chunk.py --audit` MUST report `events=none` for every member. An OVERFLOW displaces a member band, and no slot-1 copy remains behind it.
  - Re-run the audit after any growth of this file and compare each member's `chunks=` with the header's `slots=`. A chunk past the last slot → split `## Agent Injection Core` at H3 or add a slot.

## Readers and coupled tests

- `hooks/lib/inject_chunk.py` reads the file by registry membership and packs it at heading boundaries.
- `hooks/test/inject-scope-rules.bats` → the retired naming case plants a synthetic `AGENT-INJECT:NAMING` pair at the old default path and asserts slot 1 never extracts it; it never reads this file.
- `skills/glass-atrium-dev-naming/SKILL.md` keeps the on-demand detail. It, `references/VARIABLES-BOOLEANS.md`, `references/ANTI-PATTERNS.md` and the reviewer (`agents/glass-atrium-qa-code-reviewer.md` → `### Naming Checks` and both `### Naming Edge Cases` tables) cite the rule file by heading and bold lead. Each literal below is load-bearing — rename one and fix its citers in the same pass:
  - `## Agent Injection Core` — `SKILL.md` · `references/ANTI-PATTERNS.md`
  - `## Core rules outside the delta-core` — `SKILL.md` · `references/VARIABLES-BOOLEANS.md` · `references/ANTI-PATTERNS.md`
  - **Canonical verb set (PRIMARY)** — `SKILL.md` · `references/ANTI-PATTERNS.md` · the reviewer
  - **One verb per purpose per layer** — `SKILL.md` · `references/ANTI-PATTERNS.md`
  - **Identifier-kind binary** — `SKILL.md` · `references/VARIABLES-BOOLEANS.md` · the reviewer
  - **No-stutter** — `references/ANTI-PATTERNS.md` · the reviewer
  - **Reduction-floor guardrail** (the bold lead's opening words) — `SKILL.md` · the reviewer
  - **Read-down naming** · **Prefix-family grouping** — the reviewer
- The delta-core carries each rule, one Bad → Good pair and the exclusions a DEV agent needs to write a compliant name. Every other edge-case verdict lives once in the reviewer's two `### Naming Edge Cases` tables.
  - The rule file's `## On-demand detail` points to the **Naming edge cases** bullet in `### Naming Checks`, which names both tables. Rename that lead or any of the three headings and fix the pointers in the same pass.
- The delta-core's flat-only clause under **Prefix-family grouping** and the reviewer's flat-only rows must give one verdict on a relational column, mapped ORM field or other flat-only name. Change either and re-read the other in the same pass; `agents/glass-atrium-dev-db.md` → **Schema** (FK `{table}_id`, OLAP denormalization) is the DEV rule they must not contradict.
- Outbound: the reviewer's `### Naming Edge Cases — Scope and Kind` cites `skills/glass-atrium-dev-naming/SKILL.md` → **Family alignment**. Rename that skill bold lead and fix the reviewer in the same pass.
- Outbound: the reviewer's `### Naming Edge Cases — Family Shapes` log-or-error-text row cites `skills/glass-atrium-dev-naming/references/ANTI-PATTERNS.md` → **Cross-boundary names keep their qualifier**; its in-code row applies **Reduction-floor guardrail** alone.
  - Keep the split at the log/error boundary, and fix the reviewer in the same pass as any rename of that skill bold lead.
- Outbound: the rule file's scope lines and the reviewer's `### Naming Edge Cases — Scope and Kind` cite `scoped/shared-testing.md` → `### Names, comments and test data`. Rename that heading and fix both in the same pass.

## Manifest-regeneration preconditions

Requirements for the wave that regenerates `manifest.json`. None is satisfied at this commit, and each is stated as a requirement rather than a state.

- **The manifest must ship this rule file and the part-slot wrappers (`hooks/inject-scope-part-*.sh`, `hooks/lib/inject-chunk.sh`, `hooks/lib/inject_chunk.py`) in the SAME deploy that carries the retired `hooks/inject-scope-rules.sh`, or earlier.** Slot 1 no longer carries the delta-core, so a deploy that lands the injector while the wrapper binding rows are declined leaves every member with no naming rule at all.
- **The regeneration must run AFTER the agent-body mode fix, and its output is committed with the rest of the change set.** `scripts/generate-manifest.sh` takes its file list from `git ls-files`, so the eight new files must be tracked before it runs. It records the raw `stat` mode with no normalisation and both install paths chmod landed files to the recorded mode, so a file left at a demoted mode is regenerated at that mode and then applied at it.
- **The regeneration is a PR-time gate, not only a deploy concern.** `test-install-macos` carries no path filter and no `if:`, and its `publish-release.sh build` step runs `verify_manifest` → `generate-manifest.sh --check`; no other check catches a stale manifest, which makes that job the first enforcement point for manifest freshness. `scripts/generate-manifest.sh --check` exits 1 DIVERGED at this worktree today. The branch also carries stale hashes from earlier waves, so the regeneration closes pre-existing drift as well as the eight additions.

## Open

- Whether a subagent can invoke the `glass-atrium-dev-naming` skill once its frontmatter no longer lists it is unsettled. Nothing read so far answers it, and neither the rule file nor this note asserts it either way.
- CLOSED by the wave's citation-repair pass: `scoped/shared-search-first.md` cited the naming canon as `glass-atrium-dev-naming` while the canonical verb set and the boolean form now live in this rule file. Its Step 3 — Mirror sub-bullet now cites `scoped/shared-naming.md`.
