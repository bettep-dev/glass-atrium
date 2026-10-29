# Maintainer note — `rules/glass-atrium/core-compliance-matrix.md`

Corpus-maintenance companion to the path-scoped compliance matrix. The matrix reaches an agent only on a Read its `paths:` globs match; this note reaches none. Read it before editing the matrix; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the matrix's one stub heading, `## Precedence Resolution`, points to the charter, not here; its one link to this note is the editor HTML comment after its frontmatter.

## Machine readers

Live consumers parse the matrix. Reword around what they read, never through it.

| Consumer | Reads | Breaks when |
|---|---|---|
| `hooks/validate-compliance-matrix.sh` — SessionStart, exit 2 on a confirmed mismatch | Tier-1 bullets ↔ ALL column · cell markers ↔ `>` definitions, 1:1 · columns ↔ legend scopes · legend agents ↔ registry | a Tier-1 bullet is dropped · a footnote definition is orphaned · a legend row is removed |
| `monitor/src/server/architecture/governance-membership.ts` | every `scoped/…`, `rules/glass-atrium/…` or `agents/…` `.md` path in inline code, reported absent if no such file exists | an illustrative or placeholder path is written in that form |
| `hooks/test/injector-roster-docs-closed-set.bats` | roster variables of `hooks/inject-scope-rules.sh` and `hooks/lib/styleref-roster.sh`, each asserted named in the matrix | a roster name, or the inject-block name it owns, is named nowhere in the matrix |
| `scripts/agent_lifecycle/scope_infer.py`, via `readers.py` | the `## Scope Legend` table, as an agent-name → scope map | the legend's two-column shape changes, or an agent cell gains a lowercase hyphenated non-agent token |
| `scripts/agent_lifecycle/orphan_scan.py --mode rules-membership-mismatch`, via `scope_infer.py` | the Tier 2 and Tier 3 declaration tables, each read from its heading to the next heading of any level | a heading is inserted between a Tier heading and its table, or a declaration row's two-column shape changes |
| Claude Code host rules loader | the `paths:` frontmatter globs at the file head (matrix → **Path-scoped delivery**) | the block is dropped or reduced to `**`, so the file loads at every session start · a glob loses its `**/` lead |

- **Inline-code path set**: the membership regex admits one path segment after the prefix, so a nested path such as one under `scoped/maintainers/` is not read.
  - Moving text that carries a top-level inline-code path out of the matrix shrinks the declared set; check that each path still appears once.
- **Tier-3 subset tokens**: `scope_infer.py` → `_SUBSET_MARKERS` treats `subset`, `-authoring`, `-reviewing` and the four footnote markers in a Tier-3 cell as a subset qualifier, so the orphan scan never asserts that file as `rules.shared` membership.
  - The `shared-destructive-path-suite-safety.md` row relies on its `subset` tokens for exactly this.
- **Rows, not cells**: the reconcile reads the Tier-2 and Tier-3 declaration rows, never the Compliance Matrix table cell, which is a coarser summary of them.
  - A cell reader reports a permanent false divergence for glass-atrium-qa-debugger on every reviewer-only QA cell (matrix → `### Tier 3 — Cross-cutting (conditional inheritance)` → **QA**).
  - The scan runs off the delivery path, where a fail-open matrix parser is the right instrument.

## Reserved headings, literals and shapes

- **Headings**:
  - `## Loading Tiers`, `## Scope Legend` and `## Compliance Matrix` carry anchors the scope files and `agents/GLASS_ATRIUM_GLOBAL_RULES.md` link to; the validator matches `## Scope Legend` and `## Compliance Matrix` exactly.
  - `### Tier 1`, `### Tier 2` and `### Tier 3` are parse prefixes.
  - `### Membership vs. Delivery (per tier)` is cited in full by maintainer notes under `scoped/maintainers/`, by `agents/GLASS_ATRIUM_GLOBAL_RULES.md` and by `rules/glass-atrium/shared-self-improve-hygiene.md`.
    - `hooks/inject-scope-rules.sh` and `hooks/inject-session-context.sh` cite it by its `Membership vs. Delivery` prefix.
    - The citing set changes as those files are edited: grep the corpus for the heading before renaming it.
  - `#### Per-scope inheritance detail` sits below the Tier 3 table, so no parser's section bound moves; never insert a heading above a Tier table.
  - `### Membership declaration and SubagentStart channels`: maintainer notes, for the part-slot channel table.
  - `### Injected Blocks (SubagentStart allowlist)`: `skills/glass-atrium-ops-delegation-contracts/references/agent-lifecycle-ceremony.md` and `scoped/maintainers/shared-turn-budget.md`, for roster curation.
  - `## Precedence Resolution`: a stub the `agents/GLASS_ATRIUM_GLOBAL_RULES.md` maintainer note names.
  - `## Archived Agents`: named by the Scope Legend's `~~DATA~~` row.
