---
name: glass-atrium-ops-delegation-contracts
description: 'Orchestrator-only delegation contracts behind pointers in rules/glass-atrium/orchestrator-role.md: the ultracode [AGENT-COMPOSITION] declaration and its block-* verdicts, the [SIZE-EST] delegation-size discipline, the [SCOPE] files= parser, worktree isolation for parallel fan-out, plan edge discovery, the pre-merge live-deploy gate, and Stage-2, exposure and failure-recovery detail. Use when authoring a Workflow script that spawns dev-* agents, sizing or splitting a DEV or schema-mode analysis spawn, writing a [SIZE-EST] or [AGENT-COMPOSITION] line, reading a block-* verdict, checking why a [SCOPE] line gave no signal, isolating concurrent tracks, classifying a plan''s predecessor edges, or deploying before the PR. Do NOT use inside a subagent (orchestrator-role.md binds the main session only), for the [SCOPE] grammar line or its authoring rules (orchestrator-role.md → Context Handoff Size), or for workflow skeletons, sentinel placement and schema caps (skills/glass-atrium-ops-orchestrator.md).'
---

# Delegation Contracts (orchestrator only)

- **What this skill holds**: the detail behind standing obligations that `rules/glass-atrium/orchestrator-role.md` states as pointers.
- **SoT split**: each pointer states its obligation, when it fires and its triggers, and is the SoT for them; the Reference Index names what each side is the SoT for.

## When to Use

- Authoring a Workflow script that spawns a `dev-*` agent → the Ultracode declaration contract.
- Sizing a DEV delegation or a schema-mode non-DEV analysis/research/audit spawn, and writing its `[SIZE-EST]` line → the Delegation-size discipline.
- Checking how a `[SCOPE] files=` line is parsed, or why a declaration produced no signal → the `[SCOPE]` parser behaviour.
- Fanning out concurrent tracks — choosing an isolation path, checking that no other index mutator is live, writing the `// [OWNERSHIP]` line → Automatic Parallelization.
- Composing a delegation derived from a persisted plan, or writing its `[PLAN-SUBSET]` line → Plan edge discovery.
- Delivering a cycle whose change touches a live-install bundle member → the pre-merge live-deploy gate.
- Composing the Stage-2 plan-direction team, supplying its standing-job inputs, or judging its revision outcome → the Stage-2 gate detail.
- Setting the exposure bit or running the Visual-Weight Probe on an authoring delegation, or judging a `needs_devfront_markup` flag → deliverable exposure.
- Picking a team's cardinality from the task shape → the Effort-scaling table.
- Reading why a Failure Recovery stage is or is not enforced → the failure-recovery backing.
- A spawn gate blocked or advised on one of these tokens → the reference file for that token (Reference Index).

## Reference Index

Read only the file the task needs.

