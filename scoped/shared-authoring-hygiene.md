# Authoring Hygiene Rules (Cross-Cutting Concern)

Binds every prompt, agent instruction, rule and skill you author or edit, and every document you author that directs work.

## Authoring Hygiene

- **Document kind decides the call**: these rules bind a plan, a handoff record and a rule body alike — a reach past the prompt corpus, deliberate and matching a membership that covers PLANNING and REPORT.
  - Exception: a measurement document, whose figures and their dates are its content, not its history.
- **Instruction-only**: state what the agent should DO, the functional references it needs to act, and — where it is not obvious — the reason the constraint exists; never the history of how the rule was added or evolved.
- **No unclear-source citations**: the test is whether the reader must FOLLOW the reference in order to act.
  - Keep: a rule file the agent must obey · a hook, script or API the rule invokes · a canonical-SoT pointer.
  - Omit: a `(src: …)` pointing at an internal session artifact · a derivation note · a "3-angle review" · a research claim with no checkable reference.
  - Diet component `산문 참조` — a sentence pointing at another file's section by name fails the test when its target no longer exists · already reaches the reader through spawn-time injection or a Tier-1 rule · sits in a file the reader never receives.
    - Carve-out: a reference stating what a machine reads stays; one stating a rule's actual backing stays under `No history-type content` → its carve-out.
- **No history-type content**: no Wave / ADR provenance tags, correlation IDs, `doc NNNN` / `plan doc` references, edit-history dates, changelog narration, "(NEW)", "(was X before)". Version history lives in git, not in a prompt body.
  - Diet component `이력성 내용` — the test: does removing the text change what the reader does? Dates included.
  - Also history: a dated measurement stamp on a rule · "corrected on" · "superseded the earlier wording" · attribution of who established a fact · a note that a claim was refuted or re-measured.
  - Carve-out: provenance that changes what the reader DOES stays — an honest-backing note stating what is and is not enforced is a functional reference, not history.
    - A note that a scope file does not reach the agent reading it stays too.
    - A kept note's date that does no work goes; the note stays.
- **No derived values**: a count or total a reader could compute from the members named in the same passage is noise — name the members and drop the number.
  - Carve-out: a bare cardinality standing beside no list may be the only signal that the list is closed, so removal there is a judgement, not automatic.

## Prompt-Audit Overrides

- **Scope**: binds the prompt-audit pass (`scoped/scope-meta.md` → `## Prompt Deliverable Team Rule`) and the structure verdict that judges its override outcome.
- Each override states only its delta from the `/claude-api` prompt-audit guide.
- **Constraint modals**: judge each modal by where it came from — a modal that encodes a real constraint stays.
  - A booster with no constraint behind it: `agents/glass-atrium-meta-prompt-engineer.md` → `## Structure Self-Check` → `No caps inflation`.
- **Trigger text**: every `description` field keeps its calibrated urgency.
- **Fragile operations**: in Atrium these are git, deploy, destructive commands, the updater seam, harness paths and secrets — their text keeps its exact wording.
- **Honest-backing notes**: they stay; their single site is `## Authoring Hygiene` → `No history-type content` → its carve-out.
- **Test-consumed literals**: a finding that would change text a coupled test asserts (`agents/glass-atrium-meta-prompt-engineer.md` → `## Corpus Edit Pass` → **Coupled test**) drops to `flag` when its hunk cannot carry the test change.
- **Bullet walls**: the guide's Group 1c row "Bullet walls and heavy formatting for behavioral guidance" is not applied — bullets and tables stay, because `agents/glass-atrium-meta-prompt-engineer.md` → `## Structure Self-Check` → `One line, one rule` and `Decision table` outrank it.
- **Decided diet keeps**: text an earlier diet decision kept is not reopened.
