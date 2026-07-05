<!-- 9-section structure adapted from nexu-io/open-design docs/design-systems.md (Apache 2.0) · DTCG 2025.10 schema integration -->
<!-- This template is consumed by glass-atrium-design-designer (authoring) + DEV-scope agents (consumption per rules/shared-design-token-consumption.md) + Figma Make / MCP-fed coding agents (per AI Model Guidelines in §6) -->
<!-- Authoring contract: every section MUST be filled. Empty sections signal incomplete design system. Anti-patterns (§9) cross-link to glass-atrium-design-designer.md AI Slop Tropes — do NOT duplicate. -->

# [Design System Name]

> **Created**: YYYY-MM-DD
> **Version**: 0.1.0
> **Author**: [glass-atrium-design-designer name / agent]
> **Brand**: [brand reference name / source URL]
> **Category**: [SaaS / E-commerce / Finance / Healthcare / Education / Editorial / Other]

---

## 1. Visual Theme & Atmosphere

> Prose — establish the design philosophy, movement name, and emotional anchor. 4-6 paragraphs covering: Space+Form → Color+Material → Scale+Rhythm → Composition+Balance → Visual Hierarchy.

**Movement Name**: [unique design philosophy name, e.g., "Concrete Poetry" / "Chromatic Language" / "Analog Meditation"]

**Atmosphere**: [1-2 sentences capturing the felt sense]

**Philosophy** (4-6 paragraphs):

[Paragraph 1 — Space+Form: how negative space, geometric relationships, and structural form establish the visual foundation]

[Paragraph 2 — Color+Material: palette intent, material metaphor (paper / glass / metal / earth), light treatment]

[Paragraph 3 — Scale+Rhythm: type scale ratio, spacing cadence, vertical rhythm, repetition vs surprise]

[Paragraph 4 — Composition+Balance: grid intent, asymmetry strategy, focal points, breathing room]

[Paragraph 5 — Visual Hierarchy: how the eye traverses the design, what dominates, what recedes]

[Optional Paragraph 6 — Craft signature: the one decisive flourish that distinguishes this system from generic AI aesthetics]

---

## 2. Color

> DTCG 2025.10 schema embedded inside `:root {}` CSS variables. Tokens carry `$value` + `$type: "color"` + `$description`. Prose explains intent before the JSON block.

**Palette intent**: [1-2 sentences — what role the palette plays, semantic vs decorative, brand anchors]

**Color tokens** (DTCG 2025.10 format):

```json
{
  "$schema": "https://www.designtokens.org/schemas/2025.10/format.json",
  "color": {
    "brand": {
      "primary": {
        "$type": "color",
        "$value": "#141413",
        "$description": "Near-black brand anchor — use for body text on light backgrounds, primary CTA backgrounds in dark mode"
      },
      "surface": {
        "$type": "color",
        "$value": "#faf9f5",
        "$description": "Warm white canvas — primary background, never pure #ffffff"
      },
      "accent": {
        "$type": "color",
        "$value": "#d97757",
        "$description": "Signature accent — CTAs and interaction states only, never decorative"
      }
    },
    "neutral": {
      "100": { "$type": "color", "$value": "#e8e6dc", "$description": "Light gray — disabled surfaces" },
      "500": { "$type": "color", "$value": "#b0aea5", "$description": "Mid gray — secondary borders, dividers" }
    },
    "semantic": {
      "success": { "$type": "color", "$value": "#788c5d", "$description": "Success — verdict OK, completed states" },
      "info":    { "$type": "color", "$value": "#6a9bcc", "$description": "Info — informational badges, neutral signals" }
    }
  }
}
```

**Generated CSS variables** (consumption layer — glass-atrium-dev-front consumes):

```css
:root {
  --color-brand-primary: #141413;
  --color-brand-surface: #faf9f5;
  --color-brand-accent: #d97757;
  --color-neutral-100: #e8e6dc;
  --color-neutral-500: #b0aea5;
  --color-semantic-success: #788c5d;
  --color-semantic-info: #6a9bcc;
}
```

**Contrast verification**: [list pairings tested — e.g., `--color-brand-primary on --color-brand-surface = 16.2:1 AAA pass`]

---

## 3. Typography

