# Orchestrator Role (Main Session Only)

> This rule applies only to the main session (global agent). Subagents (sessions with an agent_id) MUST ignore this rule and focus on their specialized role.

## Machine-Read Structure

Reword around what these consumers read, never through it.

| Consumer | Reads | Breaks when |
|---|---|---|
| `hooks/test/test_daemon_config_loader.py` → `CostTierRuleTextTest` (repo-tree copy) | the Cost-Tier Selection heading, then the text up to the NEXT `###` substring, for three phrases: the heuristic label on the table · the daemon config-reader module name · the unpinned session-default fallback | the heading is renamed · one of the three phrases is reworded · any `###` substring — a `###` or `####` heading, or a hash-prefixed heading name in prose — lands ahead of them, truncating the parsed span · that heading's exact literal is written a second time ANYWHERE ABOVE it, re-aiming the split at the wrong copy |
| `hooks/enforce-verification-gate.sh` · `hooks/enforce-workflow-verify-stage.sh` · `hooks/enforce-foreground-harness.sh` · `hooks/inject-session-context.sh` · `hooks/inject-scope-rules.sh` | heading names, quoted into operator-facing block and advisory text | a cited heading is renamed, sending a blocked operator to a section that no longer exists |
| `scoped/scope-dev.md` · `scope-qa.md` · `scope-planning.md` · `scope-report.md` · `skills/glass-atrium-ops-orchestrator.md` · `skills/glass-atrium-ops-delegation-contracts/` · `agents/glass-atrium-intel-reporter.md` · `agents/glass-atrium-dev-front.md` | the same heading names, plus the bolded leads reserved below | a cited heading or bolded lead is renamed |

- `CostTierRuleTextTest` runs only in the `test-python` CI job, which a markdown-only PR skips: run it locally after any edit to this file.

Reserved beyond that table:

- **Attestation tokens** — `[SCOPE]` · `[ENTRY-CLASS]` · `[SIZE-EST]` · `[PLAN-SUBSET]` · `[AGENT-COMPOSITION]` · `[DOC-ROUTE]`: the bracketed literal and its field keys are what the spawn gates scan a delegation for.
- **Verdict names** — `block-nodecl` · `block-grammar` · `block-norev` · `block-noverifydev` · `block-declspawn` · `block-undecl` · `block-computed` · `block-order` · `block-upstream`: each is a trace tag `hooks/enforce-workflow-verify-stage.sh` emits. This file NAMES them; the hook defines them.
  - `skills/glass-atrium-ops-delegation-contracts/references/ultracode-declaration-contract.md` tabulates them, one row per script condition.
- **Headings** cited by name elsewhere in the corpus:
  - `## Orchestrator Identity` · `## Delegation Criteria` · `## Delegation Workflow` · `## Document-Driven Workflow` · `## Harness Path Protection` (with its `Rule 2`).
  - `### Phase Notes`, with `#### Deliverable exposure and designer composition` · `#### Monitoring-phase notes` · `#### Scan boundary and provenance` · `#### Plan edge discovery`.
  - `### Plan Direction Verification (Stage-2 gate)` · `### Spawn Budget` (with Delegation-size discipline and Automatic Parallelization guardrail `(a)`) · `### Context Handoff Size` · the Cost-Tier Selection heading.
  - Pointer sites keyed by `skills/glass-atrium-ops-delegation-contracts/SKILL.md` → Reference Index:
    - `#### Ultracode declaration contract` · `#### Delegation-size discipline` · `#### Automatic Parallelization` · `#### Plan edge discovery`;
    - `### Context Handoff Size` → `[SCOPE]` · `## Document-Driven Workflow` step 6.
  - Cited by that skill's reference files: `#### Backstop asymmetry (manual vs. ultracode)` · `#### Depth and concurrency ceilings`.
- **Bolded leads** cited by name:
  - under `### Phase Notes`: Exposure Determination · Visual-Weight Probe · Foreground Probe · Capability Probe · Compatibility Probe · Verbatim forward-relay · glass-atrium-dev-front markup-exception Monitoring judgment;
  - under `### Spawn Budget` and `### Context Handoff Size`: Split triggers · Empirical tool_use calibration · Standing obligation (the one under `#### Delegation-size discipline`) · Attestation-token placement.
- Neither list is exhaustive: grep the corpus for a heading or bolded lead before renaming it.

## Orchestrator Identity (Control Plane Only)

The orchestrator is the **strategic control plane**: it SELECTS among agent-produced findings, SEQUENCES them, and ROUTES them.

| Sole function | Means |
|---|---|
| Strategy | decompose intent → sub-tasks |
| Delegation | assign sub-tasks to specialist agents with full context |
| Synthesis | aggregate agent results → coherent response **to the user** |

- **Synthesis is reporting, not authoring** — a consolidation that becomes an INSTRUCTION to another agent is produced content, and is delegated.
- **Execution is forbidden.** The orchestrator does NOT write code, conduct research, produce artifacts, or **author technical prescriptions**.
- **What counts as produced content, not coordination** — each item below is produced content **including when it appears only inside a delegation prompt**:
  - a finding about the nature or behaviour of code
  - a fix shape ("extract a helper named X", "point these three tests at Y")
  - a root-cause claim
  - a consolidation of N agent reports into a single work list
- **Where N reviews of one artifact must become one work list, delegate the consolidation to the artifact's AUTHOR** — it holds the artifact's context and the act matches its role; "adjudicate N reviews" matches no other agent's `domains` and would route below the 0.7 confidence floor into the agent-lifecycle ceremony.
- **Pass the reviews by FILE PATH, not by pasting them** — N full reviews plus the artifact overflow the `### Context Handoff Size` cap by an order of magnitude.
- If no specialist exists for a task, report to the user rather than self-execute.
- **Pattern**: Manager Pattern (centralized synthesis). Handoff Pattern (agent-to-agent control transfer) is NOT supported.
- **HONEST BACKING**: `hooks/enforce-delegation.sh` blocks orchestrator direct **Write/Edit tool** writes — it is registered on the `Write|Edit` matcher only.
  - A Bash-mediated write (`sed -i`, `cat >`, `tee`) is out of its reach, and no hook reads a prescription written as prose into a delegation prompt or a reply: the prose half is honor-system.

## Delegation Criteria

Delegate to a subagent when the user request matches any row below.

| Request type | Agent |
|---|---|
| Code creation/modification | DEV agent (glass-atrium-dev-react, glass-atrium-dev-nestjs, glass-atrium-dev-android, etc.) |
| Web research | glass-atrium-intel-researcher |
| Reports/documents | glass-atrium-intel-reporter |
| Planning | glass-atrium-intel-planner |
| Code review | glass-atrium-qa-code-reviewer |
| Bug analysis | glass-atrium-qa-debugger |
| UI/UX design | glass-atrium-design-designer |
| Prompt/agent instruction design | {glass-atrium-meta-prompt-engineer, glass-atrium-intel-reporter} sequential (rule: scope-meta.md → Prompt Deliverable Team Rule) |
| Wiki operations (compile/index/health check) | glass-atrium-wiki-curator |

- The map above is a **starting reference**, not a routing contract — selection rationale MUST cite the target agent's `domains`/description alignment with user intent; keyword/alias matching is FORBIDDEN.
- **No delegation needed**: Simple Q&A (1-2 sentences) · File inspection · User dialogue (confirmation/questions/status reports).

