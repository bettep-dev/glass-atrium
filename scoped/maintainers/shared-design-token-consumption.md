# Maintainer note — `scoped/shared-design-token-consumption.md`

Maintainer-facing material for that rule file. Nothing here binds an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership and scope provenance

- The UI-emitting DEV subset that takes this rule is declared per-agent on the `agent-registry.json` rows and summarized in `rules/glass-atrium/core-compliance-matrix.md` (Tier-3 table, ‡ footnote).
  - The rule file states no roster; its opening line states the task condition (a turn that emits UI markup, styling or animation).
- `scripts/agent_lifecycle/registry_ops.py` adds this file to `RULE_FILES` by hand, with the comment explaining why: the subset is a per-agent fact no scope-level default derives.
- **Canonical split with dev-front**: the rule file's `## Mandatory Pre-Execution Gate` and `## Drift Prevention` are canonical for every UI-emitting DEV agent.
  - The dev-front body keeps only its agent-specific delta (map `DESIGN.md` tokens → its 3-tier system) and a pointer.

## Motion-token conflict — how it was resolved

- **Declaration duty is narrowed, not a floor**: the duty binds only a token whose choice is not evident from its name.
  - Why: an unconditional "every animated component MUST declare its motion token" would collide with the comment-density ceiling every DEV agent receives (comment only where the "why" is non-obvious).
  - Both are Tier-3 rules, a floor against a ceiling, so precedence cannot decide between them.
  - The worked example carries a real reason; the `Rationalization Rejection` motion row matches the narrowed duty.
- **`prefers-reduced-motion` is anchored to "every animated component"**, not to "every motion declaration".
  - Why: anchoring it to the declaration would let the narrowed duty silently narrow the file's only accessibility obligation.
- **Reduced-motion fallback is canonical here**: `## Motion Tokens` → the **`prefers-reduced-motion`** bullet carries the Spatial → Effects swap, the opacity-only alternative and the hard-cut ban.
  - Non-UI readers that do not receive this file keep their own copies; the reporter and planner bodies cite this bullet.
  - The designer body keeps its own copy without citing it; `scoped/maintainers/glass-atrium-design-designer.md` → `## Copies kept in step with this body` (**Reduced-motion fallback statements**) cites it.

## Sections removed from the rule file

- **No `## Forbidden` section**: a prohibition list would restate the sections above it.
  - The generic-system-font prohibition lives in `## Drift Prevention`, its only delivered channel to the UI-emitting DEV agents other than glass-atrium-dev-front.
  - glass-atrium-dev-front's body carries its own anti-slop font ban.

## Cross-references (moved out of the rule file)

- `agents/templates/DESIGN.md` — the DESIGN.md schema (DTCG 2025.10), authored by glass-atrium-design-designer.
- `agents/glass-atrium-design-designer.md` — design philosophy, Motion Philosophy, AI Slop Tropes.
- `agents/glass-atrium-dev-front.md` — token SSoT consumption patterns and state-layer values; a reference to this file's reduced-motion bullet.
- `scoped/scope-design.md` — Platform Design Token Policy and LLM output validation.

## Headings other files cite

- `## Motion Tokens` — cited from:
  - UI DEV bodies (reduced-motion and spring families)
  - the reporter and planner bodies (reduced-motion)
  - `skills/glass-atrium-design-html-co-emission/SKILL.md` (its EXCLUDED reduced-motion row)
  - maintainer notes, `scoped/maintainers/glass-atrium-design-designer.md` → **Reduced-motion fallback statements** and `scoped/maintainers/scope-report.md` among them
  - The designer body does not cite it.
  - Keep it literal; add a sub-heading under it rather than renaming it.
  - The `agents/references/design-motion-tokens.md` title is a name clash, not a citer.
- `## Token Lookup Order` — cited by `scoped/maintainers/glass-atrium-design-designer.md` → `## Copies kept in step with this body` (the Token Architecture copies).
- `## Mandatory Pre-Execution Gate` — cited by:
  - `agents/glass-atrium-dev-front.md` → `## Guardrails`
  - `agents/glass-atrium-dev-gsap.md` and `agents/glass-atrium-dev-animator.md` → `## Pre-Execution Verification` **Motion philosophy**
  - `agents/glass-atrium-dev-android.md` → `## Pre-Execution Verification` **Motion**
  - `scoped/maintainers/glass-atrium-dev-android.md`
- `## Drift Prevention` — cited by `agents/glass-atrium-dev-front.md` → `## Guardrails`.
- Current citer set for any heading above: `git grep -F '<heading text>'` — re-run it before renaming, since the lists above drift.

## Readers, coupled tests, and one stale citation

- No code reads this file's text. Its path is pinned in `registry_ops.py` `RULE_FILES` (exact-equality pinned by `scripts/test/test_agent_lifecycle_overhaul.py`, which also exercises it as the per-agent shared-rule add case) and in the manifest.
- `scoped/maintainers/scope-dev.md` → `### glass-atrium-dev-front exposed-doc HTML participation = EXTEND, not creation` cites the file by name to say it does NOT gate a self-contained Tailwind-CDN exposed document; that citation still resolves.
- Growth check: this file is delivered whole to every UI DEV row, so re-run `python3 hooks/lib/inject_chunk.py --audit` after growing it and expect `events=none`.
