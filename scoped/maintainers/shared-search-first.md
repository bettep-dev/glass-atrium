# Maintainer note — `scoped/shared-search-first.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- The member set → `rules/glass-atrium/core-compliance-matrix.md` → `### Tier 3 — Cross-cutting (conditional inheritance)` → the `scoped/shared-search-first.md` row; declared on each `agent-registry.json` row (`rules.shared`).

## Coupled readers — the anchors that must keep their names

- No code reads a literal from the rule file's body; prose citations resolve into it by name.
- Reserved leads: **Pattern recognition** · **Inconclusive probe** · **Step 1 — Search** · **Step 2 — Read** · **Step 3 — Mirror**.
- Before renaming one, grep the corpus for its bare name and edit every citer.
  - `rules/glass-atrium/core-outcome-record.md` → `### Role-scoped fields` → `style_ref` spells "Step 2 Read / Step 3 Mirror", which a dashed grep misses.
  - `agents/glass-atrium-dev-rag.md` → **Codebase exploration** cites "Pattern recognition → **Inconclusive probe**".
    - Keep this record: `scoped/maintainers/scope-research.md` → **DEV citers** points at it.

## Decisions worth keeping

- **Mirror conflict closed**: keep Step 3's split between the sibling's case and separator and the naming canon's identifier form.
  - Why: with `naming` among the mirrored axes and no precedence clause, the step authorizes a sibling's forms against the canon the same agent receives.
- **Inconclusive probe stays self-contained**: never point it at `scoped/scope-research.md` → `## Iterative Codebase Retrieval [RESEARCH]`.
  - Why: a DEV reader never receives that file, so the action would be unreachable.
- **No Project Convention Probe pointer or detail in the rule file**: each DEV reader holds the probe in `scoped/scope-dev.md`, its `rules.scope`.
- **Keep the project-search bullet** (`scoped/shared-search-first.md` → **In the project**): `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Philosophy (ETHOS) [ALL]` → **Existing patterns > New introduction** points at the rule file for that search.
- **Keep the rule file's `## Rationalization Rejection (Search)`**: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Rationalization Rejection [ALL]` homes the search pairs in the rule file, so that table is their only copy.
