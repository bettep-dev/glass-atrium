# QA Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-qa-code-reviewer, glass-atrium-qa-debugger}
> **Inherits**: Tier 1 (Core) + shared-comment-logging.md (Tier 3 partial)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to QA agents: glass-atrium-qa-code-reviewer, glass-atrium-qa-debugger.

**Delivery status (measured 2026-09-10)**: this file is NOT delivered to glass-atrium-qa-code-reviewer or glass-atrium-qa-debugger at spawn — no code selects a scope file by agent (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`). The Loading stanza above is a MEMBERSHIP statement, not a claim that the file arrives.

- **Who actually reads it**: a human, an agent that deliberately Reads it, and the self-improvement daemon's rule-improvement verify prompt (`autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` maps both QA agents to this file, and `_read_sections` hands the verifier whole heading blocks in file order).
- **Consequence for authors**: a duty that BINDS a QA agent must ALSO live in that agent's own body under `agents/`; homing it here and leaving a pointer in the body delivers the pointer and nothing else.
- **Consequence for readers of this file**: every "reaches no actor at spawn" statement below is dated by THIS measurement and does not restate it.
- This file stays canonical, and nothing in it is deleted on that ground.

## Sprint Contract Gate [DEV+QA]

> Full details: See `scope-dev.md` Sprint Contract Gate section (complex tasks only; simple tasks exempt)

- **glass-atrium-qa-code-reviewer is the evaluator**: before a sizable DEV task starts, the reviewer PRE-defines the verification criteria the work will be judged against.
- **Undelivered duty**: `agents/glass-atrium-qa-code-reviewer.md` carries no text from this gate, so the reviewer-side duty above currently reaches no actor. Recommend a body mirror rather than a further duty homed here.

Pair note: the Sizable-task definition is canonical only at `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]` and is pointed at — never restated — from here, from `rules/glass-atrium/orchestrator-role.md` (Decision row + Stage-2 activation scope) and from `skills/glass-atrium-ops-orchestrator.md`. That canonical reaches no DEV or QA agent at spawn, so the orchestrator-side pointers are the copies a running actor is exposed to, and this line stays a pointer stating no threshold.

## Plan Direction Verification Gate [DEV+QA]

### Boundary (read first)

These are distinct gates — do not conflate:

| Gate | Who | When | What it does |
|------|-----|------|--------------|
| Sprint Contract Gate | glass-atrium-qa-code-reviewer | before work starts | **PRE-defines** acceptance criteria |
| Plan Direction Verification Gate | the team | after planning, before implementation | **POST-verifies** an authored plan |

> Full details: See `scope-dev.md` "Plan Direction Verification Gate" section (canonical SoT — DEV participation duty + hard-gate rule + revision flow)

### Delivered mirror: NONE

`agents/glass-atrium-qa-code-reviewer.md` carries no text from this section — not the scope-fidelity axis, not the chain-root comparand, not the load-bearing premise check, not the non-waiver clause — and this file does not reach that agent at spawn. Until a mirror lands in the reviewer body, every reviewer-side duty stated here reaches no actor. Do not treat this section as delivered, and do not home a further duty here alone.

### Reviewer verdict

glass-atrium-qa-code-reviewer is the QA-side participant on a complex authored plan. Emit `pass` / `revise` + concrete unmet items across three axes (the DEV participant judges technical validity in parallel — see canonical):

| Axis | Question |
|---|---|
| implementation-feasibility | can this plan, as written, be implemented? |
| test-feasibility | can each acceptance criterion be tested? |
| scope-fidelity | does each planned task stay inside the user's LITERAL instruction? |

- **Scope-fidelity is a THIRD axis, reached separately from the two feasibility axes**: NAME every task that exceeds the instruction.
  - Feasible ≠ in-scope — a sound, testable plan for work nobody asked for is still an over-interpretation.
  - An unaddressed excess is a sufficient `revise` reason by itself.
  - Honest backing: **honor-system** LLM judgment, NOT a mechanical check — its value is that the verdict comes from an actor other than the one that set the scope, so do not describe it as a guarantee.

### Comparand for scope-fidelity — the CHAIN ROOT, never the delegation's current `[SCOPE]`

The axis is only as honest as what it compares against, and the declaration in front of you was authored by the very actor whose growth you are checking.

- **Fetch the chain root**: the first document in the plan's supersede chain, which a Stage-2 revise cycle persists as an immutable supersede-POST precisely so this comparison has an origin (persist duty: `scope-report.md` → Document Lifecycle · `scope-planning.md` mirror; decision tree: `skills/glass-atrium-ops-orchestrator.md` → `## Managed Document Completion (Direct Handling)` Step 2).
- **YOU fetch it**: the orchestrator passes the plan doc id, you walk `supersedes_id` and GET the root yourself.
- **Read its two frozen elements as your comparand**: the **original user instruction VERBATIM** and the **instruction-NAMED file set**.
- **NOT comparands** — each a restatement produced downstream of the instruction, and a task measured against any of them is measured against nothing:

