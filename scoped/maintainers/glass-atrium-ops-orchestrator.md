# Maintainer note — `skills/glass-atrium-ops-orchestrator.md`

Maintainer-facing material for that skill reference. Nothing here binds the orchestrator; the skill file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the skill file carries no stub heading and no prose pointer to this note.
  - The one editor-addressed HTML comment, atop `### Architecture Patterns [ORCHESTRATOR]`, is the carve-out above: suites extract that H3's fences and grep its rule phrases, and the comment names this note.

## Held cap exception — `### Architecture Patterns [ORCHESTRATOR]`

- This H3 stays over the 3 KB H3 cap.
- Each block below is held in place by its pin (suites under hooks/test/).
- Move a block only once its pin is retired or repointed in the same pass.

| Block (under this H3) | Pin that holds it in place |
|---|---|
| `#### Resilient Workflow Authoring [ORCHESTRATOR]` and its `#####` children | frozen `agents/` citations at this level · `schema-cap-authority-single-site.bats` |
| `##### Absolute schema-cap rules` | the rule phrases `orchestrator-skill-schema-example.bats` greps in this file |
| `##### Copyable helper (robustAgent)` | its `js` fence, replayed by `workflow-gate-completion-channel.bats` |
| `##### Stage gates` | revision caps cited by `references/review-rounds.md` · `scoped/maintainers/orchestrator-role.md` |
| `###### Copyable skeletons — 2-phase (verify → implement) and its 3-phase variant` | `###### Machine-checked skeletons` suites · the gate hook header's promotion condition |
| `##### Entry-class token placement (ultracode — DEV workflow)` | its declaration fence, read by the same suites |

### Relocated — `#### Analysis-Track Right-Sizing (input-side) [ORCHESTRATOR]`

- The heading stays in the skill as a three-bullet pointer; its body and `AnalysisSchema` fence live in `skills/glass-atrium-ops-delegation-contracts/references/delegation-size-discipline.md` → `## Analysis-Track Right-Sizing (input-side)`.
- Pins that read the moved fence from the reference, so a further move repoints them in the same pass:
  - `hooks/test/orchestrator-skill-schema-example.bats` → `EXEMPLAR` (D1–D3, AC13).
  - `hooks/test/workflow-gate-completion-channel.bats` → `ANALYSIS_REF` (both skeleton floors).
- Citers of the moved section:
  - `references/delegation-prompt.md` → `## Resource Budget` (the floor bullet) · `## Read-Extent Discipline` → **Scope of this duty**.
  - the skill's **Print-block-then-emit** bullet (via the kept heading).
  - `hooks/enforce-workflow-verify-stage.sh` → `PROMOTION CONDITION` — both sentences name the reference beside the skill; verbatim pin: `enforce-workflow-verify-stage.bats` → `schema-cap(promotion)`.

### Held cap exception — `## Core Process`

- This H2 stays over the 8 KB H2 cap because it contains the held `### Architecture Patterns [ORCHESTRATOR]`, itself over 8 KB.
- Every other H3 under it is held to the 3 KB H3 cap, read as 3,000 B (UTF-8, heading to the next H3); re-measure the H2 once that H3's pins retire.

### Relocated — Agent selection and delegation-prompt detail

- Each heading stays in the skill as a pointer stating its duty; bodies live in `skills/glass-atrium-ops-delegation-contracts/references/`:
  - `agent-selection.md` ← `#### Selection procedure` · the `#### Ordering caveat` heading · `#### Compound Task Examples` · `#### Routing-Decision Record (observability convention)` · `#### Routing Verification (LLM-as-Judge)`.
  - `delegation-prompt.md` ← `#### Resource Budget` · `#### Prompt-content aids` · `#### Read-Extent Discipline [ORCHESTRATOR]` · `#### Delegation Information-Hiding [ORCHESTRATOR]`.
- External citer repointed: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Routing output: team schema, size, and correlation ID` → **Example**.
- No test, hook message or `agents/` file reads the moved text.
