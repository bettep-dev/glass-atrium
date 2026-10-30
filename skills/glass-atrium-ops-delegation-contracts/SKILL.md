---
name: glass-atrium-ops-delegation-contracts
description: 'Delegation contracts behind pointers in skills/glass-atrium-ops-orchestrator(-role).md. Use when routing a request or writing a delegation''s budget, read extents or plan content; authoring or pre-submit-checking a dev-*-spawning Workflow script; sizing or splitting a DEV or analysis spawn; reading a block-* verdict; checking why a [SCOPE] line gave no signal; isolating concurrent tracks; classifying a plan''s predecessor edges; composing the Stage-2 team; setting the exposure bit; running the agent-lifecycle CLI; judging completion from a transcript; setting a managed document''s stage or supersede vs new; composing or routing a review round; reading Failure Recovery backing; or deploying to a live install (Deploy-Safety Idiom, pre-merge live-deploy gate). Do NOT use inside a subagent, for the [SCOPE] grammar line or its binding author rules (role file → Context Handoff Size), or for verify-stage workflow skeletons, sentinel placement and schema caps (skills/glass-atrium-ops-orchestrator.md).'
---

# Delegation Contracts (orchestrator only)

- **What this skill holds**: the detail behind standing obligations that `skills/glass-atrium-ops-orchestrator-role.md` or `skills/glass-atrium-ops-orchestrator.md` states as pointers.
- **SoT split**: each pointer site is the SoT for its obligation, when it fires and its triggers; the Reference Index names what each side is the SoT for.

## When to Use

| Task | Reference Index topic |
|---|---|
| Authoring a Workflow script that spawns a `dev-*` agent | Ultracode declaration contract |
| Sizing a DEV delegation or a schema-mode non-DEV analysis/research/audit spawn, and writing its `[SIZE-EST]` line | Delegation-size discipline |
| Checking how a `[SCOPE] files=` line is parsed, or why a declaration produced no signal | `[SCOPE]` parser behaviour |
| Fanning out concurrent tracks: the isolation path, the no-other-index-mutator check, the `// [OWNERSHIP]` line | Automatic Parallelization |
| Composing a delegation derived from a persisted plan, or writing its `[PLAN-SUBSET]` line | Plan edge discovery |
| Delivering a cycle whose change touches a live-install bundle member | Pre-merge live-deploy gate |
| Composing the Stage-2 plan-direction team, supplying its standing-job inputs, or judging its revision outcome | Stage-2 gate |
| Setting the exposure bit or running the Visual-Weight Probe on an authoring delegation | Deliverable exposure |
| Judging a `needs_devfront_markup` flag | dev-front markup exception |
| Picking a team's cardinality from the task shape | Effort-scaling table |
| Reading why a Failure Recovery stage is or is not enforced | Failure Recovery backing |
| Composing a review round, or routing one that does not converge | Review rounds and reviewer prompts |
| Copying files toward a live install | Deploy-Safety Idiom |
| Routing a request to agents | Agent selection |
| Writing a delegation's budget fields, read extents or plan content | Delegation prompt content |
| Running the agent-lifecycle CLI to create or extend a DEV agent, or reading its exit code | Agent-lifecycle ceremony |
| Locating or reading a delegated agent's transcript to judge whether it finished | Completion signals |
| Writing a managed document's stage, or choosing supersede vs new for new content | Managed Document Completion |
| Confirming a DEV-spawning script's pre-submit checks, or mapping a failed check to its verdict | Pre-submit check table |
| Reading a `block-*` verdict | Ultracode declaration contract |
| A spawn gate blocked or advised on `[AGENT-COMPOSITION]`, `[SIZE-EST]`, `[SCOPE]` or `[PLAN-SUBSET]` | the row whose Topic names that token |

## Reference Index

Read only the file the task needs.

