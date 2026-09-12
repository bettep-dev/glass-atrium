# Authoring Hygiene Rules (Cross-Cutting Concern)

Binds every prompt, agent instruction, rule and skill you author or edit, and every document you author that directs work.

## Authoring Hygiene

- **Document kind decides the call**: these rules bind a plan, a handoff record and a rule body alike — a reach past the prompt corpus, deliberate and matching a membership that covers PLANNING and REPORT.
  - Exception: a measurement document, whose figures and their dates are its content, not its history.
- **Instruction-only**: state what the agent should DO plus the functional references it needs to act — never why a rule was added or how it evolved.
- **No unclear-source citations**: the test is whether the reader must FOLLOW the reference in order to act.
  - Keep: a rule file the agent must obey · a hook, script or API the rule invokes · a canonical-SoT pointer.
  - Omit: a `(src: …)` pointing at an internal session artifact · a derivation note · a "3-angle review" · a research claim with no checkable reference.
- **No history-type content**: no Wave / ADR provenance tags, correlation IDs, `doc NNNN` / `plan doc` references, edit-history dates, changelog narration, "(NEW)", "(was X before)". Version history lives in git, not in a prompt body.
  - Carve-out: provenance that changes what the reader DOES stays — an honest-backing note stating what is and is not enforced is a functional reference, not history.
- **No derived values**: a count or total a reader could compute from the members named in the same passage is noise — name the members and drop the number.
  - Carve-out: a bare cardinality standing beside no list may be the only signal that the list is closed, so removal there is a judgement, not automatic.
