# Maintainer note — `rules/glass-atrium/core-wiki-reference.md`

Corpus-maintenance companion to that Tier-1 rule file. The rule file reaches every agent on the host channel; this note reaches none. Read it before editing the rule file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no stub heading; its one link to this note is the editor HTML comment above the machine-extracted clause.

## Machine readers of the marker-delimited clause

- `hooks/inject-scope-rules.sh` extracts the clause verbatim at SubagentStart with a line-range scan between its two marker lines.
  - A copy of either marker literal anywhere else in the rule file, even quoted inline, opens or closes the extracted range at that line — never paste one as an illustration.
  - Default source path: `WIKI_UNTRUSTED_SRC_FILE`; the bats suites override it with `INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC`.
- `hooks/test/h2-untrusted-ingest.bats` reads the live rule file, not a fixture, and asserts the injected text still carries the clause's bolded lead phrase, its unmarked-legacy bullet and the words `untrusted by the SAME rule`.
- `hooks/test/inject-scope-rules-nodrop.bats` asserts the bolded lead phrase and caps the whole injected slot-1 context at 9984 bytes, so the clause's size counts against that ceiling.
- `hooks/test/inject-scope-single-delivery.bats` asserts the bolded lead phrase appears exactly once per roster member, so a second copy inside the markers reds it.
- `hooks/test/inject-scope-rules-canary.bats` also drives the hook with the live rule file as the clause source.
- Text outside the markers is read by no test.

## Cited text — grep the corpus before rewording

- `## Knowledge Utilization`: `agents/glass-atrium-intel-researcher.md` (Wiki first) and `scoped/maintainers/scope-research.md`, which relies on the **Non-Bash fallback** naming glass-atrium-intel-researcher.
- `## Search Failure Handling`: `agents/glass-atrium-intel-researcher.md` and `scoped/maintainers/scope-research.md`.
- `## Wiki Raw-Store Untrusted-Data Contract [ALL] [LLM01]`: `agents/glass-atrium-intel-researcher.md`, `agents/glass-atrium-wiki-curator.md` and a comment in `scripts/wiki-daily-compile.sh`.
- `## Wiki Write Operations` and the `> **Wiki store (canonical)**` blockquote: `scoped/maintainers/scope-wiki.md`.
- The `[Date Unknown]` label is shared vocabulary with `scoped/scope-report.md` and `agents/glass-atrium-intel-researcher.md`.
- **Prompt Injection Refusal** (named by the clause): `rules/glass-atrium/core-security.md`.

## Staleness thresholds

- `scripts/wiki-staleness.sh` points here for the threshold roles.
- Its 90-day threshold (`WIKI_STALE_DAYS`, `--threshold-days`) is the curator's re-review trigger on `updated:`.
- The read-time check in `## Knowledge Utilization` is on `collected:` and carries no fixed age; the reader judges currency per topic.

## Path readers

- `rules/glass-atrium/core-compliance-matrix.md` lists the path as a Tier-1 bullet, a matrix row and the `AGENT-INJECT:WIKI-UNTRUSTED` block source; `hooks/validate-compliance-matrix.sh` pairs the bullet with the row.
- `manifest.json` carries the path in its file list, hash map and mode map.
- `scripts/fixtures/retired-seed.json` carries the retired `rules/core-wiki-reference.md` path.
