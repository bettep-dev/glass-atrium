# Maintainer note — `scoped/shared-performance.md`

- Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- The rule file states no membership; its authoritative sites are `agent-registry.json` → `rules.shared` and `rules/glass-atrium/core-compliance-matrix.md`.

## Coupled readers

- No test or script names the rule file's headings or text; `hooks/lib/inject_chunk.py` only delivers it, so a text edit is a single-site edit.
- Renaming the file is a multi-site edit: grep `shared-performance.md` across the repo and read every hit.
  - `agents/glass-atrium-qa-code-reviewer.md` → `### 7-Perspective Checklist`: the Performance row by filename, the Read list below it by path; neither names a heading.

## Restructure + diet pass — dispositions

- No **Measure first** bullet in the rule file: `GLASS_ATRIUM_GLOBAL_RULES.md` → `## Philosophy (ETHOS) [ALL]` → **Measurement > Guessing** reaches every agent, and `## Rationalization Rejection (Performance)` → the "This optimization is obvious, no measurement needed" row rebuts the same excuse.
- `## Backend` → **DB queries** stays whole: among the rule file's members, N+1 recurs only in the `glass-atrium-dev-db` body, EXPLAIN ANALYZE there and in `glass-atrium-dev-rag`; every other member receives them only here.
- `## Rationalization Rejection (Performance)` stays: `GLASS_ATRIUM_GLOBAL_RULES.md` → `## Rationalization Rejection [ALL]` names performance among the home files, so this table is the only copy of its pairs.