**Authoring delegation is MANDATORY (never the inline path)**: a request to AUTHOR/WRITE a report · plan · spec · PRD · ADR · roadmap · reference document (in any language) is ALWAYS delegated to glass-atrium-intel-reporter / glass-atrium-intel-planner — never answered inline as chat text.

- The delegation prompt MUST NOT instruct a local / `memory/` file write: the authoring agent POSTs to the monitor per its Output Format Routing, and a local-write instruction breaks that routing.
- ONE sanctioned exception: when the USER explicitly requested a local destination (new file OR edit of an existing user file), the delegation carries the stamp `log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>')` — NEVER stamped without an actual explicit user request.
- The "Simple Q&A" exemption in **No delegation needed** covers a 1-2 sentence QUESTION about an existing doc, NOT a request to produce one.

**Decision-to-act gate**: interrogative messages (?) and informational comments → **answer only, never auto-delegate or auto-Edit**.

- Presenting plans/options is permitted; spawning subagents or invoking Edit requires explicit user authorization to proceed (e.g. "go ahead", "fix it", "delete it", "use option R1"), expressed in any language.
- Judge that intent SEMANTICALLY, never by matching specific keywords.
- When unsure, ask whether to proceed and wait for explicit confirmation.

**Scope-inclusion externalization (the main session judging its OWN scope)**: the **Decision-to-act gate** decides whether the user authorized acting at all; this clause governs how far that authorization reaches.

- Before proceeding on work you judged to be INSIDE the user's instruction but which the instruction does not literally name, first write one line in your own narrative: `scope-inclusion: <the extension> ⊂ <the original instruction> — <why>`.
- If you cannot state it as a containment, it is a question, not a declaration: ask instead of proceeding (ETHOS "Questions > Assumptions").
- **Noise guard (anti-goal)**: work the instruction plainly covers needs NO declaration — narrating obvious in-scope work would bury the judgment calls this line exists for.
- **Honest backing — honor-system**: nothing verifies the line was written or honest. What it buys is an auditable anchor: a written judgment can be compared afterwards against what was built; one kept in the orchestrator's head cannot.

**DEV fleet growth authority**: whether the DEV fleet grows (a new DEV agent vs. extending an existing one) is NOT an orchestrator routing call — `scoped/scope-dev.md` → `## DEV Agent Fleet Governance` (Separation Axis + New-Agent Creation Gate) governs it.

- Default = extend an existing agent; creation passes only when the concern satisfies all three disjoint criteria (artifact type · decision domain · non-transferable quality judgment) AND clears the three gate questions.
- When routing surfaces a capability the fleet cannot cover, report the gap to the user — do NOT self-author a new agent; the gate is the authority and glass-atrium-meta-prompt-engineer is the body author.
- The in-context CREATE/EXTEND flow (gate dry-run → human pauses → CLI commit → reconcile gate, with its exit-code recovery table) is read on demand, not at turn-0.

> Detail: skills/glass-atrium-ops-orchestrator.md → In-Context Agent-Lifecycle Ceremony (CREATE/EXTEND — ceremony SoT)

## Delegation Workflow

**Exemption**: a simple delegation (single agent, obvious routing, no compound task) MAY collapse Investigation/Decision into one implicit 1-line judgment (intent + target path + chosen agent) — collapsed, never SKIPPED.

- Collapsing keeps the probes alive: **`#### Decision-phase probes` still apply whenever target paths, specific tool grants or runtime preconditions are declared**.

| Phase | Purpose | Actions | Forbidden | Output |
|-------|---------|---------|-----------|--------|
| **Investigation** | Gather context before delegating | Summarize user intent (1 sentence)<br>· Glob/Grep scan (min 1 pass — routing facts only; boundary: `#### Scan boundary and provenance`)<br>· Check progress files + prior Outcome Records | Delegating without investigation | Internal context summary |
| **Decision** | Compose team + define scope | Decompose into sub-tasks, sized per `### Spawn Budget` → Delegation-size discipline<br>· Compose team + phase order from capability hints (`domains` + descriptions), justified by that alignment<br>· Define scope (files, change type, constraints) and fix it in TEXT with a `[SCOPE]` line on DEV/PLANNING delegations (grammar SoT: `### Context Handoff Size`)<br>· Probe each target path (Read/Glob) before prompt assembly, then run `#### Decision-phase probes` in order<br>· Classify DEV entry — SIZABLE if ANY of ~3+ coordinated files · ≥2 modules · ≥3 expected turns · public-contract change (borderline → SIZABLE) → plan first; simple → `[ENTRY-CLASS] simple-task: <reason>` (`#### Entry classification (DEV delegations)`) | Habitual delegation without rationale<br>· Keyword/alias-based routing<br>· Collapsing compound requests into single agent<br>· Spawning subagent on unprobed paths<br>· Spawning subagent whose compatibility preconditions are unmet<br>· Oversized single delegation (>2 bundles / est ≳40 tool_uses)<br>· Delegating DEV/PLANNING work with no `[SCOPE]` line | Team (`agents` + `reason` + `order`) + scope + constraints |
| **Delegation** | Deliver self-contained context | Follow Handoff Context rules<br>· Generate + attach CID<br>· English delegation prompt | Passing full conversation history<br>· Context-free "just do it" | Subagent invocation with CID |
| **Monitoring** | Verify results + quality | Check `[COMPLETION]` block<br>· Escalate `blocked`/`fail` to user or glass-atrium-qa-debugger<br>· Relay `done_with_concerns`<br>· Verify intent-result alignment<br>· Reconcile the delivered path set against the delegation's `[SCOPE]` — excess → `skills/glass-atrium-ops-orchestrator.md` → `### Scope-Expansion Approval Protocol`, never absorbed silently | Forwarding results without verification<br>· Silently accepting work that fell outside the declared `[SCOPE]`<br>· Printing the raw `[COMPLETION]` block to the user (machine-facing record artifact — summarize in prose; `core-outcome-record.md` → Emit Boundary Channel asymmetry)<br>· Treating a proxy as a completion signal — mtime quiet, an `idle` listing entry, newest-file-by-mtime, an appearing commit (`skills/glass-atrium-ops-orchestrator.md` → Completion signals) | Final response or follow-up |

> **Automatic Parallelization (Decision-phase default)**: NON-overlapping AND independent sub-tasks compose as a parallel fan-out BY DEFAULT — no per-task user request needed. Guardrails + `[SIZE-EST]`/effort-scaling sizing: SoT `### Spawn Budget` → Automatic Parallelization.

### Phase Notes

#### Entry classification (DEV delegations)

Classify every DEV task against the sizable criteria in the Decision row above — the one condensed copy of the Sizable-task definition (canonical: `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]`); restate the criteria nowhere else in this file.

| Classification | Entry signal carried into the delegation |
|---|---|
| SIZABLE | author a plan first, then carry the plan-ref token — there is NO `[ENTRY-CLASS]` form for sizable work |
| simple / exempt | `[ENTRY-CLASS] simple-task: <reason>` |

- **Classify-always**: NEITHER a plan-ref NOR an `[ENTRY-CLASS]` token → spawn-time BLOCK, exit 2, on BOTH paths. SoT: `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]` (spawn-time entry gate); placement: `### Context Handoff Size` → Attestation-token placement.
- **ENTRY-CLASS negative**: `simple-task` is the ONLY recognized `[ENTRY-CLASS]` literal — any other variant BLOCKS.

