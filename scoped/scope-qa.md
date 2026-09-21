# QA Scope Rules

Binds `glass-atrium-qa-code-reviewer`. No duty in this file binds `glass-atrium-qa-debugger`. A section that fires only under a particular spawn or artifact type says so in its opening line.

## Sprint Contract Gate [DEV+QA]

The gate's criteria duty, its Sizable-task definition and its spawn-time entry gate are canonical at `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]` and are restated nowhere else. This heading is the anchor the files citing it by name resolve to.

## Plan Direction Verification Gate [DEV+QA]

**Condition — the whole section, every standing job in it included, fires only here**: you are `glass-atrium-qa-code-reviewer`, spawned as the QA member of a `{glass-atrium-qa-code-reviewer, DEV}` team verifying an authored complex plan before implementation begins. On a code review, a document review, or any spawn without that team composition, none of it applies.

- **The verdict vocabulary is this gate's, not the review template's**: here you emit `pass` / `revise`. `Pass / Conditional Pass / Reject` belongs to the code-review template in your own body and is not emitted here.
- Gate operation — trigger, team composition, DEV specialist selection, revision and escalation — is the orchestrator's: `rules/glass-atrium/orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`.
- The DEV half of the standing jobs below is canonical at `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`.

### Reviewer verdict

Emit `pass` / `revise` plus concrete unmet items across three axes; the DEV member judges technical validity in parallel.

| Axis | Question |
|---|---|
| implementation-feasibility | can this plan, as written, be implemented? |
| test-feasibility | can each acceptance criterion be tested? |
| scope-fidelity | does each planned task stay inside the user's LITERAL instruction? |

- **Direction, never completeness**: all three axes judge where the plan is headed. A plan lacking a structure the user did not ask for — a DAG, per-task acceptance criteria, an executive summary, a premise tag — is not a `revise` on that ground.
- **Scope-fidelity is reached separately from the two feasibility axes**: NAME every task that exceeds the instruction.
  - Feasible ≠ in-scope — a sound, testable plan for work nobody asked for is still an over-interpretation.
  - An unaddressed excess is a sufficient `revise` reason by itself.
- Honest backing: honor-system LLM judgment. Its one structural property is that the verdict comes from an actor other than the one that set the scope — do not describe it as a guarantee.

### Comparand for scope-fidelity — the CHAIN ROOT, never the delegation's current `[SCOPE]`

The axis is only as honest as what it compares against, and the declaration in front of you was authored by the very actor whose growth you are checking.

- **YOU fetch the chain root**: the orchestrator passes the plan doc id; walk `supersedes_id` to the first document in the supersede chain and GET it yourself. A Stage-2 revise cycle persists that root immutably so this comparison has an origin.
- **Read its two frozen elements as your comparand**: the original user instruction VERBATIM, and the instruction-NAMED file set.
- **NOT comparands** — each a restatement produced downstream of the instruction, and a task measured against any of them is measured against nothing:

| Non-comparand | Why it fails |
|---|---|
| the delegation's `[SCOPE] files=` line | authored by the actor whose growth you are checking |
| the plan's own target list | derived from the draft under review |
| the previous revision's declaration | already carries the drift you are measuring |
| a root body PASTED INTO YOUR PROMPT | the root's authority without the root's immutability, handed over by that same actor |

- **Cumulative from the root, never per-link**: judge how far the CURRENT draft has travelled from the root, not how far it moved since the last revision.
  - Every link is locally inside the reference it was checked against — that is how a plan reaches its third cycle with each step approved and the whole outside what was asked.
  - A per-link test therefore cannot structurally fail, and its passing is evidence of nothing.
- **Net out an approval-stamped delta only by ENUMERATING it**: growth the user approved is netted out of the drift figure, and every netted delta is NAMED individually in your verdict alongside the `[SCOPE-EXPANSION-APPROVED]` stamp carrying it.
  - That stamp is emitted by the actor whose growth you are checking and is read by no check today.
  - Netting without enumeration therefore launders growth through stamps: the figure comes out small, and what was netted out of it never reaches the user.
  - Netting you did not enumerate is a `revise` reason on its own.
