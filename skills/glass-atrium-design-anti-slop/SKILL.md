---
name: glass-atrium-design-anti-slop
description: Detects AI-slop visual design patterns (color/font/layout/content/iconography/effects/emoji, plus admin-console data screens — borders, filters, tables, forms, copy) by mechanical inspection of HTML / CSS / canvas / PDF artifacts per the glass-atrium-design-designer.md AI Slop Tropes SoT plus community patterns. Use when reviewing glass-atrium-design-designer or UI-emitting DEV agent deliverables for generic-AI aesthetics before emit OR during code review. Do NOT use for plain code review without UI (→ glass-atrium-qa-code-reviewer), motion/animation review (→ glass-atrium-dev-animator review), or accessibility scoring without slop concern (→ glass-atrium-design-contrast-check).
triggers:
  - anti-slop check
  - AI slop audit
  - design originality review
  - anti-slop scan
---

<!-- Pattern categories adapt nexu-io/open-design `apps/daemon/src/prompts/official-system.ts` (Apache 2.0) entries plus community patterns. -->

# Anti-Slop

## Overview

- Mechanical detector for AI-slop visual patterns: surfaces hits per category with a severity band and a remediation hint.
- It never overrides glass-atrium-design-designer creative judgment and never prescribes replacement code.
- It is the inspection pass over the pattern SoT, `agents/glass-atrium-design-designer.md` → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)`.

## When to Use

- Pre-emit review of glass-atrium-design-designer canvas / DESIGN.md / philosophy artifacts
- Code review of glass-atrium-dev-front / glass-atrium-dev-react / glass-atrium-dev-gsap HTML / CSS deliverables (D8 visual sub-pass complement)
- Post-emit audit when user flags "looks AI-generated"

## Pattern Categories (mirror glass-atrium-design-designer.md SoT)

### Color
- Warm beige / cream / peach / pink / orange-brown canvas without brand justification
- Purple+white gradient (over-used "AI brand" cliche)
- Achromatic + single fluorescent accent (one-trick palette)
- Pure white `#fff` text on dark mode (use `#E5E5E5` floor)
- Aggressive gradient backgrounds

### Font
- Inter / Roboto / Arial / Fraunces / generic system fonts as a default primary — a brand spec or a selected 5-Direction stack naming one is not the trope
- shadcn `zinc-*` / `slate-*` palette default exposure

### Layout
- Uniform `rounded-lg` everywhere (shadcn-ification)
- 3-column equal-distribution (no compositional rhythm)
- Rounded box with left-border accent (cliche callout card) — the same stripe on a selected table row too
- Vibe-Coding pattern: centered everything + excessive whitespace + identical padding
- 3+ consecutive sections of same type (card / list / chart)

### Content
- Stat-slop: invented metrics ("99% faster" / "10,000+ users") without source
- Filler copy: lorem-ipsum-equivalent dressed as real
- Invented testimonials not provided by user
- SVG-as-illustration when placeholder would suffice

### Iconography
- Lucide / Hero Icons uniform 1.5px stroke-width monotone — vary stroke or mix families; on admin consoles one set on a size-keyed stroke ladder passes, never a family mix

### Effects
- Glassmorphism overuse: blur + gradient + shadow stacked on single element
- AI-generated 3D floating mesh / glowing geometric hero objects

### Emoji
- Gratuitous emoji unless brand system explicitly includes

### Default-style
- Off-white page background chosen as a default — a background taken from the brand palette or the selected direction's `--bg` is not the trope
- Italic accent words inside headlines
- Numbered "01 / 02 / 03" section labels
- Monospace labels as the default label treatment — a selected direction whose posture names mono (editorial-monocle metadata, tech-utility code/IDs) is not the trope
- Pill-shaped buttons — status pills and full-pill avatars/tags are not buttons; admin-console status pills also stay out of table cells

### Admin-console (data screens)

Mirror of the SoT's `#### Admin-console tropes (data screens)` — scope, exceptions and rules live there; apply to admin and operations consoles only.