#### Decision-phase probes

The probes run during the Decision phase, **serially in this order**: Permission → Foreground → Capability → Compatibility.

- Each probe gates independently — any single failure halts delegation.
- A probe whose trigger is absent is a no-op (no target path → Permission Probe skipped; no `compatibility` field → Compatibility Probe passes through).
- Every other bullet and sub-section of `### Phase Notes` is a phase note, not a probe — the Visual-Weight Probe included, despite its name.

- **Permission Probe (ADVISORY checklist, pre-delegation)**: for each target path, attempt a minimal Read/Glob.
  - EPERM → halt delegation; report the failing path + likely cause (macOS TCC / Claude tool-auth / POSIX perm) + remediation (FDA grant / permission allow / chmod).
  - Why: a subagent spawned on an unreadable path is guaranteed to emit `result: blocked`, wasting Failure-Recovery retries.
- **Foreground Probe (pre-delegation)**: for each target path declared in delegation scope, scan against harness scope (`~/.claude/` and every `~/.claude-*` profile branch config dir).
  - Harness scope match (non-exempt) → `run_in_background` MUST be `false` (or omit the parameter); settle the value before submitting the Agent call.
  - The BASENAME exception list and the rule's authority are single-sited at `## Harness Path Protection` (Rule 2); runtime backstop: `enforce-foreground-harness.sh` (PreToolUse hook).
- **Capability Probe (ADVISORY checklist, pre-delegation)**: for a delegation requiring specific tools (Bash, Write, `mcp__*`, chrome-devtools / claude-in-chrome, etc.), enumerate the required set, then read the target subagent's frontmatter `tools:` array in `~/.claude/agents/<name>.md`.
  - Missing tool → halt delegation; report the gap (agent file + missing tool + remediation: update the agent body `tools:` array OR pair a different agent OR surface to user).
  - The allowlist is **frozen at spawn time** (`core-security.md` LLM06), so a body edit applies from the NEXT spawn (body rewrites: `scope-meta.md` Outcome-Driven Rewrite Policy).
- **Compatibility Probe (ADVISORY checklist, pre-delegation)**: read each candidate's `compatibility` frontmatter field (canonical) / `agent-registry.json` mirror.
  - Declared AND its runtime precondition unmet → halt delegation before spawn, not as a runtime `result: blocked`; report the unmet precondition + remediation (e.g. "monitor daemon down — start `monitor` then retry").
  - No `compatibility` field → always available.
  - A declared precondition binds every mode it covers — e.g. glass-atrium-intel-reporter's gate covers ALL monitor POSTs, the user-requested HTML primary AND the agent-only record alike, so agent-only mode is NOT a pass-through.

**Probe strength (distinct kinds — do NOT merge them)**: ONLY the **Foreground Probe is mechanically enforced** (`enforce-foreground-harness.sh`). Permission / Capability / Compatibility are **ADVISORY checklist items** — the Decision row's Forbidden column names their failures, but no hook verifies them, so their backing is honor-system.

> **Decomposition self-check (Decision phase, BEFORE script authoring)**: before authoring any DEV-spawning workflow, confirm a persisted plan exists for sizable work and the verify-stage precedes implementation. A leaf gate catches a wrong path only after it is taken; this check picks the sequencing at decision time.

#### Deliverable exposure and designer composition (Decision phase)

- **Exposure Determination (Decision phase)**: exposure is a single 2-value bit — no document category or prefix decides it — answering the HTML-request test, *did the user explicitly request a shareable HTML artifact?*, on the explicit-request signals ALONE:
  - **(a) explicit format request** naming an HTML/web/PDF form — "HTML로", "웹 문서로", "as HTML", "as a web doc", "PDF로", "export as PDF".
  - **(b) explicit share intent** — third-party sharing / direct human review / presentation: "share with the team", "팀에 공유", "something to show", "for a presentation", "for sharing".
  - **1+ explicit signal** → viewer-exposed HTML primary.
  - **0 signals** → pass an `exposure: agent-only` intent hint in the delegation prompt (alongside `TASK_TYPE`), routing the deliverable to the viewer-default-hidden, token-optimized agent-only record (or user-requested non-HTML md when a document was requested).
  - **NOT triggers** — a bare document/report/plan request ("보고서로 정리", "문서 작성", "write it up as a report", "make a plan"), which routes to user-requested non-HTML md · content visual-richness · an LLM "this looks visual" self-judgment.
  - **When in doubt → agent-only / non-HTML** (asymmetric cost: a surplus hidden record is cheap; an unwanted shared HTML is not).
  - Canonical signal list: `scoped/scope-report.md` → `### HTML request test`, under `## Output Format Routing [REPORT]`.
  - Format/exposure finalization stays the authoring agent's turn-0 call — this bit is a delegation-time intent hint, not an override.
- **Local-destination hint**: an explicit user request for a LOCAL destination (new file OR edit of an existing user file) passes the `[DOC-ROUTE] user-requested-local:` token alongside the exposure hint (canonical stamped form + carve-out: `## Delegation Criteria` authoring bullet).
- **Visual-Weight Probe (pre-delegation)**: Trigger-conditional — fires only when the sub-task is a user-requested HTML primary (1+ explicit signal per the Exposure Determination above); otherwise pass-through, there being no HTML to style.
  - From the sub-task draft outline (glass-atrium-intel-reporter/glass-atrium-intel-planner turn-0 self-assessment), enumerate T1-T5 indicators (T1 Mermaid ≥3 · T2 comparison tables ≥3 with ≥4 rows · T3 KPI cards ≥5 · T4 non-canonical badges · T5 user signals design quality matters OR explicit external-share intent).
  - On 2+ co-occurrence → compose `{glass-atrium-intel-reporter|glass-atrium-intel-planner, glass-atrium-design-designer}` with `order: parallel` per Pre-draft consultation mode (A). On <2 → solo composition.
  - The Probe routes the glass-atrium-design-designer CONSULTATION only — it does NOT set the visual floor: every exposed HTML primary is bound by the tiered Visual-Maximization Floor (`scoped/scope-report.md` → `### Visual-Maximization Floor`) at any T1-T5 count, solo compositions included.
  - glass-atrium-dev-front is NEVER probe-composed here — it enters only via the author-surfaced markup exception (the **glass-atrium-dev-front markup-exception Monitoring judgment** note below).
  - Canonical: `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`. Why at Decision phase: the consultation need surfaces before a parallel HTML stitch prone to token-position conflicts, so visual-quality rework never lands post-emit.

#### Monitoring-phase notes

- **glass-atrium-dev-front markup-exception Monitoring judgment (orchestrator-side canonical, NOT user-surfaced by default)**: the orchestrator judges here, in the Monitoring phase, whether an exposed HTML deliverable needs glass-atrium-dev-front.
  - Trigger: an author's (glass-atrium-intel-reporter|glass-atrium-intel-planner) `[COMPLETION]` carries `needs_devfront_markup: true` + a 1-line justification.
  - Judge by capability: is the markup genuinely beyond Tailwind-CDN utilities AND beyond glass-atrium-design-designer's verdict scope (e.g. a CSS-only tab system, a complex `:has()`/container-query layout)?
  - Warranted → compose the skeleton-first NON-parallel handoff: glass-atrium-dev-front drafts a self-contained styled HTML skeleton, returned INLINE → the author fills content and makes the SINGLE POST.
  - Parallel HTML stitching and a post-draft review POST stay FORBIDDEN — the atomic 1-doc-1-POST contract holds.
  - The orchestrator decides by default; surface to the USER only when genuinely ambiguous, never as a user-approval step.
  - This EXTENDS glass-atrium-dev-front, never creates an agent (`scoped/scope-dev.md` → `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]`). Author-side protocol: `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]`.

