# Maintainer note — `rules/glass-atrium/orchestrator-role.md`

Maintainer-facing material for that rule file and its full text. Nothing here binds the orchestrator; the rule file carries the duties.

## Stub and full-text split

- `rules/glass-atrium/orchestrator-role.md` is a stub; the full text sits verbatim in `skills/glass-atrium-ops-orchestrator-role.md`, an on-demand reference the main session Reads by path.
  - Why: the file at that path reaches every subagent on the host channel, while the control-plane core (`scoped/orchestrator-core.md`) already reaches the main session at SessionStart.
- The stub keeps the path: AA-scoped code, `agents/GLASS_ATRIUM_GLOBAL_RULES.md` ("its opening line") and the ORCHESTRATOR pair row in `rules/glass-atrium/core-compliance-matrix.md` cite it.
- In this note, "the rule file" means the full text; the stub is named as the stub.
- What the stub keeps, each for a reader that cannot be repointed:

| Kept in the stub | Reader |
|---|---|
| the H1 + opening blockquote, verbatim | `agents/GLASS_ATRIUM_GLOBAL_RULES.md` ("its opening line") |
| `### Cost-Tier Selection` + the live-operator Model pins bullet, verbatim, under its wrapper H2 | `autoagent/lib/editable_merge.py` · `autoagent/test/test_editable_merge.py` |

- A kept verbatim line is a mirror of its full-text canonical: edit both together.
- Every other citer points at the full text, never at the stub; a stub heading with no remaining citer goes.
- Citers whose quoted text differs from the full text; each entry names the file its citation resolves to:
  - `hooks/advisory-subagent-budget.sh` says "40-52 tool_use truncation band"; it resolves to `skills/glass-atrium-ops-orchestrator-role.md`, whose **HARD SECONDARY** bullet says "measured 46-52".
  - `autoagent/lib/editable_merge.py` quotes "NEVER ported to git"; it resolves to the stub's `### Cost-Tier Selection`, whose Model pins bullet reads "never".
  - `autoagent/daemon_cycle.py` cites "Self-Improvement User-Approval Trigger" at `orchestrator-role.md`; it resolves to `skills/glass-atrium-ops-orchestrator.md`.
    - The fix belongs at that comment (point it at the skill), never a pointer back in the rule file (`### Failure Recovery Loop` linkage below).

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no pointer to this note; its linkage is recorded under the `## Linkage` headings below.
  - The one editor-addressed HTML comment, atop the rule file's Cost-Tier Selection section, is the carve-out above: it names `CostTierRuleTextTest` and this note. The stub carries none.

## Byte contract every edit must honour

- The consumers below are the maintained statement of what the rule file's machine readers read: reword the rule file around what they read, never through it.
- `CostTierRuleTextTest` — `hooks/test/test_daemon_config_loader.py`.
  - Reads the repo-tree copy, not the install (the module resolves the rule path from its own location), so a branch edit is verifiable before deploy.
  - Reads the text after the Cost-Tier Selection heading, up to the next `###` substring, for these phrases: the heuristic label on the table · the daemon config-reader module name · the pinned worker-model-id fallback.
  - Breaks when the heading is renamed, or one of the three phrases is reworded.
  - Breaks when any `###` substring — a `###` or `####` heading, or a hash-prefixed heading name in prose — lands ahead of them, truncating the parsed span.
    - The rule file's Cost-Tier editor comment sits inside that span, so it must never contain a `###` substring.
  - Breaks when that heading's exact literal is written a second time anywhere above it, re-aiming the split at the wrong copy.
  - Runs only in the `test-python` CI job, which a markdown-only PR skips: run it locally after any edit to the rule file.
- The close-token bats case — `hooks/test/inject-session-context.bats` → "the workflow pre-flight carries both close-token forms of the grammar SoT".
  - Reads both close-token form literals, token included: exactly one of each across the file.
  - Breaks when either form literal is reworded, or written a second time anywhere in the file, quoted or not.
  - Runs in the bats CI leg, which an edit to the rule file triggers.
- Hooks under `hooks/` quote the rule file's heading names into operator-facing block and advisory text; grep `hooks/` for the full-text path to find them.
  - They break when a cited heading is renamed, sending a blocked operator to a section that no longer exists.
- Corpus files under `scoped/`, `skills/` and `agents/` cite the same heading names, plus the bolded leads under `## Reserved names`; they break when one is renamed.
- **Indifferent suites**: `hooks/test/enforce-workflow-verify-stage*.bats` and `hooks/test/enforce-verification-gate*.bats` drive the hooks through their own fixtures and never read the rule file.
  - They neither guard nor fail on its wording; they guard the token and verdict literals at the hook.
- Must stay byte-exact, each at the site named — the rule file unless another file is given:
  - the opening blockquote as first content line, in the stub and the rule file alike;
  - the attestation tokens and `block-*` verdict names, listed under `## Reserved names`;
  - the `block-*` verdict names in the verdict table's Verdict column: `skills/glass-atrium-ops-delegation-contracts/references/ultracode-declaration-contract.md`;
  - the closed lexicon, premise-register and `[PLAN-SUBSET]` grammars;
  - both `[SIZE-EST]` grammars: `skills/glass-atrium-ops-delegation-contracts/references/delegation-size-discipline.md`;
  - the `[SIZE-EST]` key names on the `#### Delegation-size discipline` pointer;
  - the `[SCOPE]` grammar;
  - the six-plus-`7th` delegation-element count — `scoped/orchestrator-core.md` → `## Request flow` mirrors the six, so the two move together;
  - `Rule 1` and the three BASENAME names;
  - `AUTOAGENT_PREFLIGHT_ACTIVE=1 scripts/run-bats-parallel.sh`;
  - the Document-Driven Workflow step numbers.
- The statement of this duty for that skill's editors, covering `references/ultracode-declaration-contract.md` and `references/delegation-size-discipline.md`: `scoped/maintainers/glass-atrium-ops-delegation-contracts.md` → Edit Rules → **Machine-read literals**.

## Reserved names

