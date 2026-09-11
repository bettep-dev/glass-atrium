# Maintainer note — `scoped/shared-design-token-consumption.md`

Maintainer-facing material for that rule file. Nothing here binds an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership and scope provenance

- The UI-emitting DEV subset that takes this rule is declared per-agent on the `agent-registry.json` rows and summarized in `rules/glass-atrium/core-compliance-matrix.md` (Tier-3 table, ‡ footnote). The rule file's former roster sentence was a third copy and is dropped; its opening line now states the TASK condition (a turn that emits UI markup, styling or animation) instead.
- **Open item, out of this wave's file set**: `rules/glass-atrium/core-compliance-matrix.md` footnote ‡ still says "Scope declaration: `scoped/shared-design-token-consumption.md` header" and sends a reader there for the ROSTER — which that header no longer states. Reword the footnote to drop the header pointer; the roster it wants is the matrix's own Tier-3 table plus the registry rows.
- `scripts/agent_lifecycle/registry_ops.py` adds this file to `RULE_FILES` by hand, with the comment explaining why: the subset is a per-AGENT fact no scope-level default derives.
- Scope-expansion provenance, dropped from the rule file: `agents/glass-atrium-dev-front.md` holds the canonical token-drift prohibition, and this rule extended that requirement to the other UI-emitting DEV agents.

## Motion-token conflict — how it was resolved

- The former unconditional floor ("any animated component MUST declare which motion token is applied", with a label-shaped worked example) collided with the comment-density ceiling injected to every DEV agent at spawn, which says to comment only where the "why" is non-obvious and to omit in doubt. Two Tier-3 rules, a floor against a ceiling — precedence could not decide it.
- Resolution, applied in this pass: the declaration duty is narrowed to a token whose choice is NOT evident from its name, the worked example was replaced with one carrying a real reason, and the `Rationalization Rejection` row on the same subject was rewritten to match the narrowed duty instead of re-asserting the floor.
- The `prefers-reduced-motion` contract was re-anchored from "every motion declaration" to "every animated component" in the same edit. Without that re-anchor, narrowing the declaration duty would silently have narrowed the file's only accessibility obligation.
- The former `## Forbidden` section was a negative-form restatement of the sections above it. Its one non-duplicate member — the generic-system-font prohibition — moved into `## Drift Prevention`; the rest is gone. That prohibition is kept in this file because five of the six UI-emitting DEV agents have no other delivered channel for it.

## Cross-references (moved out of the rule file)

- `agents/templates/DESIGN.md` — the DESIGN.md schema (DTCG 2025.10), authored by glass-atrium-design-designer.
- `agents/glass-atrium-design-designer.md` — design philosophy, Motion Philosophy, AI Slop Tropes.
- `agents/glass-atrium-dev-front.md` — token SSoT consumption patterns, state-layer values, and its own `prefers-reduced-motion` canonical section.
- `scoped/scope-design.md` — Platform Design Token Policy and LLM output validation.

## Heading changes in this pass

- `## Motion-Token Declaration Requirement` → `## Motion Tokens`: the section no longer states an unconditional declaration requirement, so the old name misdescribed it. No corpus site cited that heading (grep over the tree at the time of the rename).
- `## Purpose`, `## Forbidden` and `## Cross-References` are gone; `## Mandatory Pre-Execution Gate`, `## Token Lookup Order`, `## Drift Prevention`, `## DTCG 2025.10 Awareness` and `## Rationalization Rejection` are unchanged.

## Readers, coupled tests, and one stale citation

- No code reads this file's TEXT. Its path is pinned in `registry_ops.py` `RULE_FILES` (exact-equality pinned by `scripts/test/test_agent_lifecycle_overhaul.py`, which also exercises it as the per-agent shared-rule add case) and in the manifest.
- `scoped/scope-dev.md` cites the file by name to say it does NOT gate a self-contained Tailwind-CDN exposed document; that citation still resolves.
- PARTLY STALE, outside this pass's file set: `agents/glass-atrium-design-designer.md` cites `scoped/shared-design-token-consumption.md` → `## Token Lookup Order` in its unresolved-canonical note. The heading still resolves, but two clauses of that note no longer describe the file: the "calls glass-atrium-dev-front the canonical enforcement site" characterization moved into this companion, and the "reaches no agent at spawn" clause is one the wave retires.
- STALE, outside this pass's file set: `agents/templates/DESIGN.md` cites `rules/shared-design-token-consumption.md` in its opening HTML comment. No file exists at that path (glob over `rules/**` returns nothing); the rule is at `scoped/shared-design-token-consumption.md`. Whether the citation was ever correct is not established here — only that it resolves to nothing today.
