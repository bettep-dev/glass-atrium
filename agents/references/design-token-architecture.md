# Token Architecture — 3-Tier Model, Multi-Mode Matrix, DTCG Grammar, AI Model Guidelines

> Reference for `glass-atrium-design-designer`, which reproduces these spec templates in DESIGN.md by hand.

## Applicability (opt-in escalation, not a default mandate)

- The 3-tier architecture and the multi-mode matrix below apply only to a **full design-system deliverable** (DESIGN.md / MASTER.md).
- A single-page philosophy doc, a canvas or a one-off palette keeps its flat shape.

## 3-Tier Token Architecture

- Every consumable token is an *alias reference* up the chain.
- The alias arrow (`→`) is written explicitly, so the chain stays auditable.

| Tier | Holds | Aliases | Example |
|------|-------|---------|---------|
| **Base** | raw values (OKLch / hex / px) | nothing (primitives) | `--base-neutral-0`, `--base-blue-50` |
| **Semantic** | purpose tokens | aliases **base only** | `--bgColor-default → {base.neutral.0}` |
| **Component** | variant tokens | aliases **semantic only** | `--btn-bgColor-rest → {control.bgColor.rest}` |

- Full chain example: `button.bgColor.rest` → `{control.bgColor.rest}` → `{base.neutral.X}`.

### Hard rules

- Raw values are forbidden outside the Base tier.
- Component / consumption examples reference semantic (or component) tokens — never base, never raw.
- DESIGN.md emits three labelled tables:
  - a `Base Primitives` table (raw values);
  - a `Semantic Tokens` table (`token → base alias` + role);
  - a `Component Tokens` table (`token → semantic alias`).

### Composite tokens

- Bundle correlated sub-properties into one composite token so they cannot desync:
  - **Typography** → `--text-{role}-{size}` bundling font-size + line-height + weight + tracking.
  - **Shadow** → `--shadow-{level}` bundling offset + blur + color.
  - **Border** → one composite bundling color + width + style.
- Where a composite exists, consumers use it, never its loose sub-properties.

## Multi-Mode Override Matrix

- Semantic token names are mode-invariant; each mode re-points the same semantic token to a different base primitive.

| Semantic token | light | dark | light-high-contrast | dark-high-contrast | colorblind (conditional) |
|----------------|-------|------|---------------------|--------------------|--------------------------|
| `bgColor-default` | `{base.neutral.0}` | `{base.neutral.900}` | `{base.neutral.0}` | `{base.neutral.950}` | … |
| `fgColor-default` | `{base.neutral.900}` | `{base.neutral.50}` | `{base.neutral.950}` | `{base.neutral.0}` | … |
| `borderColor-default` | `{base.neutral.200}` | `{base.neutral.700}` | `{base.neutral.500}` | `{base.neutral.400}` | … |

### Mode floor

| Modes | Required when | Contrast floor (text / UI) |
|-------|---------------|----------------------------|
| `light` + `dark` | a system deliverable | 4.5:1 / 3:1 |
| `*-high-contrast` (light + dark) | accessibility is declared in scope | 7:1 / 4.5:1 |
| `colorblind` / `tritanopia` | status or data-viz colors exist | 4.5:1 / 3:1 |

- An exhaustive mode set (the full 16-mode Primer matrix) is over-spec for most projects.

## DTCG Cell Grammar

- When DESIGN.md emits structured token definitions, use the W3C DTCG keys below as the cell vocabulary.
- Tables stay primary; a separate JSON artifact is not required.

| Key | Holds |
|-----|-------|
| `$value` | a raw value (Base tier only) or a `{tier.token.path}` alias reference (Semantic / Component tiers) |
| `$type` | the token category: `color` / `dimension` / `fontFamily` / `shadow` / `typography` / `duration` |
| `$description` | one-line role |

## AI Model Guidelines (structured form)

- The AI Model Guidelines section uses the structured shape below, not a prose list of Bad examples.
- Each token's role is stated once in the Semantic Key, not repeated per token.

### Semantic Key table

| Semantic | Meaning | Usage | Text pairing |
|----------|---------|-------|--------------|
| `danger` | destructive / error | error banners, delete actions | `fgColor-onEmphasis` on `bgColor-danger-emphasis` |
| `success` | positive / confirmed | success toasts, valid state | … |
| `accent` | primary brand action | CTA, links, focus | … |
| `neutral` | default UI surfaces / text | backgrounds, body text | … |

### Color-Pairing Logic Matrix (with NEVER rows)

| bg token | required fg token | NEVER |
|----------|-------------------|-------|
| `bgColor-*-emphasis` | `fgColor-onEmphasis` | — |
| `bgColor-muted` | `fgColor-default` | `fgColor-muted` (insufficient contrast) |
| `bgColor-danger-emphasis` | `fgColor-onEmphasis` | raw `fgColor-danger` |

### RFC-2119 keyword tables

| Category | MUST | SHOULD | NEVER |
|----------|------|--------|-------|
| Motion | duration ≤ ceiling per family | use named easing token | — |
| Typography | use composite shorthand | keep a bounded weight set | use loose `font-size`/`line-height` when a shorthand exists |
| Spacing | use the spacing scale | use the 8px-base scale steps | hard-code arbitrary px |

### Hallucination Guard

- Any token name not present in this spec MUST be flagged inline (e.g. suffix the unknown name with `/* check-token */`) so it cannot silently ship.

### Golden reference component

- One reference component rendered in each state — default / hover / active / focus / disabled — each state naming its tokens.
