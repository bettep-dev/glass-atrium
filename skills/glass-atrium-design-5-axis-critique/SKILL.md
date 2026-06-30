---
name: glass-atrium-design-5-axis-critique
description: Applies design-designer.md Pre-Emit 5-Axis self-critique rubric (Philosophy / Hierarchy / Execution / Specificity / Restraint) with 0-10 banded scoring as machine-checkable pre-emit gate. Use when design-designer or dev-front / dev-react / dev-gsap artifact needs pre-emit gate scoring before canvas / motion-philosophy / DESIGN.md / HTML primary deliverable emit. Do NOT use for qa-code-reviewer external-judge scope (→ scope-qa.md LLM-as-Judge 4-Dimensions), post-emit design quality scoring (→ design-designer.md Design Evaluation 4-Axis), or non-design code review.
triggers:
  - design 5-axis
  - pre-emit critique
  - design-designer self-score
  - 5-axis self-critique
od:
  mode: review
  inputs:
    - name: artifact
      type: file_path
      label: design deliverable (canvas / philosophy / DESIGN.md / HTML)
  outputs:
    primary: critique_report.md
  capabilities_required: [Read]
---

<!-- 5-axis rubric (Philosophy / Hierarchy / Execution / Specificity / Restraint) adapted from nexu-io/open-design `design-templates/critique/SKILL.md` (Apache 2.0). Mirrors design-designer.md `## Pre-Emit 5-Axis Self-Critique (ADR-4 R2)` — design-designer.md remains SoT. -->

# Design 5-Axis Critique

## Overview

Single-agent self-critique mode (design-designer scores own work pre-emit). Mechanical application of 5 axes with 0-10 banded rubric and emit-gate rule. Designer.md `## Pre-Emit 5-Axis Self-Critique (ADR-4 R2)` is SoT.

## When to Use

- Turn 3+ of design-designer work — before emitting any canvas / motion-philosophy / DESIGN.md
- Pre-emit gate for dev-front / dev-react / dev-gsap HTML primary with visual concern
- Designer self-iteration loop

## 5 Axes (verbatim from design-designer.md SoT)

- **Philosophy**: consistency with stated design philosophy / brand direction / movement name. Does this deliverable embody the declared philosophy or drift from it?
- **Hierarchy**: visual hierarchy clarity. Does the eye traverse the intended path? Is the primary action obvious within 1 second?
- **Execution**: technical execution detail quality. Are spacing, alignment, contrast, and motion timing crafted rather than approximate?
- **Specificity**: real content vs placeholder / filler. Are values, copy, and components specific to the project — or generic AI-defaults pattern-matched from training data?
- **Restraint**: "one decisive flourish per design" — no overdesign. Is there exactly one signature gesture, or has the design become a collage of attention-seeking elements?

## Band Rubric (per axis, 0-10)

| Band | Range | Verdict |
|------|-------|---------|
| Broken | 0-4 | Axis is failing — deliverable cannot ship in current state |
| Functional | 5-6 | Axis meets baseline but lacks craft — iterate |
| Strong | 7-8 | Axis is well-executed — emit-ready |
| Exceptional | 9-10 | Axis is exemplary — preserve as reference |

## Per-Axis Evaluation Prompts

- **Philosophy**: Does the artifact's color / font / layout choices align with the stated movement name? Are deviations justified by brand context?
- **Hierarchy**: On first 1-second glance, what does the eye land on? Is that the intended primary action? Are secondary / tertiary tiers visually distinguishable?
- **Execution**: Are spacing values round multiples of a base unit (e.g., 4 / 8px)? Are color contrasts measured or guessed? Is motion timing easing-curved or default-linear?
- **Specificity**: Pick any 3 visible strings — are they real project values or placeholder / lorem-ipsum / round-number stat-slop?
- **Restraint**: Count attention-seeking gestures (gradient, glow, large animation, oversize hero element). >1 = overdesign — which is the signature, which gets removed?

## Emit-Gate Rule

If ANY axis < 7 (Broken or Functional band) → design-designer MUST iterate before emit. Pre-emit gate (not post-emit score) — deliverable does NOT leave the agent until all 5 axes ≥ 7.

## Iteration Protocol

Identify axis < 7 → revise specific dimension:
- Philosophy → re-read movement name
- Hierarchy → re-check focal point
- Execution → re-verify spacing / contrast values (pair with `glass-atrium-design-contrast-check` skill)
- Specificity → replace placeholders with real content
- Restraint → remove the second flourish

Re-score → repeat until all axes ≥ 7.

## Output Format

`critique_report.md`:

```
# 5-Axis Critique: <artifact>

| Axis | Score | Band | Evidence (1 sentence) |
|------|-------|------|----------------------|
| Philosophy | N | Strong | <evidence> |
| Hierarchy | N | Functional | <evidence> |
| Execution | N | Strong | <evidence> |
| Specificity | N | Broken | <evidence> |
| Restraint | N | Exceptional | <evidence> |

**Gate**: PASS (all ≥7) | ITERATE (axis < 7 listed)
**Next action**: <revise dimension X per iteration protocol>
```

## Distinction from Other Rubrics

- **Pre-emit (this skill)**: gates emit at design-designer's own turn 3 — single-agent self-critique
- **Post-emit Design Evaluation 4-Axis** (design-designer.md `## Design Evaluation 4-Axis`): scores deliverables that DO emit, weighted for visual identity (Identity 35% / Originality 35% / Craft 20% / Function 10%) — for learning-log signal
- **External-judge 4-Dim** (scope-qa.md): qa-code-reviewer / QA agents apply Coverage / Insight / Instruction-following / Clarity when reviewing designer-authored deliverables — different lens, different consumer

Both pre-emit and post-emit apply: pre-emit first (gate), post-emit after (signal).

## Cross-References

- Designer.md `## Pre-Emit 5-Axis Self-Critique (ADR-4 R2)` — SoT
- Designer.md `## Design Evaluation 4-Axis` — post-emit complement
- Scope-qa.md `## D8 Visual Decision Sub-Pass` — external-judge visual rubric
- `glass-atrium-design-anti-slop` skill — paired use for Specificity axis evidence
- `glass-atrium-design-contrast-check` skill — paired use for Execution axis evidence
