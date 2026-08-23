---
name: glass-atrium-design-html-co-emission
description: Designer-side consultative role for user-requested HTML primary outputs — Mermaid type mapping (14 permitted types), Pyramid 3-layer section composition, non-canonical badge palette extension, and comparison-table split axis. Use when glass-atrium-intel-reporter / glass-atrium-intel-planner composes a user-requested HTML primary and the Visual-Weight Probe routes a glass-atrium-design-designer consultation. Do NOT use for agent-only token-optimized records, user-requested non-HTML documents, standalone ADR, markup authoring (glass-atrium-design-designer is verdict/spec-only — markup is glass-atrium-dev-front via the narrow handoff), or AI-slop auditing (-> glass-atrium-design-anti-slop).
triggers:
  - HTML primary co-emission
  - designer co-emission trigger
  - mermaid type mapping
  - section composition consult
od:
  mode: review
  inputs:
    - name: draft_outline
      type: file_path
      label: author draft outline for the user-requested HTML primary
    - name: fired_triggers
      type: string
      label: Visual-Weight Probe indicators fired (T1-T5)
  outputs:
    primary: co_emission_spec.md
  capabilities_required: [Read]
---

<!-- The agent body retains a stub carrying the trigger, the output fields, and the veto line — the veto produces `result: blocked`, so it MUST stay reachable when this skill is not loaded. `scope-report.md` "Designer Co-Emission Trigger" remains canonical for the trigger spec. -->

# HTML Primary Co-Emission

## Overview

Consultative-only role: glass-atrium-design-designer supplies the judgment calls an author cannot make mechanically (which Mermaid type fits the information shape, how sections partition across the skim/scan/read rhythm), and withholds the ones that are already deterministic. Verdict + spec only — never markup.

> Canonical trigger spec: `scope-report.md` "Designer Co-Emission Trigger" (mirrored in `scope-planning.md`). This section defines designer-side consultative role + scope.

**Consultative role** for user-requested HTML primary outputs — glass-atrium-design-designer's advisory responsibility under `{glass-atrium-intel-reporter|glass-atrium-intel-planner, glass-atrium-design-designer}` 2-agent Pre-draft consultation mode (Workflow A). glass-atrium-design-designer is verdict/spec-only and NEVER emits markup; the author (glass-atrium-intel-reporter|glass-atrium-intel-planner) composes + POSTs. Rare exception: an exposed-doc needing a bespoke interactive component / hand-authored CSS beyond Tailwind-CDN utilities → glass-atrium-dev-front owns that styled-skeleton markup via the narrow handoff (author signals `needs_devfront_markup` → orchestrator judges + composes per `scope-report.md` Designer Co-Emission Trigger + `orchestrator-role.md` Visual-Weight Probe note). glass-atrium-design-designer's markup-output prohibition is unchanged; the philosophy/Mermaid-type/section-composition/palette split below stays glass-atrium-design-designer's.

**Contribution scope**:

- **PRIMARY** (glass-atrium-design-designer SoT — not mechanically processable by glass-atrium-intel-reporter/glass-atrium-intel-planner):
  - Mermaid type mapping — select among 14 permitted types (flowchart · sequenceDiagram · classDiagram · stateDiagram-v2 · erDiagram · gantt · journey · pie · quadrantChart · mindmap · timeline · xychart-beta · C4Context/Container/Component) the one that fits the information shape
  - section composition — Pyramid 3-layer rhythm (skim/scan/read) section partitioning + `<details>` fold-unit + visual weight distribution
- **CONDITIONAL** (trigger-bound):
  - T4 fired — non-canonical status badge palette extension (when hues beyond canonical 4-badge ✓/⚠/✕/ℹ are needed, derive brand-safe oklch)
  - D8 P2 ≤ 5-col split required — comparison table splitting axis selection (preserve rows=criteria / columns=alternatives + prioritize semantic grouping)
- **EXCLUDED** (mechanical-deterministic — outside glass-atrium-design-designer consultation scope):
  - canonical 4-badge palette application (hard-coded canonical set)
  - H1/H2/Body typography (D8 P5 3-level rule mechanical)
  - dark base default hue selection (within recommended set zinc-950/slate-950/neutral-950)
  - `prefers-reduced-motion` contract enforcement (glass-atrium-dev-front / Motion Philosophy SoT)

**Response form** (verdict + spec — code/markup output FORBIDDEN per `scope-design.md` verdict-only alignment):

- declare `mermaid_types: [...]` — selected Mermaid type list + 1-line rationale per type
- declare `section_composition: [...]` — section order + layer attribution per section (skim/scan/read)
- (when T4 fired) declare `non_canonical_badges: [{meaning, symbol, oklch_hue}]` — brand-safe palette extension spec
- (when D8 P2 split) declare `table_split_axis: <criterion>` — split criterion + post-split row/column mapping
- turn count: 1-2 turns MAX — pre-draft consultation mode compression mandatory (POST atomic contract · token efficiency)

**Scope branching**:

- Applicable to: user-requested HTML primary outputs
- Not applicable to — agent-only token-optimized records (md/yaml/json/txt fallback · user readability fully abandoned · glass-atrium-design-designer consultation meaningless)
- Not applicable to — any user-requested non-HTML document (MD/other; no visual surface to consult on)
- Not applicable to — standalone ADR (MD-only)

**Veto authority**: On D8 P1-P5 invariant violation (color-blind safety / ≤5 col / sandbox-safe interactivity / WCAG AA / 3-level typography), declare verdict → glass-atrium-intel-reporter/glass-atrium-intel-planner emits `result: blocked` · silent fallback FORBIDDEN.

## Cross-References

- `scope-report.md` "Designer Co-Emission Trigger" — canonical trigger spec (mirrored in `scope-planning.md`)
- `orchestrator-role.md` Visual-Weight Probe — T1-T5 indicator set that routes this consultation at Decision phase
- `scope-qa.md` `## D8 Visual Decision Sub-Pass` — P1-P5 invariants the veto line enforces
- `glass-atrium-design-contrast-check` — mechanical WCAG verification backing D8 P4
- glass-atrium-design-designer.md `## HTML Primary Co-Emission Role` — body stub (trigger + output fields + veto)
