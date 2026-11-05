---
name: glass-atrium-design-md-lint
description: Machine-checkable structural lint of a DESIGN.md token graph (Base/Semantic/Component alias tiers + `var(--token)` CSS custom properties + `{tier.token.path}` DTCG brace aliases) — flags broken alias references (blocking), orphaned base tokens (warning, multi-mode-aware), and out-of-canonical-order sections (warning). Use before a design-system DESIGN.md emit OR during code review when token aliases / DESIGN.md sections change, to prove every alias resolves. Do NOT use for WCAG contrast ratio checks (→ glass-atrium-design-contrast-check), AI-slop visual pattern audit (→ glass-atrium-design-anti-slop), or design originality scoring (→ glass-atrium-design-5-axis-critique).
triggers:
  - DESIGN.md lint
  - token graph check
  - broken token reference
  - design token alias verify
---

# DESIGN.md Token-Graph Lint

## Overview

- Token model it enforces (SoT): `~/.claude/agents/references/design-token-architecture.md` — the 3-tier alias model and multi-mode matrix.

## Rules

- **broken-ref** (error, blocking) — every Semantic/Component alias (a `var(--x)` reference or a `{tier.token.path}` brace alias) MUST resolve to a defined token before submission.
  - A raw color literal (`#rgb`, `rgba(...)`) at the Component tier, where an alias belongs, is also a broken-ref — raw values are allowed only at the Base tier.
- **orphaned-token** (warning) — a Base token referenced by no alias.
  - Multi-mode tokens (`*-dark`, `*-high-contrast`, colorblind variants) are excluded: they re-point a semantic name consumed by mode switching.
  - A full MD3 palette leaves many tokens unreferenced by a small component set: review these findings, do not block.
- **section-order** (warning) — sections keep the canonical order (§1-§9) of `~/.claude/agents/templates/DESIGN.md`.
  - Unrecognized sections are kept, never flagged — consumers MUST preserve them (`agents/glass-atrium-design-designer.md` → **Section minimalism**).
  - Heading aliases bind author-written section names to their canonical slot: `UI Copy Rules` / `Copy Rules` → §8 Voice, `Do's/Don'ts` → §9 Anti-Patterns.

## Usage

```bash
~/.claude/skills/glass-atrium-design-md-lint/lint.sh <DESIGN.md> [design_tokens.json] [--json]
```

- `design_tokens.json` is optional; pass it to verify an export against its DESIGN.md — its DTCG token tree joins the defined-token set and its component-alias values count as references.
- Without it, tokens come from the DESIGN.md's `:root { --x: ... }` blocks and YAML frontmatter.
- `--json` emits `{ design, tokens, summary: {errors, warnings, defined_tokens, references}, findings: [{severity, path, message}] }` for downstream tooling; default output is human-readable.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | no blocking (error) findings — warnings may be present |
| 1 | at least one blocking finding (broken-ref) |
| 2 | measurement failure (missing dependency, unreadable file, malformed JSON) |