- **Attestation tokens** — `[SCOPE]` · `[ENTRY-CLASS]` · `[SIZE-EST]` · `[PLAN-SUBSET]` · `[PLAN-CLOSE]` · `[AGENT-COMPOSITION]` · `[DOC-ROUTE]`: the bracketed literal and its field keys or form values are what the spawn gates scan a delegation or script for.
- **Verdict names** — `block-nodecl` · `block-grammar` · `block-norev` · `block-noverifydev` · `block-declspawn` · `block-undecl` · `block-computed` · `block-order` · `block-upstream`.
  - Each is a trace tag `hooks/enforce-workflow-verify-stage.sh` emits. The rule file names them; the hook defines them.
- **Headings** cited by name elsewhere in the corpus:
  - `## Orchestrator Identity` · `## Delegation Criteria` · `## Delegation Workflow` · `## Document-Driven Workflow` · `## Harness Path Protection` (with its `Rule 1`, `### Write routes`, `### Progress-file exclusion`).
  - `### Phase Notes`, with `#### Entry classification (DEV delegations)` · `#### Plan edge discovery`.
  - `#### Decision-phase probes` · `#### Deliverable exposure and designer composition` · `#### Monitoring-phase notes` · `#### Scan boundary and provenance`.
  - `### Plan Direction Verification (Stage-2 gate)` · `### Spawn Budget` (with Delegation-size discipline) · `#### Automatic Parallelization` (with guardrail `(a)`) · `### Context Handoff Size` · the Cost-Tier Selection heading · `### Failure Recovery Loop`.
  - Pointer sites, the `block-*` verdict table's file included: `skills/glass-atrium-ops-delegation-contracts/SKILL.md` → Reference Index.
  - Cited by that skill's reference files: `#### Backstop asymmetry (manual vs. ultracode)`.
  - Cited from `scoped/orchestrator-core.md` and `skills/glass-atrium-ops-orchestrator.md`: `#### Depth and concurrency ceilings`.
  - Cited from `scoped/orchestrator-core.md` only: `## Owner Queue`.
- **Bolded leads** cited by name:
  - under the phase-note H4s:
    - `#### Decision-phase probes`: Capability Probe · Compatibility Probe;
    - `#### Deliverable exposure and designer composition (Decision phase)`: Exposure Determination · Visual-Weight Probe;
    - `#### Monitoring-phase notes`: Verbatim forward-relay · glass-atrium-dev-front markup-exception Monitoring judgment;
  - under `### Spawn Budget`: Split triggers · HARD SECONDARY · Empirical tool_use calibration · Standing obligation (the one under `#### Delegation-size discipline`) · COUNTER-CAVEAT (over-fragmentation);
  - under `#### Analysis fan-out and team cardinality`: Effort-scaling by task shape;
  - under `### Context Handoff Size`: Attestation-token placement;
  - under `### Failure Recovery Loop`: Backing honesty (which stages are enforced) · Retry effort escalation · Regression-chain trigger;
  - under `## Document-Driven Workflow` step 6: Prompt-file tail.
- Neither list is exhaustive: grep the corpus for a heading or bolded lead before renaming it.

## Wrapper headings

- The rule file's H2s `## Decision-Phase Notes` · `## Monitoring and Provenance Notes` · `## Verification Gates and Cost Tiers` · `## Spawn Sizing and Team Composition` · `## Handoff and Failure Recovery` are split points that hold each H2 under the 8 KB cap.
- Its H3s `### Pre-spawn Probes` · `### Deliverable Exposure` · `### Monitoring Notes` · `### Provenance` · `### Stage-2 Backstops` · `### Team Composition` · `### Parallel Fan-out` wrap cited H4s, so that no H3 carries more than one cap's worth of them.
- `### Context Handoff Size` has no wrapper and no H4: its citers name it for the summary-only rule, the delegation-element count, the token placement and both token grammars, so all of them stay directly under it.
- `### Spawn Budget`, `### Provenance`, `### Context Handoff Size` and `### Phase Notes` sit near the 3 KB H3 cap: byte-measure each, H4 children included, before any addition to it.
  - A line that would push `### Phase Notes` over the cap moves plan-edge detail to `references/plan-edge-discovery.md` first.
  - A line that would push `### Context Handoff Size` over the cap moves `[SCOPE]` detail to `references/scope-parser.md` first.
- A section that grows past a cap splits the same way: insert a wrapper heading, never change a cited heading's level.
  - Why: hooks quote `### Spawn Budget`, `### Context Handoff Size` and `### Phase Notes`, and `CostTierRuleTextTest` splits on the next `###`.
- A wrapper is a split point, not a citation target: cite the heading inside it.

## Linkage moved out of the rule file

- Under every `## Linkage` heading in this note: where a rule-file heading keeps a pointer and its detail sits in a `skills/glass-atrium-ops-delegation-contracts/references/` file, the split between them is recorded in that skill's `SKILL.md` → Reference Index, not here.

### `#### Deliverable exposure and designer composition (Decision phase)`

- The explicit format/share signal list behind **Exposure Determination** restates the signal literals; it sits in `references/deliverable-exposure.md` → `## Exposure Determination — signals and routing`.
  - Canonical literals: `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test (explicit-request-only — heuristic auto-HTML FORBIDDEN)`.
  - Mirror: `agents/glass-atrium-intel-planner.md` → `### HTML request test (explicit-request-only — heuristic auto-HTML FORBIDDEN)`, under `## Output Format Routing`.
  - Routing rule: `scoped/scope-report.md` → `### HTML request test`.
- The orchestrator's copy is the pointer plus that reference, together. The pointer's one-bit rule reaches the orchestrator without a read; the signal literals sit one read away in the reference.
  - One read away is enough because the authoring agent re-decides the format at turn-0, so the orchestrator's bit is a hint.
  - Edit the pointer and the reference with the set, and never delete either as redundant.
- The local-destination stamp is single-sited at the rule file's `### Authoring delegation is MANDATORY (never the inline path)` → "One sanctioned exception"; the heading carries no second statement of it.
- The T1-T5 thresholds in the **Visual-Weight Probe** restate `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`; `scoped/scope-planning.md` carries a pointer only.
- Other counting sites:
  - `agents/glass-atrium-intel-reporter.md` → `## Designer Handoff Contract` references the scope-report canonical and carries no threshold table.
  - `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract` carries the planner's own threshold table.
  - For the consulted designer, the stub `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` keeps the trigger, output fields and veto line; the preloaded `skills/glass-atrium-design-html-co-emission/SKILL.md` keeps the full consultative scope.
