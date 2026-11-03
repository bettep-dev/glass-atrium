# Maintainer note — `scoped/shared-performance.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

- The rule file states membership nowhere: it lives on the registry row (`agent-registry.json` → `rules.shared`) and in the compliance matrix.

## Coupled readers

- No code parses this file's content: `hooks/lib/inject_chunk.py` → `split_sections` only splits it at headings for spawn delivery, so editing its text is a single-site edit.
- `python3 hooks/lib/inject_chunk.py --audit` covers the section sizes.
- The file path is pinned, so renaming it is a multi-site edit:
  - `manifest.json`
  - `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES` and `scripts/test/test_agent_lifecycle_overhaul.py`
  - `agent-registry.json` → `rules.shared`
  - the compliance-matrix rows naming the file: `### Tier 3` table (full path) and `## Compliance Matrix` (basename)
- Prose citers name it by file only, and survive any heading change:
  - `agents/glass-atrium-qa-code-reviewer.md` → `### 7-Perspective Checklist`: the Performance row and the Read list
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Rationalization Rejection [ALL]`, naming `performance` as a home
  - `scoped/maintainers/glass-atrium-qa-code-reviewer.md`: the `### 7-Perspective Checklist` Performance row bullet and the `The Read instructions for` bullet

## Restructure + diet pass — dispositions

- `## General` stays above the platform sections: it is the only unconditionally applicable section, and each platform heading states its own condition.
- No **Measure first** bullet: Tier-1 `GLASS_ATRIUM_GLOBAL_RULES.md` → Philosophy (ETHOS) → **Measurement > Guessing** reaches every agent, and the first rationalization row rebuts the same excuse.
- The N+1 clause of the Backend DB bullet ↔ `agents/glass-atrium-dev-db.md`: canonical + mirror; both stay, because the other member agents receive it from nowhere else.
- `## Rationalization Rejection (Performance)` stays — the Tier-1 charter homes the performance excuse→rebuttal pairs here, so this table is their only copy.
