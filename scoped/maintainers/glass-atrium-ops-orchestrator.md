# Maintainer note — `skills/glass-atrium-ops-orchestrator.md`

Maintainer-facing material for that skill reference. Nothing here binds the orchestrator; the skill file carries the duties.

## Held cap exception — `### Architecture Patterns [ORCHESTRATOR]`

This H3 stays over the 3 KB H3 cap. Each block below is held in place by its pin (suites under hooks/test/); move one only once its pin is retired or repointed in the same pass.

| Block (under this H3) | Pin that holds it in place |
|---|---|
| `#### Resilient Workflow Authoring [ORCHESTRATOR]` and its `#####` children | frozen `agents/` citations at this level · `schema-cap-authority-single-site.bats` |
| `##### Absolute schema-cap rules` | the rule phrases `orchestrator-skill-schema-example.bats` greps in this file |
| `##### Copyable helper (robustAgent)` | its `js` fence, replayed by `workflow-gate-completion-channel.bats` |
| `#### Analysis-Track Right-Sizing (input-side) [ORCHESTRATOR]` | the `AnalysisSchema` fence `orchestrator-skill-schema-example.bats` reads |
| `##### Stage gates` | revision caps cited by `references/review-rounds.md` · `scoped/maintainers/orchestrator-role.md` |
| `###### Copyable skeletons — 2-phase (verify → implement) and its 3-phase variant` | `###### Machine-checked skeletons` suites · the gate hook header's promotion condition |
| `##### Entry-class token placement (ultracode — DEV workflow)` | its declaration fence, read by the same suites |