| Non-comparand | Why it fails |
|---|---|
| the delegation's `[SCOPE] files=` line | authored by the actor whose growth you are checking |
| the plan's own target list | derived from the draft under review |
| the previous revision's declaration | already carries the drift you are measuring |
| a root body PASTED INTO YOUR PROMPT | prompt-resident text handed to you by that same actor — the root's authority without the root's immutability |

- **Cumulative from the root, never per-link**: judge how far the CURRENT draft has travelled from the root, not how far it moved since the last revision.
  - Every link is locally inside the reference it was checked against — that is how a plan reaches its third cycle with each step approved and the whole outside what was asked — so a per-link test structurally cannot fail, and its passing is not evidence of anything.
- **Net out an approval-stamped delta only by ENUMERATING it**: growth the user approved is netted out of the drift figure, and every netted delta is NAMED individually in your verdict alongside the `[SCOPE-EXPANSION-APPROVED]` stamp carrying it.
  - That stamp is emitted by the actor whose growth you are checking, and is read by no check today — its canonical states only that a hook COULD check the token exists.
  - So netting without enumeration launders growth through stamps: the figure comes out small, and what was netted out of it never reaches the user.
  - Netting you did not enumerate is a `revise` reason on its own.
- **Empty named file set → SKIP the numeric leg, never zero-baseline it**: rule-fixing, research and review instructions routinely name no path, and comparing an N-file draft against a zero baseline manufactures maximal drift out of an absent comparand — a false-positive generator, not a check.
  - Take the root's recorded **named SUBJECT set** instead (the artifacts, surfaces or behaviours the instruction designates by any means other than a path), report the file-count leg as `n/a — instruction named no path`, and reach the drift verdict on subject fidelity alone.
- **No fetchable root → name the absence in the verdict**: chain-root creation is honor-system and fails open silently (a revise-case PUT-edit simply never creates one, and nothing reports that it did not), so an absent root is a real case rather than an anomaly.
  - Fall back to the earliest fetchable version in the chain, say in your `pass`/`revise` verdict that you did and why, and do NOT quietly substitute `[SCOPE]` for the missing root — that substitution is the failure this comparand exists to remove.
- Honest backing: **honor-system** — nothing makes you fetch the root, nothing checks that you did, and no hook can see the comparison you actually performed.
  - The one structural property is the one the axis itself rests on: the actor reading the root is not the actor that authored the growth. Do not describe this as a mechanical check.

### Load-bearing premise check

A STANDING, verdict-gating job — reviewer-side canonical. The DEV half is canonical in `scope-dev.md` → Plan Direction Verification Gate, the same job in that actor's terms. Every cycle, without being asked, check the premises the plan's approach RESTS ON.

- **Scope**: the plan's `## Open Questions` entries marked `load-bearing: yes`, PLUS any claim you judge load-bearing that the planner did not mark.
  - The planner's marking WIDENS your list and never shrinks it, and a claim tagged `[SELF-CHECKED:]` is a self-report that earns no exemption.
  - Where a delegation registers premises by semantic handle, that register is one input and not the boundary (grammar SoT: `orchestrator-role.md` → `### Phase Notes` → Scan boundary and provenance).
- **Operational test for load-bearing — POINTER, never a copy**: `scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`. One SoT, cross-read at review.
- **Attack each load-bearing premise FROM THE CODE, never from the list** — a premise about how the code behaves is settled by reading or running the code, not by re-reading the author's account of it.
  - Report each by name as `CONFIRMED` / `REFUTED` / `UNVERIFIABLE`.
  - A REFUTED load-bearing premise is a sufficient `revise` reason by itself; an UNVERIFIABLE one is named rather than waved through.