| Topic | File | Pointer site in `skills/glass-atrium-ops-orchestrator-role.md` | SoT at the pointer site | SoT in the reference file |
|---|---|---|---|---|
| Ultracode declaration contract (`[AGENT-COMPOSITION]`) | `references/ultracode-declaration-contract.md` | `#### Ultracode declaration contract` | one-block obligation, its `/* */` home, when it fires, manual path's discipline | line grammar, `block-*` verdicts, upstream waiver, honest backing, pre-verify Discovery routes |
| Delegation-size discipline (`[SIZE-EST]`) | `references/delegation-size-discipline.md` | `### Spawn Budget` → `#### Delegation-size discipline` | sizing duties of both modes, when they fire, split triggers and measured truncation band, COUNTER-CAVEAT | analysis-spawn roster, token formats, budget formula, field and effort values, calibration, gates, backing, notes |
| `[SCOPE]` parser behaviour | `references/scope-parser.md` | `### Context Handoff Size` → `[SCOPE]` | grammar line, placement, completeness, honest backing, **Author rules** lines | **Declaration line**, separators, author-rule detail, worked case, **Parser behaviour** → `hooks/lib/scope-match.sh` |
| Automatic Parallelization (worktree isolation) | `references/automatic-parallelization.md` | `#### Automatic Parallelization` | fan-out duty, trigger, guardrails (a)-(c), isolation duties, partition-then-size; worktree rules: `core-git-workflow.md` | isolation paths, ledger location, `[OWNERSHIP]` format, honest backing, independence, floor, (c) notes |
| Plan edge discovery (`[PLAN-SUBSET]`) | `references/plan-edge-discovery.md` | `### Phase Notes` → `#### Plan edge discovery` | obligation, three predecessor classes, HALT with its exits and reach, `[PLAN-SUBSET]` grammar | declaration sites, unit, instruments, per-path ordering, why HALT, `<id>`, no free text, placement, backing |
| Pre-merge live-deploy gate | `references/live-deploy-gate.md` | `## Document-Driven Workflow` step 6 | what it binds, deploy and verify before the PR, live-suite exit 0, Destructive-Path clearance, prompt-file tail | per-cycle order line and its steps, bundle members, post-merge cases, deploy boundary, honest framing |
| Stage-2 gate | `references/plan-direction-verification.md` | `### Plan Direction Verification (Stage-2 gate)` | trigger, ownership, team, DEV hard gate, DEV selection, direction duty, inputs, outcome, activation scope | DEV selection examples, verdict axes, direction-rule detail, scope-fidelity, standing jobs, count basis |
| Stage-2 backstops | `references/plan-direction-verification.md` | `#### Backstop asymmetry (manual vs. ultracode)` | identical policy, both backstops, primary authoring obligation | policy coverage, hook events, mechanical surface and its limits |
| Deliverable exposure | `references/deliverable-exposure.md` | `#### Deliverable exposure and designer composition (Decision phase)` | exposure bit and its outcomes, Visual-Weight Probe trigger, T1-T5, composition | signal literals, NOT-triggers, routing, canonicals, turn-0 call, Probe detail, rationale |
| Decision-phase probes | `references/decision-phase-probes.md` | `#### Decision-phase probes` | four probes, their halts, what each checks, probe strength | causes, remediation lists, reasons, worked compatibility case |
| Scan boundary and provenance | `references/scan-provenance.md` | `#### Scan boundary and provenance` | routing vs findings, label grammar, by-definition classes, register and lexicon literals | worked pair, register and lexicon reasons, positional backing leg |
| dev-front markup exception | `references/deliverable-exposure.md` | `#### Monitoring-phase notes` → **glass-atrium-dev-front markup-exception Monitoring judgment** | trigger, capability judgment, skeleton-first one-POST handoff, no user surfacing | trigger detail, capability criterion, handoff steps, stitching ban, surfacing exception, EXTEND citation |
| Effort-scaling table | `references/delegation-size-discipline.md` | `#### Analysis fan-out and team cardinality` → **Effort-scaling by task shape** | duty to pick count from shape, when it fires | table, its examples and notes |
| Failure Recovery backing | `references/failure-recovery.md` | `### Failure Recovery Loop` → **Backing honesty (which stages are enforced)** | honor-system checks, the one code-backed stage | why they are honor-system, counter, `.suspended` marker, reset, SubagentStart signal |

