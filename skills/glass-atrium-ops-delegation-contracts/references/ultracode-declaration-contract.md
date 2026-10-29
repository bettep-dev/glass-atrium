# Ultracode declaration contract (the mechanically-enforced facet of the Stage-2 gate — `[AGENT-COMPOSITION]`)

- **Why authors declare roles**: role information does not exist in code, so `enforce-workflow-verify-stage.sh` cannot infer verify roles from script layout; the author declares them, in parity with `[ENTRY-CLASS]` / `[SIZE-EST]` / `[DOC-ROUTE]` / plan-ref.
- **This gate**: `skills/glass-atrium-ops-orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`.
  - The standing obligation (one block, its `/* */` home, when it is owed): `#### Ultracode declaration contract` in that file.
  - The manual-vs-ultracode backstop split: `#### Backstop asymmetry (manual vs. ultracode)` in that file.
- **Strict line grammar** — keys `{verify, impl, impl-computed}`, one line per key:
  - Names are validated against the runtime DEV_SET roster plus the reviewer literal; free text is allowed only after a spaced dash.
  - `verify:` takes one of exactly two forms.
    - **Team form** — the comma-separated literal `verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-<domain>`: reviewer + exactly one `dev-*` type.
      - A space-joined pair collapses to one unknown name → `block-grammar`.
    - **Upstream form** — `upstream clauded-docs/<N>`: this workflow executes an already-verified persisted plan.
  - `impl:` = literal dev spawn types | `none`.
  - `impl-computed:` = indirectly-spawned dev types (config-array / ternary / wrapper indirection).
- **Exit-2 verdicts** — each one blocks the Workflow call:

  | Script condition | Verdict |
  |---|---|
  | no block at all on a DEV-spawning script | `block-nodecl` |
  | unknown/duplicate key · unknown name · malformed upstream clause · unterminated · 2+ blocks · 2+ verify dev types | `block-grammar` |
  | a team-form `verify:` clause naming no dev-* | `block-noverifydev` |
  | a DEV-spawning script with zero reviewer spawn anywhere in it | `block-norev` |
  | declared role never spawned | `block-declspawn` |
  | undeclared dev type in code | `block-undecl` |
  | declared computed type with no data-literal presence | `block-computed` |
  | a declared impl dev preceding every reviewer | `block-order` |
  | upstream `<N>` not cited by a plan-ref token in the script body | `block-upstream` |

  - `block-declspawn`: each declared verify/impl type must appear as an `agent('<type>')` first-arg or an `agentType:'<type>'` literal.
    - A type present only as a wrapper argument like `robustAgent('<type>',…)` has no spawn position and trips it: use the opts `agentType:` literal, or declare the type `impl-computed:`.
  - `block-undecl` fires on an undeclared real spawn and also on a dev-* literal with no spawn — one parked in a config array, or quoted in prose.
    - One-edit fix: declare the type (`impl-computed:` for a computed spawn), or de-quote the mention.
  - `block-order` applies the slot binding at `skills/glass-atrium-ops-orchestrator.md` → `###### Grammar and verdicts`.
    - Computed spawns have no static position, so their order is honor-system.
- **Simple-task waiver**: a script carrying `[ENTRY-CLASS] simple-task` and no plan-ref resolves every verdict in the table above to pass, `block-norev` included.
  - A plan-ref keeps them all.
  - SoT: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Entry classification (DEV delegations)` → **Simple-task waiver**.
- **Upstream waiver scope**: the upstream form waives the in-script pair-mapping and ordering only; `block-norev` is evaluated independently of declaration form and still fires under upstream.
  - Why: a fake upstream line can never remove reviewer presence.
- **HONESTY (the accepted floor, stated once)**: declaration presence, grammar and declaration↔code consistency are mechanical; role truthfulness is honor-system.
  - A lying declaration passes — the same trust model as the sibling attestation tokens.
  - Never describe this gate as semantic enforcement of the verify contract.
- **A legitimate pre-verify Discovery/Design phase stays compliant** by either route; a Discovery `dev-*` is truthfully a declared `impl:` spawn, and bound as an impl slot ahead of every reviewer it trips `block-order` (slot binding: **Exit-2 verdicts** → the `block-order` bullet):
  - **(a) non-DEV Discovery** — run pre-verify analysis with a non-DEV agent (`glass-atrium-intel-researcher` / `glass-atrium-intel-planner` / Explore), so no dev-* precedes the reviewer.
  - **(b) reviewer-first Contract phase** — front-load a reviewer-first `{glass-atrium-qa-code-reviewer, DEV}` verify (a real Contract phase, never a lone reviewer inserted only to satisfy ordering) before any Discovery dev-*.
  - Honest scope: a first-spawned Discovery `dev-*` of the verify-dev type is bound as the verify slot, which the gate does not catch — there the routes are an honor-system duty.
- Sentinel placement, the copy-verbatim declaration-bearing skeletons and the grammar deltas they rely on: `skills/glass-atrium-ops-orchestrator.md` → `##### In-script verify-stage (ultracode)`.
