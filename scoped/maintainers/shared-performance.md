# Maintainer note — `scoped/shared-performance.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

DEV agents, plus glass-atrium-meta-prompt-engineer under the "prompts = code" Tier-3 inheritance; glass-atrium-meta-agent does not inherit it. The authoritative membership lives on the registry row (`agent-registry.json` → `rules.shared`) and in the compliance matrix; the rule file states it nowhere.

## Coupled readers

No code reads the body of this file. The file PATH is pinned in three places — the manifest hash set, the closed rule-file set the agent-lifecycle registry writer validates against, and the compliance-matrix row keyed on the basename — so renaming the file is a multi-site edit, while editing its text is not. One prose citation names it by filename only (`agents/glass-atrium-qa-code-reviewer.md`, the review-checklist Performance row) and survives any heading change.

## Restructure + diet pass (this wave)

- `## General` moved above the three platform sections: it is the only unconditionally applicable section, and each platform heading states its own condition.
- The **Measure first** bullet was dropped as redundant. Tier-1 `GLASS_ATRIUM_GLOBAL_RULES.md` → Philosophy (ETHOS) states "Measurement > Guessing — No optimization without profiler/benchmark" and measurably reaches every agent, and the first rationalization row rebuts the same excuse with "profile first".
- The applies-to membership line was dropped (recorded above).
- The N+1 clause of the Backend DB bullet is restated in one DEV body. It was KEPT: the other twelve agents receive it from nowhere else, and the EXPLAIN-ANALYZE and index-strategy halves of the same line are unduplicated.
- `## Rationalization Rejection (Performance)` is unchanged. The Tier-1 charter's Rationalization Rejection section names this file as the home of the performance excuse→rebuttal pairs, so this table is their only copy.