| Topic | File | Pointer site in `skills/glass-atrium-ops-orchestrator.md` | SoT at the pointer site | SoT in the reference file |
|---|---|---|---|---|
| Review rounds and reviewer prompts | `references/review-rounds.md` | `### Quality Gates [ORCHESTRATOR]` → `#### Review rounds and reviewer prompts` | trigger (every review round, both paths), reviewer-side counterpart | non-convergence routing table, reviewer-prompt content |
| Architecture patterns (pipeline combinations, Agent Teams) | `references/architecture-patterns.md` | `#### Explicit Pipeline Combinations [ORCHESTRATOR]` · `#### Agent Teams Hybrid [ORCHESTRATOR]` | when a Pipeline is enforced, when Agent Teams apply | combinations, stage ordering, ultracode mapping, Agent Teams table, rules, anti-patterns, priority |
| Workflow JS parse hazards | `references/workflow-js-parse-hazards.md` | `#### Resilient Workflow Authoring [ORCHESTRATOR]` → `##### JS parse hazards (a workflow script is plain JavaScript)` | what it binds (every workflow script), when it fires | two forms, their remedies, Bad/Good example, hook coverage |
| Analysis-Track Right-Sizing | `references/delegation-size-discipline.md` | `#### Analysis-Track Right-Sizing (input-side) [ORCHESTRATOR]` | per-track bounds duty, when it fires | rule SoT per bound, three deltas, `AnalysisSchema` skeleton |
| Deploy-Safety Idiom | `references/deploy-safety-idiom.md` | `#### Deploy-Safety Idiom (drift-preserving live-copy + verify) [ORCHESTRATOR]` | what it binds, advisory status, when in the cycle the deploy runs | sanctioned flows, copy-step anti-patterns, bash 3.2-safe idiom |
| Agent selection | `references/agent-selection.md` | `### Capability-Based Agent Selection [ORCHESTRATOR]` | each routing duty and when it fires, Return Schema, 3-layer safety | four steps, ordering caveat, compound examples, record format, verification checklist |
| Delegation prompt content | `references/delegation-prompt.md` | `### Delegation/Communication Rules [ORCHESTRATOR]` | six elements, budget fields, read-extent and plan-not-request duties | budget tables, prompt aids, read-extent rules and backing, information-hiding rules |
| Agent-lifecycle ceremony | `references/agent-lifecycle-ceremony.md` | `### In-Context Agent-Lifecycle Ceremony (CREATE/EXTEND — ceremony SoT)` | trigger, EXTEND default, direct CLI, no self-authored body, two human pauses, reconcile gate | six steps, EXTEND path, CLI refusals, exit-code recovery table |
| Completion signals | `references/completion-signals.md` | `#### Completion signals` | three signals, forbidden proxies, reversible-action escape, backing | transcript location, sidecar identification, terminality test, ledger writer, proxy reasons |
| Managed Document Completion | `references/managed-document-completion.md` | `## Managed Document Completion (Direct Handling)` → Step 1 · Step 2 | stages, closers, `implementing` timing, recipe, `done` immutability, revise carve-out, close | recipe error cases and worked call, supersede table, row notes, carve-out's why and chain-root rationale, backing |
| Pre-submit check table | `references/workflow-pre-submit-check.md` | `#### Pre-submit self-check — run before submitting ANY DEV-spawning Workflow script` | lint-first order, hand-checked rows, simple-task subset, unverifiable obligations | each check's pass condition and verdict, where each check's detail lives |
