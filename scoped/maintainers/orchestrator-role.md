# Maintainer note — `rules/glass-atrium/orchestrator-role.md`

Maintainer-facing material for that rule file. Nothing here binds the orchestrator; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: no pointer to this note survives in the rule file. Nothing moved out of it, so nothing needs one.

## Scheduled for its own restructure-and-diet track

The file was touched in this wave but NOT restructured or dieted. That work is deferred to a track of its own, and this note is where the deferral is on the record.

- **Condition, a dated observation and not a maintained value**: this wave's verify pass reported it on 2026-09-12 as the one file the wave touched that is still pre-diet — around 551 lines, with roughly 25 bullets over 400 characters, against `scoped/scope-report.md` after its cut. Re-measure before the track starts rather than trusting these figures.
- **The whole uncommitted delta in this wave is one repoint**, under `#### Deliverable exposure and designer composition (Decision phase)`: the Pair note dropped a citation of a `scoped/scope-planning.md` heading that has never existed and now writes the delivered reporter heading as its full literal.
- **Why it is its own unit of work**: the file is large, it carries a live byte contract, and it reaches every subagent through the parent's project-instruction set while telling subagents to ignore it — so a diet here is read far more widely than a scope-file diet, and it cannot ride along inside another track's scope.

## Byte contract the diet track must honour

- `hooks/test/test_daemon_config_loader.py` → `CostTierRuleTextTest` reads the repo-tree copy, not the install — the module resolves its rule path relative to its own file location — splits it at `### Cost-Tier Selection` and scans only up to the NEXT `###` occurrence.
  - In this track's favour: a repo-tree run covers a branch edit, so the diet is verifiable before deploy rather than after.
- The maintained statement of what that span must contain, and of the four ways an edit breaks it, is the file's own `## Machine-Read Structure` table. Read it there; a second copy of those phrases would be one more thing to keep in step.
- The suite runs in the `test-python` CI job, which a markdown-only PR does not trigger — so a diet that breaks the pin goes green on the PR and red afterwards.

## Open pointer this pass did not repair

- `## Document-Driven Workflow (end-to-end lifecycle)`, step 1, sends the reader to "`scope-report.md` / `scope-planning.md` HTML request test". Only the first half resolves: `scoped/scope-planning.md` carries no such section and its `## Output Format Routing [PLANNING]` points at the report canonical instead. Left for the diet track rather than repaired here, to keep this wave's delta to the single repoint above.
