# Plan edge discovery (Decision phase — fires for any delegation derived from a persisted plan, whole or subset)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator-role.md` → `### Phase Notes` → `#### Plan edge discovery`.

## Declaration sites

- **Unit read**: each included work stream — or task, where the plan was asked to decompose into tasks.
- **Declaration sites (examples, not an enumeration)**: an ordering note on a work stream that names a predecessor (the form a brief plan uses) · a DAG · a critical path · wave notes · a per-task `depends:` field · an acceptance criterion or a prose premise that names one.
- **Stream order alone declares no edge**: a brief plan's work-stream order is sequencing advice; an edge needs a declaration site that names the predecessor.

## Notes on each predecessor class

- **LANDED**:
  - Instruments: `git log`, the file's current content.
  - Whether a named change is in the tree is a routing fact the orchestrator establishes directly; what it implies about the code's behaviour is a finding (`skills/glass-atrium-ops-orchestrator-role.md` → `#### Scan boundary and provenance`).
- **INCLUDED**:
  - **"Before the dependent runs" resolves per path**:
    - Manual path → before the dependent's spawn call.
    - Ultracode path → the script is submitted whole, so an in-script `{glass-atrium-qa-code-reviewer, DEV}` verify stage sits between them.
  - A `pipeline()` may contain an edge; it is authored with that verify stage.
- **EXCLUDED and not landed**:
  - The Stage-2 team shape: `skills/glass-atrium-ops-orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)` → **Verification team**.
  - Why the composing role may not clear itself: it would be judging its own scoping, a judgment this rule set routes to a second party, as at the Stage-2 gate.
  - Why HALT: a task shipped without the predecessor that made its premise true can pass its own acceptance criteria and still be wrong; where that predecessor's behavioural half is not CI-testable, nothing downstream surfaces it.

## `[PLAN-SUBSET]` notes

- **Placement**: `skills/glass-atrium-ops-orchestrator-role.md` → `### Context Handoff Size` → Attestation-token placement.
- **What an `<id>` resolves to**: the plan's own task id where it carries one; on a brief plan, whose work streams carry no identifier, the stream's ordinal in the execution-order list (`included=2,3 order=2>3`).
- **Ids, edges and the `none` / `n/a` literals only — no free text**: justifications go in the delegation body.
  - Why: sibling token grammars are strict — `references/ultracode-declaration-contract.md` → **Team form**.
- **Honest backing**: the check is honor-system.
  - `hooks/enforce-verification-gate.sh` draws a stderr advisory, never a block, on a main-session DEV spawn that references a plan and carries no token — manual path only.
  - Nothing checks the token under ultracode, and its truthfulness is checked on neither path.
