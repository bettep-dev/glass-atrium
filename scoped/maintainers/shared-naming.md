# Maintainer note — `scoped/shared-naming.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: every externally cited rule-file heading is load-bearing and carries no companion pointer beside it; `## Readers and coupled tests` lists each cited heading and bold lead with its citers.

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
  - Re-run the audit after any growth of this file and before any merge, and read each member's `chunks=` against the header's `slots=` from that run.
  - A branch-side run sets `GA_CHUNK_RULES_ROOT` to the tree under test and runs that tree's `hooks/lib/inject_chunk.py`; unset, the audit reads the live install's corpus, and `slots=` comes from whichever core file runs.
  - A chunk past the last slot is an overflow, settled by the owner: split `## Agent Injection Core` at H3, a smaller text, or a new slot — never a silent slot add.
  - **Packing grain**: the chunker packs whole H2 sections greedily in file order and splits at H3 only past one part, so a large H2 that misses the current part strands the space before it.
    - The edge-case verdicts are therefore H2 sections of ~2 KB or less, and the small `## On-demand detail` stays last to fill the final part.

## Readers and coupled tests

- `hooks/lib/inject_chunk.py` reads the file by registry membership and packs it at heading boundaries.
- `hooks/test/inject-scope-rules.bats` → the retired naming case plants a synthetic `AGENT-INJECT:NAMING` pair at the old default path and asserts slot 1 never extracts it; it never reads this file.
- `skills/glass-atrium-dev-naming/SKILL.md` keeps the on-demand detail. It, `references/VARIABLES-BOOLEANS.md`, `references/ANTI-PATTERNS.md` and the reviewer (`agents/glass-atrium-qa-code-reviewer.md` → `### Naming Checks`) cite the rule file by heading and bold lead.
  - Each literal below is load-bearing — rename one and fix its citers in the same pass:
    - `## Agent Injection Core` — `SKILL.md` · `references/ANTI-PATTERNS.md`
    - `## Core rules outside the delta-core` — `SKILL.md` · `references/VARIABLES-BOOLEANS.md` · `references/ANTI-PATTERNS.md`
    - the `## Edge-case verdicts —` prefix shared by `identifier kinds` · `scopes and bindings` · `family shapes` · `sibling sets` · `reads and joins` — the reviewer's **Naming edge cases** bullet
    - **Canonical verb set (PRIMARY)** — `SKILL.md` · `references/ANTI-PATTERNS.md`
    - **One verb per purpose per layer** — `SKILL.md` · `references/ANTI-PATTERNS.md`
    - **Identifier-kind binary** — `SKILL.md` · `references/VARIABLES-BOOLEANS.md`
    - **No-stutter** — `references/ANTI-PATTERNS.md`
    - **Reduction-floor guardrail** (the bold lead's opening words) — `SKILL.md` · the reviewer
    - **Prefix-family grouping** — `references/VARIABLES-BOOLEANS.md` · the reviewer
    - **Qualifier-sibling grouping** — `references/ANTI-PATTERNS.md` · the reviewer
    - **Read-down naming** — the reviewer
  - Inside the rule file, the delta-core items and the edge-case sections cite one another by bold lead; a rename fixes those in-file citers in the same pass.
- **Identifier-kind binary**'s group-member sub-bullet and `references/VARIABLES-BOOLEANS.md` → `### Noun-only form (data identifiers)` and **Maps** must give one verdict on a group member (`request.pending`, `user.byId`). Change either and re-read the other in the same pass.
  - A member taken out of its group needs one verdict too, stated at each site below. Change one and re-read the others in the same pass:
    - the group-member sub-bullet's extraction sub-bullet · the rule file's `Member taken out of its group` and `Qualified read` rows
    - `SKILL.md` → "A group member reads with its group" · `references/VARIABLES-BOOLEANS.md` → **Group members read with their group**
    - the rule file's `## Edge-case verdicts — scopes and bindings` row on an existing `user` beside an added `userById`, and its note: the join covers only a `userById` not read out of `user`
- The delta-core carries each rule, one Bad → Good pair and the exclusions a DEV agent needs to write a compliant name.
- Every other verdict that shapes a name lives once in the edge-case sections, outside the delta-core, which DEV agents and the reviewer both receive.
  - A shape the rule text already settles word for word gets no row (a plain generic-terminal, bound-qualifier or `user`/`newUser` case); add a row only where two readers could split.
  - The reviewer keeps review mechanics only: `### Naming Checks` (triggers, word counting, finding or no finding) and its `### Naming Edge Cases` tables.
  - Rename `### Naming Checks`, a `### Naming Edge Cases` heading or the **Naming edge cases** lead and fix this note in the same pass.
- The closed fallback list under **Qualifier-sibling grouping** and the `## Edge-case verdicts — sibling sets` qualifier-stays rows must give one verdict per shape. Change either and re-read the other in the same pass.
- `skills/glass-atrium-dev-naming/references/ANTI-PATTERNS.md` → **Sibling collision groups first**, its `fileBlock` over-reduction row and its **Reduction floor** checklist line must read group first, qualifier as the fallback, in step with **Reduction-floor guardrail**.
- `skills/glass-atrium-dev-naming/references/VARIABLES-BOOLEANS.md` → **Parameters** and **Prefix-family grouping**'s parameter exclusion must give one verdict: a function's own parameters stay flat.
  - In `## Edge-case verdicts — identifier kinds`, the constructor row groups and the props-or-options row stays flat. Change any of these and re-read the others in the same pass.
- The delta-core's flat-only clause under **Prefix-family grouping** and the `## Edge-case verdicts — identifier kinds` flat-only row must give one verdict on a relational column, mapped ORM field or other flat-only name.
  - Change either and re-read the other in the same pass; `agents/glass-atrium-dev-db.md` → **Schema** (FK `{table}_id`, OLAP denormalization) is the DEV rule they must not contradict.
- Outbound: the rule file's `## Edge-case verdicts — identifier kinds` cites `skills/glass-atrium-dev-naming/SKILL.md` → **Family alignment**. Rename that skill bold lead and fix the rule file in the same pass.
- Outbound: the rule file's `## Edge-case verdicts — reads and joins` log-or-error-text row cites `skills/glass-atrium-dev-naming/references/ANTI-PATTERNS.md` → **Cross-boundary names keep their qualifier**; its in-code `Member taken out of its group` row applies rename-at-extraction, with no floor check.
  - Keep the split at the log/error boundary, and fix the rule file in the same pass as any rename of that skill bold lead.
- Outbound: the rule file's scope lines and the reviewer's `### Naming Edge Cases — Scope and Kind` cite `scoped/shared-testing.md` → `### Names, comments and test data`. Rename that heading and fix both in the same pass.

## Manifest-regeneration preconditions

Requirements for the wave that regenerates `manifest.json`. None is satisfied at this commit, and each is stated as a requirement rather than a state.

- **The manifest must ship this rule file and the part-slot wrappers (`hooks/inject-scope-part-*.sh`, `hooks/lib/inject-chunk.sh`, `hooks/lib/inject_chunk.py`) in the SAME deploy that carries the retired `hooks/inject-scope-rules.sh`, or earlier.** Slot 1 no longer carries the delta-core, so a deploy that lands the injector while the wrapper binding rows are declined leaves every member with no naming rule at all.
- **The regeneration must run AFTER the agent-body mode fix, and its output is committed with the rest of the change set.** `scripts/generate-manifest.sh` takes its file list from `git ls-files`, so the eight new files must be tracked before it runs. It records the raw `stat` mode with no normalisation and both install paths chmod landed files to the recorded mode, so a file left at a demoted mode is regenerated at that mode and then applied at it.
- **The regeneration is a PR-time gate, not only a deploy concern.** `test-install-macos` carries no path filter and no `if:`, and its `publish-release.sh build` step runs `verify_manifest` → `generate-manifest.sh --check`; no other check catches a stale manifest, which makes that job the first enforcement point for manifest freshness. `scripts/generate-manifest.sh --check` exits 1 DIVERGED at this worktree today. The branch also carries stale hashes from earlier waves, so the regeneration closes pre-existing drift as well as the eight additions.

## Open

- Whether a subagent can invoke the `glass-atrium-dev-naming` skill once its frontmatter no longer lists it is unsettled. Nothing read so far answers it, and neither the rule file nor this note asserts it either way.
- CLOSED by the wave's citation-repair pass: `scoped/shared-search-first.md` cited the naming canon as `glass-atrium-dev-naming` while the canonical verb set and the boolean form now live in this rule file. Its Step 3 — Mirror sub-bullet now cites `scoped/shared-naming.md`.
