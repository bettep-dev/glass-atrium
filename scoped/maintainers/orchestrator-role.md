# Maintainer note — `rules/glass-atrium/orchestrator-role.md`

Maintainer-facing material for that rule file. Nothing here binds the orchestrator; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: no pointer to this note survives in the rule file. Linkage moved out of it is recorded under the `## Linkage` headings below.
  - The one editor-addressed HTML comment, atop the rule file's Cost-Tier Selection section, is the carve-out above: it names `CostTierRuleTextTest` and this note.

## Byte contract every edit must honour

- `hooks/test/test_daemon_config_loader.py` → `CostTierRuleTextTest` reads the repo-tree copy, not the install — the module resolves its rule path relative to its own file location.
  - In an editor's favour: a repo-tree run covers a branch edit, so an edit is verifiable before deploy rather than after.
- The consumers below are the maintained statement of what the rule file's machine readers read; the rule file carries no copy, only the Cost-Tier editor comment. Reword the rule file around what they read, never through it.
  - That comment sits inside the parsed span, so it must never contain a `###` substring.
- `CostTierRuleTextTest` — `hooks/test/test_daemon_config_loader.py`, repo-tree copy.
  - Reads the text after the Cost-Tier Selection heading, up to the next `###` substring, for three phrases.
  - The three phrases: the heuristic label on the table · the daemon config-reader module name · the pinned worker-model-id fallback.
  - Breaks when the heading is renamed, or one of the three phrases is reworded.
  - Breaks when any `###` substring — a `###` or `####` heading, or a hash-prefixed heading name in prose — lands ahead of them, truncating the parsed span.
  - Breaks when that heading's exact literal is written a second time ANYWHERE ABOVE it, re-aiming the split at the wrong copy.
  - Runs only in the `test-python` CI job, which a markdown-only PR skips: run it locally after any edit to the rule file.
- The close-token bats case — `hooks/test/inject-session-context.bats` → "the workflow pre-flight carries both close-token forms of the grammar SoT".
  - Reads both close-token form literals, token included: exactly one of each across the file.
  - Breaks when either form literal is reworded, or written a second time anywhere in the file, quoted or not.
  - Runs in the bats CI leg, which an edit to the rule file triggers.
- The citing hooks — `hooks/enforce-verification-gate.sh` · `hooks/enforce-workflow-verify-stage.sh` · `hooks/enforce-foreground-harness.sh` · `hooks/inject-session-context.sh` · `hooks/inject-scope-rules.sh`.
  - Read heading names, quoted into operator-facing block and advisory text.
  - Break when a cited heading is renamed, sending a blocked operator to a section that no longer exists.
- The citing corpus files — `scoped/scope-dev.md` · `scope-qa.md` · `scope-planning.md` · `scope-report.md` · `skills/glass-atrium-ops-orchestrator.md` · `skills/glass-atrium-ops-delegation-contracts/` · `agents/glass-atrium-intel-reporter.md` · `agents/glass-atrium-dev-front.md`.
  - Read the same heading names, plus the bolded leads under `## Reserved names`.
  - Break when a cited heading or bolded lead is renamed.

- **Indifferent suites**: `hooks/test/enforce-workflow-verify-stage*.bats` and `hooks/test/enforce-verification-gate*.bats` drive the hooks through their own fixtures and never read the rule file.
  - They neither guard nor fail on its wording; they guard the token and verdict literals at the hook.
- Must stay byte-exact, each at the site named — the rule file unless another file is given:
  - the opening blockquote as first content line;
  - the attestation tokens and `block-*` verdict names, listed under `## Reserved names`;
  - the `block-*` verdict table: `skills/glass-atrium-ops-delegation-contracts/references/ultracode-declaration-contract.md`;
  - the closed lexicon, premise-register and `[PLAN-SUBSET]` grammars;
  - both `[SIZE-EST]` grammars: `skills/glass-atrium-ops-delegation-contracts/references/delegation-size-discipline.md`;
  - the `[SIZE-EST]` key names on the `#### Delegation-size discipline` pointer;
  - the `[SCOPE]` grammar;
  - the six-plus-`7th` delegation-element count — `hooks/inject-session-context.sh` mirrors it, so the two move together;
  - `Rule 2` and the three BASENAME names;
  - `AUTOAGENT_PREFLIGHT_ACTIVE=1 scripts/run-bats-parallel.sh`;
  - the Document-Driven Workflow step numbers.
