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

## When to Use

- DESIGN.md palette emit — every fg/bg pair MUST be verified
- User-requested HTML primary documents on the dark canvas — text ≥ 4.5:1
- Code review — every color pair introduced or modified

## WCAG 2.2 Thresholds

| Element | AA | AAA |
|---------|----|----|
| Normal text (<18pt or <14pt bold) | 4.5:1 | 7:1 |
| Large text (≥18pt or ≥14pt bold) | 3:1 | 4.5:1 |
| UI components + graphical objects | 3:1 | — |

## Luminance Formula

Per WCAG 2.2:

1. Convert each sRGB channel C ∈ [0,1]: `C_linear = (C ≤ 0.04045) ? C/12.92 : ((C+0.055)/1.055)^2.4`
2. Relative luminance: `L = 0.2126·R_linear + 0.7152·G_linear + 0.0722·B_linear`
3. Contrast ratio: `(L1 + 0.05) / (L2 + 0.05)` where L1 = lighter, L2 = darker

## Computation Tool

First matching row wins.

| Condition | Tool |
|---|---|
| No Node runtime; `python3` or WebFetch available | `## Luminance Formula` as a `python3` one-off via Bash, or the WebAIM contrast checker's API via WebFetch |
| No Node runtime; neither `python3` nor WebFetch available | none: report the pair as unverified |
| A contrast package is already in the project's lock file | that package |
| Node runtime present | `npx accessible-color-contrast "<fg_hex>" "<bg_hex>"` |

A ratio worked out by hand is not a verification.

## Output Format

Return inline in the response, in this shape:

```
# Contrast Check: <fg> on <bg>

| Element | Ratio | AA | AAA |
|---------|-------|----|----|
| Normal text | N.NN:1 | PASS / FAIL (≥4.5) | PASS / FAIL (≥7.0) |
| Large text | N.NN:1 | PASS / FAIL (≥3.0) | PASS / FAIL (≥4.5) |
| UI / graphics | N.NN:1 | PASS / FAIL (≥3.0) | — |

**Verdict (for the pair's text size — normal or large, per the thresholds table)**: PASS / FAIL
**Remediation hint** (if FAIL): <adjustment direction, per the Remediation Hint Policy>
```

## Remediation Hint Policy

- A hint names an adjustment direction only: darken the text, lighten the background, swap the fg/bg pair, or use a larger text size to meet the 3:1 threshold.
- No hex values and no CSS: glass-atrium-design-designer chooses the replacement per brand palette.