- The probe is the orchestrator-side counting site, not a duplicate: edit it with those copies and never delete it as redundant.

### `#### Monitoring-phase notes`

- The dev-front markup-exception judgment's orchestrator-side canonical, for the judgment only, is the pointer under `#### Monitoring-phase notes` plus `references/deliverable-exposure.md` → `## glass-atrium-dev-front markup exception — detail`.
- The author-side protocol canonical is `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`, pointed to from `scoped/scope-planning.md` → `## Designer Co-Emission Trigger [PLANNING]`.
- Agent-body halves: `agents/glass-atrium-intel-reporter.md`, `agents/glass-atrium-intel-planner.md`, `agents/glass-atrium-dev-front.md`; `skills/glass-atrium-design-html-co-emission/SKILL.md` restates it for the consulted designer.

### `#### Decision-phase probes` and `#### Scan boundary and provenance`

- The closed lexicon's recall is unknown: its quantifier group was pruned against a single incident, so a hook reading the list stays advisory until a false-positive record justifies promotion.
  - Such a hook takes its literals from the rule file's list, cross-read at review, never from a second maintained copy.

### `#### Entry classification (DEV delegations)`

- Its SIZABLE criteria are the Decision action rows of `## Delegation Workflow`, a condensed copy of `scoped/maintainers/scope-dev.md` → `### Sizable-task definition (single SoT — the positive entry floor)`: edit the two together.
- The hooks behind the waiver's honest-backing line, each reading token presence only: `hooks/enforce-verification-gate.sh` · `hooks/enforce-workflow-verify-stage.sh` · `hooks/validate-scope-drift.sh`.

### `#### Plan edge discovery`

- The H4 does not restate the simple-task waiver: `[PLAN-SUBSET]` is listed in the waiver itself, and the HALT's reach line keeps simple-task entries bound.
- The `[PLAN-SUBSET]` grammar stays in the rule file because the byte contract above names the rule file as its site. Move it only together with that line.

## Linkage — gates, tiers and budgets

### `### Plan Direction Verification (Stage-2 gate)`

- The gate-operation canonical is the pointer plus `references/plan-direction-verification.md`.
- The participant-duty canonicals are the two scope-file headings the pointer's **Ownership** line names.
- The hooks quote only the gate heading (`hooks/enforce-verification-gate.sh` reviewer-miss reason, `hooks/enforce-workflow-verify-stage.sh` DEV hard-gate warning), which stays.
- The reference's cited `##` headings, text and level fixed: `scoped/maintainers/glass-atrium-ops-delegation-contracts.md` → Edit Rules → **Cited headings**.
  - Citer naming the `##` level: `scoped/maintainers/scope-qa.md` (two Team-composition citations).
- Location-only citer that stays: `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria` → the Stage 2 bullet names the gate heading for team composition, DEV hard gate, activation scope and direction-not-completeness. The pointer keeps all four.
  - Its **Stage-2 revision/escalation** bullet names the same heading for the escalation path; the pointer's **Revision + escalation** carries that path and its path-only limit.
- The pointer, its reference and the two scope-file duty canonicals are not a redundancy to collapse; no dev-* or reviewer body mirrors the scope files.
  - A duty moved into the rule file is read by the wrong actors and owed by none.
  - A duty deleted from a scope file loses its only maintained statement.
- Do not copy the first-link question literal into the rule file or its Stage-2 reference; both point to it only.
  - The literal is cross-read between `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` and the ultracode gate's presence scan in `hooks/enforce-workflow-verify-stage.sh`.
    - That scan is pinned by `hooks/test/enforce-workflow-verify-stage-firstlink.bats`; a further copy adds a drift surface no suite polices.

### `### Cost-Tier Selection`

- Why the rule file's `load_daemon_config` fallback is a pinned id: the monitor rejects a bare alias for the worker model, and `hooks/pricing.json` cannot price one.
- That id sits in every seam holding the fallback:
  - `hooks/daemon_config.py` → `_FALLBACK`;
  - `scripts/lib/atrium-config.sh` → `atrium_resolve_worker_model`;
  - `monitor/src/server/model-config-consts.ts` → `RETIRED_WORKER_MODEL_REPLACEMENT`;
  - `monitor/prisma/migrations/20260901000000_rename_haiku_model_config_keys_to_worker/migration.sql` → both `model.daemon_cycle_worker` values.
- Moving the id:
  - the migration's values move only through a new migration, never by editing the applied file.
    - Why: `migrate deploy` never re-applies an applied migration, so an edit reaches fresh installs only (`migration.sql` → "WHY a new migration rather than an edit").
  - every other seam is edited together, deliberately.
- Pinned ids are sanctioned in those fallback seams and in the monitor's model-config seed values for the domains it renders into live agent frontmatter.
  - The repo-body ban that binds authors — no `model:` key and no hardcoded tier/version string in repo agent bodies or daemon body proposals — lives in the rule file's Model pins.
- The dashboard `fail_rate` the tier-escalation heuristic reads is computed read-only in monitor `agents.ts`; no code consumes it to switch a tier.
- The rule file's "every pin is LIVE-ONLY, and the updater preserves it across updates" (`### Cost-Tier Selection` → Model pins) is implemented by `autoagent/lib/editable_merge.py` → `_LOCAL_ONLY_FRONTMATTER_KEYS`, exactly `("model",)`.
  - `effort` is not in it: `_BASE_AWARE_FRONTMATTER_KEYS` keeps a live `effort` line only when it differs from base@install, or always when no base anchor exists (live-wins), so the LIVE-ONLY sentence never extends to `effort`.
- `scripts/test/glass-atrium-update.bats` cites the full text's "Cost-Tier Selection" as the sanction for live-wins, as the stub's two readers in the table above do: keep that heading and the sanction sentence in both files.

### `#### Analysis fan-out and team cardinality`

- **Effort-scaling by task shape** is a one-line pointer.
  - Citers: the heading is cited by `skills/glass-atrium-ops-orchestrator.md` and stays; the partition-then-size line under `#### Automatic Parallelization` names the lead.

### `#### Automatic Parallelization`

