# Maintainer note — `scoped/shared-turn-budget.md`

Maintainer-facing material for that source file. It is an injection-TEXT source, so its only agent-facing content is the two marker blocks the hook extracts.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: `scoped/shared-turn-budget.md` moved nothing out from under an externally-cited heading, so its preamble pointer to this note was removed rather than kept.

## Status in the corpus

- No tier membership and no Compliance Matrix row: the policy SoT is `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Turn Budget & Graceful Exit`, and this file owns only the compressed injection variants. `rules/glass-atrium/core-compliance-matrix.md` states the same exclusion alongside the naming SKILL.md.
- `hooks/validate-compliance-matrix.sh` carries the file in `EXEMPT_FILES` for exactly that reason, so its Layer A basename→matrix-row drift check skips it. Do not remove it from that list and do not add a matrix row; `hooks/test/validate-compliance-matrix.bats` fixtures the exemption.
- Keeping the two copies in step (policy section → compressed blocks) is a manual obligation. No test compares them; the nodrop suite pins only a first-line needle per block, which survives almost any rewording.

## Rosters

- Roster curation — which agents take each block and why each excludes the carriers it does — is stated in `rules/glass-atrium/core-compliance-matrix.md` under the injected-blocks table, and the arrays themselves live in `hooks/inject-scope-rules.sh`. The former roster section in the source file was a third copy and is dropped rather than moved.
- The analysis roster contains no DEV agent, which is why delivering this file wholesale to a DEV agent would ship it another roster's block.

## The meter block, and why it stays a shell literal

The source file keeps the reciprocal pointer; the rejected-refactor record is here.

- A marker block would need two substitution placeholders, because the meter interpolates the agent's frontmatter `maxTurns` and the derived 80% ceiling, while `extract_block` returns literal text. That part is mechanically fine and byte-neutral.
- The blocker is the test harness: `hooks/test/inject-scope-rules.bats` → `run_hook_full` is the only meter-ENABLED driver in that suite, and it synthesizes BOTH the budget source AND the agents dir under `BATS_TEST_TMPDIR` — so a meter sourced from any markdown file extracts empty there and reds 9 tests. Landing the move means writing the marker pair into that fixture writer first. Measured, not assumed: the extraction was implemented, run and reverted.
- The same record sits in the `build_meter_block` header comment in `hooks/inject-scope-rules.sh`, which is the code-site canonical.
- Do not park a dormant copy of the meter TEXT in the source file while it is unsourced — a second copy no code reads is a drift surface with no reader.

## Block rationale (moved from the source file)

- Both blocks are sizing-only ON PURPOSE: the 80%-ceiling / `needs_context` half of the canonical discipline is omitted because the non-droppable meter block already delivers it on every spawn, and restating it would be intra-assembly duplication.
- The BUDGET marker names differ from every other injected block's name so the sed ranges never collide.
- The byte-budget guard comments stay in the source file, above the blocks they cap, because that is where the edit that would breach the cap happens.

## Readers and coupled tests

- `hooks/inject-scope-rules.sh` reads the file at `BUDGET_SRC_FILE` (overridable by env for tests) and extracts both blocks.
- `hooks/test/inject-scope-rules-nodrop.bats` and `hooks/test/h2-untrusted-ingest.bats` read the LIVE file; nodrop additionally enforces a hard byte bound on the DEV block and a first-line needle per block. `hooks/test/inject-scope-rules.bats` does NOT read it — it synthesizes its own two-marker fixture.
- A broken or renamed marker empties the block silently at the hook (fail-open) and is caught only by the nodrop needle assertions.
