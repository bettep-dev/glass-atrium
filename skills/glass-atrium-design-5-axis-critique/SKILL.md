---
name: glass-atrium-design-5-axis-critique
description: Applies the glass-atrium-design-designer.md Pre-Emit 5-Axis self-critique (Philosophy / Hierarchy / Execution / Specificity / Restraint, 0-10 banded) through per-axis evaluation prompts and an inline critique shape. Use when glass-atrium-design-designer scores its own canvas / motion-philosophy / DESIGN.md / HTML primary deliverable before emit. Do NOT use for glass-atrium-qa-code-reviewer external-judge scope (→ scope-qa.md LLM-as-Judge 4-Dimensions), post-emit design quality scoring (→ glass-atrium-design-designer.md Design Evaluation 4-Axis), or non-design code review.
triggers:
  - design 5-axis
  - pre-emit critique
  - glass-atrium-design-designer self-score
  - 5-axis self-critique
---

<!-- 5-axis rubric (Philosophy / Hierarchy / Execution / Specificity / Restraint) adapted from nexu-io/open-design `design-templates/critique/SKILL.md` (Apache 2.0). Rubric SoT: glass-atrium-design-designer.md `## Pre-Emit 5-Axis Self-Critique`. -->

# Design 5-Axis Critique

## Overview

- Single-agent self-critique: glass-atrium-design-designer scores its own work before emit.
- The axes, band rubric, emit-gate rule and iteration protocol live in `agents/glass-atrium-design-designer.md` → `## Pre-Emit 5-Axis Self-Critique`.
- This skill adds the per-axis evaluation prompts and the inline output shape.

## When to Use

- Turn 3+ of glass-atrium-design-designer work — before emitting any canvas / motion-philosophy / DESIGN.md
- Designer self-iteration loop

## Per-Axis Evaluation Prompts

- **Philosophy**: Does the artifact's color / font / layout choices align with the stated movement name? Are deviations justified by brand context?
- **Hierarchy**: On first 1-second glance, what does the eye land on? Is that the intended primary action? Are secondary / tertiary tiers visually distinguishable?
- **Execution**: Are spacing values round multiples of a base unit (e.g., 4 / 8px)? Are color contrasts measured or guessed? Is motion timing easing-curved or default-linear?
- **Specificity**: Pick any 3 visible strings — are they real project values or placeholder / lorem-ipsum / round-number stat-slop?
- **Restraint**: Count attention-seeking gestures (gradient, glow, large animation, oversize hero element). >1 = overdesign — which is the signature, which gets removed?

## Output Format

Return inline in the response, in this shape:

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
**Next action**: <revise dimension X per the iteration protocol>
```

## Cross-References

- `agents/glass-atrium-design-designer.md` → `## Pre-Emit 5-Axis Self-Critique` — SoT for the axes, band rubric, emit-gate rule and iteration protocol
- `agents/glass-atrium-design-designer.md` → `## Design Evaluation 4-Axis (1-5 each, 20 total)` — post-emit complement
- `scoped/scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` — external-judge visual rubric
- `glass-atrium-design-anti-slop` skill — paired use for Specificity axis evidence
- `glass-atrium-design-contrast-check` skill — paired use for Execution axis evidence