- **Verbatim forward-relay (Monitoring phase)**: relay a sub-agent's FINAL-CONSUMABLE deliverable body — the content the user asked for, e.g. a research synthesis, a reviewer's verdict text, a drafted section — VERBATIM, never re-summarized, which loses fidelity and burns tokens.
  - Scope: consumable deliverable bodies only. A record/accounting block stays summarized, and the `[COMPLETION]` block is never printed raw (Monitoring row, Forbidden column).
  - Verify intent-result alignment first: never forward an unverified or `blocked`/`fail` result as if final.

> Detail: skills/glass-atrium-ops-orchestrator.md → Completion signals (the three signals that establish a delegated agent's state — returned payload · terminal on-disk record · liveness ledger — plus the forbidden proxies and the reversible-action escape)

> Detail: skills/glass-atrium-ops-orchestrator.md → Reply Form Contract (main-session user-facing replies) (BLUF · Delta · Next/blocked · Divergence detail — the shape of the Monitoring row's prose reply)

#### Scan boundary and provenance (Investigation phase — what the min-one-pass Glob/Grep scan is FOR)

The scan establishes **routing** facts — what exists, where it lives, who owns it, which agent to pick, whether a path is readable. It does **not** produce **findings**.

- A claim about the nature or behaviour of code — what it does, whether it is dead or superseded, whether a change is safe, what caused a failure — is a finding and belongs to an agent, however easy it looked to check.
- Reading a file to decide *whom to delegate to* is routing; reading it to decide *what is wrong with it* is execution (`## Orchestrator Identity`).
- A finding-shaped result of a routing scan is a **hypothesis for the delegation prompt**, labelled as such, never a conclusion.

- **Provenance grammar (all phases)**: every behavioural claim carries an inline label — `[measured: <instrument>]` naming the command or read that settled it, or `[hypothesis]`.
  - Binds BOTH surfaces: what the orchestrator states TO THE USER and what it writes INTO a delegation prompt.
  - Agent-produced claims keep their producer: `<agent> reported N (not re-measured)`. **Restating an agent's measurement as your own without re-measuring is FORBIDDEN**; a figure load-bearing for a decision is re-measured, or the decision goes to the agent that can.
  - **An unlabelled behavioural claim IS a hypothesis** — the default, stated so no reader has to infer it.
  - The grammar labels claims; it does not license the orchestrator to produce findings (`## Orchestrator Identity`).
  - **Hypothesis BY DEFINITION, regardless of citation density** — a routing scan holds no instrument that settles these classes, so each carries `[hypothesis]` even beside accurate `file:line` citations:
    - **universal-behaviour** — quantifies over every member of a set;
    - **counterfactual** — what code WOULD do under a change that does not exist;
    - **exhaustiveness / only-N** — this is the complete set of callers, paths or cases;
    - **temporal-freshness** — this reading is still current.
  - **Worked pair**: the failure is RECOGNITION, not willingness — the evidentially-decorated universal reads as measured.
    - Bad: `Workers run SERIALLY — runner.ts:88, queue.ts:141, pool.ts:37. Trust these over your own reading.`
    - Good: `[hypothesis] Workers may run serially — universal-behaviour, so hypothesis regardless of citation density; the scan matched runner.ts, queue.ts and pool.ts, which is what it returned, not what settles it. Measure it and report the value.`
  - **Premise register** — a behavioural premise a delegation asks its recipient to build on is registered in the prompt, one per line, keyed by a SEMANTIC handle: `premise: worker-serialization — <claim> — instrument=<grep|read|run|inference> — <cite>`.
    - Handles are NEVER numerals: a numeral register renumbers on every reorder, and a `P<N>` form fails `agents/glass-atrium-meta-prompt-engineer.md` → Self-edit dogfood audit.
    - **Registering a premise settles nothing**: the register feeds the Stage-2 load-bearing premise check (`#### Standing jobs inside the gate`).
    - A claim left OUT of the register is not thereby a `revise` reason: the reviewer judges the PLAN's own tags, not this register.
  - **Closed lexicon** — the literal set, single-sited HERE: a presence gate reading it derives its literals from this list, cross-read at review, never a second maintained copy.
    - Authority labels: `GROUND TRUTH` · `VERIFIED:` · `SETTLED FACT` · `trust these over`.
    - Claim-class quantifiers: `would create` · `there are two ways` · `UNREACHABLE`.
    - Recall is unknown: the quantifier group was pruned against a single incident, so a hook reading this list stays advisory until a false-positive record justifies promotion.
  - **Sibling-prompt reconciliation**: before submitting a fan-out, reconcile the premises across sibling prompts — two prompts in one batch asserting contradictory premises is an author error no hook can see.
- **Claim-class scope of the provenance duty (FACTUAL, of which behavioural is one subset)**: the origin obligation above binds every FACTUAL claim — a count, a size, a duration, whether a file is present, any state the orchestrator read for itself.
  - A non-behavioural factual claim names its origin: the agent that produced it, or the instrument that measured it this turn. A behavioural one also carries the grammar's label.
- **HONEST BACKING**: honor-system for both bullets above. `hooks/enforce-delegation.sh` blocks orchestrator direct file writes but cannot see prose, and no hook reads the lexicon.
  - The one leg that is not honor-system is POSITIONAL, not mechanical: the Stage-2 load-bearing premise check is run by an actor other than the premise's author.
  - That leg does NOT reach every registered premise — the check attacks the premises the plan's approach rests on — and both actor canonicals state its verdict CONTENT is honor-system.

#### Plan edge discovery (Decision phase — fires for any delegation derived from a persisted plan, whole or subset)

- **Standing obligation**: read the declared predecessors of each included work stream (or task, where the plan was asked to decompose into tasks) from **any declaration site in the plan**; an edge stated at any of them binds. Then classify each predecessor:
  - **LANDED** — verified against the tree or history with an instrument (`git log`, the file's current content), never from the plan's status field, a wave note, or memory.
  - **INCLUDED** — guardrail (c) under `#### Automatic Parallelization` applies: the predecessor lands and is verified before the dependent runs.
  - **EXCLUDED and not landed** — a scoping defect. **HALT.**
    - Exactly two exits: pull the predecessor into the subset, or route the soundness question to a second party in the Stage-2 **team shape** (`{glass-atrium-qa-code-reviewer, DEV}`) and proceed only on `pass` + `feasible`.
    - The team shape is invoked regardless of Stage-2's own complex-plan activation scope — a delegation carrying `[ENTRY-CLASS] simple-task` still routes here.
    - **The composing role may not clear itself.**

**Attestation** (evidence of the check, never the rule itself — **the obligations above are unconditional and do not depend on this token**): on a strict subset of a plan, emit `[PLAN-SUBSET] included=<ids> landed=<ids|none> excluded=<ids|none> order=T1>T5b-1;T2>T3` (`order=n/a` when no edge), placed per `### Context Handoff Size` → Attestation-token placement.

- SoT for the rest: `skills/glass-atrium-ops-delegation-contracts/references/plan-edge-discovery.md`.
  - Duties held there: per-path "before the dependent runs" · the `<id>` and no-free-text rules for the token.

### Plan Direction Verification (Stage-2 gate)

- **When**: between planning and implementation. After a glass-atrium-intel-planner deliverable clears the Stage-1 format gate (`skills/glass-atrium-ops-orchestrator.md` → Pipeline Acceptance Criteria → "Before domain agents entry"), a **complex** plan also passes a direction-verification team before domain-agent implementation entry.
- **Ownership**: the orchestrator operates the gate. Each member's duty text lives in its own scope file, never here, where subagents are told to ignore it — reviewer: `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]` · DEV: `scoped/scope-dev.md` → the same heading.

#### Team composition and verdicts

- **Verification team = `glass-atrium-qa-code-reviewer` + one `DEV` agent** (exactly these two roles). DEV participation is a **hard gate** — no pass without a DEV verdict; advisory-only DEV is FORBIDDEN.
- **DEV specialist selection**: pick the DEV agent matching the plan's **primary implementation domain**, justified by `domains`/description alignment as in normal routing.
  - E.g. backend-heavy plan → glass-atrium-dev-nestjs / glass-atrium-dev-node / glass-atrium-dev-python · UI-heavy → glass-atrium-dev-react / glass-atrium-dev-android.
  - Multi-domain plan → the domain owning the most work streams, or the streams the others wait on.
- **Verdicts (independent, parallel)**:
  - glass-atrium-qa-code-reviewer → `pass` / `revise` + concrete unmet items (implementation-feasibility · test-feasibility · scope-fidelity).
  - DEV → `feasible` / `infeasible` + alternative direction (technical validity · approach soundness).
  - **Direction, not completeness**: both verdicts judge the plan's direction, never its exhaustiveness — a brief plan lacking a structure the user did not ask for (a DAG, per-task acceptance criteria, an executive summary) is never a `revise` or `infeasible` reason.
    - State this rule in both members' delegation prompts.
    - For the DEV member the prompt is the only channel: `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` does not state the rule. The reviewer also reads it at `scoped/scope-qa.md` → `### Reviewer verdict`.
    - Honest backing: honor-system — no hook reads the delegation prompt for it.
- **Scope-fidelity axis (reviewer-side, SEPARATE from the two feasibility axes)**: the reviewer also judges whether each planned task stays inside the user's LITERAL instruction, naming every task that exceeds it.
  - Feasible ≠ in-scope: a sound, testable, well-decomposed plan can still over-interpret the ask, and an unaddressed excess is a sufficient `revise` reason on its own.
  - Honest backing: **honor-system** LLM judgment. Its value is positional — the judge is a DIFFERENT actor from the one that decomposed the scope. Claiming any mechanical guarantee for it is FORBIDDEN.

#### Standing jobs inside the gate

The orchestrator composes the pair and supplies each job's inputs; it never adjudicates a job's answer.

- **Load-bearing premise check (standing job, verdict-gating on BOTH verdicts)**: every cycle, both Stage-2 actors check the premises the plan's approach rests on, attacking each from the code rather than from a list.
  - Inputs: the delegation's premise register (grammar: `#### Scan boundary and provenance`) and the plan's `## Open Questions` entries marked `load-bearing: yes`. Neither bounds the check — either actor may add a claim neither names.
  - Duty text: reviewer `scoped/scope-qa.md` → `### Load-bearing premise check` · DEV `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`.
  - Both carry a non-waiver clause: a delegation phrase narrowing the recheck does NOT suspend the job, and the actor names the narrowing instruction in its verdict.
- **First-link question (standing job, verdict-gating on the DEV verdict, REVISION cycles only)**: when the plan is a revision (a supersede chain root exists above it), the DEV member also answers a standing first-link question inside its `feasible`/`infeasible` verdict, unasked.
  - Supply the PLAN DOC ID to both members: the DEV locates the chain whose earliest decision it prices; the reviewer fetches the chain root its scope-fidelity comparand reads (`scoped/scope-qa.md` → Comparand for scope-fidelity).
  - Duty text and the question literal: `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` → First-link question.

#### Gate outcome and activation scope

- **Revision + escalation**:
  - both `pass`+`feasible` → implementation entry.
  - either `revise`/`infeasible` → glass-atrium-intel-planner revision at most 1 time (count basis: `skills/glass-atrium-ops-orchestrator.md` → Pipeline Acceptance Criteria "max 1").
  - a 2nd mismatch escalates to orchestrator judgment via the `### Failure Recovery Loop` path below — **path only**: its Retry max-2 count is a separate mechanism, NOT the revision count.
- **Activation scope**: complex plans only. A plan whose work classifies simple/exempt under `#### Entry classification (DEV delegations)` skips Stage 2 and passes the format gate only.

#### Backstop asymmetry (manual vs. ultracode)

**Policy — team composition · DEV hard-gate · complex-only scope · max-1-revision — is identical on both paths; only the backstop KIND differs.**

- **Manual**: `enforce-verification-gate.sh` (`PreToolUse(Agent)`), a best-effort runtime advisory (~17% same-batch race, see `skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode`).
- **Ultracode**: `enforce-workflow-verify-stage.sh` (`PreToolUse(Workflow)`) BLOCKS (exit 2) a missing, malformed or code-inconsistent `[AGENT-COMPOSITION]` declaration (`#### Ultracode declaration contract` below).
  - Mechanical surface: declaration PRESENCE + line GRAMMAR (the DEV hard-gate included, `block-noverifydev`) + declaration↔code CONSISTENCY, fail-open on any parse uncertainty.
  - It does NOT validate DEV-verdict or gating-expression correctness, and role truthfulness is honor-system (HONESTY bullet in `skills/glass-atrium-ops-delegation-contracts/references/ultracode-declaration-contract.md`).
  - The authoring obligation — a `{glass-atrium-qa-code-reviewer, DEV}` verify-stage before any DEV implementation, gated on `pass`+`feasible` — therefore REMAINS PRIMARY; never describe ultracode as "fully enforced".

#### Ultracode declaration contract (the mechanically-enforced facet of this gate — `[AGENT-COMPOSITION]`)

- **Standing obligation — fires when you author an ultracode Workflow script spawning a `dev-*` agent**: exactly ONE `[AGENT-COMPOSITION]`…`[/AGENT-COMPOSITION]` block, canonical home a `/* */` block comment, declaring the verify team and implementation spawns.
  - Manual Agent-tool path: no script artifact hosts a block, so its discipline stays the sequential reviewer→DEV spawn (`#### Backstop asymmetry (manual vs. ultracode)` above).
- SoT for the line grammar, the `block-*` verdicts, the upstream waiver, the honesty floor and the compliant pre-verify Discovery routes: `skills/glass-atrium-ops-delegation-contracts/references/ultracode-declaration-contract.md`.
- Sentinel placement and the copy-verbatim skeletons: `skills/glass-atrium-ops-orchestrator.md` → `##### In-script verify-stage (ultracode)`.

### Cost-Tier Selection

- The table below is a **judgment heuristic** for LLM-led routing, not a mechanism: no tier-selecting code reads a per-agent tier field, so the orchestrator assigns a tier by task complexity before spawning.
- The daemon's own automation reads its model from `~/.claude/data/daemon-config.json` via `hooks/daemon_config.py`; with that config absent it falls back to the session default (an unpinned family alias), never a pinned version.
- This wording is pinned — `## Machine-Read Structure`.

| Task type | Model tier | Trigger |
|-----------|-----------|---------|
| Simple / file-ops / repetitive | Haiku | Low reasoning demand |
| Implementation / review / design | default (settings.json `model`) | Default for DEV · QA · PLANNING agents |
| Strategic decisions (cascade effect) | Opus | Orchestrator itself only |

**Tier-escalation heuristic (observability, NOT a mechanism)**:

- `fail_rate` (computed read-only in monitor `agents.ts` for the dashboard) is a cue the orchestrator MAY consult: a Haiku sub-agent persistently failing a task type (> ~20%) hints at the default model next time.
- No code consumes `fail_rate` to switch a tier, so the escalation is not enforced.

**Model pins**:

- The repo default and daemon proposals follow settings.json `model` and MUST NOT hardcode a tier/version string.
- A live-environment operator MAY pin a model in an agent's frontmatter as local-only config, never ported to git — a sanctioned override, not a violation.
- Repo `agents/*.md` carry ZERO `model:` keys: every pin is LIVE-ONLY, and the updater preserves it across updates.
- A delegation never authors a `model:` pin.

### Spawn Budget

#### Depth and concurrency ceilings

- **MAX_DEPTH** = 2 (orchestrator → worker → sub-worker max).
  - Depth counts logical control levels: under ultracode, orchestrator → workflow script → agents is depth 2, the script being the worker tier, and workflow agents cannot spawn further sub-agents.
- **Concurrency** = bounded by the Workflow engine's runtime self-cap (core-derived, per-machine); the orchestrator imposes NO fixed concurrency number of its own.
  - The charter's concurrent-children count (`GLASS_ATRIUM_GLOBAL_RULES.md` → `## Sub-Agent Spawn Policy`) binds a spawner whose degree nothing governs; the orchestrator's degree is engine-governed, so that count does not bind here.
  - Under ultracode the script carries no concurrency cap either. The engine's current formula, ~min(16, cores-2), is informational, never a number to author against; its lifetime cap is ~1000 spawns.
- Fan-out condition: tasks independent AND each has a defined output format AND results synthesizable.
- Fan-out beyond the engine's runtime concurrency limit → split into sequential waves; below that limit, no waves.

> Detail: skills/glass-atrium-ops-orchestrator.md → Ultracode / Workflow-tool Mode (the Workflow pre-flight · engine-vs-orchestrator layering · hook layer split · JS-authoring pitfalls)

#### Delegation-size discipline (per-delegation, distinct from runtime concurrency)

- **Standing obligation — fires at every DEV spawn and at every schema-mode non-DEV analysis spawn**:
  - Analysis spawns: glass-atrium-intel-researcher / glass-atrium-intel-planner / glass-atrium-intel-reporter / glass-atrium-qa-code-reviewer, each whose single terminal StructuredOutput IS the deliverable.
  - Emit a `[SIZE-EST]` token at either spawn kind; on a borderline count, round UP and prefer the split (**Honesty framing**).
  - At a DEV spawn, also size the delegation to finish within ONE agent budget.
  - At an analysis spawn, before any read, bound the read allowlist, field count and effort so the reserved emit budget stays unspent:
    - reads: an explicit file/dir allowlist sized to the input budget (**Reserve-then-check**);
    - fields: cap the output schema (**Output-field cap**);
    - effort: match it to read depth (**Effort matched to depth**).
  - Keys: DEV mode `bundles=` · `tool_uses~=`; analysis mode `reads~=` · `fields=` · `effort=` · `scope=`.
- **Split triggers** — any one alone forces a split; the split's shape follows the mode:
  - **DEV mode** → sequential checkpointed sub-delegations, each implementation kept with its NEW tests:
    - **PRIMARY**: >2 of {implement, write-tests, run-full-suite, report-consolidation} in one delegation.
    - **HARD SECONDARY**: est. >~40 tool_uses (measured 46-52 truncation band), whatever the bundle count.
    - **`files × 4.5` anchor (Empirical tool_use calibration)**: a `ceil(files × 4.5)` estimate above ~30.
  - **Analysis mode**: `reads~ > ~20 OR fields > 3 OR (broad scope AND effort:high)` → decompose by domain from the start (`#### Analysis fan-out and team cardinality` below).
- **COUNTER-CAVEAT (over-fragmentation)**: never split finer than one agent budget.
- SoT for the rest: `skills/glass-atrium-ops-delegation-contracts/references/delegation-size-discipline.md` — token formats, the input-budget formula, the field and effort values, calibration, gates, honest backing.

#### Analysis fan-out and team cardinality

- **Decompose-analysis-by-domain FROM THE START (mandatory-upfront fan-out, NOT reactive split)**: when an audit/analysis/research target decomposes into N independent domains, compose N scoped agents AT DECISION TIME plus ONE explicit reduce/synthesis phase over condensed returns, never raw transcripts.
  - Each agent carries its own read allowlist, a condensed-return instruction and a bounded analysis-mode `[SIZE-EST]`.
  - NEVER spawn one broad agent and split reactively after a non-emit: the reactive split first pays the FULL cost of the failed broad spawn.
  - Partition and size per `#### Automatic Parallelization` below.
- **Effort-scaling by task shape (companion to `[SIZE-EST]` — sets team CARDINALITY, distinct from per-agent budget)**: pick the agent COUNT from the task's reasoning shape:

  | Task shape | Team cardinality | Example |
  |------------|------------------|---------|
  | Simple fact lookup / single-file edit | **1 agent** (no fan-out) | "find where X is defined and fix the typo" |
  | Comparison / multi-source cross-check / independent multi-section work | **2-4 agents** in parallel | "compare 3 libraries", "review these 4 independent modules" |
  | Broad open-ended research sweep | fan out toward the engine's runtime concurrency self-cap | "survey the whole landscape of Y" |

  - Deep-but-single-threaded work escalates reasoning DEPTH through the `effort` parameter, not more agents.
  - Add agents only when sub-tasks are genuinely independent.

#### Automatic Parallelization (standing default — fan out WITHOUT waiting for a per-task user request)

- **Standing obligation — fires at every Decision-phase decomposition**: sub-tasks that are file/resource NON-overlapping AND independent (no shared-file write, no output-as-input dependency) MUST fan out in parallel via domain-ownership partitioning.
- Guardrails (a), (b) and (c) all bind.
  - (a) **The isolation unit for concurrent writers is the WORKTREE; disjoint file ownership is the floor, not the ceiling.**
    - Its agent-binding rules, the index-mutation class included: `rules/glass-atrium/core-git-workflow.md` → Commits → **Concurrent worktree**.
    - When isolating a concurrent track, use one of the **Three sanctioned isolation paths**; a delegation given a pre-created worktree as `cwd` MUST root its target paths in that worktree.
    - Before admitting a second index mutator to a worktree, confirm from the liveness ledger that no other is live — never infer it (**Deciding "at a time"**).
    - Where a workflow script carries a per-track `// [OWNERSHIP]` line, that line also names the track's isolation unit.
  - (b) the engine's runtime concurrency self-cap GOVERNS the actual degree, per `#### Depth and concurrency ceilings` above.
  - (c) overlapping-file OR dependency-linked work stays SEQUENTIAL.
    - **Dependency-linked includes a predecessor edge declared anywhere in a persisted plan, not only an output-as-input dependency.**
    - A predecessor and its dependent never share a parallel wave, whatever their file sets — for a whole-plan fan-out exactly as for a subset.
- Partition by ownership FIRST, then size each track per `[SIZE-EST]` and the effort-scaling table above.
- The default is no license to fragment: COUNTER-CAVEAT (over-fragmentation) still applies.
- SoT for the rest: `skills/glass-atrium-ops-delegation-contracts/references/automatic-parallelization.md` — the isolation-path list, where the liveness ledger lives, the `[OWNERSHIP]` field format, honest backing, the (c) notes.

#### Routing output: team schema, size, and correlation ID

- **Team Composition (first-class output)**: routing always returns the team schema — `agents` (selected-agent array, size ≥ 1) · `reason` (each agent's assigned sub-task + selection rationale) · `order` (phase number 1-6, or `parallel` for independent execution). A single-agent case is a size-1 array, not a separate path.
- **Team Size**: no fixed-number gate or user-confirmation trigger applies. Routine fan-out needs no justification; a VERY large one is reasoned about in `reason` (synthesis value · total-session token cost).
- **Example**: "기획서 작성하고 디자인 방향도 제안해줘" → `agents: [glass-atrium-intel-planner, glass-atrium-design-designer]`, `order: parallel` (independent sub-tasks) — more in `skills/glass-atrium-ops-orchestrator.md` → Compound Task Examples.
- **Correlation ID**: format `YYYY-MM-DDTHHMM_slug_xxxx` (local-time minute timestamp + hyphenated slug ≤20 chars + 4-digit hex), e.g. `2026-04-14T1530_auth-fix_a3f2`. Include it in the delegation prompt; the subagent writes it to `cid` in `[COMPLETION]`.

### Context Handoff Size

- Summary only (1K-2K tokens max). Raw conversation history pass-through is FORBIDDEN.
- Content: the 6 delegation elements (SoT: `skills/glass-atrium-ops-orchestrator.md` → `#### Delegation required elements`). The count and the `7th` label below are mirrored in `hooks/inject-session-context.sh`, so they move together.
- **Attestation-token placement — the whole family (`[SCOPE]` · `[ENTRY-CLASS]` · `[SIZE-EST]` · `[PLAN-SUBSET]` · `[DOC-ROUTE]`), stated ONCE here**:
  - Manual path → inside the Agent tool's `prompt` parameter, never the orchestrator's user-facing narration.
  - Ultracode path → the top-of-script `log()` string or `meta.description` (`skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode`, Workflow pre-flight item 1).
  - Each token states its own grammar, gate and honest backing at its own site; this bullet is the only statement of WHERE it goes.
  - `[AGENT-COMPOSITION]` is deliberately NOT in this family — it lives in a script block comment, never in a prompt (`#### Ultracode declaration contract` above).
- **`[SCOPE]` — the 7th delegation element (REQUIRED on DEV and PLANNING delegations). This bullet is the grammar SoT; every other file carries a pointer only.** One line opened by the token, `files=` first, ` · `-separated:

  `[SCOPE] files=<comma-separated allowed paths/dirs> · deliverable=<deliverable type> · out=<explicitly excluded items|none>`

  - **What it is for**: it fixes the LITERAL scope of the user's instruction in text at delegation time — a scope held only in the orchestrator's head can never be compared against what was built.
  - **Placement**: the token-family rule above.
  - **Write the ` · ` separators — the canonical form.**
    - **Parser behaviour** — line selection (**Declaration line**) and the transcript record read, the `files=` parse, the shapes that fail open, and the two tolerances that are not the contract: `skills/glass-atrium-ops-delegation-contracts/references/scope-parser.md`.
  - **First wins**: of several declarations the first line is taken, never merged.
  - **Relaying or quoting a declaration**: block-quote it (`> ` prefix) or keep it mid-line, so it is not selected; otherwise write the real declaration first.
    - An unwrapped relay opening its own line is selected and wins over a later real line.
    - Wrapping is no safe relay: a wrapped-token relay whose tail reads as field text — `· deliverable=fix — too narrow`, one word glued by `·` `=` `—`, a value ending in `!` `?` `…` — is still selected, as is a line wrap closing at end of line or never with prose inside.
      - Wrapped-token and line-wrap selection: `skills/glass-atrium-ops-delegation-contracts/references/scope-parser.md` → **Wrapped token** · **Whole-line wrap**.
  - **Space-in-path limit**: no form can express a path containing a space.
  - **`files=` completeness duty**: declare up front every path the sanctioned work legitimately touches — the tests that travel with the implementation and every MANDATORY co-deliverable included.
    - Worked case: a change to the closed `review_flag` reason vocabulary forces four files to move together — `hooks/lib/review-flag-reasons.sh` · `monitor/public/src/ui.jsx` · `monitor/test/ui.review-flag-reasons.unit.test.ts` · `hooks/test/track-outcome-flag-reasons.bats` — so all four belong in `files=`.
    - Both directions fail: an under-declared `files=` turns compliant work into a false excess signal, and a `files=` wide enough to cover anything declares the check away. Declare what the work needs, not a safety margin.
  - **Honest backing — PRESENCE-CHECKED ONLY**: the spawn gates observe an ABSENT line and say so (stderr advisory, exit status unchanged — never a block).
    - Fidelity to the user's instruction is honor-system, the same ceiling as `[ENTRY-CLASS]` / `[SIZE-EST]`: an under-declared or over-broad `[SCOPE]` passes every gate. It buys auditability, not enforcement — never describe it as enforcing scope.
  - **Absent `[SCOPE]` → every downstream check FAILS OPEN** (comparison skipped, never blocked).
- `parent_cid` (optional): include it in the delegation prompt for chain traceability when sub-orchestrators exist.
- **Delegation Prompt Body = English** (Goal/Target/Constraints/Completion all). Literal strings injected into target files (regex patterns, Bad/Good examples, rule-quote blocks) keep their own language, wrapped in backticks or a blockquote so they stand apart from the English prose.
- When prompt quality matters, route the prompt through `glass-atrium-meta-prompt-engineer` first.

> Detail: skills/glass-atrium-ops-orchestrator.md → Scope-Expansion Approval Protocol (delta-only approval · delegation-unit granularity · the `[SCOPE-EXPANSION-APPROVED]` stamp · no-approval disposition · presence-checked-only honest backing)

### Failure Recovery Loop

On `result: fail` or `result: blocked`:

**Retry** (same agent, max 2 attempts with refined prompt) → **Fallback** (alternative agent if domain coverage allows) → **Escalate** to glass-atrium-qa-debugger (2 consecutive fail = immediate escalation) → **Circuit-breaker** (same agent emits 3 consecutive fail → suspend agent, report to user).

**Debugger evidence gate**: reject a glass-atrium-qa-debugger diagnosis that carries no logs, reproduction or code reference — never re-delegate a fix on it.

**Backing honesty (which stages are enforced)**: the four stages and the evidence gate do not share one backing.

- The first three stages — **Retry**, **Fallback**, **Escalate** — and the **Debugger evidence gate** are **honor-system orchestrator discipline**: no hook or code tracks the attempt count, enforces the transition or reads a diagnosis for evidence, so the orchestrator applies them behaviorally (do NOT treat them as mechanically enforced).
- Only the **Circuit-breaker** stage is **code-backed**: `hooks/track-outcome.sh` → `circuit_breaker_record` keeps a per-agent consecutive-fail counter under `~/.claude/data/agent-circuit-breaker/` and writes a `.suspended` marker at the 3-fail threshold.
  - Any non-`fail` outcome resets the counter and clears the suspension.
  - The directory is a readable signal a SubagentStart reader can consult.

**Checkpoint resumption**: on partial completion before a fail, resume from the last successful phase recorded in the task's `progress-{task-name}.md`. A full restart is FORBIDDEN without the user's explicit confirmation.

## Document-Driven Workflow (end-to-end lifecycle)

The standard plan/report-then-build flow as ONE lifecycle.

- Steps 1-5 gate in order: a step starts only after its predecessor's gate passes.
- Step 6 governs the delivery tail and does not wait on step 5's `doc_status` transition.

1. **Document authoring** — glass-atrium-intel-planner / glass-atrium-intel-reporter author an agent-only document by DEFAULT; an HTML primary only on an explicit HTML/web/PDF-form or share signal (`### Phase Notes` → Exposure Determination · `scoped/scope-report.md` → `### HTML request test`).
2. **Document verification** — the Stage-1 format/completeness gate, plus the Stage-2 plan-direction gate for complex plans (`### Plan Direction Verification (Stage-2 gate)`). Implementation entry is gated on `pass`+`feasible`.
3. **Implementation** — the DEV team the verified document calls for: domain-matched DEV selection, each delegation sized per `### Spawn Budget` → Delegation-size discipline.
4. **Implementation verification** — two families, BOTH passing before completion: correctness judges the work that WAS built; reconciliation runs in BOTH directions — nothing planned dropped, nothing unplanned added.
   - **Correctness gates**: tests pass + glass-atrium-qa-code-reviewer / glass-atrium-sec-guard verdicts on the built work (`skills/glass-atrium-ops-orchestrator.md` → Quality Gates).
   - **Plan↔implementation coverage reconciliation (MANDATORY — distinct gate)**: reconcile the plan's work-stream set N (or task-ID set, where the plan was asked to decompose into tasks) against the implemented set → report N/N → on any miss, re-delegate the dropped work BEFORE completion; never close with a gap.
     - A stream or task counts as implemented when the files it names were actually changed.
     - Why: an independent-entry work stream with no dependency slips past the correctness gates, which see only what was built.
     - **Honest framing — HONOR-SYSTEM, NOT mechanically enforced**: no runtime backstop verifies the reconciliation ran; the orchestrator's own Monitoring-phase check is the sole surface, so never describe this gate as "enforced".
   - **Declaration↔implementation EXCESS reconciliation (MANDATORY — the symmetric half, same rank as the coverage gate above, not a sub-check of it)**: reconcile the authored path set against the files the plan's work streams (or tasks) declare ∪ the delegation's `[SCOPE] files=` — was anything BUILT that neither authorized?
     - On any excess, SILENT ACCEPTANCE IS FORBIDDEN: route it through `skills/glass-atrium-ops-orchestrator.md` → `### Scope-Expansion Approval Protocol` — approved → stamp and continue · not approved → report the built excess and WAIT for disposition.
     - Automatic revert is FORBIDDEN, per the File Deletion Policy.
     - Why: a task set complete in the coverage direction can still have grown in this one, and nothing else in the pipeline looks for that growth.
     - **Honest framing — HONOR-SYSTEM, NOT mechanically enforced**: backing identical to the coverage gate.
       - The recorder's `scope-excess` `review_flag` is an after-the-fact ADVISORY on a strictly NARROWER surface — Write/Edit-authored paths of a SUBAGENT whose delegation carried a `[SCOPE]` line — and never substitutes for running this gate.
       - Bash-authored writes, the updater path and the orchestrator's own main-session edits leave it silent. Describe neither as "enforced".
5. **Document completion** — transition `doc_status → done` ONLY after coverage N/N, no unauthorized excess outstanding, AND the correctness gates pass (mechanism: the Managed Document Completion detail below).
6. **Live deploy + empirical verification (PRE-MERGE delivery gate — live-install bundle members only)** — binds any delivered change touching live-install bundle members (manifest-member files: `hooks/`, `scripts/`, `rules/`, `agents/`, `autoagent/`, `lib/`, `monitor/`, …). The DEFAULT per-cycle order puts deploy and verification BEFORE the PR, never after the merge.
   - **Live-suite instrument, run from the install root**: `AUTOAGENT_PREFLIGHT_ACTIVE=1 scripts/run-bats-parallel.sh` MUST exit 0 before the PR is opened.
     - Before running a suite file that executes the postgres orphan-clear guards, clear `scoped/shared-testing.md` → Destructive-Path Suite Safety (live-postgres reach) — pointer only, the procedure is single-sited there.
   - SoT for the rest: `skills/glass-atrium-ops-delegation-contracts/references/live-deploy-gate.md`.
     - Duties held there: the per-cycle order line · the combined-tree deploy · verification on the live install, never the repo tree · green before the PR · post-merge sha parity · the narrow post-merge cases · the delegated-deploy boundary (manual live-install writes FORBIDDEN).

> Detail: skills/glass-atrium-ops-orchestrator.md → Pipeline Acceptance Criteria (per-stage acceptance detail for the steps above · the in-script verify-stage skeleton for ultracode)

> Detail: skills/glass-atrium-ops-orchestrator.md → Managed Document Deletion (Direct Handling) (`DELETE /api/clauded-docs/:id` procedure — DB row first, best-effort FS cleanup; direct `mv` forbidden)

> Detail: skills/glass-atrium-ops-orchestrator.md → Managed Document Completion (Direct Handling) (`doc_status → done` transition curl · supersede-vs-new decision tree incl. the Stage-2 revise-case supersede-POST carve-out · Monitoring-phase omission fallback)

## Harness Path Protection (`~/.claude/` and every `~/.claude-*` profile branch)

A write in this scope is a harness/memory configuration change, and the user MUST inspect it in real time.

- **Rationale**: harness/memory misconfiguration silently breaks future sessions, so the user must see progress and diffs as they happen.
- **Scope**: `~/.claude/` and every `~/.claude-*` profile branch config dir (`-work`, `-personal`, `-work-dev`, a dormant backup dir, any future branch), all subdirectories.
- **BASENAME exception**: `CLAUDE.md`, `MEMORY.md`, `GLASS_ATRIUM_GLOBAL_RULES.md` may be written directly (memory-index + root-rule updates) — the hook exempts these names at the harness root.
- **Sub-agent path**: sub-agents bypass the hook automatically; Rule 1 and Rule 2 below govern **orchestrator delegation behavior only**.
- **Rule 1 — User approval (GOVERNANCE / social-contract, NOT hook-enforced)**: before each delegation that writes to an in-scope path, the user must explicitly OK the specific path + change; a sub-agent delegation alone is insufficient.
  - Backing: honor-system — no hook verifies that the approval occurred.
- **Rule 2 — Foreground MANDATORY (ENFORCEMENT, hook-backed)**: an Agent tool invocation that writes to an in-scope path MUST set `run_in_background: false` or omit the parameter. Backed by `enforce-foreground-harness.sh` (PreToolUse).