- Guardrail (a)'s agent-binding rules, the index-mutation class and the mechanisms they answer live in Tier-1 `rules/glass-atrium/core-git-workflow.md` → Commits → **Concurrent worktree** · **Worktree occupancy**, which reaches every agent on the host channel.
  - Never copy them back into the rule file: its opening line tells subagents to ignore it, so a rule placed there loses its agent audience.
- `skills/glass-atrium-ops-orchestrator.md` cites the Tier-1 home and the leads of `references/automatic-parallelization.md` directly. Before renaming such a lead, grep for its citers (`scoped/maintainers/glass-atrium-ops-delegation-contracts.md` → Edit Rules → **Cited leads**).
- Main-session copies in `scoped/orchestrator-core.md` → `## Routing` move with their rule-file sites:
  - the compound-request line ↔ the `## Delegation Workflow` Forbidden row `Collapsing compound requests into a single agent that does not fit every part` ↔ `skills/glass-atrium-ops-orchestrator.md` → `#### Selection procedure` ("route it by fit").
    - The core line carries the full scope: one agent takes only the parts it fits and its context can carry, in step with `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Sub-Agent Spawn Policy [ALL]`.
    - The row and the skill line state its short form.
  - the parallel-by-default line ↔ `#### Automatic Parallelization` → **Standing obligation**.
    - Decided keep: it orders sub-tasks already split and keeps both conditions (independent, non-overlapping), so the spawn policy still decides the split; reword it only on observed over-delegation.
    - The bullet under that H4 that opens `The default orders sub-tasks already split` states that reading and points at the spawn policy.

## Linkage — handoff and recovery

### `### Context Handoff Size`

- The `[SCOPE]` and `[PLAN-CLOSE]` grammar SoTs sit in the rule file; every other file carries a pointer only.
- The `[SCOPE]` author rules keep two binding lines in the rule file, the separators and first-wins with relaying.
  - `references/scope-parser.md` → `## Author rules — detail` holds only what the rule file does not say: never-merged, the bare-form relay case and the space-in-path limit.
- The simple-task waiver lives once at `#### Entry classification (DEV delegations)` → **Simple-task waiver**; the H3 does not repeat it; its `[SCOPE]` and `[PLAN-CLOSE]` grammar leads state only where each token is required.
- The `[PLAN-CLOSE]` advisory is advisory, not a block, because a multi-script track legitimately closes in a later script, which a block would false-positive on.
- The delegation-prompt language rule is the Tier-1 `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language`.
  - The rule file keeps only the delta, a Delegation action row: injected literal strings set apart in backticks or a blockquote.
- `parent_cid` sits under `#### Routing output: team schema, size, and correlation ID` → Correlation ID; the prompt-quality routing line is a Delegation action row.

### `### Failure Recovery Loop`

- `**Debugger evidence gate**` has no other maintained copy — `scoped/shared-investigation-discipline.md` only points at it as the orchestrator half.
  - Its backing is stated in the rule file's **Backing honesty (which stages are enforced)** pointer, which names the gate as honor-system.
- The bolded lead **Retry effort escalation** under `### Failure Recovery Loop` has no other maintained copy.
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Thinking Budget Policy [ALL]` → **Task-class rule** cites it by name as one tier mover.
  - `references/failure-recovery.md` carries no Retry or tier text.
- The deliberate-blocker exception to the loop sits at `#### Monitoring-phase notes` → **Blocker class**, not under this H3, which is at its cap; the loop's opening line names that bullet as the only way a `blocked` result enters.
  - `#### Decision-phase probes` states a handling policy — treat a failed probe as a deliberate blocker — and leaves the class definition to the charter section.
  - That bullet and `#### Decision-phase probes` cite `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Obstacles and Blockers [ALL]`: a rename of that heading lands in both.
- The rule file carries no pointer to `skills/glass-atrium-ops-orchestrator.md` → `### Self-Improvement User-Approval Trigger`.
  - The orchestrator reaches that section through Tier-1 `rules/glass-atrium/core-learning-log.md` → Instruction Improvement Approval Tier.

## Linkage — lifecycle and harness

### `## Document-Driven Workflow (end-to-end lifecycle)`

- `## Document-Driven Workflow` is the orchestrator-side lifecycle SoT. `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria` mirrors its gate sequence as per-stage acceptance detail and carries the ultracode in-script verify-stage skeleton.
  - The skill cites the rule file as the SoT for step 4's procedure (`#### Pipeline Acceptance Criteria`) and for step 6's pre-PR default and live-suite threshold (`#### Deploy-Safety Idiom`). Edit the two together; neither is a redundancy to delete.
  - Step 6's per-cycle order line and its narrow post-merge cases live in `references/live-deploy-gate.md`; `#### Deploy-Safety Idiom` cites that file for them, so an edit there moves with the skill's citer too.
  - Step 6's **Prompt-file tail** is an insertion into the reference file's per-cycle order, never a second order; the reference file's `## Per-cycle order` points to it by that lead.
    - The tail is also the single site of the prompt-file cycle trigger class; every other file points to the tail rather than restating the class.
      - Why the class reaches code: model-received text is prompt text whatever file carries it, and the add-review table already routes code-file hunks to a DEV reviewer.
      - The class is stated with examples, never as a file list: a list drifts as hooks and daemon prompts are added or moved.
      - A code hunk whose coupled test must change: `scoped/shared-authoring-hygiene.md` → `## Prompt-Audit Overrides` → **Test-consumed literals**.
    - Citers that move with it:
      - `live-deploy-gate.md` → `## Per-cycle order`;
      - `skills/glass-atrium-ops-delegation-contracts/SKILL.md` → Reference Index row "Pre-merge live-deploy gate";
      - `#### Deploy-Safety Idiom` → the step-6 pointer;
      - `#### Pipeline Acceptance Criteria` → `##### Stage gates`;
      - `scoped/scope-meta.md` → `## Prompt Deliverable Team Rule` → **Prompt-audit pass**.
- Step 6's pointer to `scoped/shared-destructive-path-suite-safety.md` keeps the phrase "pointer only, the procedure is single-sited there": `scoped/maintainers/shared-destructive-path-suite-safety.md` quotes it as the reason that procedure stays single-sited. Reword both together or neither.

### `## Harness Path Protection`

