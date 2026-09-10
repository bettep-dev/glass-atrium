---
name: glass-atrium-design-html-co-emission
description: Designer-side consultative role for user-requested HTML primary outputs — Mermaid type mapping (the seven adopted types), Pyramid 3-layer section composition, non-canonical badge palette extension, and comparison-table split axis. Use when glass-atrium-intel-reporter / glass-atrium-intel-planner composes a user-requested HTML primary and the Visual-Weight Probe routes a glass-atrium-design-designer consultation. Do NOT use for agent-only token-optimized records, user-requested non-HTML documents, standalone ADR, markup authoring (glass-atrium-design-designer is verdict/spec-only — markup is glass-atrium-dev-front via the narrow handoff), or AI-slop auditing (-> glass-atrium-design-anti-slop).
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

glass-atrium-design-designer supplies the judgment calls an author cannot make mechanically — which Mermaid type fits the information shape, how sections partition across the skim/scan/read rhythm — and withholds the ones that are already deterministic.

- **Mode**: `{glass-atrium-intel-reporter|glass-atrium-intel-planner, glass-atrium-design-designer}` 2-agent Pre-draft consultation (Workflow A).
- **Output**: verdict + spec only. glass-atrium-design-designer NEVER emits markup (prohibition stated at `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role`).
- **Composition and POST**: the author composes and POSTs; the atomic 1-doc-1-POST contract is never split.

> Canonical trigger spec: `scope-report.md` "Designer Co-Emission Trigger" (mirrored in `scope-planning.md`). This file defines the designer-side consultative role and its scope.

### Delivery

A skill does NOT reach a reader the way an agent body does (measured 2026-09-10).

- This body reaches glass-atrium-design-designer only when the skill is invoked; the frontmatter `description` is all that is present at the invocation decision, and at spawn the designer holds only the body stub.
- The SubagentStart injector delivers marker-extracted blocks and reads exactly one skill file — the naming skill — not this one.
- Closed set of copies for this contract — this file, plus:
  - `scope-report.md` → `## Designer Co-Emission Trigger [REPORT]` (policy canonical)
  - `scope-planning.md` → `## Designer Co-Emission Trigger [PLANNING]` (mirror)
  - both of those are read by the main session and by none of the three agents involved
  - `agents/glass-atrium-intel-reporter.md` and `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract` (delivered author-side copies)
  - `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` (delivered stub)

### Markup exception (glass-atrium-dev-front)

An exposed doc needing a bespoke interactive component or hand-authored CSS beyond Tailwind-CDN utilities goes to glass-atrium-dev-front for the styled skeleton, through the narrow handoff — not to glass-atrium-design-designer.

- Path: the author signals `needs_devfront_markup` → the orchestrator judges and composes.
- Authority: `scope-report.md` → Designer Co-Emission Trigger (author-side protocol) · `orchestrator-role.md` → `#### Monitoring-phase notes` → the glass-atrium-dev-front markup-exception Monitoring judgment (orchestrator-side judgment canonical).
- The exception changes nothing here: the philosophy, Mermaid-type, section-composition and palette calls below stay glass-atrium-design-designer's, and the markup prohibition is unchanged.

## Contribution Scope

| Band | Item | Why it lands here |
|---|---|---|
| PRIMARY | Mermaid type mapping | information shape → type is a judgment, not a lookup |
| PRIMARY | section composition — Pyramid skim/scan/read partitioning, `<details>` fold-unit, visual weight distribution | rhythm is a judgment the author cannot derive mechanically |
| CONDITIONAL (T4 fired) | non-canonical badge palette extension — derive brand-safe oklch for hues beyond the canonical 4-badge set | only arises once the canonical set is exhausted |
| CONDITIONAL (D8 P2 split required) | comparison-table split axis — preserve rows=criteria / columns=alternatives, prioritize semantic grouping | the cap is mechanical, the axis is not |
| EXCLUDED | canonical 4-badge palette application | hard-coded canonical set |
| EXCLUDED | H1/H2/Body typography | D8 typography-levels rule is mechanical |
| EXCLUDED | dark base default hue, within zinc-950 / slate-950 / neutral-950 | recommended set already fixed |
| EXCLUDED | `prefers-reduced-motion` contract enforcement | glass-atrium-dev-front / Motion Philosophy SoT |

### Mermaid type mapping

Select from the adopted set the one type that fits the information shape. The set is CLOSED — a type absent from it is excluded, and excluded content becomes a table or prose.