- The skill-side statement of this duty, for `references/ultracode-declaration-contract.md` and `references/delegation-size-discipline.md`: `skills/glass-atrium-ops-delegation-contracts/SKILL.md` → Edit Rules → **Machine-read literals**.

## Reserved names

- **Attestation tokens** — `[SCOPE]` · `[ENTRY-CLASS]` · `[SIZE-EST]` · `[PLAN-SUBSET]` · `[PLAN-CLOSE]` · `[AGENT-COMPOSITION]` · `[DOC-ROUTE]`: the bracketed literal and its field keys or form values are what the spawn gates scan a delegation or script for.
- **Verdict names** — `block-nodecl` · `block-grammar` · `block-norev` · `block-noverifydev` · `block-declspawn` · `block-undecl` · `block-computed` · `block-order` · `block-upstream`.
  - Each is a trace tag `hooks/enforce-workflow-verify-stage.sh` emits. The rule file NAMES them; the hook defines them.
- **Headings** cited by name elsewhere in the corpus:
  - `## Orchestrator Identity` · `## Delegation Criteria` · `## Delegation Workflow` · `## Document-Driven Workflow` · `## Harness Path Protection` (with its `Rule 2`, `### Write routes`, `### Staged lane`, `### Progress-file exclusion`, `### Reach of the gate`).
  - `### Phase Notes`, with `#### Entry classification (DEV delegations)` · `#### Plan edge discovery`.
  - `#### Decision-phase probes` · `#### Deliverable exposure and designer composition` · `#### Monitoring-phase notes` · `#### Scan boundary and provenance`.
  - `### Plan Direction Verification (Stage-2 gate)` · `### Spawn Budget` (with Delegation-size discipline) · `#### Automatic Parallelization` (with guardrail `(a)`) · `### Context Handoff Size` · the Cost-Tier Selection heading · `### Failure Recovery Loop`.
  - Pointer sites, the `block-*` verdict table's file included: `skills/glass-atrium-ops-delegation-contracts/SKILL.md` → Reference Index.
  - Cited by that skill's reference files: `#### Backstop asymmetry (manual vs. ultracode)` · `#### Depth and concurrency ceilings`.
- **Bolded leads** cited by name:
  - under the three phase-note H4s:
    - `#### Decision-phase probes`: Foreground Probe · Capability Probe · Compatibility Probe;
    - `#### Deliverable exposure and designer composition (Decision phase)`: Exposure Determination · Visual-Weight Probe;
    - `#### Monitoring-phase notes`: Verbatim forward-relay · glass-atrium-dev-front markup-exception Monitoring judgment;
  - under `### Spawn Budget`: Split triggers · HARD SECONDARY · Empirical tool_use calibration · Standing obligation (the one under `#### Delegation-size discipline`);
  - under `#### Analysis fan-out and team cardinality`: Effort-scaling by task shape;
  - under `### Context Handoff Size`: Attestation-token placement;
  - under `### Failure Recovery Loop`: Backing honesty (which stages are enforced) · Retry effort escalation;
  - under `## Document-Driven Workflow` step 6: Prompt-file tail.
- Neither list is exhaustive: grep the corpus for a heading or bolded lead before renaming it.

## Wrapper headings

- The rule file's H2s `## Decision-Phase Notes` · `## Monitoring and Provenance Notes` · `## Verification Gates and Cost Tiers` · `## Spawn Sizing and Team Composition` · `## Handoff and Failure Recovery` are split points that hold each H2 under the 8 KB cap.
- Its H3s `### Pre-spawn Probes` · `### Deliverable Exposure` · `### Monitoring Notes` · `### Provenance` · `### Stage-2 Backstops` · `### Team Composition` · `### Parallel Fan-out` wrap cited H4s, so that no H3 carries more than one cap's worth of them.
- `### Context Handoff Size` has no wrapper and no H4: its citers name it for the summary-only rule, the delegation-element count, the token placement and both token grammars, so all of them stay directly under it.
  - It is held under the 3 KB H3 cap by compression alone; the `[SCOPE]` author-rule detail sits in `references/scope-parser.md`, and the rest of its moved text is recorded in this note's Context Handoff Size linkage entry.
  - `### Provenance` is the other H3 near the cap; measure both after any edit to them.
