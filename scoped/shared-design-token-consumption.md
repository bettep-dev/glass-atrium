# Design Token Consumption Rules (Cross-Cutting Concern)

Applies to all DEV agents that emit UI markup or styling: dev-front · dev-react · dev-angular · dev-android · dev-gsap · dev-animator.

## Purpose

Prevent silent design-token re-derivation. When a project ships a `DESIGN.md` (per `~/.claude/agents/templates/DESIGN.md` schema) and/or a `motion-philosophy.md` (per design-designer Motion Philosophy contract), DEV agents MUST consume those documents — they are the project's design source-of-truth, not optional reference material.

## Mandatory Pre-Execution Gate

Before ANY UI/styling decision (component implementation, page layout, animation timing, color/font/spacing application):

- **If project contains `DESIGN.md`** at any level (root / `docs/` / `design-system/`) → MUST read before emitting markup or styles. Cross-link to `~/.claude/agents/dev-front.md` for token SSoT consumption patterns.
- **If project contains `motion-philosophy.md`** → MUST read before any animation / transition / spring-family decision.
- **If neither exists** → proceed using framework defaults, but flag the absence in `[COMPLETION]` `lesson` so the next session can request design-designer to author one.

Reading is non-negotiable — silent token re-derivation from screenshots, descriptions, or memory FORBIDDEN.

## Token Lookup Order

When applying a color / typography / spacing / motion value:

- **Order**: DESIGN.md (project-local SSoT) → dev-front SSoT (`~/.claude/agents/dev-front.md` — semantic token patterns) → platform config (`tailwind.config.{ts,js}` / Angular Material theme / Compose `MaterialTheme`).
- **Resolution rule**: project-local DESIGN.md wins over global dev-front SSoT wins over platform defaults. Never skip up the chain — if DESIGN.md is silent on a value, only THEN consult dev-front SSoT; if that is also silent, only THEN consult platform config.
- **Single SoT enforcement**: mirrors dev-front's existing token-SSoT rule. A value declared in DESIGN.md MUST NOT be re-declared elsewhere — drift risk.

## Drift Prevention

Arbitrary hex / rgb / oklch / dp values without verifying token existence FORBIDDEN:

- Hex literal in JSX / template / xml → check DESIGN.md `§2 Color` JSON block first; map to `--color-*` CSS variable or platform-equivalent token.
- Spacing literal (`margin: 17px`) → check DESIGN.md `§4 Spacing`; map to `--spacing-*` or re-design to fit the scale.
- Typography literal (`font-size: 19px`) → check DESIGN.md `§3 Typography`; map to `typography.*` token or re-design.
- Animation literal (`transition: 0.25s ease-in`) → check DESIGN.md `§7 Motion & Interaction`; map to `transition.*` token.

Cross-ref: `~/.claude/agents/dev-front.md` existing token-drift prohibition is the canonical enforcement site; this rule extends the requirement to all UI-emitting DEV agents.

## Motion-Token Declaration Requirement

Any animated component MUST declare which motion token (spring family OR `transition.*` token OR `duration.*` + `easing.*` pair) is applied:

- **Source**: spring families named in `motion-philosophy.md` (`spatial-default` · `spatial-fast` · `spatial-slow` · `effects-default` · `effects-fast` · `effects-slow`) per M3 Expressive contract.
- **Declaration site**: code-side comment (per `~/.claude/scoped/shared-comment-logging.md` "why over what") naming the applied family — e.g., `// motion: spatial-default (M3E Spatial, primary CTA tier)`.
- **`prefers-reduced-motion` contract**: every motion declaration MUST honor `@media (prefers-reduced-motion: reduce)` (CSS auto-honors; JS animations require explicit check). Fallback typically `transition: opacity` only — no spatial overshoot.
- **Mixing prohibition**: spring family consistency within a single element flow — mixing Spatial and Effects on one element FORBIDDEN (per design-designer Motion Philosophy choreography rules).

## DTCG 2025.10 Awareness

When the project's DESIGN.md is DTCG-aligned (per `~/.claude/agents/templates/DESIGN.md` schema using W3C Design Tokens 2025.10 format):

- Prefer DTCG-format token consumption — generated CSS variables in `:root {}` are the consumption layer; the JSON blocks are the SSoT.
- DTCG composite types in use: `color` · `typography` · `dimension` · `duration` · `cubicBezier` · `transition`.
- When DESIGN.md is NOT DTCG-aligned (legacy projects) → fall back to ad-hoc CSS variables, but flag in `[COMPLETION]` `lesson` for future migration to DTCG schema.
- Spec reference: `https://www.designtokens.org/schemas/2025.10/format.json` (first stable release, 2025-10-28).

## Forbidden

- Silent token re-derivation from designs (screenshots / mockups / descriptions) without consulting DESIGN.md.
- Ad-hoc color decisions when DESIGN.md exists — every color MUST resolve to a declared token.
- Ad-hoc spacing decisions when DESIGN.md exists — every dimension MUST resolve to the 8px scale (or declared base).
- Ad-hoc typography decisions when DESIGN.md exists — every text style MUST resolve to a declared typography token.
- Animation without motion-token declaration — every animated component requires a comment naming the spring family or transition token applied.
- Generic system font primaries (Inter / Roboto / Arial) when DESIGN.md declares brand families — per `~/.claude/agents/design-designer.md` AI Slop Tropes.

## Rationalization Rejection

| Excuse | Rebuttal |
|--------|----------|
| "It's just a small style tweak, no need to read DESIGN.md" | Small tweaks compound into drift. The token lookup is < 30 seconds; the maintenance debt from inconsistent tokens is permanent. |
| "I'll match the existing color visually" | Visual matching ≠ token consumption. Pixel-perfect hex match still creates a new declaration site (drift risk per Single SoT enforcement). Read the token name. |
| "DESIGN.md doesn't cover this exact case" | Either a token IS defined (you didn't find it — re-read) OR DESIGN.md genuinely lacks coverage → ask design-designer to extend it, do NOT invent a value. |
| "Motion is too trivial to declare a token" | Motion-token declaration is the only audit signal for spring-family consistency. Skipping declaration breaks choreography rules silently. |

> See the central **Rationalization Rejection Table** in [[GLOBAL_RULES#Rationalization Rejection Table (Central)]]

## Cross-References

- `~/.claude/agents/templates/DESIGN.md` — DESIGN.md schema (DTCG 2025.10) authored by design-designer
- `~/.claude/agents/design-designer.md` — design philosophy + Motion Philosophy + AI Slop Tropes SoT
- `~/.claude/agents/dev-front.md` — token SSoT consumption patterns + state layer values
- `~/.claude/rules/scope-design.md` — Platform Design Token Policy + LLM Output Validation
- W3C DTCG 2025.10 spec — `https://www.designtokens.org/schemas/2025.10/format.json`
