# Deliverable exposure and designer composition (Decision phase)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Deliverable exposure and designer composition (Decision phase)`.
- **Markup-exception pointer site**: the same file → `#### Monitoring-phase notes` → **glass-atrium-dev-front markup-exception Monitoring judgment**.

## Exposure Determination — signals and routing

- **What decides the bit**: the explicit signals below, never a document category or prefix.
  - **Explicit format request** naming an HTML/web/PDF form — "HTML로", "웹 문서로", "as HTML", "as a web document / web doc", "PDF로", "export it as PDF".
  - **Explicit share intent** — third-party sharing / direct human review / presentation: "share with the team", "팀에 공유", "something to show", "for a presentation", "for sharing".
- **Not triggers**: a bare document/report/plan request ("보고서로 정리", "문서로 작성", "write it up as a report", "make a plan") · content visual-richness · an LLM "this looks visual" self-judgment.
- **0 signals**: the `exposure: agent-only` hint routes the deliverable to the default-hidden agent-only record — or to user-requested non-HTML md when a document was requested.
- **When in doubt — why agent-only**: a surplus hidden record is cheap; an unwanted shared HTML is not.
- The bit is a delegation-time intent hint, never an override: the authoring agent finalizes format and exposure at its turn-0.
- Canonical signal literals: `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test (explicit-request-only — heuristic auto-HTML FORBIDDEN)`.

## Visual-Weight Probe — detail

- **Author re-count**: the author counts T1-T5 again at its own turn-0 self-assessment and declares the result.
- **Composition mode**: the designer composition at 2+ T1-T5 indicators runs per `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]` → **Pre-draft consultation order**.
- The Probe routes the glass-atrium-design-designer consultation only, never the visual floor: every exposed HTML primary, solo compositions included, is bound at any T1-T5 count by the tiered Visual-Maximization Floor (`scoped/scope-report.md` → `### Visual-Maximization Floor`).
- glass-atrium-dev-front is never probe-composed: it enters only through the author-surfaced markup exception (`## glass-atrium-dev-front markup exception — detail`).
- T1-T5 canonical: `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`.
- Why at Decision phase: the consultation need surfaces before drafting, so visual-quality rework never lands post-emit as a conflict-prone parallel HTML stitch.

## glass-atrium-dev-front markup exception — detail

- **Trigger**: the author is glass-atrium-intel-reporter|glass-atrium-intel-planner, and its `needs_devfront_markup: true` flag travels with a 1-line justification.
- **Capability criterion** — whether an exposed HTML deliverable needs glass-atrium-dev-front: is the markup genuinely beyond Tailwind-CDN utilities and beyond glass-atrium-design-designer's verdict scope (e.g. a CSS-only tab system, a complex `:has()`/container-query layout)?
- **Handoff steps**: glass-atrium-dev-front drafts a self-contained styled HTML skeleton, returned inline → the author fills content and makes the single POST.
- Parallel HTML stitching and a post-draft review POST stay forbidden — the atomic 1-doc-1-POST contract holds.
- **User surfacing — the exception**: only when genuinely ambiguous, never as a user-approval step.
- The exception extends glass-atrium-dev-front and never creates an agent (`scoped/scope-dev.md` → `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]`).