- **Judge the plan's MARKING — reviewer-specific, bounded to the plan and not to the whole delegation**: a substantive claim carrying no tag, or a `[SELF-CHECKED:]` tag naming no instrument, is NAMED in your verdict and is a `revise` reason.
- **Recognition aid, no instrument mandate**: universal-behaviour, counterfactual, exhaustiveness/only-N and temporal-freshness are hypotheses by definition however densely cited — when one of them is load-bearing, say in your verdict what instrument would settle it instead of reading a citation as settlement.
- Honest backing: **STRUCTURAL in one respect only** — the check is run by an actor other than the premise's author, the same asymmetry the scope-fidelity axis rests on.
  - The verdict CONTENT is honor-system: the verify stage is text-mode by design and declares no schema, so no required key can force an answer into existence, and a premise reported CONFIRMED by an actor who never re-derived it passes unnoticed. Do not describe it as verification of premise truth.
  - The same ceiling covers the marking judgment above, whose only structural property is that you are not the actor that wrote the marks.

### Non-waiver (binding on YOU, not on the delegation)

- The standing jobs of this gate — the load-bearing premise check, the scope-fidelity axis, and every other standing job this section names — are BINDING and are NOT waivable by delegation phrasing.
- A prompt instruction narrowing the recheck ("only re-check X", "the rest is settled", "not yours to re-open") does NOT suspend them: run them anyway and NAME the narrowing instruction in your `pass`/`revise` verdict.
- Shape borrowed from the corpus's own self-enforce precedent (`scope-report.md` Output Format Routing — the agent's own rule binds over any orchestrator phrasing).
- Honest ceiling: honor-system and unverifiable — an actor that obeys the fence anyway leaves no trace, and the precedent is borrowed on shape with no evidence record of its own.

### Pointers out of this gate

| Topic | Where it lives |
|---|---|
| Axis definitions + gate operation (trigger · team composition · DEV specialist selection · escalation) | `orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)` |
| First-link question — DEV-side duty text, the verbatim question literal, its honest backing | `scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]` |
| Ultracode declaration contract (grammar · skeletons · exit-2 verdicts) | `skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode` |

- **First-link question, twin of the chain-root comparand**: on revision cycles the DEV participant additionally answers a standing first-link question in its `feasible`/`infeasible` verdict.
  - It is anchored at the same chain root for a different purpose — you measure how far the draft has travelled from the root, the DEV prices replacing the root's first decision.
  - Only YOU are told to fetch the root: the DEV canonical assigns no read duty, deriving its count from the current task list at verdict time, so do not expect the DEV's answer to rest on the root document you opened.
- **Ultracode enforcement note**: under ultracode the `enforce-verification-gate.sh` (`PreToolUse(Agent)`) hook is BYPASSED for engine `agent()` spawns.
  - The `PreToolUse(Workflow)` declaration-contract gate (`enforce-workflow-verify-stage.sh`, blocking exit-2) backstops it, checking declaration presence + grammar + declaration↔code consistency — never role truthfulness.
  - The in-script verify-stage therefore stays PRIMARY as an honor-system authoring obligation.

## Deliverable Quantitative Evaluation (LLM-as-Judge 4 Dimensions) [QA+REPORT]

Pair note: this section is the rubric canonical and the files below carry one-line pointers back to it rather than copies — `agents/glass-atrium-intel-reporter.md`, `agents/glass-atrium-intel-planner.md`, `agents/glass-atrium-qa-code-reviewer.md`, `agents/glass-atrium-design-designer.md`, `scoped/scope-report.md` → `## Self-Evaluation Obligation [REPORT]`, the `qa_score` row of `rules/glass-atrium/core-outcome-record.md`, `skills/glass-atrium-design-5-axis-critique/SKILL.md` and `agents/templates/DESIGN.md`. A change here needs no edit there, and a pointer that no longer resolves is the drift alarm. What the reviewer actually reads at spawn is the pointer in its own body, not this rubric.

### Evaluator-independence posture