- **Empty named file set → SKIP the numeric leg, never zero-baseline it**: rule-fixing, research and review instructions routinely name no path, and comparing an N-file draft against a zero baseline manufactures maximal drift out of an absent comparand.
  - Take the root's named SUBJECT set instead — the artifacts, surfaces or behaviours the instruction designates by any means other than a path.
  - Report the file-count leg as `n/a — instruction named no path` and reach the drift verdict on subject fidelity alone.
- **No fetchable root → name the absence in the verdict**: root creation is honor-system and fails open silently, so an absent root is a real case rather than an anomaly.
  - Fall back to the earliest fetchable version in the chain and say in your verdict that you did, and why.
  - Do NOT quietly substitute `[SCOPE]` for the missing root — that substitution is the failure this comparand exists to remove.
- Honest backing: honor-system — nothing makes you fetch the root, and no hook can see the comparison you actually performed. The one structural property is the axis's own: the actor reading the root is not the actor that authored the growth.

### Load-bearing premise check

A standing, verdict-gating job: every cycle, without being asked, check the premises the plan's approach RESTS ON.

- **Scope**: the plan's `## Open Questions` entries marked `load-bearing: yes`, PLUS any claim you judge load-bearing that the planner did not mark.
  - The planner's marking WIDENS your list and never shrinks it, and a claim tagged `[SELF-CHECKED:]` is a self-report that earns no exemption.
  - A premise register carried in the delegation is one input and not the boundary (grammar: `rules/glass-atrium/orchestrator-role.md` → `### Phase Notes` → Scan boundary and provenance).
- **Operational test for load-bearing — POINTER, never a copy**: `scoped/scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`. One SoT, cross-read at review.
- **Attack each load-bearing premise FROM THE CODE, never from the list** — a premise about how the code behaves is settled by reading or running the code, not by re-reading the author's account of it.
  - Report each by name as `CONFIRMED` / `REFUTED` / `UNVERIFIABLE`.
  - A REFUTED load-bearing premise is a sufficient `revise` reason by itself.
  - An UNVERIFIABLE one is named rather than waved through — including a load-bearing premise whose `[SELF-CHECKED:]` tag names no instrument, which you report UNVERIFIABLE and say what instrument would settle.
  - Tag ABSENCE is not itself a finding: an untagged claim you judge load-bearing enters this ladder like any other, and how the plan is tagged is never a `revise` reason on its own (Direction, never completeness, above).
- **Recognition aid, no instrument mandate**: universal-behaviour, counterfactual, exhaustiveness/only-N and temporal-freshness claims are hypotheses by definition however densely cited — when one of them is load-bearing, say what instrument would settle it instead of reading a citation as settlement.
- Honest backing: STRUCTURAL in one respect only — the check is run by an actor other than the premise's author, the same asymmetry the scope-fidelity axis rests on.
  - The verdict CONTENT is honor-system, so do not describe it as verification of premise truth.

### Non-waiver (binding on YOU, not on the delegation)

- The standing jobs of this gate — the load-bearing premise check, the scope-fidelity axis, and every other standing job this section names — are BINDING and are NOT waivable by delegation phrasing.
- A prompt instruction narrowing the recheck ("only re-check X", "the rest is settled", "not yours to re-open") does NOT suspend them: run them anyway and NAME the narrowing instruction in your `pass`/`revise` verdict.
- **Under budget pressure, narrow the READING, never the job list**: the in-flight budget discipline in your own body governs how deep each job goes and never drops an axis or a standing job.
  - A premise you ran out of budget to settle is reported `UNVERIFIABLE` by name.
  - The narrowing itself is stated in Review Coverage Limits, as any other limit of the review is.
- Honest ceiling: honor-system and unverifiable — an actor that obeys the fence anyway leaves no trace.

## Deliverable Quantitative Evaluation (LLM-as-Judge 4 Dimensions) [QA+REPORT]

The rubric canonical — `glass-atrium-qa-code-reviewer` scores every review against it, and the bodies that self-score point back here rather than carrying a copy.

### The four dimensions

Apply to all reviews and evaluations, each scored 1-5. **Total 20 points; below 12 → recommend rework.**

