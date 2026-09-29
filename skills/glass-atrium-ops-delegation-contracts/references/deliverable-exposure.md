# Deliverable exposure and designer composition (Decision phase)

- **Pointer site**: `rules/glass-atrium/orchestrator-role.md` → `### Phase Notes` → `#### Deliverable exposure and designer composition (Decision phase)`.
- **Markup-exception pointer site**: the same file → `#### Monitoring-phase notes` → **glass-atrium-dev-front markup-exception Monitoring judgment**.

## Exposure Determination — signals and routing

- **What decides the bit — detail**: no document category or prefix decides it. The explicit signals the pointer names are:
  - **(a) explicit format request** naming an HTML/web/PDF form — "HTML로", "웹 문서로", "as HTML", "as a web doc", "PDF로", "export as PDF".
  - **(b) explicit share intent** — third-party sharing / direct human review / presentation: "share with the team", "팀에 공유", "something to show", "for a presentation", "for sharing".
- **0 signals — detail**: the hint travels alongside `TASK_TYPE`, routing the deliverable to the viewer-default-hidden, token-optimized agent-only record (or user-requested non-HTML md when a document was requested).
- **NOT triggers** — a bare document/report/plan request ("보고서로 정리", "문서 작성", "write it up as a report", "make a plan"), which routes to user-requested non-HTML md · content visual-richness · an LLM "this looks visual" self-judgment.
- **When in doubt — why agent-only**: asymmetric cost: a surplus hidden record is cheap; an unwanted shared HTML is not.
- Canonical signal list: `scoped/scope-report.md` → `### HTML request test`, under `## Output Format Routing [REPORT]`.
- Format/exposure finalization stays the authoring agent's turn-0 call — this bit is a delegation-time intent hint, not an override.

## Local-destination hint — scope and canonical

- A LOCAL destination is a new file OR an edit of an existing user file.
- Canonical stamped form + carve-out: `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria` authoring bullet.

## Visual-Weight Probe — detail

- **Trigger — detail**: a user-requested HTML primary means 1+ explicit signal per Exposure Determination; otherwise the probe passes through, there being no HTML to style.
- **Indicator source**: the sub-task draft outline is the glass-atrium-intel-reporter/glass-atrium-intel-planner turn-0 self-assessment.
- **Composition mode**: the 2+ parallel designer composition runs per Pre-draft consultation mode (A).
- The Probe routes the glass-atrium-design-designer CONSULTATION only — it does NOT set the visual floor: every exposed HTML primary is bound by the tiered Visual-Maximization Floor (`scoped/scope-report.md` → `### Visual-Maximization Floor`) at any T1-T5 count, solo compositions included.
- glass-atrium-dev-front is NEVER probe-composed here — it enters only via the author-surfaced markup exception (the markup-exception pointer site above; detail in `## glass-atrium-dev-front markup exception — detail` below).
- Canonical: `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`. Why at Decision phase: the consultation need surfaces before a parallel HTML stitch prone to token-position conflicts, so visual-quality rework never lands post-emit.

## glass-atrium-dev-front markup exception — detail

- **Trigger — detail**: the author is glass-atrium-intel-reporter|glass-atrium-intel-planner, and the flag travels with a 1-line justification.
- **Capability criterion** — whether an exposed HTML deliverable needs glass-atrium-dev-front: is the markup genuinely beyond Tailwind-CDN utilities AND beyond glass-atrium-design-designer's verdict scope (e.g. a CSS-only tab system, a complex `:has()`/container-query layout)?
- **Handoff steps**: glass-atrium-dev-front drafts a self-contained styled HTML skeleton, returned INLINE → the author fills content and makes the SINGLE POST.
- Parallel HTML stitching and a post-draft review POST stay FORBIDDEN — the atomic 1-doc-1-POST contract holds.
- **User surfacing — the exception**: only when genuinely ambiguous, never as a user-approval step.
- This EXTENDS glass-atrium-dev-front, never creates an agent (`scoped/scope-dev.md` → `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]`). Author-side protocol: `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`.
