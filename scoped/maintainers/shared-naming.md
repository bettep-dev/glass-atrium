# Maintainer note — `scoped/shared-naming.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: every externally cited rule-file heading is load-bearing and carries no companion pointer beside it; `## Readers and coupled tests` lists them.

## Membership

- Members:
  - the member set → `rules/glass-atrium/core-compliance-matrix.md` → `### Tier 3 — Cross-cutting (conditional inheritance)` → the `scoped/shared-naming.md` row
  - the `glass-atrium-qa-debugger` exclusion → `rules/glass-atrium/core-compliance-matrix.md` → `#### Per-scope inheritance detail`
  - declared on each `agent-registry.json` row (`rules.shared`)
- The Compliance Matrix QA cell is a plain `✓` with no footnote marker: the Tier-3 row names the single agent outright.
  - A marker glyph (`‖`) would also need an edit to `readonly FOOTNOTE_MARKERS` in `hooks/validate-compliance-matrix.sh`; an unlisted glyph would not fail check B2 — it would go unchecked, worse than a false failure.
  - A later file needing a genuine multi-agent QA subset introduces `‖` there and adds it to that constant in the same edit; this row may then adopt it.

## The delta-core — edit rules

- **Delivery**: the whole rule file reaches every member through the part slots (`hooks/lib/inject_chunk.py`, selected by `rules.shared`), packed at heading boundaries.
  - It carries no `AGENT-INJECT` marker: `rules/glass-atrium/core-compliance-matrix.md` → **Slot 1 MUST carry no scope-file text**.
- **Admission test**: the delta-core and `## Core rules outside the delta-core` hold only rules an agent gets wrong without them — a divergence from the model's default, or a closed vocabulary it cannot guess.
  - Model-inferable rules stay out: padding verbs and the noise nouns Data/Info/Manager.
  - Lookup tables stay in the skill (`## On-demand detail`).
  - The delta-core carries each rule, one Bad → Good pair and the exclusions a DEV agent needs to write a compliant name.
- **Edge-case verdicts**: every other verdict that shapes a name lives once in the `## Edge-case verdicts —` sections, which DEV agents and the reviewer both receive.
  - A shape the rule text already settles word for word gets no row (a plain generic-terminal, bound-qualifier or `user`/`newUser` case); add a row only where two readers could split.
  - The reviewer keeps review mechanics only, in `agents/glass-atrium-qa-code-reviewer.md` → `### Naming Checks`: which identifiers it judges, the severity, and the **Naming edge cases** lead.
  - Rename `### Naming Checks` or the **Naming edge cases** lead and fix this note in the same pass.
- **Reduction-floor guardrail is non-compressible**: never trim it in a diet pass — it is the counterweight to **No-stutter**.
- **Keep the delta-core's bold lead phrase** (`Naming delta-core`, the words before its em dash):
  - `hooks/test/inject-scope-rules-nodrop.bats` → `RETIRED_NEEDLES` asserts it absent from slot 1; the check proves nothing once the phrase is gone from the source.
  - `hooks/test/inject-scope-single-delivery.bats` → `RETIRED_BLOCKS` anchors `**Naming delta-core` to exactly one line and counts that whole line once per member assembly — keep the anchor on one line, never repeated in another member file.
- **Overflow audit** (`rules/glass-atrium/core-compliance-matrix.md` → **Overflow audit**): re-run it after any growth of the rule file and before any merge, reading each member's `chunks=` against the header's `slots=`.
  - A branch-side run sets `GA_CHUNK_RULES_ROOT` to the tree under test and runs that tree's `hooks/lib/inject_chunk.py`; unset, the audit reads the live install's corpus, and `slots=` comes from whichever core file runs.
  - A chunk past the last slot is an overflow the owner settles: split `## Agent Injection Core` at H3, a smaller text, or a new slot — never a silent slot add.
  - **Packing grain**: the chunker packs whole H2 sections greedily in file order and splits at H3 only past one part, so a large H2 that misses the current part strands the space before it.
    - Hence edge-case verdict H2 sections of ~2 KB or less, and the small `## On-demand detail` last to fill the final part.

## Readers and coupled tests

