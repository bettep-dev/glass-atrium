---
name: glass-atrium-design-contrast-check
description: Verifies WCAG 2.2 AA / AAA contrast ratios (4.5:1 normal text AA, 3:1 large text + UI components AA, 7:1 AAA) for color pairs in DESIGN.md palettes / HTML / CSS artifacts using mechanical luminance computation. Use before any design emit OR during code review when color pairs are introduced. Do NOT use for design originality scoring (→ glass-atrium-design-5-axis-critique), AI-slop catalog audit (→ glass-atrium-design-anti-slop), or motion / animation review.
triggers:
  - WCAG contrast
  - color contrast check
  - AA contrast verify
  - contrast ratio
od:
  mode: review
  inputs:
    - name: fg_color
      type: color
      label: foreground color (hex / rgb / rgba)
    - name: bg_color
      type: color
      label: background color (hex / rgb / rgba)
    - name: text_size
      type: enum
      values: [normal, large]
      default: normal
      label: normal (<18pt or <14pt bold) or large (≥18pt or ≥14pt bold)
  outputs:
    primary: contrast_report.md
  capabilities_required: [Bash, Read]
---

# Contrast Check

## Overview

Mechanical WCAG 2.2 contrast verification. Computes relative luminance per sRGB algorithm, derives contrast ratio, returns AA / AAA pass-fail with remediation hint. Public-domain methodology — no creative judgment.

## When to Use

- DESIGN.md palette emit — every fg/bg pair MUST be verified
- User-requested HTML primary documents per Wave 44 dark base policy — text ≥ 4.5:1, AAA ≥ 7:1 preferred
- Code review when color pair is introduced or modified

## WCAG 2.2 Thresholds

| Element | AA | AAA |
|---------|----|----|
| Normal text (<18pt or <14pt bold) | 4.5:1 | 7:1 |
| Large text (≥18pt or ≥14pt bold) | 3:1 | 4.5:1 |
| UI components + graphical objects | 3:1 | — |

## Luminance Formula

Per WCAG 2.2 (sRGB to linear, weighted RGB):

1. Convert each sRGB channel C ∈ [0,1]: `C_linear = (C ≤ 0.03928) ? C/12.92 : ((C+0.055)/1.055)^2.4`
2. Relative luminance: `L = 0.2126·R_linear + 0.7152·G_linear + 0.0722·B_linear`
3. Contrast ratio: `(L1 + 0.05) / (L2 + 0.05)` where L1 = lighter, L2 = darker

## Computation Tool (2026)

Recommended CLI: `accessible-color-contrast` (WCAG 2.2 AA/AAA support):

```bash
npx accessible-color-contrast <fg_hex> <bg_hex>
```

Alternative npm packages: `colour-contrast-cli`, `color-contrast-checker`, `wcag-contrast`, `@mdhnpm/wcag-contrast-checker`. Pick per project lock-file presence. If no Node runtime, fall back to manual formula application or WebAIM contrast checker URL.

## Output Format

`contrast_report.md`:

```
# Contrast Check: <fg> on <bg>

| Element | Ratio | AA | AAA |
|---------|-------|----|----|
| Normal text | N.NN:1 | PASS / FAIL (≥4.5) | PASS / FAIL (≥7.0) |
| Large text | N.NN:1 | PASS / FAIL (≥3.0) | PASS / FAIL (≥4.5) |
| UI / graphics | N.NN:1 | PASS / FAIL (≥3.0) | — |

**Verdict (for declared text_size)**: PASS / FAIL
**Remediation hint** (if FAIL): darken text by ΔL ≈ X OR lighten background OR swap fg/bg pair
```

## Remediation Hint Policy

Hint stays at adjustment-direction level (policy):
- "Darken text by ΔL ≈ X for AA pass"
- "Lighten background"
- "Swap fg/bg pair"
- "Use larger text size to meet 3:1 threshold"

No specific hex values, no concrete CSS — design-designer chooses replacement per brand palette.

## Cross-References

- Scope-design.md `## LLM Output Validation` — contrast verification gate before downstream DEV handoff
- Designer.md `## Red Flags` — WCAG AA not verified = flag
- Scope-report.md / scope-planning.md `**Dark base default (Wave 44)**` — AAA contrast (≥ 7:1) recommended for HTML primary body
- Scope-qa.md `## D8 Visual Decision Sub-Pass` — d8 axis P4 (WCAG AA contrast 4.5:1 text / 3:1 UI)
- `glass-atrium-design-5-axis-critique` Execution axis — paired use for spacing / contrast evidence
