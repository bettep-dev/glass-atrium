# Maintainer note — `scoped/shared-search-first.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

DEV agents, plus glass-atrium-meta-prompt-engineer under the "prompts = code" Tier-3 inheritance; glass-atrium-meta-agent does not inherit it. The authoritative membership lives on the registry row (`agent-registry.json` → `rules.shared`) and in the compliance matrix.

## Coupled readers — the anchors that must keep their names

No code reads this file's body, but two prose citations resolve INTO it by name, one of them from a Tier-1 rule that reaches every agent:

- `rules/glass-atrium/core-outcome-record.md` → Field Input Guide → `style_ref` cites "Pattern recognition → Step 2 Read / Step 3 Mirror".
- `scoped/scope-dev.md` → Pre-Execution Verification → Project Convention Probe cites "Pattern recognition".

So the bolded lead **Pattern recognition** and the three **Step 1 — Search** / **Step 2 — Read** / **Step 3 — Mirror** names are the file's reserved anchors. Compress around them; do not rename them without editing both citing sites.

## Restructure + diet pass (this wave)

- **Mirror conflict closed (wave disposition 1).** Step 3 previously deferred comment axes to the comment rules and left `naming` inside the mirrored axis list with no precedence clause, which read as authorizing a sibling's identifier forms against the naming canon the same agent receives. Step 3 now splits the axis: the sibling settles case and separator convention, while identifier FORM — canonical verb set, boolean / stative prefixes — follows the naming canon, and a divergent sibling is explicitly not a precedent. The companion halves of this disposition (the injected style-ref block and the DEV bodies that mirror it) are edited in their own files.
- **Escalation section folded to one line.** `## Escalation to Iterative Codebase Retrieval` pointed a DEV agent at a Tier-2 RESEARCH scope file for the loop's definition — a file that reader never receives, so the duty named a trigger whose action was unreachable. Nothing in the corpus pointed into that section. The trigger and a self-contained action (narrow, at most three rounds, declare the adopted convention as an assumption) now sit inline under Pattern recognition; the retrieve/evaluate/refine rubric was not reproduced.
  - Open, out of this wave's file set: `agents/glass-atrium-dev-front.md`'s sibling case does not exist, but `agents/glass-atrium-dev-rag.md` → Codebase exploration still sends its reader to the same RESEARCH scope file for the same loop. One end is fixed here; that one is not.
- Dropped the Project-Convention-Probe pointer into `scope-dev.md` (a Tier-2 file the DEV reader does not receive) and the duplicated probe detail the injected style-ref block already delivers.
- Dropped the applies-to membership line (recorded above).
- The project-search bullet was KEPT in compressed form rather than cut as a duplicate of the ETHOS line: that Tier-1 line points AT this file, so cutting it here would leave the pointer resolving to a file that discusses only packages and official docs.
- `## Rationalization Rejection (Search)` is unchanged — the Tier-1 charter homes the search excuse→rebuttal pairs here, so this table is their only copy.
