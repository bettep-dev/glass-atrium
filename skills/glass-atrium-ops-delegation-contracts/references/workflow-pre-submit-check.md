# Workflow pre-submit check table — what each check passes on and fails as

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Pre-submit self-check — run before submitting ANY DEV-spawning Workflow script` — when it runs, the lint-first order, the hand-checked rows, the simple-task subset and the obligations the gate cannot verify.
- Coverage: the gate's DEV-relevant block branches, the plan-stage rows its advisories back, and the parse hazards.

## Check table

| Check | Pass when | Fails as |
|---|---|---|
| entry token | a plan-ref or `[ENTRY-CLASS] simple-task: <reason>` token (raw-scanned, any placement) | entry-miss BLOCK · `lint` |
| `[SIZE-EST]` presence | a `[SIZE-EST]` token at every `dev-*` spawn — presence only, never correctness | size-est-miss BLOCK · `lint` |
| declaration present + well-formed | exactly one `[AGENT-COMPOSITION]` block in a `/* */` comment, parsing under the contract grammar | `block-nodecl` · `block-grammar` · `lint` |
| verify clause carries the DEV hard-gate | team form: reviewer + exactly one `dev-*` · or upstream form with `<N>` cited by a plan-ref token | `block-noverifydev` · `block-upstream` · `lint` |
| declaration matches the code | declared roles all spawn · code dev types all declared · `impl-computed:` types have data literals | `block-declspawn` · `block-undecl` · `block-computed` · `lint` |
| reviewer present and first | a reviewer spawn exists, and no declared impl `dev-*` spawn precedes every reviewer | `block-norev` · `block-order` · `lint` |
| JS parse hazards | no bash `${…}` form and no nested backtick inside `${…}` in a template literal | Workflow parse error |
| `implementing` write | the plan the plan-ref cites is at `implementing` or a later stage before submit | `implementing` advisory — stderr only |
| close token | the close form with a terminal Reconcile & Close phase, or the deferral form naming the closing step | close-token advisory — stderr only |

- Each BLOCK and `block-*` verdict exits 2.

## Where each check's detail lives

- grammar, verdicts and the upstream waiver — `skills/glass-atrium-ops-delegation-contracts/references/ultracode-declaration-contract.md`;
- sentinel placement and the opts `agentType:` literal a spawn needs — `skills/glass-atrium-ops-orchestrator.md` → `##### In-script verify-stage (ultracode)`;
- the two parse-hazard forms and their remedies — `skills/glass-atrium-ops-delegation-contracts/references/workflow-js-parse-hazards.md` → `## The two forms and their remedies`;
- a pre-verify Discovery `dev-*` tripping the ordering check — `skills/glass-atrium-ops-orchestrator.md` → ``### Pre-verify Discovery `dev-*` order guard (ultracode)``;
- the stage write and the close — `skills/glass-atrium-ops-orchestrator.md` → `## Managed Document Completion (Direct Handling)`; the close-token grammar — `skills/glass-atrium-ops-orchestrator-role.md` → `### Context Handoff Size`.
