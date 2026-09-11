# Design Token Consumption Rules (Cross-Cutting Concern)

Binds on any turn that emits UI markup, styling, or animation. A project's design documents are its token source of truth, not optional reference material.

## Mandatory Pre-Execution Gate

Run this before any UI decision — component implementation, page layout, animation timing, color/font/spacing application.

| Condition | Duty |
|---|---|
| project has a `DESIGN.md` (root / `docs/` / `design-system/`) | read it before emitting markup or styles |
| project has a `motion-philosophy.md` | read it before any animation / transition / spring-family decision |
| neither exists | proceed on framework defaults, and flag the absence in `[COMPLETION]` `lesson` so a later session can ask glass-atrium-design-designer to author one |

- Re-deriving a token value from a screenshot, a mockup, a description, or memory instead of reading the document is FORBIDDEN.

## Token Lookup Order

- **Order**: project `DESIGN.md` → the glass-atrium-dev-front token SSoT (`~/.glass-atrium/agents/glass-atrium-dev-front.md`, semantic token patterns) → platform config (`tailwind.config.{ts,js}` / Angular Material theme / Compose `MaterialTheme`).
- **Resolution**: the earliest source that speaks to the value wins. Never skip up the chain — consult the next source only once the previous one is silent.
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

- **Declaration**: where the applied token's choice is NOT evident from its name in context, a code comment names the token and the reason for that choice — e.g. `// motion: effects-fast — the drawer is fixed-height, so a spatial family would overshoot its edge`. A self-evident choice needs no comment; the comment-density ceiling governs there.
- **Source**: the spring families named in `motion-philosophy.md` (`spatial-default` · `spatial-fast` · `spatial-slow` · `effects-default` · `effects-fast` · `effects-slow`), per the M3 Expressive contract.
- **`prefers-reduced-motion`**: every animated component MUST honor `@media (prefers-reduced-motion: reduce)` — CSS auto-honors it, a JS animation requires an explicit check. The fallback is typically opacity-only, with no spatial overshoot.
- **Mixing**: mixing the Spatial and Effects families on one element is FORBIDDEN — one element flow keeps one family.

## DTCG 2025.10 Awareness

Applies only where a `DESIGN.md` exists AND is DTCG-aligned (W3C Design Tokens 2025.10, schema `https://www.designtokens.org/schemas/2025.10/format.json`).

- Consume the generated CSS variables in `:root {}`; the JSON blocks are the SSoT.
- Composite types in use: `color` · `typography` · `dimension` · `duration` · `cubicBezier` · `transition`.
- `DESIGN.md` present but not DTCG-aligned → fall back to ad-hoc CSS variables, and flag it in `[COMPLETION]` `lesson` for a later migration.

## Rationalization Rejection

| Excuse | Rebuttal |
|--------|----------|
| "It's just a small style tweak, no need to read DESIGN.md" | Small tweaks compound into drift. The lookup costs seconds; the inconsistency it prevents is permanent. |
| "I'll match the existing color visually" | A pixel-perfect hex match still creates a second declaration site. Read the token name. |
| "DESIGN.md doesn't cover this exact case" | Either the token exists and you have not found it — re-read — or coverage is genuinely missing → ask glass-atrium-design-designer to extend it. Inventing a value is FORBIDDEN. |
| "Motion is too trivial to declare a token" | Choosing a spring family IS a decision. Where the choice is not evident from the token name, that comment is the only record of why this family and not its sibling. |