- A section that grows past a cap splits the same way: insert a wrapper heading, never change a cited heading's level.
  - Why: hooks quote `### Spawn Budget`, `### Context Handoff Size` and `### Phase Notes`, and `CostTierRuleTextTest` splits on the next `###`.
- A wrapper is a split point, not a citation target: cite the heading inside it.

## Linkage moved out of the rule file

- Every scope file named below reaches its agents through the registry row's `rules.scope` (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).

### `#### Deliverable exposure and designer composition (Decision phase)`

- The explicit format/share signal list behind **Exposure Determination** restates `scoped/scope-report.md` → `### HTML request test`. It sits in `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md` → `## Exposure Determination — signals and routing`.
- The signal literals live in the author bodies: `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test (explicit-request-only — heuristic auto-HTML FORBIDDEN)` and `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`.
- The orchestrator's copy is the pointer plus that reference, together. The pointer's one-bit rule reaches the orchestrator without a read; the signal literals sit one read away in the reference.
  - One read away is enough because the authoring agent re-decides the format at turn-0, so the orchestrator's bit is a hint.
  - The relocation is not a redundancy-collapse: edit the pointer and the reference with the set, and never delete either as redundant.
- The local-destination stamp is single-sited at the rule file's `### Authoring delegation is MANDATORY (never the inline path)` → "One sanctioned exception"; the heading carries no second statement of it.
- The split between the rule-file heading and `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md`: that skill's `SKILL.md` → Reference Index.
- The T1-T5 thresholds in the **Visual-Weight Probe** restate `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`; `scoped/scope-planning.md` carries a pointer only.
- Other counting sites:
  - `agents/glass-atrium-intel-reporter.md` → `## Designer Handoff Contract` references the scope-report canonical and carries no threshold table.
  - `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract` carries the planner's own threshold table.
  - For the consulted designer, the stub `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` keeps the trigger, output fields and veto line; the preloaded `skills/glass-atrium-design-html-co-emission/SKILL.md` keeps the full consultative scope.
- The probe is the orchestrator-side counting site, not a duplicate: edit it with those copies and never delete it as redundant.

### `#### Monitoring-phase notes`

- The dev-front markup-exception judgment is the orchestrator-side canonical for the JUDGMENT only.
  - It is the pointer under `#### Monitoring-phase notes` plus `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md` → `## glass-atrium-dev-front markup exception — detail`.
  - The split between the two: that skill's `SKILL.md` → Reference Index.
- The author-side protocol canonical is `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`, pointed to from `scoped/scope-planning.md` → `## Designer Co-Emission Trigger [PLANNING]`.
- Agent-body halves: `agents/glass-atrium-intel-reporter.md`, `agents/glass-atrium-intel-planner.md`, `agents/glass-atrium-dev-front.md`; `skills/glass-atrium-design-html-co-emission/SKILL.md` restates it for the consulted designer.
- The rule-file pointer also reaches every subagent through the parent's project-instruction set; the reference does not. That is a delivery accident and gives it no authority over the author-side canonical.

### `#### Decision-phase probes` and `#### Scan boundary and provenance`

- Each keeps its binding lines in the rule file; the detail sits in `skills/glass-atrium-ops-delegation-contracts/references/decision-phase-probes.md` and `references/scan-provenance.md`. The split: that skill's `SKILL.md` → Reference Index.
- The closed lexicon's recall is unknown: its quantifier group was pruned against a single incident, so a hook reading the list stays advisory until a false-positive record justifies promotion.

### `#### Plan edge discovery`

- The split between the rule-file heading and `skills/glass-atrium-ops-delegation-contracts/references/plan-edge-discovery.md`: that skill's `SKILL.md` → Reference Index.
- The `[PLAN-SUBSET]` grammar stays in the rule file because the byte contract above names the rule file as its site. Move it only together with that line.

## Linkage — gates, tiers and budgets

### `### Plan Direction Verification (Stage-2 gate)`

- `### Plan Direction Verification (Stage-2 gate)` is the gate-OPERATION canonical, as a pointer plus `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md`.
- The participant-duty canonicals are `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]` (reviewer) and `scoped/scope-dev.md` → the same heading (DEV).
- The split between the pointer and that reference: that skill's `SKILL.md` → Reference Index.
  - The hooks quote only the gate heading (`hooks/enforce-verification-gate.sh` reviewer-miss reason, `hooks/enforce-workflow-verify-stage.sh` DEV hard-gate block), which stays.
  - `#### Backstop asymmetry (manual vs. ultracode)` stays as a pointer: `references/ultracode-declaration-contract.md` cites it.
