# Maintainer note — `rules/glass-atrium/orchestrator-role.md`

Maintainer-facing material for that rule file. Nothing here binds the orchestrator; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: no pointer to this note survives in the rule file. Linkage moved out of it is recorded under `## Linkage moved out of the rule file`.

## Byte contract every edit must honour

- `hooks/test/test_daemon_config_loader.py` → `CostTierRuleTextTest` reads the repo-tree copy, not the install — the module resolves its rule path relative to its own file location.
  - In an editor's favour: a repo-tree run covers a branch edit, so an edit is verifiable before deploy rather than after.
- The maintained statement of what that span must contain, of the four ways an edit breaks it, and of the CI gap, is the rule file's own `## Machine-Read Structure` section. Read it there; a second copy of those phrases would be one more thing to keep in step.
- Must stay byte-exact: the opening blockquote as first content line · the six attestation tokens and nine `block-*` verdicts · the closed lexicon, premise-register and `[PLAN-SUBSET]` grammars · both `[SIZE-EST]` grammars and the `[SCOPE]` grammar.
- Must also stay byte-exact: the six-plus-`7th` delegation-element count · `Rule 2` and the three BASENAME names · `AUTOAGENT_PREFLIGHT_ACTIVE=1 scripts/run-bats-parallel.sh` · the Document-Driven Workflow step numbers.

## Linkage moved out of the rule file

### `## Machine-Read Structure`

- **Live-file pin**: `CostTierRuleTextTest` is the only suite that reads the rule file's text (byte contract above).
- **Indifferent suites**: `hooks/test/enforce-workflow-verify-stage*.bats` and `hooks/test/enforce-verification-gate*.bats` drive the hooks through their own fixtures and never read the rule file. They neither guard nor fail on its wording; they guard the token and verdict literals at the hook.

### `#### Deliverable exposure and designer composition (Decision phase)`

- The explicit format/share signal list under **Exposure Determination** restates the canonical at `scoped/scope-report.md` → `### HTML request test`, which reaches no authoring agent at spawn.
- The authoring agents read their own copies: `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test (explicit-request-only — heuristic auto-HTML FORBIDDEN)` and `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`.
- The rule-file copy is the only one reaching the orchestrator, which makes the exposure call. Edit the set together; never collapse it as redundant.
- The T1-T5 thresholds in the **Visual-Weight Probe** restate `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`; `scoped/scope-planning.md` carries a pointer only. Neither scope file reaches its authoring agent at spawn.
- Delivered copies: `agents/glass-atrium-intel-reporter.md` and `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract`; for the consulted designer, `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` plus `skills/glass-atrium-design-html-co-emission/SKILL.md`.
- The probe is the orchestrator-side counting site, not a duplicate: edit it with those copies and never delete it as redundant.

### `#### Monitoring-phase notes`

- The dev-front markup-exception judgment under `#### Monitoring-phase notes` is the orchestrator-side canonical for the JUDGMENT only.
- The author-side protocol canonical is `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]` (mirrored at `scoped/scope-planning.md` → `## Designer Co-Emission Trigger [PLANNING]`); neither scope file reaches its authoring agent at spawn.
- Delivered halves: `agents/glass-atrium-intel-reporter.md`, `agents/glass-atrium-intel-planner.md`, `agents/glass-atrium-dev-front.md`; `skills/glass-atrium-design-html-co-emission/SKILL.md` restates it for the consulted designer.
- The rule-file copy also reaches every subagent through the parent's project-instruction set. That is a delivery accident and gives it no authority over the author-side canonical.

### `### Plan Direction Verification (Stage-2 gate)`

- `### Plan Direction Verification (Stage-2 gate)` is the gate-OPERATION canonical. The participant-duty canonicals are `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]` (reviewer) and `scoped/scope-dev.md` → the same heading (DEV).
- Neither scope file reaches its actor at spawn today, and no dev-* or reviewer body mirrors either. The rule file does reach every subagent through the parent's project-instruction set, while telling subagents to ignore it.
- The three are not a redundancy to collapse: a duty moved into the rule file is read by the wrong actors and owed by none; a duty deleted from a scope file loses its only maintained statement.
- Do not copy the first-link question literal into the rule file; the rule file points to it only.
  - The literal is cross-read between `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` and the ultracode gate's presence scan (`hooks/enforce-workflow-verify-stage.sh`, pinned by `hooks/test/enforce-workflow-verify-stage-firstlink.bats`); a further copy adds a drift surface no suite polices.

### `### Cost-Tier Selection`

- The rule file's "every pin is LIVE-ONLY, and the updater preserves it across updates" (`### Cost-Tier Selection` → Model pins) is implemented by `autoagent/lib/editable_merge.py` → `_LOCAL_ONLY_FRONTMATTER_KEYS`, exactly `("model",)`. The identity keys `{name, tools, scope}` stay vendor-owned (`hooks/enforce-harness-critical.sh` protects them and excludes `model`).
- A second, weaker tuple sits beside it: `_BASE_AWARE_FRONTMATTER_KEYS`, exactly `("effort",)` — a key the release DOES ship, so a live line is kept only when it differs from base@install, and with no base anchor it falls back to live-wins. Unlike `model`, `effort` is not unconditionally local-only.
- Code comments in `autoagent/lib/editable_merge.py`, `autoagent/test/test_editable_merge.py` and `scripts/test/glass-atrium-update.bats` cite "Cost-Tier Selection" as the sanction for live-wins; keep that heading and the sanction sentence when editing the rule.

### `### Failure Recovery Loop`

- `**Debugger evidence gate**` came from the retired `glass-atrium-core-iron-laws` skill's Debugger Escalation section; it has no other maintained copy — `scoped/shared-investigation-discipline.md` only points at it as the orchestrator half; its backing is stated in the rule file's Backing honesty paragraph.
- The rule file no longer points at `skills/glass-atrium-ops-orchestrator.md` → `### Self-Improvement User-Approval Trigger`. The orchestrator reaches it through Tier-1 `rules/glass-atrium/core-learning-log.md` → Instruction Improvement Approval Tier and `rules/glass-atrium/shared-self-improve-hygiene.md` → Cross-References.
- A comment in `autoagent/daemon_cycle.py` still cites `orchestrator-role.md` for that name; the fix belongs at the comment (point it at the skill), not a pointer back here.

### `## Document-Driven Workflow (end-to-end lifecycle)`

- `## Document-Driven Workflow` is the orchestrator-side lifecycle SoT. `skills/glass-atrium-ops-orchestrator.md` → `#### Pipeline Acceptance Criteria` mirrors its gate sequence as per-stage acceptance detail and carries the ultracode in-script verify-stage skeleton.
  - The skill states the direction itself (step 4 "Procedure + honest backing (SoT)", step 6 "Order SoT"). Edit the two together; neither is a redundancy to delete.
- Step 6's pointer to `scoped/shared-testing.md` → Destructive-Path Suite Safety keeps the phrase "pointer only, the procedure is single-sited there": `scoped/maintainers/shared-testing.md` quotes it as the reason that section stays single-sited. Reword both together or neither.