| Topic | File | Pointer site in `rules/glass-atrium/orchestrator-role.md` | SoT at the pointer site | SoT in the reference file |
|---|---|---|---|---|
| Ultracode declaration contract (`[AGENT-COMPOSITION]`) | `references/ultracode-declaration-contract.md` | `#### Ultracode declaration contract` | the one-block obligation, its `/* */` home, when it fires, the manual path's discipline | line grammar, `block-*` verdicts, upstream waiver, honest backing, pre-verify Discovery routes |
| Delegation-size discipline (`[SIZE-EST]`) | `references/delegation-size-discipline.md` | `### Spawn Budget` → `#### Delegation-size discipline` | the sizing duties of both modes, when they fire, the split triggers and measured truncation band, COUNTER-CAVEAT | analysis-spawn roster, token formats, budget formula, field and effort values, calibration, gates, backing, notes |
| `[SCOPE]` parser behaviour | `references/scope-parser.md` | `### Context Handoff Size` → `[SCOPE]` | the grammar line, placement, completeness, honest backing, separators, first wins, relaying, space-in-path limit | line selection and the record-0 read, field parse, fail-open shapes, the two tolerances, relay shapes, the worked case |
| Automatic Parallelization (worktree isolation) | `references/automatic-parallelization.md` | `### Spawn Budget` → `#### Automatic Parallelization` | fan-out duty, trigger, guardrails (a)-(c), isolation duties, partition-then-size; worktree rules: `core-git-workflow.md` | isolation paths, the ledger's location, the `[OWNERSHIP]` format, honest backing, independence, floor, (c) notes |
| Plan edge discovery (`[PLAN-SUBSET]`) | `references/plan-edge-discovery.md` | `### Phase Notes` → `#### Plan edge discovery` | the obligation, the three predecessor classes, the HALT with its exits and reach, the `[PLAN-SUBSET]` grammar | declaration sites, unit, instruments, per-path ordering, why HALT, `<id>`, no free text, placement, backing |
| Pre-merge live-deploy gate | `references/live-deploy-gate.md` | `## Document-Driven Workflow` step 6 | what it binds, deploy and verify before the PR, live-suite exit 0, Destructive-Path clearance, prompt-file tail | the per-cycle order line, each step of it, bundle members, post-merge cases, the deploy boundary, honest framing |
| Stage-2 gate | `references/plan-direction-verification.md` | `### Plan Direction Verification (Stage-2 gate)` | trigger, ownership, team, DEV hard gate, DEV selection, direction duty, inputs, outcome, activation scope | DEV selection examples, verdict axes, the direction rule's detail, scope-fidelity, the standing jobs, count basis |
| Stage-2 backstops | `references/plan-direction-verification.md` | `#### Backstop asymmetry (manual vs. ultracode)` | the identical policy, both backstops, the primary authoring obligation | policy coverage, hook events, the mechanical surface and its limits |
| Deliverable exposure | `references/deliverable-exposure.md` | `### Phase Notes` → `#### Deliverable exposure and designer composition (Decision phase)` | the exposure bit and its outcomes, the local-destination hint, the Visual-Weight Probe trigger, T1-T5, composition | signal literals, NOT-triggers, routing, canonicals, the turn-0 call, local-destination scope, Probe detail, rationale |
| dev-front markup exception | `references/deliverable-exposure.md` | `#### Monitoring-phase notes` → **glass-atrium-dev-front markup-exception Monitoring judgment** | its trigger, the capability judgment, skeleton-first one-POST handoff, no user surfacing | trigger detail, capability criterion, handoff steps, stitching ban, surfacing exception, EXTEND citation |
| Effort-scaling table | `references/delegation-size-discipline.md` | `#### Analysis fan-out and team cardinality` → **Effort-scaling by task shape** | the duty to pick count from shape, when it fires | the table, its examples and notes |
| Failure Recovery backing | `references/failure-recovery.md` | `### Failure Recovery Loop` → **Backing honesty (which stages are enforced)** | which checks are honor-system and how applied, the one code-backed stage | why they are honor-system, the counter, `.suspended` marker, reset, SubagentStart signal |

## Edit Rules

- **Machine-read literals**: the token literals and their field keys, and the `block-*` verdict names, are what the spawn gates scan for and emit — keep them byte-identical.
- **Pointer sync**: edit an obligation or trigger only at its pointer site, the SoT; a reference file names it and never restates it.
- **Cited leads**: a bolded lead in a reference file can be a pointer target in another file — grep the corpus before renaming one. Leads cited by name elsewhere:
  - `references/scope-parser.md` → **Declaration line** · **Wrapped token** · **Whole-line wrap**.
  - `references/ultracode-declaration-contract.md` → **Exit-2 verdicts** · **HONESTY** · the pre-verify Discovery/Design bullet.
  - `references/delegation-size-discipline.md` → **`[SIZE-EST]` self-attestation token** · **`[SIZE-EST]` analysis mode** · **Reserve-then-check** · **Effort matched to depth** · **Honesty framing** · **Output-field cap**.
  - `references/automatic-parallelization.md` → **Three sanctioned isolation paths** · **Deciding "at a time"**.
- **Cited headings**: a heading in a reference file cited by name elsewhere keeps its text and level — grep the corpus before renaming one:
  - `references/plan-direction-verification.md` → `## Team composition and verdicts` · `## Standing jobs inside the gate` · `## Gate outcome and activation scope`.
  - `references/deliverable-exposure.md` → `## Exposure Determination — signals and routing` · `## glass-atrium-dev-front markup exception — detail`.
