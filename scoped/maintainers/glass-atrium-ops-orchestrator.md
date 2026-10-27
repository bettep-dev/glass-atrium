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
| `#### Analysis-Track Right-Sizing (input-side) [ORCHESTRATOR]` | the `AnalysisSchema` fence `orchestrator-skill-schema-example.bats` reads — repointable (below) |
| `##### Stage gates` | revision caps cited by `references/review-rounds.md` · `scoped/maintainers/orchestrator-role.md` |
| `###### Copyable skeletons — 2-phase (verify → implement) and its 3-phase variant` | `###### Machine-checked skeletons` suites · the gate hook header's promotion condition |
| `##### Entry-class token placement (ultracode — DEV workflow)` | its declaration fence, read by the same suites |

### Relocatable — `#### Analysis-Track Right-Sizing (input-side) [ORCHESTRATOR]`

- This block and its `AnalysisSchema` fence are relocatable: no frozen `agents/` file and no hook message cites them.
- Every pin is repointable in the pass that moves it:
  - `hooks/test/orchestrator-skill-schema-example.bats` — reads the `AnalysisSchema` fence and its `completion_block` member from the skill file.
  - the **Print-block-then-emit** bullet under `##### Authoring idioms that implement those rules` — its reference form and machine-checked-repetition sub-bullets cite the fence.
  - in-file prose cites — `#### Resource Budget` (the FLOOR bullet) · `#### Read-Extent Discipline [ORCHESTRATOR]` → **Scope of this duty**.
- Owner of the move: the follow-on prompt-slimming plan (clauded-docs/43821 brief), which supersedes the remaining rank-14 sub-passes.