- Owner-review signatures: bordered bar controls · filter name repeated in its value · bordered current-page chip · per-bar inline padding drift · page actions under the title
- Borders and surfaces: every bar control bordered · border + shadow + tint on one card · tinted rounded box inside a card · colored stripe on a card or selected row · a vertical rule per table column
- Filters: applied filters hidden behind one button · reset shown at defaults · tabs filtering one list · view state lost on reload
- Tables and pagination: no total or range · sort state hidden · numbers left-aligned or units spaced · hover-only row actions · a pill on every row · color-only state · a one-value status column · short-and-small mock data · one empty state for first use and no results
- Forms: filled and outlined fields mixed · save disabled until complete · errors only in a summary or toast · silent exit with unsaved changes
- Layout and navigation: big-number KPI card row + big chart · record detail or edit in a modal · intro sentence restating the title · an icon on every menu item and tab · everything centered
- Dialogs, toasts and copy: toasts for everything or long · generic error copy · `OK / Submit / Yes` buttons · leftover dev or filler copy · marketing voice and round numbers
- Type and density: type shrunk for density
- Motion and data visualization: entrance motion on everything · `transition: all` · reduced motion ignored · a chart where one number would do · decorative sparkline · false precision
- Color, type and decoration: gradients, glow, glass, blur · one accent everywhere · permanent dark + neon · default fonts, italic accents, eyebrow labels · emoji, sparkles, boxed icons · blinking badges and dots · happy path only

## Detection Guidance

Run each pattern with the Grep tool (ripgrep syntax — a bare `|` is alternation; case-insensitive where marked), then read every hit in context before banding it.