- No hook stands behind the section: Rule 1 is honor-system, and no write in its scope is blocked.
- The detection statement is single-sited at `rules/glass-atrium/core-security.md` → `### Enforcement boundary` → **Harness integrity**.
  - The section (its `### Write routes` included), `scoped/orchestrator-core.md` → `## Harness path protection`, `skills/glass-atrium-ops-orchestrator.md` and `references/deploy-safety-idiom.md` each point there; none restates the compared kinds.

## Linkage — owner queue

### `## Owner Queue`

- The section is the only rule text telling a session what to post and when to use the queue; `scoped/orchestrator-core.md` → `## Where the rest lives` carries its trigger line.
  - That line stays one line: the core is printed whole at SessionStart, inside `hooks/inject-session-context.sh` → `CONTEXT_CAP_UNITS`.
  - The trigger line states the must-not-miss obligation, the turn's `record` call and the relay keyword, and nothing more of the rule.
    - Single-sited in the section: the posting table, the must-not-miss kinds list and the record's forms.
  - The trigger line names no wait: a session reaches the wait rows through a trigger it already has — background job, posting, or the resume prompt's own wait step.
  - The trigger line states no relay rule: a recipient reaches `## Owner Queue Relay` through the `[ATRIUM-QUEUE]` trigger and `### Claimed items`, and each relay's provenance line states its own reading.
- The section restates no command list or item JSON: their home is `scripts/atrium-queue.sh` → `print_usage`.
  - A tool's inputs live in the MCP adapter's tool schemas (`scripts/atrium-queue-mcp.sh` → `TOOLS`): `## Owner Queue Tools` names the tools and their CLI counterparts, and no input.
  - Its `wait` exit rows, under `### On a wait's exit`, are the one exit-code list it carries: a mirror of `print_usage` → `On a wait's exit`, canonical there, so both stay.
    - `print_usage` states each action bare; the rule binds the rows to a background job session and a resumed one, and has an interactive session restart no `wait`.
  - The wait's bound is named, never quoted: its values live in `scripts/atrium-queue.sh` → `WAIT_MINUTES_DEFAULT` · `WAIT_MINUTES_MAX`.
  - The section's `"again once"` restart row reads `once` as one restart, then stop: `print_usage` states no second failure.
- The posting table defines a background job session by how it started, never by `CLAUDE_JOB_DIR`.
  - Why: a process started inside a job inherits that variable (`scripts/lib/queue-session.sh` → `queue_get_job_name`).
  - The listener's run condition does read that variable, in the closed direction only: an inherited one costs a session its listener and never starts one (`hooks/queue-listener.sh` → `is_listenable_session`).

### Owner Queue — split points

- `## Owner Queue Tools`, `## Owner Queue Authority`, `## Owner Queue Relay`, `## Owner Queue Listener` and `## Owner Queue Waiting` are split points holding `## Owner Queue` under the 8 KB H2 cap.
  - A citer outside the rule file names `## Owner Queue`, never a split: the core's trigger line names it alone.
  - `## Owner Queue` keeps one pointer line to each of `## Owner Queue Tools`, `## Owner Queue Authority` and `## Owner Queue Relay`, in its lead list.
    - Single-sited in `## Owner Queue Tools`: which route a session takes, the tool-to-CLI table, the CLI's spelling, the main-session rule with its backing, and what each claimed item calls for.
    - Single-sited in `## Owner Queue Authority`: the trust rule and its source-and-first keying, the approval scope, the approval posting form, the owner-only actions and their honest backing.
    - Single-sited in `## Owner Queue Relay`: when and how to relay, the bounds by name, the reading of a received relay and the relay's honest backing.
    - `### Claimed items` and `### Untrusted sources` each carry a relay row that only points at `## Owner Queue Relay`.
    - `### Envelopes and authority`, `### Untrusted sources`, `### Provenance and images` and `### Owner-only actions` live in `## Owner Queue Authority`; the middle two are split points holding `### Envelopes and authority` under the 3 KB H3 cap.
  - A session reaches `## Owner Queue Listener` through the pointer on the wait table's `[ATRIUM-QUEUE]` `pending` row, where a woken session looks.
    - The action on a wake stays single-sited in the wait table's `[ATRIUM-QUEUE]` rows.
  - `### On a wait's exit` is a split point holding `### Answers and messages` under the 3 KB H3 cap: the wait table's last row points to it.
    - It sits under `## Owner Queue Waiting`: a session reaches its rows only through that row, after a `wait` it started has exited, and the core's trigger line names no wait — so the split loses no reader the trigger sends.
  - `### Last-act post` is a split point holding `### Posting and registering` under the 3 KB H3 cap: the **Turn record** tool-route bullet points to it.
  - `### Wait or listener` is a split point of the same H3 and the single site of the wait-or-listener rule.
    - Its pointers: the wait table's two `next` rows · `## Owner Queue Listener` · the interactive bullet of `### On a wait's exit`.
    - It stays under `## Owner Queue`: the core's trigger line names that heading alone, so a rule under a split reaches no session the trigger sends.
  - `## Owner Queue Body` is a split point holding `## Owner Queue` under the 8 KB H2 cap: the `post` bullet of `### Posting and registering` points to it, and so does the `post` tool's `body` description (`scripts/atrium-queue-mcp.sh` → `TOOLS`).
    - Its notation table mirrors `monitor/public/src/ui.jsx` → `getProseBlocks`, canonical there: change a row with the parser, and each quoted limit with its constant — `PROSE_LIST_DEPTH` · `PROSE_TABLE_COLUMNS_MAX` · `PROSE_FOLD_LINES`.
  - The section names the listener's lifetime, never quotes it: its value lives in `scripts/atrium-queue.sh` → `LISTEN_LIFETIME_S`.
  - The section's announce bound mirrors constants of `scripts/atrium-queue.sh`, canonical there: change each literal with its constant.
    - `twice` and `a further two`: `LISTEN_ANNOUNCE_MAX`.
    - `three times` and `the third`: `LISTEN_INTERVAL_RESETS_MAX`.
    - The nudge interval is cited by its constant, never quoted: `scripts/lib/queue-session.sh` → `QUEUE_NUDGE_INTERVAL_MIN`.

### Owner Queue — texts in sync