- **Cited leads** — grep the corpus for the lead before rewording one:
  - **Path-scoped delivery**: `rules/glass-atrium/shared-self-improve-hygiene.md`, the maintainer notes for `agents/GLASS_ATRIUM_GLOBAL_RULES.md` and `glass-atrium-dev-python`, the matrix's § footnote, and this note's `Claude Code host rules loader` row.
  - Tier-3 **QA**: this note's **Rows, not cells** bullet.
  - Scope Legend **New-agent doc-sync note**: `scoped/maintainers/scope-dev.md` → its `### Doc-sync note (CLI auto-writes vs. manual matrix update)` row.
- **Literals**: the matrix header cell `Rule File`, the `✓` glyph, the footnote markers †‡§¶, and the Scope Legend's `~~DATA~~` strikethrough row.
- **Row shape**: a table row anywhere in the matrix whose first cell is a bare `name.md` is read as a declared rule file by the drift scan — only Compliance Matrix rows may take that shape.

## Coupled suites

- **Live-file pins** — `hooks/test/injector-roster-docs-closed-set.bats` (per the table above) and `monitor/test/architecture.governance-membership.unit.test.ts`.
  - The latter's last case reads the real matrix and asserts it still declares `scoped/scope-dev.md` and `rules/glass-atrium/core-security.md` as inline-code paths.
- **Fixture-driven, so they catch nothing here** — `hooks/test/validate-compliance-matrix.bats`, `scripts/test/test_inject_sync.py` and `scripts/test/test_rules_membership.py` drive temp-dir or in-memory fixtures.
  - A live edit that breaks a parser passes all three: run the validator and the orphan scan against the edited file itself.
- `autoagent/daemon_cycle.py` → `_read_sections` excerpts the whole matrix, cut at heading blocks, into the daemon's rule-improvement verify prompt; it pins no literal.

## Cell-marker decisions

- **A bare `✓` with no marker**: a new marker needs its own `>` definition, a reserved-literal entry above and the validator's marker set, so a cell stays bare for one of two reasons.
  - The Tier-3 row already names the agent or subset:
    - `shared-naming.md`, `shared-code-structure.md` and `shared-testing.md` QA cells: the row names glass-atrium-qa-code-reviewer outright, which no marker could state more precisely.
    - `shared-destructive-path-suite-safety.md` DEV cell: conditional, and the row names the suite-running subset.
  - Both agents of the scope take the file, so there is no subset to mark:
    - `shared-authoring-hygiene.md` META cell.
    - `shared-investigation-discipline.md` QA cell, unconditionally.

## Held cap exception — the Scope Legend DEV cell

- The DEV cell of the `## Scope Legend` table stays over the 120-char cell cap.
- Pin: `hooks/validate-compliance-matrix.sh` and `scripts/agent_lifecycle/scope_infer.py` (via `readers.py`) read that table as two columns, scope → agent names.
  - A split of the DEV roster across rows is untested against both parsers; change the cell's shape only with both re-run against the edited file.

## Implementation facts behind the matrix

- META's conditional exclusion: the prompt engineer's registry row keeps an empty `conditional` list, and `SCOPE_CONDITIONAL_RULES` in `scripts/agent_lifecycle/registry_ops.py` has no META entry.
- `autoagent/daemon_cycle.py` holds a second agent→scope-file map, used only to excerpt a scope file into the daemon's rule-improvement verify prompt; no spawn path reads it.