> DTCG 2025.10 `$type: "typography"` composite tokens. Prose declares family intent + weight discipline before the JSON block.

**Family intent**: [Heading family + body family + monospace fallback + Korean fallback per `Pretendard` if applicable]

**Typography tokens** (DTCG 2025.10 composite format):

```json
{
  "typography": {
    "heading": {
      "display": {
        "$type": "typography",
        "$value": {
          "fontFamily": ["Poppins", "Pretendard", "Arial", "sans-serif"],
          "fontSize": { "value": 48, "unit": "px" },
          "fontWeight": 600,
          "lineHeight": 1.1,
          "letterSpacing": { "value": -0.02, "unit": "em" }
        },
        "$description": "Display heading — hero only, single instance per page"
      },
      "h1": {
        "$type": "typography",
        "$value": {
          "fontFamily": ["Poppins", "Pretendard", "Arial", "sans-serif"],
          "fontSize": { "value": 32, "unit": "px" },
          "fontWeight": 600,
          "lineHeight": 1.2,
          "letterSpacing": { "value": -0.01, "unit": "em" }
        },
        "$description": "Section heading"
      }
    },
    "body": {
      "default": {
        "$type": "typography",
        "$value": {
          "fontFamily": ["Lora", "Pretendard", "Georgia", "serif"],
          "fontSize": { "value": 16, "unit": "px" },
          "fontWeight": 400,
          "lineHeight": 1.6,
          "letterSpacing": { "value": 0, "unit": "em" }
        },
        "$description": "Body copy — readable at 1.6 line-height"
      }
    }
  }
}
```

**Weight discipline**: ≤3 weights total · 1 signature weight (the "voice" of the brand).

**Numeric-to-Unit Visual Ratio** (number-centric UI): approximately 2:1 size ratio between numeric value and unit. Reference pairs: Hero 48/24 · KPI 36/18 · Donut 24/12 · Chart 18/10 · List 17/11. Concrete numbers derive from this project's type scale (not hardcoded).

**OpenType features**: declare `font-feature-settings` per family — e.g., `tnum` (tabular numerals) required for financial / data UI.

---

## 4. Spacing

> DTCG 2025.10 `$type: "dimension"` tokens. 8px base unit by default; declare custom base if different.

**Base unit**: 8px (multiples enforced via lint).

**Spacing tokens** (DTCG 2025.10 format):

```json
{
  "spacing": {
    "0":  { "$type": "dimension", "$value": { "value": 0,  "unit": "px" } },
    "1":  { "$type": "dimension", "$value": { "value": 4,  "unit": "px" }, "$description": "Quarter-unit — inline gap" },
    "2":  { "$type": "dimension", "$value": { "value": 8,  "unit": "px" }, "$description": "Base unit — tight cluster" },
    "3":  { "$type": "dimension", "$value": { "value": 12, "unit": "px" } },
    "4":  { "$type": "dimension", "$value": { "value": 16, "unit": "px" }, "$description": "Card padding default" },
    "6":  { "$type": "dimension", "$value": { "value": 24, "unit": "px" }, "$description": "Section gap default" },
    "8":  { "$type": "dimension", "$value": { "value": 32, "unit": "px" } },
    "12": { "$type": "dimension", "$value": { "value": 48, "unit": "px" }, "$description": "Major section break" }
  }
}
```

**Touch target minimum**: 44×44px (WCAG 2.5.5) — applies to all interactive elements regardless of token name.

---

## 5. Layout & Composition

> Prose — declare grid intent, breakpoints, container discipline.

**Grid**: [e.g., 12-column on desktop, 4-column on mobile, max-width 1200px with 32px gutters]

**Breakpoints**:

| Name | Min-width | Intent |
|------|-----------|--------|
| `sm` | 640px | Mobile landscape / small tablet |
| `md` | 768px | Tablet portrait |
| `lg` | 1024px | Tablet landscape / small desktop |
| `xl` | 1280px | Desktop |

**Container discipline** (opt-in): [Declare whether "all content inside cards" applies — if yes, direct background placement is forbidden; otherwise magazine/hero layouts permitted.]