- Texts that tell the session the same thing; a change to one lands in each of the others:
  - the fetch → ack → act order and the `first` rule: `monitor/src/server/queue/envelope.ts` → `buildEnvelope` · `scripts/atrium-queue.sh` → `print_claims` · `scripts/lib/queue-ops.sh` → `queue_claim_item` (both steps in one call) · `### Claimed items`;
  - the `wait` exit actions: `scripts/atrium-queue.sh` → `print_usage` · `end_wait_at_bound` · `### On a wait's exit`;
  - the two refusals behind `wait` exit 2: `monitor/src/server/queue/delivery.ts` → `lockOwnSession` (`unknown_session`) · `assertLiveFor` (`session_not_live`);
  - the register-after-ack step and the start-the-wait step after it: `envelope.ts` → `buildResumePayload`;
  - the record call and its two forms: `hooks/queue-turn-end-check.sh` → `RECORD_ASK_TEMPLATE` · `SHADOWED_RECORD_ASK_TEMPLATE` · `scripts/atrium-queue.sh` → `print_usage` (its `record` line) · `scripts/atrium-queue-mcp.sh` → the `post` tool's `lastAct` · the section's **Turn record** bullet · `### Last-act post` · the core's trigger line · the server instructions;
  - the server name and its tool names: `scripts/lib/queue-session.sh` → `QUEUE_MCP_SERVER_NAME` · `### Which route` and its tool-to-CLI table;
  - the shadowing line and its CLI-only rule: `hooks/queue-session-register.sh` (its shadowing line) · `scripts/lib/queue-session.sh` → `queue_is_server_shadowed` · `hooks/queue-turn-end-check.sh` → `SHADOWED_RECORD_ASK_TEMPLATE` · `### Which route` · the server instructions · `SECURITY.md` → **Session relays**;
  - the relay reading — a peer session's information, no owner instruction and no approval, first included:
    - `scripts/lib/queue-ops.sh` → `queue_get_relay_provenance` · `scripts/lib/queue-session.sh` → `queue_get_count_line`;
    - `scripts/atrium-queue.sh` → `print_first` · `print_claims` (its peer rows) · `print_usage` (its `relay` line);
    - `## Owner Queue Relay` → `### Reading a relay` · the server instructions · `SECURITY.md` → **Session relays**;
  - the relay's honest backing — adherence-only compliance, unauthenticated sender: `### Relay honest backing` · `SECURITY.md` → **Session relays**;
  - the main-session rule and its backing: `### Main session only` · the server instructions · `SECURITY.md` → **Session relays**.
- The server instructions are the MCP adapter's own text (`scripts/atrium-queue-mcp.sh` → `SERVER_INSTRUCTIONS`), shown to every session that lists the tools.
  - They restate, in short form, the tools, the main-session rule, the record duty, the source-and-first keying, the relay reading and the shadowing rule, and point at `## Owner Queue` for the rest.
- Texts that tell a session whether to start a `wait`, each keyed on the session's wait state; a change to one lands in each of the others:
  - `scripts/lib/queue-ops.sh` → `queue_get_wait_step` (the `next` step of a post, a `pending` and a register) · `scripts/atrium-queue.sh` → `end_wait_at_bound` · `hooks/queue-turn-end-check.sh` → `WAIT_REASON_LEAD`;
  - all three read the session's state through one reader: `scripts/lib/queue-session.sh` → `queue_get_poller`;
  - `### Wait or listener` · the wait table's two `next` rows — the second keys on the phrase "this session's listener", which the `next` step and the wait's exit line both carry.
- Texts that name `wait` where the rule withholds it from an interactive session — a divergence to keep in view, not a mirror:
  - `scripts/atrium-queue.sh` → `print_usage` (`On a wait's exit`) · `end_wait_at_bound`: "wait again", for every session kind;
  - a reword of both to the rule's reading retires the interactive bullet of `### On a wait's exit`.

### `### Posting and registering`

- What the turn record's lines rest on:
  - the record check and its once-per-turn stamp: `hooks/queue-turn-end-check.sh` → `set_record_reason` · `set_tool_turn`; the turn boundary, its start time and its last tool call: `hooks/lib/reply_language.py` → `find_current_turn`;
  - the record's write and its id check, skipped on no usable monitor reply: `scripts/lib/queue-ops.sh` → `queue_create_record` · `queue_get_record_check` · `scripts/lib/queue-session.sh` → `queue_put_record` · `queue_get_record_time`;
  - the headless `claude -p` exclusion: `hooks/lib/session-entrypoint.sh` → `is_owner_facing_session`, called by `hooks/queue-turn-end-check.sh` → `main`; the at-most-once-per-turn hold: that hook's `main`, which exits on `stop_hook_active`;
  - the turn ending at a successful `record` on the tool route: `scoped/shared-hook-capability-contract.md` → the `MCP tool result end-turn` row; the CLI's `record` carries no such result, so its turn runs on to a final message.
- The check takes a `lastAct` post as the record only as the turn's one `post` call, alone in its message: `hooks/lib/reply_language.py` → `find_current_turn` (`last_tool.alone` · `last_tool.name_calls`).

### `## Owner Queue Tools`

