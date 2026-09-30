# Plan Direction Verification (Stage-2 gate) — team, standing jobs and outcome

- **Pointer site**: `rules/glass-atrium/orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`.
- **Backstop pointer site**: `#### Backstop asymmetry (manual vs. ultracode)` in the same file.

## Team composition and verdicts

- **Verification team size**: exactly these two roles, as the pointer site names them.
- **DEV specialist selection — justification**: justified by `domains`/description alignment as in normal routing.
  - E.g. backend-heavy plan → glass-atrium-dev-nestjs / glass-atrium-dev-node / glass-atrium-dev-python · UI-heavy → glass-atrium-dev-react / glass-atrium-dev-android.
  - Multi-domain plan → the domain owning the most work streams, or the streams the others wait on.
- **Verdicts (independent, parallel)**:
  - glass-atrium-qa-code-reviewer → `pass` / `revise` + concrete unmet items (implementation-feasibility · test-feasibility · scope-fidelity).
  - DEV → `feasible` / `infeasible` + alternative direction (technical validity · approach soundness).
  - **Direction, not completeness — detail**: a brief plan lacking a structure the user did not ask for (a DAG, per-task acceptance criteria, an executive summary) is never a `revise` or `infeasible` reason.
    - For the DEV member the prompt is the only channel: `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` does not state the rule. The reviewer also reads it at `scoped/scope-qa.md` → `### Reviewer verdict`.
    - Honest backing: honor-system — no hook reads the delegation prompt for it.
- **Scope-fidelity axis (reviewer-side, SEPARATE from the two feasibility axes)**: the reviewer also judges whether each planned task stays inside the user's LITERAL instruction, naming every task that exceeds it.
  - Feasible ≠ in-scope: a sound, testable, well-decomposed plan can still over-interpret the ask, and an unaddressed excess is a sufficient `revise` reason on its own.
  - Honest backing: **honor-system** LLM judgment. Its value is positional — the judge is a DIFFERENT actor from the one that decomposed the scope. Claiming any mechanical guarantee for it is FORBIDDEN.

## Standing jobs inside the gate

- **Orchestrator's part**: supplying each job's inputs and never adjudicating a job's answer are pointer-site duties.
- **Load-bearing premise check — detail**: verdict-gating on BOTH verdicts — both Stage-2 actors check the premises the plan's approach rests on, attacking each from the code rather than from a list.
  - The inputs the pointer names do not bound the check — either actor may add a claim neither names.
  - Premise-register grammar: `rules/glass-atrium/orchestrator-role.md` → `#### Scan boundary and provenance`.
  - Duty text: reviewer `scoped/scope-qa.md` → `### Load-bearing premise check` · DEV `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`.
  - Both carry a non-waiver clause: a delegation phrase narrowing the recheck does NOT suspend the job, and the actor names the narrowing instruction in its verdict.
- **First-link question — detail**: verdict-gating on the DEV verdict — the DEV member also answers a standing first-link question inside its `feasible`/`infeasible` verdict, unasked.
  - Why both members get the PLAN DOC ID: the DEV locates the chain whose earliest decision it prices; the reviewer fetches the chain root its scope-fidelity comparand reads (`scoped/scope-qa.md` → Comparand for scope-fidelity).
  - Duty text and the question literal: `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` → First-link question.

## Gate outcome and activation scope

- **Revision + escalation — notes** (the outcome and its escalation limit sit at the pointer site):
  - Revision count basis: `skills/glass-atrium-ops-orchestrator.md` → Pipeline Acceptance Criteria "max 1".
- **Activation scope**: stated whole at the pointer site.

## Backstop detail

- **Identical policy — what it covers**: team composition · DEV hard-gate · complex-only scope · max-1-revision.
- **Manual backstop**: `enforce-verification-gate.sh` runs on `PreToolUse(Agent)`; mechanical surface: reviewer-spawn presence only, fail-open (see `skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode`).
- **Ultracode backstop**: `enforce-workflow-verify-stage.sh` runs on `PreToolUse(Workflow)`; the declaration it checks: `rules/glass-atrium/orchestrator-role.md` → `#### Ultracode declaration contract`.
  - Mechanical surface: declaration PRESENCE + line GRAMMAR (the DEV hard-gate included, `block-noverifydev`) + declaration↔code CONSISTENCY, fail-open on any parse uncertainty.
  - It does NOT validate DEV-verdict or gating-expression correctness, and role truthfulness is honor-system (HONESTY bullet in `skills/glass-atrium-ops-delegation-contracts/references/ultracode-declaration-contract.md`).
  - These limits are why the authoring obligation at the pointer site REMAINS PRIMARY.
