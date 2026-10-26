---
name: glass-atrium-design-html-co-emission
description: Designer-side consultative role for user-requested HTML primary outputs — Mermaid type mapping (the seven adopted types), Pyramid 3-layer section composition, non-canonical badge palette extension, and comparison-table split axis. Use when glass-atrium-intel-reporter / glass-atrium-intel-planner composes a user-requested HTML primary and the Visual-Weight Probe routes a glass-atrium-design-designer consultation. Do NOT use for agent-only token-optimized records, user-requested non-HTML documents, standalone ADR, markup authoring (glass-atrium-design-designer is verdict/spec-only — markup is glass-atrium-dev-front via the narrow handoff), or AI-slop auditing (-> glass-atrium-design-anti-slop).
triggers:
  - HTML primary co-emission
  - designer co-emission trigger
  - mermaid type mapping
  - section composition consult
---

# HTML Primary Co-Emission

## Overview

glass-atrium-design-designer supplies the judgment calls an author cannot make mechanically and withholds the ones that are already deterministic — `## Contribution Scope` sorts each call.

- **Mode**: `{glass-atrium-intel-reporter|glass-atrium-intel-planner, glass-atrium-design-designer}` Pre-draft consultation.
- **Output**: verdict + spec only, never markup.
- **Composition and POST**: the author composes and POSTs; the atomic 1-doc-1-POST contract is never split.
- **Markup exception**: a bespoke interactive component or CSS beyond Tailwind-CDN utilities goes to glass-atrium-dev-front, not to glass-atrium-design-designer.
  - The author signals `needs_devfront_markup`; the orchestrator judges and routes it.
  - The exception moves markup only: the philosophy call and every PRIMARY and CONDITIONAL call in `## Contribution Scope` stay glass-atrium-design-designer's.

## Contribution Scope

| Band | Item | Why it lands here |
|---|---|---|
| PRIMARY | Mermaid type mapping | information shape → type is a judgment, not a lookup |
| PRIMARY | section composition — Pyramid skim/scan/read partitioning, `<details>` fold-unit, visual weight distribution | rhythm is a judgment the author cannot derive mechanically |
| CONDITIONAL (T4 fired) | non-canonical badge palette extension — derive brand-safe oklch for hues beyond the canonical 4-badge set | only arises once the canonical set is exhausted |
| CONDITIONAL (D8 P2 split required) | comparison-table split axis — preserve rows=criteria / columns=alternatives, prioritize semantic grouping | the cap is mechanical, the axis is not |
| EXCLUDED | canonical 4-badge palette application | hard-coded canonical set |
| EXCLUDED | H1/H2/Body typography | D8 typography-levels rule is mechanical |
| EXCLUDED | dark base hue | `bg-zinc-950` is mandated → `agents/glass-atrium-intel-reporter.md` → `### Dark Theme & Typography (MUST)` |
| EXCLUDED | `prefers-reduced-motion` contract enforcement | `scoped/shared-design-token-consumption.md` → `## Motion Tokens` |

### Mermaid type mapping

- Select from the adopted set the one type that fits the information shape.
- The set is closed: a type absent from it is excluded, and excluded content becomes a table or prose.

| Adopted type | Fits |
|---|---|
| `flowchart` | routing and gate-decision logic, system overview |
| `sequenceDiagram` | delegation flow, orchestrator-to-agent call tracing |
| `stateDiagram-v2` | Outcome result states, apply-script lifecycle |
| `erDiagram` | monitor data models such as `core.outcomes` |
| `classDiagram` | type and module structure with dependency relations |
| `gitGraph` | branch and merge strategy |
| C4 (`C4Context` / `C4Container` / `C4Component`) | system boundaries and component layers |

- **SoT**: `monitor/src/server/clauded-docs/diagram-types.json` — where it and the table above disagree, the JSON wins.
- **An excluded type is report-only on the server, not a rejection**: the document still publishes, permanently annotated with a `diagram_type_excluded` notice.
  - So hold your own recommendation to the set, and never tell the author the server will catch it.

## Response Form

| Declare | When | Content |
|---|---|---|
| `mermaid_types: [...]` | always | selected type list + 1-line rationale per type |
| `section_composition: [...]` | always | section order + layer attribution per section (skim/scan/read) |
| `non_canonical_badges: [{meaning, symbol, oklch_hue}]` | T4 fired | brand-safe palette extension spec |
| `table_split_axis: <criterion>` | D8 P2 split required | split criterion + post-split row/column mapping |

- **Turn count**: 1-2 turns at most — the author drafts only after the verdict, and every consultation turn costs tokens.

## Applicability

| Deliverable | Consult? |
|---|---|
| user-requested HTML primary | YES — the only applicable case |
| agent-only token-optimized record (md/yaml/json/txt fallback) | NO — no human reader to design for |
| user-requested non-HTML document (MD or other) | NO — no visual surface to consult on |
| standalone ADR | NO — MD-only |

## Cross-References

- `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]` — canonical trigger spec, the T1-T5 indicators included
- `scoped/scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` — the P1-P5 invariants the designer's veto enforces
- `glass-atrium-design-contrast-check` — mechanical WCAG verification backing the contrast invariant
- `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` — the designer's copy of the trigger, output-field names and markup prohibition, and the sole copy of the veto line
