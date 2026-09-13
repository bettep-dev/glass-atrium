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

No code reads this file's body, but prose citations resolve INTO it by name, one of them from a Tier-1 rule that reaches every agent:

- `rules/glass-atrium/core-outcome-record.md` → Field Input Guide → `style_ref` cites "Pattern recognition → Step 2 Read / Step 3 Mirror".
- `scoped/scope-dev.md` → Pre-Execution Verification → Project Convention Probe cites "Pattern recognition".
- `agents/glass-atrium-dev-rag.md` → Work Rules → **Codebase exploration** cites "Pattern recognition → **Inconclusive probe**".

So the bolded leads **Pattern recognition** and **Inconclusive probe** and the three **Step 1 — Search** / **Step 2 — Read** / **Step 3 — Mirror** names are the file's reserved anchors. Compress around them; do not rename one without editing every site above that cites it.

## Restructure + diet pass (this wave)

- **Mirror conflict closed.** Step 3 splits the mirrored axis: the sibling settles case and separator convention, while identifier FORM — canonical verb set, boolean / stative prefixes — follows the naming canon, and a divergent sibling is explicitly not a precedent.
  - Why: with `naming` inside the mirrored axis list and no precedence clause, the step read as authorizing a sibling's identifier forms against the naming canon the same agent receives.
  - The companion halves (the probe and `style_ref` emit text in `scoped/scope-dev.md`, and the DEV bodies that mirror it) are edited in their own files.
- **Escalation section folded to one line.** `## Escalation to Iterative Codebase Retrieval` pointed a DEV agent at a Tier-2 RESEARCH scope file for the loop's definition — a file that reader never receives, so the duty named a trigger whose action was unreachable.
  - Nothing in the corpus pointed into that section. The trigger and a self-contained action (narrow, at most three rounds, declare the adopted convention as an assumption) sit inline as **Inconclusive probe** under Pattern recognition; the retrieve/evaluate/refine rubric was not reproduced.
  - `agents/glass-atrium-dev-rag.md` → Codebase exploration points at that **Inconclusive probe** as well, so no DEV body sends its reader to the RESEARCH scope file for the loop.
- Dropped the Project-Convention-Probe pointer into `scope-dev.md` and the duplicated probe detail: the DEV reader holds the probe itself in `scoped/scope-dev.md`, its `rules.scope`.
- Dropped the applies-to membership line (recorded above).
- The project-search bullet was KEPT in compressed form rather than cut as a duplicate of the ETHOS line: that Tier-1 line points AT this file, so cutting it here would leave the pointer resolving to a file that discusses only packages and official docs.
- `## Rationalization Rejection (Search)` is unchanged — the Tier-1 charter homes the search excuse→rebuttal pairs here, so this table is their only copy.
