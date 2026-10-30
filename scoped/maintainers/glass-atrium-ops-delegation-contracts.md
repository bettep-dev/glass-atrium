# Maintainer note — `skills/glass-atrium-ops-delegation-contracts/`

Maintainer-facing material for that skill's `SKILL.md` and its `references/` files. Nothing here binds the orchestrator; the skill's pointer sites carry the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: `SKILL.md` and the `references/` files carry no stub heading and no prose pointer to this note; `## Edit Rules` lists each cited lead and heading with its file.

## Edit Rules

- **Machine-read literals**: the token literals and their field keys, and the `block-*` verdict names, are what the spawn gates scan for and emit — keep them byte-identical.
  - The maintained list of those literals and their sites: `scoped/maintainers/orchestrator-role.md` → `## Byte contract every edit must honour` · `## Reserved names`.
- **Pointer sync**: edit an obligation or trigger only at its pointer site, the SoT; a reference file names it and never restates it.
- **Cited leads**: a bolded lead in a reference file can be a pointer target in another file — grep the corpus before renaming one. Leads cited by name elsewhere:
  - `references/scope-parser.md` → **Declaration line**.
  - `references/ultracode-declaration-contract.md` → **Exit-2 verdicts** · **HONESTY** · the pre-verify Discovery/Design bullet.
  - `references/delegation-size-discipline.md` → **`[SIZE-EST]` self-attestation token** · **`[SIZE-EST]` analysis mode** · **Reserve-then-check** · **Effort matched to depth** · **Honesty framing** · **Output-field cap**.
  - `references/automatic-parallelization.md` → **Three sanctioned isolation paths** · **Deciding "at a time"**.
- **Cited headings**: a heading in a reference file cited by name elsewhere keeps its text and level — grep the corpus before renaming one:
  - `references/scope-parser.md` → `## Worked completeness case`.
  - `references/plan-direction-verification.md` → `## Team composition and verdicts` · `## Standing jobs inside the gate` · `## Gate outcome and activation scope` · `## Backstop detail`.
  - `references/deliverable-exposure.md` → `## Exposure Determination — signals and routing` · `## glass-atrium-dev-front markup exception — detail`.
  - `references/architecture-patterns.md` → `## Explicit Pipeline Combinations` · `## Agent Teams Hybrid`.
  - `references/workflow-js-parse-hazards.md` → `## The two forms and their remedies`.
  - `references/delegation-size-discipline.md` → `## Effort-scaling table` · `## Analysis-Track Right-Sizing (input-side)`.
  - `references/agent-selection.md` → `## Selection procedure` · `## Ordering caveat (ultracode verify-gate)` · `## Compound Task Examples` · `## Routing-Decision Record` · `## Routing Verification (LLM-as-Judge)`.
  - `references/delegation-prompt.md` → `## Resource Budget` · `## Prompt-content aids` · `## Read-Extent Discipline` · `## Delegation Information-Hiding`.
  - `references/managed-document-completion.md` → `## Supersede vs new document`.
  - `references/workflow-pre-submit-check.md` → `## Check table`.
- **Coupled tests on `references/delegation-size-discipline.md`** — paraphrase none of these pins away:
  - `hooks/test/orchestrator-skill-schema-example.bats` requires `const AnalysisSchema = {`, `findings: 'string'` and `completion_block: 'string'`, the last as a declared member inside that fence.
    - It also requires the capped-property notation and the withdrawn per-row cap-sizing floor literal absent.
  - `hooks/test/workflow-gate-completion-channel.bats` replays every `js` fence in the file through the gate, so a fence added there must pass it unmodified.
  - The path is pinned verbatim: the `hooks/enforce-workflow-verify-stage.sh` header promotion condition names it, and `hooks/test/enforce-workflow-verify-stage.bats` asserts that header text.
- `SKILL.md` keeps its `## Reference Index` tables as the split authority the other maintainer notes cite ("that skill's `SKILL.md` → Reference Index"); a pointer-site or reference-file SoT change edits its row there.