~~~text
Color    (case-insensitive)  (beige|cream|peach|#fff[^a-f0-9]|gradient)   glob: *.{css,html}
Font     (case-insensitive)  Inter|Roboto|Arial|Fraunces                   glob: *.{css,html}
Layout   (case-insensitive)  rounded-lg|grid-cols-3|text-center            glob: *.html   (+ visual scan)
Effects  (case-insensitive)  backdrop-blur|backdrop-filter|drop-shadow     glob: *.css
Emoji                        [\x{1F300}-\x{1FAFF}]                         glob: *.{md,html}
~~~

- Content: read the body — flag round-number metrics without citation and lorem-ipsum markers.
- Iconography: grep icon-library imports, then check stroke-width consistency.

### Admin-console signals

- Run these only on admin-console screens (`### Admin-console (data screens)`), with glob `*.{css,scss,html,tsx,jsx,vue}`.
- A hit is a likelihood, never proof: the read note after a pattern names the context that makes it a signal.

~~~text
Stripe                 border-left:\s*[2-6]px|box-shadow:\s*inset\s+\d+px\s+0\s+0|border-l-[2-8]
Cell rules             border-(left|right)|divide-x|border-x|border:\s*1px       read: on td / th
Bar borders            border:\s*1px\s+solid|(class|className)="[^"]*\bborder(\s|")   read: input / select / button inside a filter, toolbar or pagination container
Card stacking          box-shadow|shadow-(sm|md|lg|xl|2xl)                       read: the same card also sets a border and a tint
Tinted box             border-radius|\brounded-                                  read: a card-body child that also sets a background (error block, callout)
Filter label           [가-힣A-Za-z ]+:\s*(전체|All)                              read: trigger or option text
Filter count           (필터|Filters?) \(\d+\)                                    read: the button is the only place applied filters show
Current page           aria-current="page"                                       read: the element carries a border
Spaced units           \d\s+(회|명|원|건)
Hover reveal           opacity:\s*0|group-hover:(opacity|visible)|invisible      read: row actions shown on :hover
Row pills              rounded-full                                              read: a tinted pill repeated in td, or a text-less dot (w-2 h-2)
Empty cell             <td[^>]*>\s*</td>
Form fields            <form\b                                                   read: inputs in the one form mixing a bg-* fill with border variants
Save gate              disabled=\{!.*(isValid|isDirty)
Error mount            [eE]rrors?[\w.?\[\]'"]*\s*&&                              read: a field message line that mounts only on error, shifting layout
Toasts                 toast\.error|toast\(                                      read: in a submit handler, toast count and text length
KPI grid               grid-cols-4                                               read: sibling cards repeating one big-number class
Centering              text-center                                               read: overuse beyond empty and error states
Error copy             (문제|오류)가 발생했습니다|Something went wrong
Button copy            >\s*(확인|제출|예|OK|Submit)\s*<
Filler (case-insensitive)     lorem|TODO|TBD|placeholder|test123|John Doe|Acme   read: visible copy — a bare placeholder= attribute name is a grep artifact; read its value as copy
Marketing (case-insensitive)  unlock|supercharge|\d+,000\+|\b\d0%
Small type             text-xs                                                   read: in table cells
Motion                 animate-(fade|slide|bounce)|@keyframes|transition:\s*all|transition-all
Pulse                  animate-pulse                                             read: outside a loading skeleton
Precision              toFixed\([3-9]\)|\d+\.\d{3,}%
Flat surface           linear-gradient|bg-gradient-to|background-clip:\s*text|bg-clip-text|backdrop-(filter|blur)|box-shadow:[^;]*0 0 \d+px
Type                   \b(Inter|Roboto|Arial)\b|italic|uppercase                 read: uppercase paired with tracking-
Icons                  Sparkles|[\x{1F300}-\x{1FAFF}]                            read: also an icon wrapped in rounded-full + a background
~~~

- **Absence checks** — a missing match is the signal; read the component:
  - `aria-sort` on a sortable `th` · a total-count string in pagination (`중\s+\d|of\s+[\d,]+`)
  - `text-align:\s*right|text-right|tabular-nums` on numeric columns · `aria-invalid|aria-describedby` on inputs
  - `beforeunload` on an edit-form screen · `prefers-reduced-motion` beside any animation
  - `useSearchParams|searchParams` beside filter or page `useState` · `loading|empty|error` branches in a list component
  - a conditional `disabled` / `hidden` on the reset control · a second empty-state variant
- **Read-only checks** — no pattern reaches these:
  - bars in one card not sharing one inline-padding variable · `h1` and buttons in stacked header blocks · a `<p>` straight after `h1`
  - a status column with one value · mock data with no 1,000+ numbers, empty values or long names
  - status-value tabs over one shared table · an edit form or detail list inside a dialog · an icon on every `menuitem` / `tab`
  - one accent variable on tabs, current page, selected row and checks · a sparkline with no data series · a chart standing in for one number

## Severity Bands

| Band | Score | Meaning |
|------|-------|---------|
| Minor | 1 | Pattern present but contextually justified |
| Brand-conflict | 3 | Pattern violates stated brand / philosophy |
| AI-signature | 5 | Pattern is canonical AI-slop signature — MUST iterate |

Admin-console banding — band names from the table above, cases from the SoT bundle:

| Band | Admin-console cases |
|---|---|
| AI-signature | an owner-review signature · gradient, glow or glass · a colored stripe on a card or selected row · a pill on every row |
| Brand-conflict | a rule the project design system already set is broken (e.g. filled fields mixed into an outlined-field form) · a brand-sourced purple or indigo spread too wide |
| Minor | a case an Exception line names · the secondary button carrying fill + border (an open decision) · a hit its context justifies |

- The more specific row wins: a brand-sourced purple or indigo spread too wide is Brand-conflict, not Minor.
- A Not-signals case is never reported; a Limit line is a source caveat and moves no band.

## Output Format

Return inline in the response, in this shape:

```
# Anti-Slop Audit: <artifact>

## Hits
- [Category/Severity] Pattern: <pattern> | Location: <file → selector or symbol> | Hint: <remediation policy>

## Summary
- Total hits: N (minor=N, brand-conflict=N, ai-signature=N)
- Verdict: PASS (0 ai-signature, ≤3 brand-conflict) / ITERATE (else)
```

## Constraints

- Hint stays at policy / defense-layer (e.g., "Replace generic font with brand-system primary"). No code, no specific API names, no concrete hex values.
- Never redefine or add a pattern here: surface a newly observed one as `[NEW PATTERN candidate]` for glass-atrium-design-designer review.

## Cross-References

- `agents/glass-atrium-design-designer.md` → `## Red Flags` → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` — pattern SoT; additions land there
- `scoped/scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` — complementary visual rubric for HTML primary
- `glass-atrium-design-contrast-check` — mechanical WCAG verification (paired use)
