---
name: glass-atrium-design-md-lint
description: Machine-checkable structural lint of a DESIGN.md token graph (Base/Semantic/Component alias tiers + `var(--token)` CSS custom properties + `{tier.token.path}` DTCG brace aliases) — flags broken alias references (blocking), orphaned base tokens (warning, multi-mode-aware), and out-of-canonical-order sections (warning). Use before a design-system DESIGN.md emit OR during code review when token aliases / DESIGN.md sections change, to prove every alias resolves. Do NOT use for WCAG contrast ratio checks (→ glass-atrium-design-contrast-check), AI-slop visual pattern audit (→ glass-atrium-design-anti-slop), or design originality scoring (→ glass-atrium-design-5-axis-critique).
triggers:
  - DESIGN.md lint
  - token graph check
  - broken token reference
  - design token alias verify
od:
  mode: review
  inputs:
    - name: design_md
      type: file_path
      label: path to the DESIGN.md to lint
    - name: design_tokens_json
      type: file_path
      label: optional design_tokens.json (DTCG token export) alongside the DESIGN.md
  outputs:
    primary: lint_report.txt
  capabilities_required: [Bash, Read]
---

# DESIGN.md Token-Graph Lint

## Overview

Deterministic structural lint of a DESIGN.md token graph. Parses the Base/Semantic/Component alias tiers (raw values live only at Base) plus `var(--token)` CSS custom properties and `{tier.token.path}` DTCG brace aliases, then runs three rules. No creative judgment — mechanical reference-resolution + section-order checks only. Adapted from Google design.md's linter, rebased onto Atrium's real token model (see `~/.claude/agents/references/design-token-architecture.md`).

## When to Use

- DESIGN.md design-system emit — every alias MUST resolve before submission
- Code review when token aliases or DESIGN.md section structure change
- Verifying a `design_tokens.json` export against its DESIGN.md

## Rules

| # | Rule | Severity | Exit impact |
|---|------|----------|-------------|
| 1 | **broken-ref** | error (BLOCKING) | exit 1 |
| 2 | **orphaned-token** | warning | exit 0 |
| 3 | **section-order** | warning | exit 0 |

1. **broken-ref [error]** — every Semantic/Component alias (a `var(--x)` reference or a `{tier.token.path}` brace alias) MUST resolve to a defined token. A raw color literal (`#rgb`, `rgba(...)`) sitting at the Component tier where an alias belongs is also a broken-ref — raw values are allowed ONLY at the Base tier.
2. **orphaned-token [warning]** — a Base token referenced by no alias. Multi-mode tokens (`*-dark`, `*-high-contrast`, colorblind variants) are NOT orphans: they are re-points of a semantic name consumed by mode switching (MD3 multi-mode aware), so they are excluded.
3. **section-order [warning]** — the canonical DESIGN.md section order (Visual Theme → Color → Typography → Spacing → Layout → Components → Motion → Voice → Anti-Patterns) is preserved. Unrecognized sections are kept, never flagged (Consumers MUST preserve unrecognized sections per design-designer.md §section minimalism).

## Usage

```bash
~/.claude/skills/glass-atrium-design-md-lint/lint.sh <DESIGN.md> [design_tokens.json] [--json]
```

- The `design_tokens.json` argument is optional — when present, its DTCG token tree is merged into the defined-token set and its component-alias values count as references.
- `--json` emits a machine-readable findings array (severity + path + message) for downstream tooling; default output is human-readable.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | no BLOCKING (error) findings — warnings may be present |
| 1 | at least one BLOCKING finding (broken-ref) |
| 2 | measurement failure (missing dependency, unreadable file, malformed JSON) |

## Output Format

Human-readable (default):

```
design-md-lint -> path/to/DESIGN.md
  defined tokens: N  references: M
  [ERROR] body:--token-x — broken-ref: alias '--token-x' resolves to no defined token
  [warn ] colors.unused — orphaned-token: base token 'colors.unused' referenced by no alias
Verdict: 1 error(s), 1 warning(s)
```

`--json`: `{ design, tokens, summary: {errors, warnings, defined_tokens, references}, findings: [{severity, path, message}] }`.

## Edge Cases

- **No `design_tokens.json`** — the DESIGN.md is linted standalone; tokens are sourced from its `:root { --x: ... }` blocks and YAML frontmatter.
- **High orphan count** — a full MD3 palette defines the complete role set; many tokens go unreferenced by a small component set. Orphan findings are warnings (non-blocking) by design — review, do not block.
- **Both Atrium `→`/`var()` and example `{path}` syntaxes** — the parser recognizes all three reference forms, so it handles both Atrium DESIGN.md authoring and DTCG-export-style token files.

## Cross-References

- `~/.claude/agents/references/design-token-architecture.md` — the 3-tier alias model + multi-mode matrix this lint enforces (SoT)
- `~/.claude/agents/templates/DESIGN.md` — canonical section order (§1-§9) the section-order rule checks
- `glass-atrium-design-contrast-check` — paired pre-emit gate (this lints structure, contrast-check verifies color ratios)
- Scope-design.md `## LLM Output Validation` — pre-emit gate family this lint joins