**Composition rules**:
- [Declare hierarchy levels — typically 3: H1/H2/Body]
- [Declare asymmetry strategy if applicable]
- [Forbidden patterns: identical section type ≥3 times in a row → redesign required]

---

## 6. Components

> Per-component spec: 7 properties × 5 states matrix. Each component name maps to a single source-of-truth file in the component library.

**Component contract** (per component): 7 properties (BG / Text / Padding / Radius / Shadow / Hover / Purpose) × 5 states (default / hover / active / focus / disabled). State alpha values (hover / focus / active) derive from glass-atrium-dev-front State Layers SSoT (`~/.claude/agents/glass-atrium-dev-front.md`).

**Example — Button (Primary)**:

| Property | default | hover | active | focus | disabled |
|----------|---------|-------|--------|-------|----------|
| BG | `var(--color-brand-primary)` | +5% lightness | -5% lightness | default + 2px outline | `var(--color-neutral-500)` |
| Text | `var(--color-brand-surface)` | inherit | inherit | inherit | `var(--color-neutral-100)` |
| Padding | `var(--spacing-3) var(--spacing-6)` | — | — | — | — |
| Radius | 8px | — | — | — | — |
| Shadow | `0 1px 2px rgba(0,0,0,0.08)` | `0 2px 4px rgba(0,0,0,0.12)` | `0 1px 1px rgba(0,0,0,0.06)` | — | none |
| Purpose | Primary CTA — single per viewport | — | — | — | — |

**Component inventory**: [List all components — Button (primary/secondary/tertiary) · Input · Card · Modal · Toast · Badge · Avatar · etc.]

---

## 7. Motion & Interaction

> DTCG 2025.10 `$type: "transition"` composite tokens compose `duration` + `delay` + `timingFunction`. Spring-family naming (M3 Expressive Spatial/Effects) is declared in companion `motion-philosophy.md` (designer-owned); this section names the consumable tokens.

**Motion philosophy reference**: see `motion-philosophy.md` (companion file) for spring family selection + WHAT-why rationale.

**Motion tokens** (DTCG 2025.10 composite format):

```json
{
  "duration": {
    "instant":  { "$type": "duration", "$value": { "value": 100, "unit": "ms" }, "$description": "Hover state changes" },
    "fast":     { "$type": "duration", "$value": { "value": 200, "unit": "ms" }, "$description": "Standard transitions" },
    "moderate": { "$type": "duration", "$value": { "value": 300, "unit": "ms" }, "$description": "Modal entry, panel slide" },
    "slow":     { "$type": "duration", "$value": { "value": 500, "unit": "ms" }, "$description": "Page transitions, hero motion" }
  },
  "easing": {
    "standard":  { "$type": "cubicBezier", "$value": [0.4, 0.0, 0.2, 1.0], "$description": "Default ease — most transitions" },
    "decelerate": { "$type": "cubicBezier", "$value": [0.0, 0.0, 0.2, 1.0], "$description": "Enter animations" },
    "accelerate": { "$type": "cubicBezier", "$value": [0.4, 0.0, 1.0, 1.0], "$description": "Exit animations" }
  },
  "transition": {
    "standard": {
      "$type": "transition",
      "$value": {
        "duration": { "value": 200, "unit": "ms" },
        "delay":    { "value": 0,   "unit": "ms" },
        "timingFunction": [0.4, 0.0, 0.2, 1.0]
      },
      "$description": "Default transition — composes fast duration + standard easing"
    },
    "modal-enter": {
      "$type": "transition",
      "$value": {
        "duration": { "value": 300, "unit": "ms" },
        "delay":    { "value": 0,   "unit": "ms" },
        "timingFunction": [0.0, 0.0, 0.2, 1.0]
      },
      "$description": "Modal entry — moderate duration + decelerate easing"
    }
  }
}
```

**`prefers-reduced-motion` contract**: every animated component MUST honor `@media (prefers-reduced-motion: reduce)` — typically substitute `transition: opacity` only (no spatial motion). Browser auto-honors when CSS uses `@media` query; JS-driven animations require explicit check.

**Spring family declaration** (consumption side — glass-atrium-dev-front maps spring families to CSS / Tailwind half-life): families named in `motion-philosophy.md` — `spatial-default` · `spatial-fast` · `spatial-slow` · `effects-default` · `effects-fast` · `effects-slow`.

