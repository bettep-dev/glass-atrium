---
name: glass-atrium-design-anti-slop
description: Detects AI-slop visual design patterns (color/font/layout/content/iconography/effects/emoji) by mechanical inspection of HTML / CSS / canvas / PDF artifacts per design-designer.md AI Slop Tropes SoT + 2026 community patterns. Use when reviewing design-designer or UI-emitting DEV agent deliverables for generic-AI aesthetics before emit OR during code review. Do NOT use for plain code review without UI (→ qa-code-reviewer), motion/animation review (→ dev-animator review), or accessibility scoring without slop concern (→ glass-atrium-design-contrast-check).
triggers:
  - anti-slop check
  - AI slop audit
  - design originality review
  - anti-slop scan
od:
  mode: review
  inputs:
    - name: artifact
      type: file_path
      label: HTML / CSS / PNG / PDF / Excalidraw JSON to audit
  outputs:
    primary: review_report.md
  capabilities_required: [Read, Grep]
---

<!-- Anti-slop pattern categories mirror design-designer.md `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` subsection of `## Red Flags` (which adapts nexu-io/open-design `apps/daemon/src/prompts/official-system.ts` Apache 2.0 verbatim entries + 2026 community patterns). This skill is the detector layer only — design-designer.md remains SoT. -->

# Anti-Slop

## Overview

Mechanical detector for AI-slop visual patterns. Surfaces hits per category with severity bands and remediation hints — does NOT override design-designer creative judgment, does NOT prescribe replacement code. Designer.md `### AI Slop Tropes` (subsection of `## Red Flags`) is canonical source of truth; this skill applies it as an inspection pass.

## When to Use

- Pre-emit review of design-designer canvas / DESIGN.md / philosophy artifacts
- Code review of dev-front / dev-react / dev-gsap HTML / CSS deliverables (D8 visual sub-pass complement)
- Post-emit audit when user flags "looks AI-generated"

## Pattern Categories (mirror design-designer.md SoT)

### Color
- Warm beige / cream / peach / pink / orange-brown canvas without brand justification
- Purple+white gradient (over-used "AI brand" cliche)
- Achromatic + single fluorescent accent (one-trick palette)
- Pure white `#fff` text on dark mode (use `#E5E5E5` floor)
- Aggressive gradient backgrounds

### Font
- Inter / Roboto / Arial / Fraunces / generic system fonts as primary
- shadcn `zinc-*` / `slate-*` palette default exposure

### Layout
- Uniform `rounded-lg` everywhere (shadcn-ification)
- 3-column equal-distribution (no compositional rhythm)
- Rounded box with left-border accent (cliche callout card)
- Vibe-Coding pattern: centered everything + excessive whitespace + identical padding
- 3+ consecutive sections of same type (card / list / chart)

### Content
- Stat-slop: invented metrics ("99% faster" / "10,000+ users") without source
- Filler copy: lorem-ipsum-equivalent dressed as real
- Invented testimonials not provided by user
- SVG-as-illustration when placeholder would suffice

### Iconography
- Lucide / Hero Icons uniform 1.5px stroke-width monotone — vary stroke or mix families

### Effects
- Glassmorphism overuse: blur + gradient + shadow stacked on single element
- AI-generated 3D floating mesh / glowing geometric hero objects

### Emoji
- Gratuitous emoji unless brand system explicitly includes

## Detection Guidance

| Category | Grep / Inspect |
|----------|----------------|
| Color | `grep -iE "(beige\|cream\|peach\|#fff[^a-f0-9]\|gradient)" *.css *.html` |
| Font | `grep -iE "Inter\|Roboto\|Arial\|Fraunces" *.css *.html` |
| Layout | `grep -iE "rounded-lg\|grid-cols-3\|text-center" *.html` + visual scan |
| Content | Read body — flag round-number metrics without citation, lorem-ipsum markers |
| Iconography | Grep icon library imports + check stroke-width consistency |
| Effects | `grep -iE "backdrop-blur\|backdrop-filter\|drop-shadow" *.css` |
| Emoji | `grep -P "[\x{1F300}-\x{1FAFF}]" *.md *.html` |

## Severity Bands

| Band | Score | Meaning |
|------|-------|---------|
| Minor | 1 | Pattern present but contextually justified |
| Brand-conflict | 3 | Pattern violates stated brand / philosophy |
| AI-signature | 5 | Pattern is canonical AI-slop signature — MUST iterate |

## Output Format

`review_report.md`:

```
# Anti-Slop Audit: <artifact>

## Hits
- [Category/Severity] Pattern: <pattern> | Location: <file:line or selector> | Hint: <remediation policy>

## Summary
- Total hits: N (minor=N, brand-conflict=N, ai-signature=N)
- Verdict: PASS (0 ai-signature, ≤3 brand-conflict) / ITERATE (else)
```

## Constraints

- Hint stays at policy / defense-layer (e.g., "Replace generic font with brand-system primary"). No code, no specific API names, no concrete hex values.
- Do NOT redefine patterns — design-designer.md SoT controls additions. If a new pattern is observed, surface as `[NEW PATTERN candidate]` for design-designer review, do not auto-canonize.

## Cross-References

- Designer.md `### AI Slop Tropes` (subsection of `## Red Flags`) — single SoT for pattern definitions
- Scope-qa.md `## D8 Visual Decision Sub-Pass` — complementary visual rubric for HTML primary
- Contrast-check skill — mechanical WCAG verification (paired use)