- The reference's cited `##` headings, text and level fixed: `SKILL.md` → Edit Rules → **Cited headings**.
  - Citers naming the `##` level: `scoped/maintainers/scope-qa.md` (two Team-composition citations), `references/scan-provenance.md` → `## Premise register — detail` and `SKILL.md` → Edit Rules → **Cited headings**.
- Location-only citer that stays: `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria` → the Stage 2 bullet names the gate heading for team composition, DEV hard gate, activation scope and direction-not-completeness. The pointer keeps all four.
  - Its **Stage-2 revision/escalation** bullet names the same heading for the escalation path; the pointer's **Revision + escalation** carries that path and its path-only limit.
- No dev-* or reviewer body mirrors `scoped/scope-qa.md` or `scoped/scope-dev.md`.
- The rule file also reaches every subagent on the host channel (see `#### Monitoring-phase notes` above), and its opening line tells subagents to ignore it.
- The three are not a redundancy to collapse: a duty moved into the rule file is read by the wrong actors and owed by none; a duty deleted from a scope file loses its only maintained statement.
- Do not copy the first-link question literal into the rule file or its Stage-2 reference; both point to it only.
  - The literal is cross-read between `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` and the ultracode gate's presence scan in `hooks/enforce-workflow-verify-stage.sh`.
    - That scan is pinned by `hooks/test/enforce-workflow-verify-stage-firstlink.bats`; a further copy adds a drift surface no suite polices.

### `### Cost-Tier Selection`

- The daemon reads its model through `hooks/daemon_config.py`: the `DAEMON_CONFIG` path override first, else `daemon-config.json` under the data root (`hooks/ga_paths.py` → `get_data_root`, whose base `GA_DATA_ROOT` overrides).
- `load_daemon_config` takes the pinned fallback when the file is missing, unreadable, corrupt or not a JSON object, or when neither `worker_model` nor the legacy `haiku_model` key holds a non-empty string.
  - Why a pinned id: the monitor rejects a bare alias for the worker model, and `hooks/pricing.json` cannot price one.
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
  - The identity keys `{name, tools, scope}` stay vendor-owned (`hooks/enforce-harness-critical.sh` protects them and excludes `model`).
- A second, weaker tuple sits beside it: `_BASE_AWARE_FRONTMATTER_KEYS`, exactly `("effort",)` — a key the release DOES ship.
  - So a live line is kept only when it differs from base@install, and with no base anchor it falls back to live-wins. Unlike `model`, `effort` is not unconditionally local-only.
- Code comments in `autoagent/lib/editable_merge.py`, `autoagent/test/test_editable_merge.py` and `scripts/test/glass-atrium-update.bats` cite "Cost-Tier Selection" as the sanction for live-wins; keep that heading and the sanction sentence when editing the rule.

### `#### Analysis fan-out and team cardinality`

- **Effort-scaling by task shape** is a one-line pointer; the table, its examples and notes sit in `skills/glass-atrium-ops-delegation-contracts/references/delegation-size-discipline.md` → `## Effort-scaling table`.
- Citers: `skills/glass-atrium-ops-orchestrator.md` cites the heading, which stays; the partition-then-size line under `#### Automatic Parallelization` names the **Effort-scaling by task shape** lead.

### `#### Automatic Parallelization`

- Guardrail (a)'s agent-binding rules, the index-mutation class and the mechanisms they answer live in Tier-1 `rules/glass-atrium/core-git-workflow.md` → Commits → **Concurrent worktree**, which reaches every agent on the host channel.
  - Never copy them back into the rule file: its opening line tells subagents to ignore it, so a rule placed there loses its agent audience.
- The split between the rule-file heading and `skills/glass-atrium-ops-delegation-contracts/references/automatic-parallelization.md`: that skill's `SKILL.md` → Reference Index.
- `skills/glass-atrium-ops-orchestrator.md` cites the Tier-1 home and the reference file's leads directly. Before renaming such a lead, grep for its citers (`SKILL.md` → Edit Rules → **Cited leads**).

## Linkage — handoff and recovery

### `### Context Handoff Size`