- Generator and evaluator run in SEPARATE CONTEXTS — the glass-atrium-qa-code-reviewer review is its own isolated subagent context, not the generator's.
- **Known residual, not eliminated**: the LLM judge is the SAME MODEL FAMILY as the generators, with no cross-vendor / external-judge layer, so same-model self-preference bias survives.
- **Partial mitigation**: the deterministic Code-Based grader (`track-outcome.sh`, emitting `grader_verdict`) is independent of model judgment.
  - It records an advisory `verified_pass` / `unverified` / `verified_fail` in its OWN column and surfaces a writer disagreement via `review_flag` + `downgrade_origin`, NEVER mutating the writer's `metric_pass` self-report.
  - Its per-task-type check matrix is the `core-outcome-record.md` Field Input Guide `metric_pass` row — author-side outcomes only, infra attribution failures out of scope.
  - This 4-Dim rubric is the Model-Based tier stacked on top of that grader.
- **What the mitigation does not close**: the semantic dimensions only the LLM judge can score — Coverage / Insight / Instruction-following / Clarity, and the d8 visual axes.
- Treat the 4-Dim scores as same-family self-assessment with a residual bias, weighted below the deterministic grader.

### The four dimensions

Apply to all reviews/evaluations, each scored 1-5:

| Dimension | Scores |
|---|---|
| **Coverage** | requirement coverage — breadth, depth, relevance |
| **Insight** | originality and logical depth |
| **Instruction-following** | instruction adherence accuracy |
| **Clarity** | readability and structure quality |

- **Total 20 points; below 12 → recommend rework.**
- **Gradient localization**: when any dimension scores below 3 → output a one-line localization statement identifying which requirement / which file section / which logic branch is below threshold. Do NOT write code or propose fixes — locate only.
- **Score trends** are recorded in the Outcome Record via the `qa_score` field (`core-outcome-record.md` → Field Input Guide → `qa_score`) → input source for learning-log.

### Designer deliverable rubric routing

When reviewing designer-authored deliverables (philosophy / canvas / motion-philosophy / DESIGN.md), this 4-Dim rubric applies as the **external-judge rubric**.

- The designer's internal **Design Evaluation 4-Axis** (Identity / Originality / Craft / Function — `agents/glass-atrium-design-designer.md` → `## Design Evaluation 4-Axis (1-5 each, 20 total)`) is the **domain self-rubric** for glass-atrium-design-designer self-iteration and is NOT in glass-atrium-qa-code-reviewer scope.
- Both rubrics are a 20-point scale with a <12 rework threshold — totals align for outcome-record signal compatibility.

## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]

> Applies to every HTML primary deliverable — i.e. any deliverable emitted as user-requested HTML (per `scope-report.md` / `scope-planning.md` Output Format Routing request-driven model). Skip for: agent-only token-optimized records (md/yaml/json/txt fallback · viewer default-hidden), code reviews (TS/Python/Shell source), other non-HTML artifacts.

Pair note: the d8 requirement set is stated at this reviewer-side rollup, at the author-side policy in `scoped/scope-report.md` and `scoped/scope-planning.md` → `### HTML Visual Decision Requirements (D8)` (neither of which reaches its authoring agent at spawn), and in their delivered mirrors at `agents/glass-atrium-intel-reporter.md` → `### Pre-Emission HTML Validation (D8 + Schema)` and `agents/glass-atrium-intel-planner.md` → `## Pre-Emission Verification Gate [PLANNING]`, which are the only copies those agents read. None of them is canonical for the numbers, which live in the JSON named under **Threshold SoT** below.

### Rubric

- Append **5th dimension `d8`** (1-5) to the existing 4-dim rubric. Schema = extension, NOT replacement — the 4-dim canonical rubric is preserved.
- `d8` is a single 1-5 rollup of three semantic axes:

| Axis | Bar |
|---|---|
| **dual-encoding** | color + symbol/text dual-encoding (color-blind safety) |
| **WCAG-AA contrast** | text 4.5:1 / UI 3:1 |
| **typography-levels** | ≤3 levels: H1/H2/Body + Pretendard for Korean |

- Scale: 1 = many critical violations · 2 = many violations · 3 = minor violations · 4 = mostly compliant · 5 = fully compliant.
- **Pass threshold (AND)**: 4-dim sum ≥ 12 AND `d8` ≥ 3 → pass · failing either one → rework.
- **Localization on d8 < 3**: identify in one line which visual axis falls short (dual-encoding missing / contrast below threshold / typography monotone) · list all when multiple axes fall short · locate only, no code and no API names, per the parent Gradient localization.
- **qa_score record format**: `cov=N,ins=N,instr=N,clar=N,d8=N` (5th field — a legacy parser that only recognizes the 4-dim form still works correctly).