- What the section's lines rest on:
  - one library behind both routes: `scripts/lib/queue-ops.sh`, sourced by `scripts/atrium-queue.sh` and by the MCP adapter `scripts/atrium-queue-mcp.sh`;
  - the session id read per call: `scripts/lib/queue-session.sh` → `queue_get_session_id`, through the owner record each SessionStart register writes (`queue_put_owner_record`);
  - the shadowing detection: `scripts/lib/queue-session.sh` → `queue_is_server_shadowed`, called by `hooks/queue-session-register.sh`, which carries the finding to the turn-end check through `queue_set_shadow_mark`;
  - a headless run listing no tool: `hooks/lib/session-entrypoint.sh` → `is_owner_facing_session`, the adapter's entrypoint gate;
  - the typed agents' freeze: every `agents/*.md` frontmatter `tools:` list names no `mcp__` tool and no wildcard — an agent body that gains one voids the enforced line of `### Main session only`;
  - no agent identity at the server, and a project or local server of the same name winning: `scoped/shared-hook-capability-contract.md` → `### MCP stdio server — measured record`;
  - the claim result's fields: `scripts/lib/queue-ops.sh` → `queue_claim_item`; the `ack` lines: `scripts/atrium-queue.sh` → `print_first`;
  - the failed-claim residual of `### Claimed items`, read statically and not run: `scripts/lib/queue-ops.sh` → `queue_claim_items` returns the error document alone, and a pulled item stays outside `pending` (this note's `### Answers and messages` entry, its turn-start rows).
    - A `queue_claim_items` that returns the ids it reached beside its error leaves one residual: a transport failure between an ack and its result.
- Honor-system: the main-session rule for a built-in, wildcard or untyped spawn, and the CLI-only rule under a shadowing line.
- A code text that names the server's tool where the rule withholds it from a shadowed session — a divergence to keep in view, not a mirror:
  - `hooks/queue-turn-end-check.sh` → `RECORD_ASK_TEMPLATE` names the server's `record` tool first, for every asked session;
  - a template that names the CLI alone under a shadowing line retires the outranking bullet of `### Which route`.

### `## Owner Queue Relay`

- A diet or audit pass adds no approval step before a relay's delivery and softens no line of `### Relay honest backing`.
- What the section's lines rest on:
  - the bounds and refusals: `monitor/src/server/queue/relay.ts` → `RELAY` · `createRelay` · `RelayRefusalReason`; `monitor/src/server/queue/schemas.ts` → `relayBodySchema`;
  - the secret scan, fail-closed: `monitor/src/server/queue/relay-scan.ts` → `scanText`, running `scripts/lib/secret-scan.sh`;
  - the envelope-shape refusal: `monitor/src/server/queue/envelope.ts` → `hasEnvelopeToken`;
  - no withdrawal: `monitor/src/server/queue/delivery.ts` → `withdrawItem`; the lapse, and no resume: `monitor/src/server/queue/sweep.ts`;
  - the refusal record without text: `monitor/src/server/middleware/audit-log.ts` → `insertAudit`;
  - the peers a relay may reach: `monitor/src/server/queue/owner-sessions.ts` → `getPeerSessions`;
  - the redaction as an owner route: `monitor/src/server/routes/queue-owner.ts` (its `redact` route) · `monitor/src/server/queue/owner-items.ts` → `putRedaction`.
- The bounds are named, never quoted: their values live in the constants the section cites.
- Honor-system: every line of `### Reading a relay`.

## Linkage — owner queue authority

### `## Owner Queue Authority`

- Decided keep: a fetched answer is the owner's explicit approval with no terminal confirmation, and an approval item resumes an ended session like any other answer.
  - A diet or audit pass restores no terminal confirmation and softens no line of `### Honest backing`.
- `rules/glass-atrium/core-security.md` stays unedited: its high-impact bullet names no approval channel, and the section states that a fetched answer is that approval.
  - The section also states why a fetched item is not the external tool output of that file's `## Prompt & Tool Input Security [LLM01:2025]`.
  - Its LLM06 pointer names the "High-impact actions" bullet alone: whether a queue answer is also that section's re-authorization is undecided — an owner decision, not a diet finding.
- What the section's lines rest on:
  - envelopes in a resume prompt only: `monitor/src/server/queue/sweep.ts`, the one caller of `buildResumePayload`;
  - the provenance line, read from the kind, the approval flag and the answer's presence, never from text: `scripts/lib/queue-ops.sh` → `queue_get_provenance` · `queue_get_provenance_class`;
  - the source and first facts of a claim, both from the stored kind and the ack's reply: `scripts/lib/queue-ops.sh` → `queue_claim_item`;
  - the approval flag and the option codes of a posted decision: `scripts/lib/queue-ops.sh` → `QUEUE_ITEM_FIELDS` · `scripts/atrium-queue.sh` → `print_usage` (its `Item JSON` line);
  - an approval item resumed like any other answer: `monitor/src/server/queue/resume-claim.ts` → `CLAIMABLE_ITEM_SQL`, which reads no approval flag;
  - the request-origin check: `monitor/src/server/request-guards.ts` → `getPageOriginSignal`;
  - the answer record and the no-record mark: `monitor/src/server/queue/owner-views.ts` → `getAnswerRecordView` · `monitor/public/src/screens/queue.jsx` → `isAnsweredOutside`;
  - the image paths: `monitor/src/server/queue/images.ts` → `getSessionImageViews` gives each one; `scripts/lib/queue-ops.sh` → `queue_get_images` lists only a server-made name inside the image folder, and `scripts/atrium-queue.sh` → `print_images` prints that list.
- Honor-system, with no hook or monitor check behind it: the one-action scope, the void on changed facts, the non-approval reading, the answer-reading table and the posting form.
- A code text worded for the CLI where a `claim` carries it — a divergence to keep in view, not a mirror:
  - `scripts/lib/queue-ops.sh` → `queue_get_provenance` states its condition as `once its ack prints "first"`, and `queue_claim_item` returns that line where no ack line prints;
  - a line worded for both routes retires the bridging bullet of `### Provenance and images`.

### Owner Queue Authority — texts in sync

- Texts that tell the session the same thing; a change to one lands in each of the others:
  - the trust sentence — once `get` returned the item and `ack` printed `first`, the owner's own instruction, and where it approves an action the explicit approval of that one action, high-impact actions included, once, as the item states it:
    - `monitor/src/server/queue/envelope.ts` → `RESUME_PREAMBLE` · `scripts/lib/queue-ops.sh` → `queue_get_provenance`;
    - `### Envelopes and authority` (**Trusted**) · `### What an approval covers`;
    - `monitor/public/src/screens/queue.jsx` → "an approving answer here approves the stated action, once";
    - the must-not-miss approval bullet, in short form;
  - the non-approval reading — a message that orders an action, or an answer to a report or a plain decision that approves one, approves that action: `queue_get_provenance` (its `message` and `report | decision` classes) · `### What an approval covers`;
  - the approving-option reading — the option the body named approves, any other declines: `queue_get_provenance` (its `approval` class) · `### What an approval covers`, its answer table · `### Posting an approval`;
    - rule-only, in no code text: the table's rows for a body that named no approving option and for free text alone;
  - the void on changed facts and the never-a-standing-licence clause: `envelope.ts` → `RESUME_PREAMBLE` · `### What an approval covers`;
  - the no-login sentence and the never-answered list — a permission prompt, a blocked command, a sandbox denial: `envelope.ts` → `RESUME_PREAMBLE` · `### Honest backing` · `SECURITY.md` → **Owner queue approvals**;
  - the resume envelope as a claim, and its steps run as the installed CLI: `envelope.ts` → `buildEnvelope` · `### Envelopes and authority`;
  - the provenance line and what it is built from: `scripts/atrium-queue.sh` → `print_usage` (its `get` line) · `### Provenance and images`;
  - the attached-image line and its read-before-acting step: `scripts/atrium-queue.sh` → `print_images` · `### Provenance and images`, its image bullet;
  - the source-and-first keying — authority only for source `owner` and first together: `### Envelopes and authority` (**Trusted**) · `### Claimed items` · `scripts/atrium-queue.sh` → `print_first` · the server instructions · `SECURITY.md` → **Owner queue approvals**.

## Linkage — owner queue delivery

### `## Owner Queue Listener`

- What the section's lines rest on:
  - where a listener starts: `lib/ga-env.sh` → `EXPECTED_HOOK_BINDINGS` (its `SessionStart` and `Stop` rows) · `EXPECTED_HOOK_BINDING_OPTIONS` (`asyncRewake` and the binding timeout, which outlasts the listener's lifetime);
    - the updater writes both into a profile's settings; a session reads its hook config once, at its start;
  - the run condition: the posting-table qualifier in this note's `## Owner Queue` entry, which cites it · `hooks/queue-listener.sh` → `main` (its `agent_id` filter);
  - the count read that claims nothing: `scripts/atrium-queue.sh` → `set_listen_count` · `monitor/src/server/queue/delivery.ts` → `getPendingCount`;
  - the wake line and its counts by kind: `scripts/atrium-queue.sh` → `print_wake` · `scripts/lib/queue-session.sh` → `queue_get_count_line`;
  - the takeover in both directions: `scripts/atrium-queue.sh` → `take_wait_lock` · `check_wait_owner` · `scripts/lib/queue-session.sh` → `queue_get_wait_lock_state` (its `listener` state);
  - the announce cap and its restart: `scripts/atrium-queue.sh` → `announce_if_due` · `get_announce_count` · `scripts/lib/queue-session.sh` → `queue_delete_announce_record`, called on a claim by `scripts/lib/queue-ops.sh` → `queue_get_pulled_claims` and `scripts/atrium-queue.sh` → `poll_wait`, and on a count read back at zero by `run_listen_loop`; the record also goes with its awaiting set: `scripts/lib/queue-session.sh` → `queue_delete_awaiting_set` · `queue_delete_stale_awaiting`;
  - the turn-end check's line: this note's `### Answers and messages` entry, its turn-end hold bullet;
  - the lifetime-end wake, its re-arm line and its pass over the announce cap: `scripts/atrium-queue.sh` → `run_listen_loop` (its `rearm` call) · `announce_if_due` · `print_wake` · `LISTEN_REARM_LINE`;
  - the ends without a wake or re-arm: `scripts/atrium-queue.sh` → `run_listen_loop` · `end_run` · `stop_listening`;
  - the wrapper, the folded wake and the unmeasured host behaviour: `scoped/shared-hook-capability-contract.md` → "`asyncRewake` command hooks — measured record";
    - the measured lifetime with its wake, and the unmeasured system sleep: that record's **Timeout** lead;
  - `stop_hook_active` on a wake-started turn's `Stop`: no reading in that file's `Stop` row; `hooks/queue-turn-end-check.sh` → `main` exits on it.
- The enforced lines' tests: `hooks/test/queue-listener.bats`.

### Owner Queue Listener — texts in sync

- Texts that tell the session the same thing; a change to one lands in each of the others:
  - the `[ATRIUM-QUEUE]` literal: `hooks/queue-session-register.sh` · `scripts/atrium-queue.sh` → `LISTEN_WAKE_LEAD` · `hooks/queue-turn-end-check.sh` → `WAIT_REASON_LEAD` · the core's trigger line;
  - the count-and-`pending` sentence: `scripts/lib/queue-session.sh` → `queue_get_count_line`, printed by `hooks/queue-session-register.sh` and `scripts/atrium-queue.sh` → `print_wake` · the wait table's `[ATRIUM-QUEUE]` `pending` row;
  - the re-arm line and its end-the-turn action: `scripts/atrium-queue.sh` → `LISTEN_REARM_LINE` · the wait table's re-arm row · `## Owner Queue Listener`;
    - the CLI line states the action bare; the rule scopes it to a turn the line started, so a line folded into a working turn ends no work;
  - the wake's not-an-error clause: `scripts/atrium-queue.sh` → `LISTEN_WAKE_LEAD` · `## Owner Queue Listener`.

### `### Answers and messages`

- What the cannot-continue row's tail and the measured line rest on: `scoped/shared-hook-capability-contract.md` → "`asyncRewake` command hooks — measured record" → **Background command exit**.
- What the waiting-mark line rests on: `monitor/src/server/queue/delivery.ts` → `isSessionWaiting`, refreshed by `claimPendingItems` on a wait poll and by `getPendingCount` on a listener's count read · `monitor/public/src/screens/queue.jsx` → `getSessionLineQ` · `PullLineQ`.
- What the turn-end hold line, and the check's line in `## Owner Queue Listener`, rest on:
  - the hold and its silence beside a wait or a listener: `hooks/queue-turn-end-check.sh` → `set_wait_reason`, silent on the lock states `live` and `listener` and on the listening mark (`scripts/lib/queue-session.sh` → `queue_get_poller`);
  - the record ask carrying no wait sentence: an item posted in answer to it takes its wait step from the post's `next` (`scripts/lib/queue-ops.sh` → `queue_print_post_result`);
  - their tests: `hooks/test/queue-turn-end-check.bats`.
- What the turn-start rows rest on:
  - `monitor/src/server/queue/delivery.ts` → `claimOne` claims only an `answered` item and moves it to `delivering`, for `pending` and a wait poll alike;
  - past `PULL.ACK_WINDOW_MS`, `monitor/src/server/queue/sweep.ts` → `getSettledStatus` settles the item of a session that has not exited as `unacked`: still outside `pending`, still acked by the msg id that wait printed (`delivery.ts` → `ACKABLE`);
  - the owner's Resend returns an `unacked` item to `answered`: `monitor/src/server/queue/owner-items.ts` → `RESENDABLE`.
