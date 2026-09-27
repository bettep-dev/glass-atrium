# Plan edge discovery (Decision phase — fires for any delegation derived from a persisted plan, whole or subset)

- **Pointer site**: `rules/glass-atrium/orchestrator-role.md` → `### Phase Notes` → `#### Plan edge discovery` — the SoT for the obligation, the three predecessor classes with the HALT, its two exits and its reach past `[ENTRY-CLASS] simple-task`, and the `[PLAN-SUBSET]` attestation grammar.
- **Relation to ordering**: ordering is already mandatory under that file's `#### Automatic Parallelization` → guardrail (c), and scoping a subset drops no edge. This check finds the edges and handles a missing predecessor.

## Declaration sites

- **Declaration sites (examples, not an enumeration)**: an ordering note on a work stream that names a predecessor (the form a brief plan uses) · a DAG · a critical path · wave notes · a per-task `depends:` field · an acceptance criterion or a prose premise that names one.
- **Stream order alone declares no edge**: the order a brief plan lists its work streams in is sequencing advice; only an ordering note naming a predecessor declares an edge.

## Notes on each predecessor class

- **LANDED**:
  - **Whether a named change is present in the tree is a ROUTING fact the orchestrator establishes directly; what that change implies about the code's behaviour is a FINDING and belongs to an agent** — the same boundary as `rules/glass-atrium/orchestrator-role.md` → `#### Scan boundary and provenance`.
- **INCLUDED**:
  - **"Before the dependent runs" resolves per path** — manual: before the dependent's spawn call · ultracode: the script is submitted whole, so an in-script `{glass-atrium-qa-code-reviewer, DEV}` verify stage sits between them.
  - A `pipeline()` containing an edge is therefore authored WITH that stage, not forbidden.
- **EXCLUDED and not landed**:
  - Why the composing role may not clear itself: a self-written justification is the same asymmetric judgment this rule set routes to a second party everywhere else.
  - Why HALT: a task shipped without its predecessor can pass its own acceptance criteria and still be wrong, because the predecessor made its premise true — and where its behavioural half is not CI-testable, nothing downstream surfaces it.

## `[PLAN-SUBSET]` notes

- **What an `<id>` resolves to**: the plan's own task id where it carries one; on a brief plan, whose work streams carry no identifier, the stream's ordinal in the execution-order list (`included=2,3 order=2>3`).
- **Ids and flags only — no free text**: sibling token parsers are strict enough to carry a dedicated `block-grammar` verdict, and spaces and commas inside a single-line token break them. Justifications go in the delegation body.
- **Distinct from `## Document-Driven Workflow` step 4** of the same rule file, which reconciles the WHOLE plan AFTER implementation; this validates edges BEFORE delegation.
- **HONEST BACKING**: honor-system for the check. The token's presence draws a stderr advisory on the manual path only (`hooks/enforce-verification-gate.sh`, plan-referencing spawns, never a block); nothing checks it under ultracode, and its truthfulness is checked on neither path.
