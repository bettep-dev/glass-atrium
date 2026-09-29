# Ultracode declaration contract (the mechanically-enforced facet of the Stage-2 gate — `[AGENT-COMPOSITION]`)

- **Why authors declare roles**: role information does not exist in code, so `enforce-workflow-verify-stage.sh` cannot infer verify roles from script layout: the AUTHOR declares them, in parity with `[ENTRY-CLASS]` / `[SIZE-EST]` / `[DOC-ROUTE]` / plan-ref.
- **This gate**: `rules/glass-atrium/orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`; its manual-vs-ultracode backstop split is `#### Backstop asymmetry (manual vs. ultracode)` in the same file.
- **Pointer site**: `#### Ultracode declaration contract` in that file.
- **Strict line grammar** — keys `{verify, impl, impl-computed}`, ONE line per key, names validated against the runtime DEV_SET roster (fed by agent_lifecycle sync-gate-roster — never a second hardcoded list):
  - `verify:` takes one of exactly two forms.
    - **Team form** — the comma-separated literal `verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-<domain>`: reviewer + exactly ONE `dev-*` type. A space-joined pair collapses to one unknown name → `block-grammar`.
    - **Upstream form** — `upstream clauded-docs/<N>`: this workflow executes an already-verified persisted plan.
  - `impl:` = literal dev spawn types | `none`.
  - `impl-computed:` = indirectly-spawned dev types (config-array / ternary / wrapper indirection).
- **Exit-2 verdicts** — each one BLOCKS the Workflow call:

  | Script condition | Verdict |
  |---|---|
  | no block at all on a DEV-spawning script | `block-nodecl` |
  | block malformed — unknown/duplicate key · unknown name · unterminated · 2+ blocks · 2+ verify dev types | `block-grammar` |
  | a team-form `verify:` clause naming no dev-* | `block-noverifydev` |
  | a DEV-spawning script with zero reviewer spawn anywhere in it | `block-norev` |
  | declared role never spawned | `block-declspawn` |
  | undeclared dev type in code | `block-undecl` |
  | declared computed type with no data-literal presence | `block-computed` |
  | a declared impl dev preceding every reviewer | `block-order` |
  | upstream `<N>` not cited by a plan-ref token in the script body | `block-upstream` |

  - `block-grammar` is a DISTINCT verdict from absence: a well-formed sentinel pair with garbage inside is a decidable author error, not fail-open territory.
  - `block-declspawn` is the one place the declaration is STRONGER than the sibling attestations — a phantom verify team is falsifiable against code.
    - Each declared verify/impl type must appear as an `agent('<type>')` first-arg or `agentType:'<type>'` literal.
    - A type present ONLY as a wrapper argument like `robustAgent('<type>',…)` has no spawn position and trips `block-declspawn`: use the opts `agentType:` literal or declare it `impl-computed:`.
  - `block-undecl` fires on a real spawn AND on Tier-A coverage: a config-array dev literal or an exact-quoted dev-* prose mention with zero spawns — one-edit fix: declare the type, or de-quote the mention.
  - `block-order` binds on the greedy-earliest same-type dual-role binding; computed spawns have no static position → declared-order honor-system.
- **Upstream waiver scope**: the upstream form waives the in-script pair-mapping + ordering ONLY — the `block-norev` zero-reviewer hard guarantee is evaluated independently of declaration form and SURVIVES upstream, so a fake upstream line can never delete reviewer presence.
- **HONESTY (the accepted floor, stated once)**: declaration presence + grammar + declaration↔code consistency are MECHANICAL; role TRUTHFULNESS is honor-system — a LYING declaration passes, the same trust model as the sibling attestation tokens. NEVER describe this gate as semantic enforcement of the verify contract.
- **A legitimate pre-verify Discovery/Design phase stays compliant** via the declaration + ordering check, by either route:
  - **(a) non-DEV Discovery** — run pre-verify analysis with a NON-DEV agent (`glass-atrium-intel-researcher` / `glass-atrium-intel-planner` / Explore), so no dev-* precedes the reviewer.
  - **(b) reviewer-first Contract phase** — front-load a genuine reviewer-first `{glass-atrium-qa-code-reviewer, DEV}` verify (a real Contract phase, NOT a lone reviewer inserted only to satisfy ordering) before any Discovery dev-*.
  - Either way, a declared impl dev textually preceding all reviewers still blocks (`block-order`).
- Sentinel placement, the copy-verbatim declaration-bearing skeletons and the grammar deltas they rely on: `skills/glass-atrium-ops-orchestrator.md` → `##### In-script verify-stage (ultracode)`.
