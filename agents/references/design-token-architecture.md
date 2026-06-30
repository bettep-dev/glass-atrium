# Token Architecture — 3-Tier Model, Multi-Mode Matrix, DTCG Grammar, AI Model Guidelines

> Reference for `design-designer` agent. By-hand design-token authoring contract: the base→semantic→component tier model, the multi-mode override matrix, DTCG cell grammar, and the structured AI Model Guidelines shape. The agent reproduces these tables in DESIGN.md by hand — they are reproducible spec templates, not build-tool plumbing (the agent runs no compiler).

## Applicability (opt-in escalation, not a default mandate)

The 3-tier architecture + multi-mode matrix below applies ONLY to a **full design-system deliverable** (DESIGN.md / MASTER.md). It does NOT gate a single-page philosophy doc, a canvas, or a one-off palette — those keep the existing flat shape. Multi-mode columns are opt-in escalation ("light+dark for system deliverables; add high-contrast when accessibility is in scope"), never a universal palette mandate.

---

## 3-Tier Token Architecture

Strict 3-tier separation where every consumable token is an *alias reference* up the chain, never a raw value at the consumption layer. The alias arrow (`→`) is written explicitly so the chain is auditable.

| Tier | Holds | Aliases | Example |
|------|-------|---------|---------|
| **Base** | the ONLY raw-value layer (raw OKLch / hex / px) | nothing (primitives) | `--base-neutral-0`, `--base-blue-50` |
| **Semantic** | purpose tokens | aliases **base only** | `--bgColor-default → {base.neutral.0}` |
| **Component** | variant tokens | aliases **semantic only** | `--btn-bgColor-rest → {control.bgColor.rest}` |

Full chain example: `button.bgColor.rest` → `{control.bgColor.rest}` → `{base.color.neutral.X}`.

**Hard rules**: raw values are FORBIDDEN in the Semantic + Component tiers. Component / consumption examples reference semantic (or component) tokens, never base, never raw. DESIGN.md emits three labelled tables — a `Base Primitives` table (raw values, the only place they appear), a `Semantic Tokens` table (`token → base alias` + role), and a `Component Tokens` table (`token → semantic alias`).

### Composite tokens

Bundle correlated sub-properties into ONE composite token so they cannot desync:

- **Typography** → a single `--text-{role}-{size}` shorthand bundling font-size + line-height + weight + tracking.
- **Shadow** → a single `--shadow-{level}` bundling offset + blur + color.
- **Border** → a single composite bundling color + width + style.

Rule: consumers use the **composite** token, never the loose sub-properties when a composite exists (prevents line-height / weight desync).

---

## Multi-Mode Override Matrix

A single token source compiles to many themes. Semantic token NAMES are mode-invariant; each mode re-points the SAME semantic token to a DIFFERENT base primitive. Rows = semantic tokens, columns = modes, cells = the base primitive each token points to in that mode.

| Semantic token | light | dark | light-high-contrast | dark-high-contrast | colorblind (conditional) |
|----------------|-------|------|---------------------|--------------------|--------------------------|
| `bgColor-default` | `{base.neutral.0}` | `{base.neutral.900}` | `{base.neutral.0}` | `{base.neutral.950}` | … |
| `fgColor-default` | `{base.neutral.900}` | `{base.neutral.50}` | `{base.neutral.950}` | `{base.neutral.0}` | … |
| `borderColor-default` | `{base.neutral.200}` | `{base.neutral.700}` | `{base.neutral.500}` | `{base.neutral.400}` | … |

**Mode floor**:

- `light` + `dark` — mandatory for SYSTEM deliverables.
- `*-high-contrast` (light + dark) — mandatory whenever accessibility is declared in scope; high-contrast columns raise the floor to **7:1 text / 4.5:1 UI** (vs 4.5:1 / 3:1 baseline).
- `colorblind` / `tritanopia` — conditional, required only when status / data-viz colors exist.

(The full 16-mode Primer matrix is over-spec for most projects — the *model* transfers, not the exhaustive count.)

---

## DTCG Cell Grammar

When DESIGN.md emits structured token definitions, use the W3C DTCG quartet as the cell vocabulary (tables stay primary; a full separate JSON artifact is explicitly NOT required):

| Key | Holds |
|-----|-------|
| `$value` | a raw value (Base tier only) OR a `{tier.token.path}` alias reference (Semantic / Component tiers) |
| `$type` | the token category: `color` / `dimension` / `fontFamily` / `shadow` / `typography` / `duration` |
| `$description` | one-line role |

Aliases use `{tier.token.path}` curly-brace notation, **values-only**. This formalizes the 3-tier `→` arrows.

---

## AI Model Guidelines (structured form)

The AI Model Guidelines section uses the structured shape below (not prose "2-3 Bad examples"). Each token's role is stated ONCE in the Semantic Key, not repeated per token.

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
| `bgColor-muted` | `fgColor-default` | NEVER `fgColor-muted` (insufficient contrast) |
| `bgColor-danger-emphasis` | `fgColor-onEmphasis` | NEVER raw `fgColor-danger` |

### RFC-2119 keyword tables

| Category | MUST | SHOULD | NEVER |
|----------|------|--------|-------|
| Motion | duration ≤ ceiling per family | use named easing token | exceed the duration ceiling |
| Typography | use composite shorthand | prefer composite type tokens; keep a bounded weight set | use loose `font-size`/`line-height` when a shorthand exists |
| Spacing | use the spacing scale | use the 8px-base scale steps | hard-code arbitrary px |

### Hallucination Guard

Any token name NOT present in this spec MUST be flagged inline (e.g. suffix the unknown name with `/* check-token */`) so it cannot silently ship.

### Golden reference component

A single reference component rendered across ALL 5 interactive states (default / hover / active / focus / disabled), each state naming its tokens — replaces the prose "Bad examples".
