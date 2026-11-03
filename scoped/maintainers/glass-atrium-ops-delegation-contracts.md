# Maintainer note — `skills/glass-atrium-ops-delegation-contracts/`

Maintainer-facing material for that skill's `SKILL.md` and its `references/` files. Nothing here binds the orchestrator; the skill's pointer sites carry the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: `SKILL.md` and the `references/` files carry no stub heading and no prose pointer to this note.

## Edit Rules

- **Machine-read literals**: the token literals and their field keys, and the `block-*` verdict names, are what the spawn gates scan for and emit — keep them byte-identical.
  - The maintained list of those literals and their sites: `scoped/maintainers/orchestrator-role.md` → `## Byte contract every edit must honour` · `## Reserved names`.
- **Pointer sync**: edit an obligation or trigger only at its pointer site, the SoT; a reference file names it and never restates it.
- **Cited leads**: a bolded lead in a reference file can be a pointer target in another file — grep the corpus for it before renaming one.
  - `references/ultracode-declaration-contract.md` → **A legitimate pre-verify Discovery/Design phase stays compliant** is cited as `pre-verify Discovery/Design bullet`, so grep that name too.
- **Cited headings**: a heading in a reference file cited by name elsewhere keeps its text and level — grep the corpus for it before renaming one.
- **Coupled tests on `references/delegation-size-discipline.md`** — paraphrase none of these pins away:
  - `hooks/test/orchestrator-skill-schema-example.bats` requires `const AnalysisSchema = {`, `findings: 'string'` and `completion_block: 'string'`, the last as a declared member inside that fence.
    - It also requires the capped-property notation and the withdrawn per-row cap-sizing floor literal absent.
  - `hooks/test/workflow-gate-completion-channel.bats` replays every `js` fence in the file through the gate, so a fence added there must pass it unmodified.
  - The path is pinned verbatim: the `hooks/enforce-workflow-verify-stage.sh` header promotion condition names it, and `hooks/test/enforce-workflow-verify-stage.bats` asserts that header text.
- **Revise carve-out duty placement** (`references/managed-document-completion.md` → `## Supersede vs new document`): the duty stays in the completing agent's own loaded rules, never in the delegation asking for the edit — a control the acting agent can suspend by phrasing is not a control.
- **Reference Index**: a pointer-site or reference-file SoT change edits its row in `SKILL.md` → `## Reference Index`.
  - `scoped/maintainers/orchestrator-role.md` cites those tables as the split authority, so they stay.
