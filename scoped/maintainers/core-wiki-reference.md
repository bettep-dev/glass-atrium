# Maintainer note — `rules/glass-atrium/core-wiki-reference.md`

Corpus-maintenance companion to that Tier-1 rule file.

- The rule file reaches every agent on the host channel; this note reaches none.
- Read this note before editing the rule file.
- Do not inject this note.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no stub heading; its one link to this note is the editor HTML comment above the machine-extracted clause.

## Machine readers of the marker-delimited clause

- `hooks/inject-scope-rules.sh` → `extract_block` copies the clause at SubagentStart with a line-range scan between its two marker lines.
  - A copy of either marker literal anywhere else in the rule file, even quoted inline, opens or closes the extracted range at that line — never paste one as an illustration.
- These suites run the hook on the live rule file, not a fixture:
  - `hooks/test/h2-untrusted-ingest.bats` requires the bolded lead `Wiki raw-store untrusted-data clause`, `UNMARKED / pre-existing legacy raw files` and `untrusted by the SAME rule`.
  - `hooks/test/inject-scope-rules-nodrop.bats` requires the bolded lead and caps the whole slot-1 context at 9984 bytes, so the clause's size counts against that ceiling.
  - `hooks/test/inject-scope-single-delivery.bats` requires the bolded lead exactly once per roster member, so a second copy inside the markers reds it.
- `hooks/test/inject-scope-rules-canary.bats` runs one control/treatment test on the rule file, its other spawns on `/nonexistent` or a synthetic clause, and pins no clause text.
- No test pins the wording outside the markers; `scripts/test/startup-budget.bats` counts only the file's length.

## Cited text — grep the corpus before rewording

- Grep each heading, bolded lead and the `> **Wiki store (canonical)**` blockquote, plus the `[Date Unknown]` label and the clause's **Prompt Injection Refusal** name, which `rules/glass-atrium/core-security.md` defines.
- Grep bare words: `agents/glass-atrium-wiki-curator.md` cites `## Wiki Raw-Store Untrusted-Data Contract [ALL] [LLM01]` without the `## ` or the tags.
- A one-line grep misses `scripts/wiki-daily-compile.sh`, whose comment wraps `Wiki Raw-Store Untrusted-Data Contract` across two lines.
- `scoped/maintainers/scope-research.md` relies on **Non-Bash fallback** naming glass-atrium-intel-researcher.

## Staleness thresholds

- `scripts/wiki-staleness.sh` cites this heading: its 90-day threshold (`WIKI_STALE_DAYS`, `--threshold-days`) is the curator's re-review trigger on `updated:`.
- The read-time check in `## Knowledge Utilization` is on `collected:` and carries no fixed age; the reader judges currency per topic.

## Path readers

- Grep the corpus for the basename `core-wiki-reference.md` before moving the file; a full-path grep misses the matrix row, `scripts/fixtures/retired-seed.json` and other basename-only citers.
- The basename grep misses `hooks/validate-compliance-matrix.sh`, which pairs the matrix's Tier-1 bullet with its row by basename without naming the path.
