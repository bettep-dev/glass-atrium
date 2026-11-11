# Plan Direction Verification (Stage-2 gate) — team, standing jobs and outcome

- **Gate pointer site** (outcome, escalation, activation scope): `skills/glass-atrium-ops-orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`.
- **Backstop pointer site**: `#### Backstop asymmetry (manual vs. ultracode)` in the same file.

## Team composition and verdicts

- **DEV specialist selection**: justified by `domains`/description alignment, as in normal routing.
  - E.g. backend-heavy plan → glass-atrium-dev-nestjs / glass-atrium-dev-node / glass-atrium-dev-python · UI-heavy → glass-atrium-dev-react / glass-atrium-dev-android.
  - Multi-domain plan → the domain owning the most work streams, or the streams the others wait on.
- **Verdicts (independent)**:
  - glass-atrium-qa-code-reviewer → `pass` / `revise` + concrete unmet items (implementation-feasibility · test-feasibility · scope-fidelity).
  - DEV → `feasible` / `infeasible` + alternative direction (technical validity · approach soundness).
  - Timing: in parallel under ultracode; in sequence on the manual path (`## Backstop detail` → **Manual backstop**).
  - **Direction, not completeness**: a brief plan lacking a structure the user did not ask for (a DAG, per-task acceptance criteria, an executive summary, a premise tag) is never a `revise` or `infeasible` reason.
    - For the DEV member the prompt is the only channel: `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` does not state the rule.
    - Honest backing: honor-system — no hook reads the delegation prompt for it.
- **Scope-fidelity axis (reviewer side, separate from the feasibility axes)**: the reviewer names every planned task that exceeds the user's literal instruction (duty text: `scoped/scope-qa.md` → `### Reviewer verdict`).
  - Honest backing: honor-system LLM judgment, whose value is positional — the judge is a different actor from the one that decomposed the scope.
    - Never claim a mechanical guarantee for it.

## Standing jobs inside the gate

- **Load-bearing premise check**: gates both verdicts — both Stage-2 actors check the premises the plan's approach rests on, attacking each from the code rather than from a list.
  - The inputs the gate pointer site names do not bound the check — either actor may check a premise neither input names.
  - Premise-register grammar: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Scan boundary and provenance`.
  - Duty text: reviewer `scoped/scope-qa.md` → `### Load-bearing premise check` · DEV `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`.
  - Both carry a non-waiver clause: a delegation phrase narrowing the recheck does not suspend the job, and the actor names the narrowing instruction in its verdict.
- **First-link question**: gates the DEV verdict — on revision cycles the DEV member answers it inside its `feasible`/`infeasible` verdict, unasked.
  - Why both members get the plan doc ID: the DEV locates the chain whose earliest decision it prices; the reviewer fetches the chain root its scope-fidelity comparand reads (`scoped/scope-qa.md` → Comparand for scope-fidelity).
  - Duty text and the question literal: `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` → First-link question.

## Backstop detail

- **Identical policy**: covers team composition · DEV hard gate · complex-only scope · max-1 revision.
- **Manual backstop**: `enforce-verification-gate.sh` runs on `PreToolUse(Agent)`.
  - It warns with `VGATE-REVIEWER-001` and the spawn still runs; any earlier reviewer spawn in the session satisfies it, whatever plan or verdict it carried.
  - A nested sub-worker origin gets a stderr advisory only.
  - Reviewer + DEV spawned in one message race (write-after-read): the DEV read precedes the reviewer's completion stamp, so the DEV spawn draws the warning.
  - So the manual discipline is sequential: spawn the reviewer, then the DEV once the reviewer's verdict is in.
  - Absent under ultracode: `skills/glass-atrium-ops-orchestrator.md` → `#### Hook layer split under the engine`.
- **Ultracode backstop**: `enforce-workflow-verify-stage.sh` runs on `PreToolUse(Workflow)` and checks the declaration of `skills/glass-atrium-ops-orchestrator-role.md` → `#### Ultracode declaration contract`.
  - It warns and never blocks the Workflow call.
  - Mechanical surface: declaration presence + line grammar (the DEV hard gate included, `block-noverifydev`) + declaration↔code consistency, fail-open on any parse uncertainty.
  - It does not validate DEV-verdict or gating-expression correctness, and role truthfulness is honor-system (`references/ultracode-declaration-contract.md` → **HONESTY**).