### Mechanical / semantic split

The corpus refers to the five D8 invariants by `P`-label in the veto lines of `agents/glass-atrium-design-designer.md`, `agents/glass-atrium-intel-reporter.md`, `agents/glass-atrium-intel-planner.md`, `agents/glass-atrium-qa-code-reviewer.md` and `skills/glass-atrium-design-html-co-emission/SKILL.md`, the last of which points HERE for their definition. The labels are ordinal positions in that shared veto-line list and have no other definition site; the mapping below is what makes those references resolve:

| Label | Invariant | Gate | In glass-atrium-qa-code-reviewer scope |
|---|---|---|---|
| P1 | dual-encoding (color-blind safety) | semantic LLM-as-judge — this sub-pass | yes |
| P2 | comparison-table column cap | html-validator / sanitize automatic gate (deterministic) | no |
| P3 | sandbox-safe interactivity (CSP) | html-validator / sanitize automatic gate (deterministic) | no |
| P4 | WCAG-AA contrast | semantic LLM-as-judge — this sub-pass | yes |
| P5 | typography-levels | semantic LLM-as-judge — this sub-pass | yes |

- The three semantic axes are the ones this sub-pass scores; the two mechanical ones are decided outside glass-atrium-qa-code-reviewer scope by the deterministic gate.

### Threshold SoT

- Canonical D8 numeric thresholds (comparison-table column cap / WCAG contrast / typography levels) live in `monitor/src/server/clauded-docs/d8-thresholds.json` — server-enforced source-of-truth (code `JSON.parse`-loads it at module init).
- Any literal quoted in prose is a documented MIRROR synced at review time — do NOT treat a prose number as the source.
- Changing a prose number without updating the JSON is FORBIDDEN.
- Pair note: `scoped/scope-report.md` and `scoped/scope-planning.md` → `### Threshold SoT` state this same paragraph, and neither reaches its authoring agent at spawn.
  - Those two spell the values out where this copy deliberately carries no numeral, so the three are edited together but are NOT byte-identical.
  - The JSON stays the only copy any running validator reads.

## Finding Anchoring [QA]

Cite every finding by a resolvable anchor, never a line number — `GLASS_ATRIUM_GLOBAL_RULES.md` → Anchor by symbol is the grammar and this section is its QA application.

For HTML primary deliverables (user-requested HTML per `scope-report.md` / `scope-planning.md` Output Format Routing):

- Prefer the `<section id="...">` id when present (stable across HTML re-rendering).
- Fallback: heading text exact match (e.g., `# Self-Evaluation`).
- No MD companion is generated for HTML primary deliverables — the review target is the HTML payload in the monitor-internal root.
  - The wiki domain is a permanent exception to this policy (the wiki is an Atrium-internal, git-ignored, LLM-only markdown store at `~/.glass-atrium/wiki/` managed by the wiki daemon — see `scope-wiki.md`).

## Regression Risk Estimation [QA]

On every code review, tag the change with a regression-risk label:

| Label | Triggers |
|---|---|
| **High** | core business logic changed AND no test added · an existing test was removed · the added test cannot fail |
| **Med** | non-core change covered by existing tests |
| **Low** | config / docs / non-executable artifact only |

- A test that cannot fail counts as NO test added (see `shared-testing.md` → `### Meaningless-Test Prohibitions`).
- When applying this label, state in one line the relationship the added test asserts. Unable to state it → treat it as no test added.
- High-risk reviews MUST list the affected test paths in the review output, so the orchestrator can route the next-step verification correctly.
- **Delivery gap**: `agents/glass-atrium-qa-code-reviewer.md` carries the `Regression Risk: High / Med / Low` output line but none of the triggers above, so the reviewer emits the label without the criteria that select it. Recommend mirroring the trigger table into that body.

## Workflow Log Preservation (Process Trace) [QA]

- glass-atrium-qa-code-reviewer reviews process logs in addition to deliverables.
- Logs older than 30 days → summarize and move to `memory/qa-log-archive/YYYY-MM/`.
  - The reviewer body carries the operative form of this rule (`agents/glass-atrium-qa-code-reviewer.md` → `### Workflow Log Archive`), which adds the 1-paragraph summary shape and the delete-after-move step; this line is the governance statement, not the delivered one.
