# Maintainer note — `scoped/shared-design-token-consumption.md`

Maintainer-facing material for that rule file. Nothing here binds an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership and scope provenance

- The UI-emitting DEV subset is declared per agent on the `agent-registry.json` rows and summarized in `rules/glass-atrium/core-compliance-matrix.md` (Tier-3 table, ‡ footnote).
  - The rule file states no roster, only the task condition in its opening line.
- `scripts/agent_lifecycle/registry_ops.py` → `RULE_FILES` adds the file by hand; the comment there says why.
- **Canonical split with dev-front**: the rule file's `## Mandatory Pre-Execution Gate` and `## Drift Prevention` are canonical for every UI-emitting DEV agent.
  - The dev-front body keeps only its agent-specific delta (map `DESIGN.md` tokens → its 3-tier system) and a pointer.

## Motion-token conflict — how it was resolved

- **Declaration duty is narrowed, not a floor**: the duty binds only a token whose choice is not evident from its name.
  - Why: an unconditional duty would collide with the comment-density ceiling every DEV agent receives; both are Tier-3 rules, a floor against a ceiling, so precedence cannot decide between them.
  - The worked example carries a real reason; the `Rationalization Rejection` motion row matches the narrowed duty.
- **`prefers-reduced-motion` is anchored to "every animated component"**, not to "every motion declaration".
  - Why: anchoring it to the declaration would let the narrowed duty silently narrow the rule file's only accessibility obligation.
- **Reduced-motion fallback is canonical in the rule file**: `## Motion Tokens` → the **`prefers-reduced-motion`** bullet.
  - The designer body keeps its own copy without citing it.
  - Readers that do not receive the rule file keep their own copies: `scoped/maintainers/glass-atrium-design-designer.md` → **Reduced-motion fallback statements**.

## Sections removed from the rule file

- **No `## Forbidden` section**: a prohibition list would restate the rule file's other sections.
  - The generic-system-font prohibition lives in `## Drift Prevention`, its only delivered channel to the UI-emitting DEV agents other than glass-atrium-dev-front.
  - glass-atrium-dev-front's body carries its own anti-slop font ban.

## Cross-references (moved out of the rule file)

- `agents/templates/DESIGN.md` — the DESIGN.md schema (DTCG 2025.10).
- `agents/glass-atrium-design-designer.md` — design philosophy, Motion Philosophy, AI Slop Tropes.
- `agents/glass-atrium-dev-front.md` — token SSoT consumption patterns and state-layer values.
- `scoped/scope-design.md` — Platform Design Token Policy and LLM output validation.

## Headings other files cite

| Heading | Cited from |
|---|---|
| `## Motion Tokens` | UI DEV bodies (reduced motion, spring families) · reporter, planner bodies · html-co-emission skill · maintainer notes |
| `## Token Lookup Order` | `scoped/maintainers/glass-atrium-design-designer.md` → `## Copies kept in step with this body` |
| `## Mandatory Pre-Execution Gate` | dev-front `## Guardrails` · dev-gsap, dev-animator **Motion philosophy** · dev-android **Motion** · dev-android note |
| `## Drift Prevention` | dev-front `## Guardrails` |

- `## Motion Tokens`: keep it literal; add a sub-heading under it rather than renaming.
- The `agents/references/design-motion-tokens.md` title is a name clash, not a citer.
- Current citers: `git grep -F '<heading text>'`; re-run it before renaming, since this table drifts.

## Readers, coupled tests, and one stale citation

- No code reads the rule file's text.
- Its path is pinned in `RULE_FILES` and in the manifest.
  - `scripts/test/test_agent_lifecycle_overhaul.py` pins it by exact equality: absent from the DEV defaults, appended by the per-agent shared-rule add case.
- `scoped/maintainers/scope-dev.md` → `### glass-atrium-dev-front exposed-doc HTML participation = EXTEND, not creation` cites the file by name to say it does not gate a self-contained Tailwind-CDN exposed document; the citation resolves.
- Growth check: the rule file is delivered whole to every UI DEV row, so re-run `python3 hooks/lib/inject_chunk.py --audit` after growing it and expect `events=none`.
