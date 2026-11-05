# Design Token Consumption Rules (Cross-Cutting Concern)

Binds on any turn that emits UI markup, styling, or animation.

## Mandatory Pre-Execution Gate

Run this before any UI decision — component implementation, page layout, animation timing, color/font/spacing application.

| Condition | Duty |
|---|---|
| project has a `DESIGN.md` (root / `docs/` / `design-system/`) | read it before emitting markup or styles |
| project has a `motion-philosophy.md` | read it before any animation / transition / spring-family decision |
| neither exists | proceed on framework defaults, and flag the absence in `[COMPLETION]` `concerns` |

- Why the flag: it lets an operator ask glass-atrium-design-designer to author the missing document.
- Re-deriving a token value from a screenshot, a mockup, a description, or memory instead of reading the document is FORBIDDEN.

## Token Lookup Order

- **Order**: project `DESIGN.md` → the glass-atrium-dev-front token SSoT (`~/.glass-atrium/agents/glass-atrium-dev-front.md` → `### Design Token 3-Tier System`) → platform config (`tailwind.config.{ts,js}` / Angular Material theme / Compose `MaterialTheme`).
- **Resolution**: the earliest source that speaks to the value wins; consult the next source only once the previous one is silent.
- **Single SoT**: a value declared in `DESIGN.md` MUST NOT be re-declared anywhere else.

## Drift Prevention

Writing a hex / rgb / oklch / px / dp literal without first checking whether a token exists is FORBIDDEN.

| Literal kind | Check | Map to |
|---|---|---|
| color in JSX / template / xml | `DESIGN.md` §2 Color JSON block | `--color-*` variable or the platform equivalent |
| spacing (`margin: 17px`) | §4 Spacing | `--spacing-*`, or re-design to fit the scale |
| typography (`font-size: 19px`) | §3 Typography | a `typography.*` token, or re-design |
| animation (`transition: 0.25s ease-in`) | §7 Motion & Interaction | a `transition.*` token |

- A generic system font (Inter / Roboto / Arial) as the primary family is FORBIDDEN where `DESIGN.md` declares brand families — resolve to the declared family.

## Motion Tokens

- **Declaration**: where the applied token's choice is not evident from its name in context, a code comment names the token and the reason for that choice.
  - Example: `// motion: effects-fast — the drawer is fixed-height, so a spatial family would overshoot its edge`
- **Source**: the spring families named in `motion-philosophy.md` (`spatial-default` · `spatial-fast` · `spatial-slow` · `effects-default` · `effects-fast` · `effects-slow`).
- **`prefers-reduced-motion`**: every animated component MUST honor `@media (prefers-reduced-motion: reduce)` — in CSS through the media query, in a JS animation through an explicit check.
  - Fallback: swap the element's Spatial family for the matching Effects family (overshoot removed), or go opacity-only.
  - A hard cut — an instant jump, or the animation stripped entirely — is FORBIDDEN: keep a non-spatial cue.
  - Concrete tokens come from the project's `motion-philosophy.md` reduced-motion contract.
- **Mixing**: mixing the Spatial and Effects families on one element within a flow is FORBIDDEN.

## DTCG 2025.10 Awareness

| `DESIGN.md` state | Duty |
|---|---|
| DTCG-aligned (W3C Design Tokens 2025.10, schema `https://www.designtokens.org/schemas/2025.10/format.json`) | consume the generated CSS variables in `:root {}`; the JSON blocks are the SSoT |
| present, not DTCG-aligned | fall back to ad-hoc CSS variables, and flag it in `[COMPLETION]` `concerns` for a later migration |

## Rationalization Rejection

| Excuse | Rebuttal |
|--------|----------|
| "It's just a small style tweak, no need to read DESIGN.md" | Small tweaks compound into drift, and the lookup costs seconds. |
| "I'll match the existing color visually" | A pixel-perfect hex match still creates a second declaration site. Read the token name. |
| "DESIGN.md doesn't cover this exact case" | Re-read: the token may exist. Genuinely missing → ask glass-atrium-design-designer to extend it; never invent a value. |
| "Motion is too trivial to declare a token" | Choosing a spring family is a decision; where the name does not show why, that comment is its only record. |
