# Maintainer note — `scoped/shared-naming.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file's `## Agent Injection Core` heading IS externally cited — `rules/glass-atrium/core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)` names it as the block's source — so the heading is load-bearing and carries no companion pointer beside it.

## Membership

- DEV unconditionally, all 13, plus `glass-atrium-qa-code-reviewer` as the enforcement surface. `glass-atrium-qa-debugger` is excluded: read-only by iron-law, it authors no identifier.
- Declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`.
- The Compliance Matrix QA cell is a plain `✓` with NO footnote marker. The design called for a fifth marker glyph (`‖`) for the qa-code-reviewer-only subset; the Tier-3 row states that subset by naming the single agent outright, which is more precise than a marker and costs no edit to `readonly FOOTNOTE_MARKERS` in `hooks/validate-compliance-matrix.sh`. An unlisted glyph would not fail check B2 — it would go unchecked, which is worse than a false failure. If a later file needs a genuine multi-agent QA subset, introduce `‖` there, add it to that constant in the same edit, and this row may adopt it.

## The injected block is byte-frozen

- The block between the `AGENT-INJECT:NAMING` markers is byte-identical to the one it replaced (SHA-256 `8aa64449b09bc8d3aa15be8f26cc2629fbd2a988a066ef3d733f42c640ad81c7` over the extracted range, 1993 B). It was spliced, not retyped.
- The worst-case DEV assembly — `glass-atrium-dev-front` and `glass-atrium-dev-android` — measures 9871 B against `INJECT_CTX_MAX_BYTES=9984`, so the block has 113 B of headroom and one byte over the ceiling sheds TWO blocks (the first shed also claims the 256 B marker reserve). That is why the three core rules the skill's ceiling-era compression had cut — boolean stative-first, the class/type suffix allowlist with the `I`-prefix prohibition, greppability / scope non-redundancy — are stated OUTSIDE the marker pair. They reach an agent only when the file body is delivered whole.
- Consequence a later editor will meet: the block's own closing line still lists boolean stative-first among the full skill's contents. Correcting that line means growing the marker range, so the rule is stated outside it instead.

## Readers and coupled tests

- `hooks/inject-scope-rules.sh` → `readonly NAMING_SRC_FILE` defaults to this file under `~/.glass-atrium/scoped`, matching `SRC_FILE` / `STYLEREF_SRC_FILE` / `BUDGET_SRC_FILE`. No symlink farm is in that path.
- `hooks/test/inject-scope-rules-nodrop.bats` and `hooks/test/h2-untrusted-ingest.bats` each set `NAMING_SRC` to the repo copy. `hooks/test/inject-scope-rules.bats` drives a hermetic fixture and never reads this file.
- The extractor is fail-open: a source path that resolves to a file WITHOUT the markers yields an empty block, one stderr line, no in-context drop marker and no drop-log entry. That is why the source constant and the file move together in one commit — a split would silently strip the block from every roster member while every path still resolved.
- `skills/glass-atrium-dev-naming/SKILL.md` keeps the on-demand detail and carries one pointer line to this rule file. Its `references/` are untouched.

## Manifest-regeneration preconditions

Requirements for the wave that regenerates `manifest.json`. None is satisfied at this commit, and each is stated as a requirement rather than a state.

- **The manifest must ship all eight new files in the SAME deploy that carries `hooks/inject-scope-rules.sh`, or earlier.** `readonly NAMING_SRC_FILE` now defaults to a path under the live install that does not exist there yet, while the retired skill file still does — the fail-open extractor above is what turns that ordering into silence rather than a failure. Measured consequence of deploying the hook first, for `glass-atrium-dev-front`: the assembly falls from 9871 B to 7877 B, the naming block is absent, NO in-context drop marker appears, NO drop-log entry is written, and the hook still exits 0. One stderr line is the only trace. The loss reaches every member of `NAMING_AGENTS` — 12 DEV agents plus `glass-atrium-qa-code-reviewer`.
- **The regeneration must run AFTER the agent-body mode fix, and its output is committed with the rest of the change set.** `scripts/generate-manifest.sh` takes its file list from `git ls-files`, so the eight new files must be tracked before it runs. It records the raw `stat` mode with no normalisation and both install paths chmod landed files to the recorded mode, so a file left at a demoted mode is regenerated at that mode and then applied at it.
- **The regeneration is a PR-time gate, not only a deploy concern.** `test-install-macos` carries no path filter and no `if:`, and its `publish-release.sh build` step runs `verify_manifest` → `generate-manifest.sh --check`; no other check catches a stale manifest, which makes that job the first enforcement point for manifest freshness. `scripts/generate-manifest.sh --check` exits 1 DIVERGED at this worktree today. The branch also carries stale hashes from earlier waves, so the regeneration closes pre-existing drift as well as the eight additions.

## Open

- Whether a subagent can invoke the `glass-atrium-dev-naming` skill once its frontmatter no longer lists it is unsettled. Nothing read so far answers it, and neither the rule file nor this note asserts it either way.
- CLOSED by the wave's citation-repair pass: `scoped/shared-search-first.md` cited the naming canon as `glass-atrium-dev-naming` while the canonical verb set and the boolean form now live in this rule file. Its Step 3 — Mirror sub-bullet now cites `scoped/shared-naming.md`.