- `hooks/test/inject-scope-rules.bats` → `retired naming block → qa-code-reviewer slot 1 carries no naming block` plants a synthetic `AGENT-INJECT:NAMING` pair; it never reads the rule file.
- Load-bearing literals, cited from `skills/glass-atrium-dev-naming/` (`SKILL.md`, `references/`) and the agent bodies named below. Before renaming one, grep it and fix every citer in the same pass:
  - `## Agent Injection Core` · `## Core rules outside the delta-core`
  - the `## Edge-case verdicts —` prefix shared by `identifier kinds` · `scopes and bindings` · `family shapes` · `sibling sets` · `reads and joins` — `agents/glass-atrium-qa-code-reviewer.md` → **Naming edge cases** only
  - **Canonical verb set (PRIMARY)** · **One verb per purpose per layer** · **Identifier-kind binary** · **No-stutter** · **Reduction-floor guardrail**
  - **Booleans — stative-first** — `agents/glass-atrium-dev-react.md` only
  - **Prefix-family grouping** · **Qualifier-sibling grouping** — also `agents/glass-atrium-qa-code-reviewer.md`
  - **Read-down naming** — `agents/glass-atrium-qa-code-reviewer.md` only
- Inside the rule file, the delta-core items and the edge-case sections cite one another by bold lead; a rename fixes those in-file citers too.

### One-verdict pairs

Each set below must give one verdict; change any site and re-read the others in the same pass.

- Group member (`request.pending`, `user.byId`): **Identifier-kind binary**'s group-member sub-bullet · `references/VARIABLES-BOOLEANS.md` → `### Noun-only form (data identifiers)` and **Maps**.
- Member taken out of its group:
  - the group-member sub-bullet's extraction sub-bullet, which also carries the rename syntax (`:` in a destructuring read, `as` in an import) · the rule file's `Member taken out of its group` and `Qualified read` rows
  - `SKILL.md` → "A group member reads with its group" · `references/VARIABLES-BOOLEANS.md` → **Group members read with their group**
  - the `## Edge-case verdicts — scopes and bindings` row on an existing `user` beside an added `userById`, whose input cell excludes a `userById` read out of `user`
- Qualifier fallback: the closed fallback list under **Qualifier-sibling grouping** · the `## Edge-case verdicts — sibling sets` qualifier-stays rows.
- Group first, qualifier as the fallback: `references/ANTI-PATTERNS.md` → **Sibling collision groups first**, its `fileBlock` over-reduction row and its **Reduction floor** checklist line · **Reduction-floor guardrail**.
- A function's own parameters stay flat: `references/VARIABLES-BOOLEANS.md` → **Parameters** · **Prefix-family grouping**'s parameter exclusion · the `## Edge-case verdicts — identifier kinds` constructor row (groups) and props-or-options row (stays flat).
- Flat-only names: the delta-core's flat-only clause under **Prefix-family grouping** · the `## Edge-case verdicts — identifier kinds` fixed-outside and flat-only rows (relational column, mapped ORM field or other flat-only name).
  - `agents/glass-atrium-dev-db.md` → **Schema** (FK `{table}_id`, OLAP denormalization) is the DEV rule they must not contradict.

### Outbound citations

Rename a target below and fix the rule file in the same pass.

- `## Edge-case verdicts — identifier kinds` → `skills/glass-atrium-dev-naming/SKILL.md` → **Family alignment**.
- `## Edge-case verdicts — reads and joins`, log-or-error-text row → `references/ANTI-PATTERNS.md` → **Cross-boundary names keep their qualifier**.
  - Keep the split at the log/error boundary: that row keeps the qualifier, while the in-code `Member taken out of its group` row applies rename-at-extraction with no floor check.
- The scope lines → `scoped/shared-testing.md` → `### Names, comments and test data`.

## Manifest-regeneration preconditions

Requirements for any regeneration of `manifest.json`; check each against the tree before relying on it.

- **Fix any demoted file mode first**: `scripts/generate-manifest.sh` records the raw `stat` mode unnormalised and both install paths chmod landed files to it, so a demoted mode is regenerated at that mode and then applied at it.
- **Track every new file first**: the script takes its file list from `git ls-files`.
- **Commit the output with the rest of the change set.**
- **It is a PR-time gate**: `.github/workflows/ci.yml` → `test-install-macos` carries no path filter and no `if:`, so it runs on every PR into `main` or `feature/pa-epic`, and its `publish-release.sh build` step runs `verify_manifest` → `generate-manifest.sh --check`.
  - `scripts/test/manifest-check-clean.bats` runs the same check in the path-filtered `scripts/test` bats leg.
  - `scripts/generate-manifest.sh --check` shows whether the tree has diverged; a regeneration closes every stale hash, not only those of the files it adds.

## Open

- Whether a subagent can invoke the `glass-atrium-dev-naming` skill, which no agent frontmatter lists, is unsettled; neither the rule file nor this note asserts it either way.
- Folding the delta-core and `## Core rules outside the delta-core` into one canonical list needs a per-bullet audit: the delta-core is the file's canonical statement of the rules it lists.
