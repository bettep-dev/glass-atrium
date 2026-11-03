# Maintainer note — `scoped/shared-search-first.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- DEV agents, plus glass-atrium-meta-prompt-engineer under the "prompts = code" Tier-3 inheritance; glass-atrium-meta-agent does not inherit it.
- The authoritative membership lives on the registry row (`agent-registry.json` → `rules.shared`) and in the compliance matrix.

## Coupled readers — the anchors that must keep their names

No code reads the rule file's body, but prose citations resolve into it by name, one of them from a Tier-1 rule that reaches every agent:

- `rules/glass-atrium/core-outcome-record.md` → `### Role-scoped fields` → `style_ref` cites "Pattern recognition → Step 2 Read / Step 3 Mirror".
- `agents/glass-atrium-dev-rag.md` → Work Rules → **Codebase exploration** cites "Pattern recognition → **Inconclusive probe**".
- `scoped/scope-dev.md` → **Sibling probe (PRIMARY)** cites **Step 3 — Mirror**.

- Reserved anchors: the bolded leads **Pattern recognition** and **Inconclusive probe**, and the names **Step 1 — Search** / **Step 2 — Read** / **Step 3 — Mirror**.
- Compress around them; do not rename one without editing every site above that cites it.

## Pair classifications

- **Step 1 — Search** / **Step 2 — Read** ↔ `scoped/scope-dev.md` → **Sibling probe (PRIMARY)**: canonical + mirror; glass-atrium-meta-prompt-engineer holds only the rule file and DEV holds both, so both stay.

## Decisions worth keeping

- **Mirror conflict closed.** Step 3's axis list says `naming case`, never bare `naming`.
  - Why: a bare `naming` axis with no precedence clause authorizes a sibling's identifier forms against the naming canon the same agent receives.
- **Inconclusive probe stays self-contained.** Its trigger and action stay inline under Pattern recognition.
  - Why: the loop's definition is in `scoped/scope-research.md` → `## Iterative Codebase Retrieval [RESEARCH]`, a file this rule's readers never receive, so a pointer there leaves the action unreachable.
- No Project-Convention-Probe pointer in the rule file, and no probe detail beyond Step 1–3 and **Inconclusive probe**: the DEV reader holds the rest (`style_ref`, greenfield, probe failure) in `scoped/scope-dev.md`, its `rules.scope`.
- Keep the project-search bullet although the ETHOS line overlaps it: that Tier-1 line points at the rule file, and without the bullet the pointer resolves to a file that discusses only packages and official docs.
- `## Rationalization Rejection (Search)` stays — the Tier-1 charter homes the search excuse→rebuttal pairs here, so this table is their only copy.