| Dimension | Scores |
|---|---|
| **Coverage** | requirement coverage — breadth, depth, relevance |
| **Insight** | originality and logical depth |
| **Instruction-following** | instruction adherence accuracy |
| **Clarity** | readability and structure quality |

### Evaluator-independence posture

What a recorded `qa_score` is worth, and how far you may claim for it:

- Generator and evaluator run in SEPARATE CONTEXTS — a review is its own isolated subagent context, not the generator's.
- **Known residual, not eliminated**: the LLM judge is the SAME MODEL FAMILY as the generators, with no cross-vendor or external-judge layer, so same-model self-preference bias survives.
- **Partial mitigation**: the deterministic Code-Based grader emitting `grader_verdict` is independent of model judgment, and this rubric is the Model-Based tier stacked above it — its column semantics live in Tier-1 `core-outcome-record.md` → Field Input Guide.
- **What the mitigation does not close**: the semantic dimensions only the LLM judge can score — Coverage / Insight / Instruction-following / Clarity, and the d8 visual axes.
- Report these scores as same-family self-assessment carrying that residual, weighted below the deterministic grader — never as an independent measurement.

### Designer deliverable rubric routing

When the artifact under review is designer-authored (philosophy / canvas / motion-philosophy / DESIGN.md), this 4-Dim rubric is the **external-judge rubric**.

- The designer's internal **Design Evaluation 4-Axis** (Identity / Originality / Craft / Function — `agents/glass-atrium-design-designer.md` → `## Design Evaluation 4-Axis (1-5 each, 20 total)`) is that agent's domain self-rubric for its own iteration, and is not yours to apply.
- Both are 20-point scales with a <12 rework threshold, so the outcome-record signal stays comparable across them.

## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]

Fires on a user-requested HTML primary deliverable only — the skip list is in your own body's template notes.

### Rubric

- Append **5th dimension `d8`** (1-5) to the four dimensions above. The schema is an extension, NOT a replacement.
- `d8` is a single rollup of three semantic axes:

| Axis | Bar |
|---|---|
| **dual-encoding** | color + symbol/text dual-encoding (color-blind safety) |
| **WCAG-AA contrast** | text 4.5:1 / UI 3:1 |
| **typography-levels** | ≤3 levels: H1/H2/Body + Pretendard for Korean |

- Scale: 1 = many critical violations · 2 = many violations · 3 = minor violations · 4 = mostly compliant · 5 = fully compliant.

### Mechanical / semantic split

The corpus's veto lines name these five invariants by `P`-label and define them nowhere else; this table is what makes those references resolve.

| Label | Invariant | Gate | Yours to score |
|---|---|---|---|
| P1 | dual-encoding (color-blind safety) | semantic LLM-as-judge — this sub-pass | yes |
| P2 | comparison-table column cap | html-validator / sanitize, deterministic | no |
| P3 | sandbox-safe interactivity (CSP) | html-validator / sanitize, deterministic | no |
| P4 | WCAG-AA contrast | semantic LLM-as-judge — this sub-pass | yes |
| P5 | typography-levels | semantic LLM-as-judge — this sub-pass | yes |

- You score the three semantic axes; the two mechanical ones are decided outside your scope by the deterministic gate.

### Threshold SoT

- The canonical D8 numeric thresholds (comparison-table column cap · WCAG contrast · typography levels) live in `monitor/src/server/clauded-docs/d8-thresholds.json`, which the server `JSON.parse`-loads at module init.
- Any literal quoted in prose — the axis bars above included — is a documented MIRROR, so do NOT raise a finding against a prose number or treat one as the source.

## Regression Risk Estimation [QA]

On every code review, tag the change with a regression-risk label and carry it on the `Regression Risk` line of your review output:

| Label | Triggers |
|---|---|
| **High** | core business logic changed AND no test added · an existing test was removed · the added test cannot fail |
| **Med** | non-core change covered by existing tests |
| **Low** | config / docs / non-executable artifact only |

- A test that cannot fail counts as NO test added (`scoped/shared-testing.md` → `### Meaningless-Test Prohibitions`).
- State in one line the relationship the added test asserts. Unable to state it → treat it as no test added.
- **High** → list the affected test paths in the review output, so the orchestrator can route the next-step verification correctly.