---

## 8. Voice & Brand

> Prose — declare brand voice, copy tone, microcopy rules, and AI Model Guidelines (for Figma Make / MCP-fed agents).

**Brand voice**: [1-2 sentences — e.g., "Concise, technically precise, warmly human. Never corporate, never breathless."]

**Copy tone rules**:
- [e.g., "Verb-stem CTAs in Korean (`확인` not `확인합니다`)"]
- [e.g., "No exclamation marks in body copy; permitted in success toasts only"]
- [e.g., "Numbers always with units; never bare numerics in prose"]

**Microcopy patterns**:

| Context | Pattern | Example |
|---------|---------|---------|
| Empty state | `[Object] 없음 — [first action verb]로 시작` | `보고서 없음 — 새 보고서 만들기로 시작` |
| Loading | Skeleton UI — no text | — |
| Error inline | `[Field] [problem] — [resolution]` | `이메일 형식 오류 — example@domain 형식 입력` |
| Success toast | `[Object] [past-tense verb]` | `보고서 저장됨` |

### AI Model Guidelines (Figma Make / MCP-fed agents — NON-NEGOTIABLE)

> This subsection is read by AI codegen tools. State which tokens are non-negotiable vs flexible. Provide 2-3 "Bad" anchors to constrain the model.

**Non-negotiable**:
- All colors MUST resolve to `--color-*` CSS variables defined in §2. Inventing hex values FORBIDDEN.
- All spacing MUST resolve to `--spacing-*` defined in §4. Arbitrary px values FORBIDDEN.
- All typography MUST resolve to `typography.*` tokens defined in §3. Generic system fonts (Inter / Roboto / Arial as primary) FORBIDDEN.
- All motion MUST resolve to `transition.*` tokens defined in §7. Ad-hoc `transition: 0.2s ease` declarations FORBIDDEN.

**Flexible** (glass-atrium-design-designer override permitted):
- Layout composition (grid placement, asymmetry decisions)
- Component variant naming (within established families)
- Microcopy phrasing (within voice/tone rules)

**Bad anchors** (concrete violations to avoid):
- `style="color: #333"` — Bad (hardcoded hex, no token reference). Good: `class="text-brand-primary"`.
- `style="margin: 20px"` — Bad (non-8px-multiple, no token). Good: `class="m-6"` (24px = spacing-6).
- `<div class="rounded-lg shadow-md bg-zinc-100 ...">` — Bad if every card uses identical pattern (shadcn-ification AI slop trope). Good: vary per component intent.

---

## 9. Anti-Patterns (Forbidden)

> SoT cross-reference — do NOT duplicate the catalogue. Authority lives in `~/.claude/agents/glass-atrium-design-designer.md` → `### AI Slop Tropes` section. This section enforces that all design decisions in this DESIGN.md avoid those patterns.

**Reference**: see `~/.claude/agents/glass-atrium-design-designer.md` → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` for the canonical anti-pattern catalogue covering:

- **Canvas/color tropes** (warm beige defaults · aggressive gradients · pure-black text)
- **Layout/container tropes** (rounded boxes with left-border accents · SVG-as-illustration · ≥3 identical section types in a row)
- **Font tropes** (Inter/Roboto/Arial/generic system fonts · gratuitous emoji)
- **Content tropes** (stat-slop · filler copy · invented metrics)
- **2026 community patterns** (shadcn-ification · Lucide uniform stroke · AI-3D floating mesh · Vibe-Coding centerism · glassmorphism overuse)
- **Workflow tropes** (Figma Make merged without glass-atrium-design-designer sign-off)

**Project-specific additions** (optional — add only if this project has unique forbidden patterns NOT in the SoT):

- [e.g., "This project's brand explicitly forbids serif accent fonts even when Lora body is in use — heading fallback is Pretendard, never Georgia."]
- [Leave empty if no project-specific additions]

**Compliance audit**: before merging any UI PR, verify zero matches against the AI Slop Tropes catalogue. Code-reviewer applies scope-qa LLM-as-Judge 4-Dim + d8 visual sub-pass to all HTML primary deliverables (per `~/.claude/rules/scope-qa.md`).