| Adopted type | Fits |
|---|---|
| `flowchart` | routing and gate-decision logic, system overview |
| `sequenceDiagram` | delegation flow, orchestrator-to-agent call tracing |
| `stateDiagram-v2` | Outcome result states, apply-script lifecycle |
| `erDiagram` | monitor data models such as `core.outcomes` |
| `classDiagram` | type and module structure with dependency relations |
| `gitGraph` | branch and merge strategy |
| C4 (`C4Context` / `C4Container` / `C4Component`) | system boundaries and component layers |

- **SoT**: `monitor/src/server/clauded-docs/diagram-types.json`, parsed at module init by `html-validator.ts`, which throws on a malformed shape. The table above is derived from it, as are the prose copies in `scope-report.md`, `scope-planning.md` and the two author bodies. Correct any prose copy against the JSON, never the JSON against a prose copy.
- **Recommending an excluded type is REPORT-ONLY on the server, not a rejection.** The document still passes and carries a standing `diagram_type_excluded` notice.
  - Read from the validator's terminal return, which is reached only on an otherwise-clean document and reports the diagram scan as notices on an OK result rather than as a failure code.
  - The cost is a published artifact permanently annotated, not a blocked emit.
  - So treat the set as binding on your own recommendation, and do NOT tell the author the server will catch it.

## Response Form

Verdict and spec only; code or markup output is FORBIDDEN.

| Declare | When | Content |
|---|---|---|
| `mermaid_types: [...]` | always | selected type list + 1-line rationale per type |
| `section_composition: [...]` | always | section order + layer attribution per section (skim/scan/read) |
| `non_canonical_badges: [{meaning, symbol, oklch_hue}]` | T4 fired | brand-safe palette extension spec |
| `table_split_axis: <criterion>` | D8 P2 split required | split criterion + post-split row/column mapping |

- **Turn count: 1-2 turns MAX** — pre-draft consultation compression is mandatory (atomic POST contract · token efficiency).

## Applicability

| Deliverable | Consult? |
|---|---|
| user-requested HTML primary | YES — the only applicable case |
| agent-only token-optimized record (md/yaml/json/txt fallback) | NO — user readability is fully abandoned, so the consultation is meaningless |
| user-requested non-HTML document (MD or other) | NO — no visual surface to consult on |
| standalone ADR | NO — MD-only |

## Veto Authority

On D8 P1-P5 invariant violation (color-blind safety / ≤5 col / sandbox-safe interactivity / WCAG AA / 3-level typography), declare verdict → glass-atrium-intel-reporter/glass-atrium-intel-planner emits `result: blocked` · silent fallback FORBIDDEN.

> Kept byte-identical with `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role`, the delivered stub a designer holds when this skill is not loaded. No test pins the pair; the identity is the maintenance signal.

## Cross-References

- `scope-report.md` "Designer Co-Emission Trigger" — canonical trigger spec (mirrored in `scope-planning.md`)
- `orchestrator-role.md` Visual-Weight Probe — the T1-T5 indicator set that routes this consultation at Decision phase
- `scope-qa.md` `## D8 Visual Decision Sub-Pass` — the invariants the veto line enforces
- `glass-atrium-design-contrast-check` — mechanical WCAG verification backing the contrast invariant
- `agents/glass-atrium-design-designer.md` `## HTML Primary Co-Emission Role` — body stub (trigger + output fields + veto) and the markup-prohibition statement

## Coupled-Test Disposition

No test in `test/`, `hooks/test/`, `scripts/test/` or `autoagent/test/` names this path, this skill name, or any literal unique to this file — searched for the path, the skill name, the four `declare` field names, `needs_devfront_markup`, and the adopted-type members. That emptiness is the disposition: nothing here is pinned, so nothing here can break a pin.

- **Indirectly coupled**: `scripts/test/manifest-check-clean.bats` runs `generate-manifest.sh --check`, which compares this file's sha256 against `manifest.json`. Any edit here requires a manifest regeneration — a whole-tree barrier operation, not a content pin.
- **Pin worth adding (recommendation, not done here)**: nothing compares the prose copies of the adopted set against `diagram-types.json`. `monitor/test/clauded-docs.diagram-types.test.ts` validates the JSON's own invariants and mermaid's behaviour, never a prose copy — which is precisely the gap that let this file and its frontmatter drift from the JSON once already. A suite reading `diagram-types.json` and asserting each prose copy's member list matches would close it.