- The `[SCOPE]` and `[PLAN-CLOSE]` grammar SoTs sit in the rule file; every other file carries a pointer only.
- The `[SCOPE]` author rules keep two binding lines in the rule file, the separators and first-wins with relaying.
  - `skills/glass-atrium-ops-delegation-contracts/references/scope-parser.md` → `## Author rules — detail` holds only what the rule file does not say: never-merged, the bare-form relay case, the space-in-path limit and skip-not-block.
- The `[PLAN-CLOSE]` advisory is advisory, not a block, because a multi-script track legitimately closes in a later script, which a block would false-positive on.
- The delegation-prompt language rule is the Tier-1 `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language` (delegation prompts in English, literal data in its own language).
  - The rule file keeps only the delta, a Delegation action row: injected literal strings set apart in backticks or a blockquote.
- `parent_cid` sits under `#### Routing output: team schema, size, and correlation ID` → Correlation ID; the prompt-quality routing line is a Delegation action row.

### `### Failure Recovery Loop`

- `**Debugger evidence gate**` has no other maintained copy — `scoped/shared-investigation-discipline.md` only points at it as the orchestrator half; its backing is stated in the rule file's Backing honesty bullet.
- The bolded lead **Retry effort escalation** under `### Failure Recovery Loop` has no other maintained copy.
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Thinking Budget Policy [ALL]` → **Task-class rule** cites it by name as one tier mover.
  - `references/failure-recovery.md` carries no Retry or tier text.
- **Backing honesty (which stages are enforced)** is a pointer to `skills/glass-atrium-ops-delegation-contracts/references/failure-recovery.md`; the split between them: that skill's `SKILL.md` → Reference Index.
  - The evidence-gate citer above resolves through that pointer: it keeps the lead and names the **Debugger evidence gate** as honor-system.
- The rule file carries no pointer to `skills/glass-atrium-ops-orchestrator.md` → `### Self-Improvement User-Approval Trigger`.
  - The orchestrator reaches that section through Tier-1 `rules/glass-atrium/core-learning-log.md` → Instruction Improvement Approval Tier and `rules/glass-atrium/shared-self-improve-hygiene.md` → Cross-References.
- A comment in `autoagent/daemon_cycle.py` still cites `orchestrator-role.md` for that name; the fix belongs at the comment (point it at the skill), not a pointer back here.

## Linkage — lifecycle and harness

### `## Document-Driven Workflow (end-to-end lifecycle)`

- `## Document-Driven Workflow` is the orchestrator-side lifecycle SoT. `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria` mirrors its gate sequence as per-stage acceptance detail and carries the ultracode in-script verify-stage skeleton.
  - The skill cites the rule file as the SoT for step 4's procedure (`#### Pipeline Acceptance Criteria`) and for step 6's pre-PR default and live-suite threshold (`#### Deploy-Safety Idiom`). Edit the two together; neither is a redundancy to delete.
  - Step 6's per-cycle order line and its narrow post-merge cases live in `skills/glass-atrium-ops-delegation-contracts/references/live-deploy-gate.md`; `#### Deploy-Safety Idiom` cites that file for them, so an edit there moves with the skill's citer too.
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
- Step 6's pointer to `scoped/shared-testing.md` → Destructive-Path Suite Safety keeps the phrase "pointer only, the procedure is single-sited there": `scoped/maintainers/shared-testing.md` quotes it as the reason that section stays single-sited. Reword both together or neither.

### `## Harness Path Protection`

- Hook internals behind Rule 2 and `### Reach of the gate`, kept here because the orchestrator acts on none of them:
  - A directory symlink the walk crosses before entering a root, leading inside a root rather than onto the root itself, voids every exemption.
  - Outside the scan's reach: a home written as a run-time expansion the hook does not read as home · a glob standing in for a root letter · a root named only as a bare word in prose, the file named relative to it.
  - The hook does not examine a symlink inside a root it has entered: it judges the rest of the path as written.
  - Past its candidate cap, the hook blocks fail-safe rather than leave candidates unresolved.
  - On the resolved-install-target route, no hook guards the install's `rules/` and `scoped/` trees.
- The layer meant to catch the writes the prompt scan cannot see is a Write/Edit/Bash gate on calls carrying an `agent_id`.
  - Not built; its home is `hooks/enforce-harness-critical.sh`.
  - It is also the candidate cover for the Workflow-tool `agent()` gap: whether a Workflow agent's Write/Edit/Bash calls carry an `agent_id` is unmeasured.
