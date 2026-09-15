---
name: glass-atrium-design-contrast-check
description: Verifies WCAG 2.2 AA / AAA contrast ratios (4.5:1 normal text AA, 3:1 large text + UI components AA, 7:1 AAA) for color pairs in DESIGN.md palettes / HTML / CSS artifacts using mechanical luminance computation. Use before any design emit OR during code review when color pairs are introduced. Do NOT use for design originality scoring (→ glass-atrium-design-5-axis-critique), AI-slop catalog audit (→ glass-atrium-design-anti-slop), or motion / animation review.
triggers:
  - WCAG contrast
  - color contrast check
  - AA contrast verify
  - contrast ratio
---

# Contrast Check

## Overview

Mechanical WCAG 2.2 contrast verification: compute relative luminance per the sRGB algorithm, derive the contrast ratio, return AA / AAA pass-fail with a remediation hint. No creative judgment.

## When to Use

- DESIGN.md palette emit — every fg/bg pair MUST be verified
- User-requested HTML primary documents on the dark canvas (`scoped/scope-report.md` → `### Dark base default`) — text ≥ 4.5:1
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

## Computation Tool

Recommended CLI: `accessible-color-contrast` (WCAG 2.2 AA/AAA support):

```bash
npx accessible-color-contrast <fg_hex> <bg_hex>
```

- Alternatives: `colour-contrast-cli`, `color-contrast-checker`, `wcag-contrast`, `@mdhnpm/wcag-contrast-checker` — pick per the project's lock file.
- No Node runtime → apply the formula above by hand or use the WebAIM contrast checker.

## Output Format

Return inline in the response, in this shape:

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

- A hint names an adjustment direction only — the template's three, or "use a larger text size to meet the 3:1 threshold".
- No hex values and no CSS: glass-atrium-design-designer chooses the replacement per brand palette.

## Cross-References

- `scoped/scope-design.md` → `## LLM Output Validation [DESIGN]` — contrast verification gate before downstream DEV handoff
- `agents/glass-atrium-design-designer.md` → `## Red Flags` — WCAG AA not verified = flag
- `scoped/scope-report.md` → `### Dark base default` — dark-canvas contract for HTML primary body text
- `scoped/scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` — d8 axis P4 (WCAG AA contrast)
- `glass-atrium-design-5-axis-critique` Execution axis — paired use for spacing / contrast evidence
