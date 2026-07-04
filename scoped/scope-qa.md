# QA Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-qa-code-reviewer, glass-atrium-qa-debugger}
> **Inherits**: Tier 1 (Core) + shared-comment-logging.md (Tier 3 partial)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to QA agents: glass-atrium-qa-code-reviewer, glass-atrium-qa-debugger.

## Sprint Contract Gate [DEV+QA]

> Full details: See `scope-dev.md` Sprint Contract Gate section (Evaluator pre-defines acceptance criteria before complex tasks; simple tasks exempt)

## Plan Direction Verification Gate [DEV+QA]

**Boundary (read first)**: Sprint Contract Gate = glass-atrium-qa-code-reviewer **PRE-defines** acceptance criteria (before work starts) · Plan Direction Verification Gate = the team **POST-verifies** an authored plan (after planning, before implementation). These are distinct gates — do not conflate.

> Full details: See `scope-dev.md` "Plan Direction Verification Gate" section (canonical SoT — DEV participation duty + hard-gate rule + revision flow)

- glass-atrium-qa-code-reviewer is the QA-side participant: on a complex authored plan, judge **implementation-feasibility + test-feasibility** and emit `pass` / `revise` + concrete unmet items (the DEV participant judges technical validity in parallel — see canonical).
- Gate operation (trigger · team composition · DEV specialist selection · escalation): `orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`.
- **Ultracode enforcement note**: under ultracode the `enforce-verification-gate.sh` hook is BYPASSED for engine `agent()` spawns — the in-script verify-stage is the SOLE enforcement (no hook backstop). See `orchestrator-role.md` → `### Ultracode / Workflow-tool Mode` (canonical).

## Deliverable Quantitative Evaluation (LLM-as-Judge 4 Dimensions) [QA+REPORT]

> Rationale: Custom evaluation dimensions inspired by G-Eval, DeepResearchGym, and other LLM-judge frameworks

> Cross-ref: the `core-outcome-record.md` Field Input Guide `metric_pass` row's per-task-type deterministic check matrix operates as the Code-Based grader tier — author-side outcomes only (infra attribution failures out-of-scope) · this 4-Dim LLM-as-Judge stacks on top of it as the Model-Based grader tier

> Evaluator-independence posture (honest framing — no overclaim): generator and evaluator run in SEPARATE CONTEXTS (the glass-atrium-qa-code-reviewer review is its own isolated subagent context, not the generator's) — this is a real separation. BUT the LLM judge is the SAME MODEL FAMILY as the generators, with NO cross-vendor / external-judge layer — so same-model self-preference bias is a KNOWN RESIDUAL, not eliminated. The deterministic Code-Based grader (`track-outcome.sh` `metric_pass`) PARTIALLY MITIGATES this — its verdict is independent of model judgment and overrides a contradicting writer self-report — but it does NOT close the gap for the semantic dimensions only the LLM judge can score (Coverage / Insight / Instruction-following / Clarity, and the d8 visual axes). This evaluation is therefore NOT fully independent; treat the 4-Dim scores as same-family self-assessment with a residual bias, weighted below the deterministic grader.

- Apply 4-dimension quantitative scores to all reviews/evaluations (each 1-5):
  - **Coverage**: Requirement coverage (breadth, depth, relevance)
  - **Insight**: Originality and logical depth
  - **Instruction-following**: Instruction adherence accuracy
  - **Clarity**: Readability and structure quality
- Total 20 points; below 12 → recommend rework
- Score trends recorded in Outcome Record → input source for learning-log
- **Gradient localization**: when any dimension scores below 3 → output a one-line localization statement identifying which requirement / which file section / which logic branch is below threshold. Do NOT write code or propose fixes — locate only.
- **Designer deliverable rubric routing**: when reviewing designer-authored deliverables (philosophy / canvas / motion-philosophy / DESIGN.md), scope-qa 4-Dim applies as the **external-judge rubric** (glass-atrium-qa-code-reviewer / glass-atrium-qa-debugger scope). Designer's internal **Design Evaluation 4-Axis** (Identity / Originality / Craft / Function — see `~/.claude/agents/glass-atrium-design-designer.md` `## Design Evaluation 4-Axis`) is preserved as **domain self-rubric** for glass-atrium-design-designer self-iteration and is NOT in glass-atrium-qa-code-reviewer scope. Both rubrics are 20-point scale with <12 rework threshold — totals align for outcome-record signal compatibility. When glass-atrium-design-designer output is an HTML primary deliverable, the d8 visual sub-pass (next section) ALSO applies.

## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]

> Applies to every HTML primary deliverable — i.e. any deliverable emitted as user-requested HTML (per `scope-report.md` / `scope-planning.md` Output Format Routing request-driven model). Skip for: agent-only token-optimized records (md/yaml/json/txt fallback · viewer default-hidden), code reviews (TS/Python/Shell source), other non-HTML artifacts.

- Append **5th dimension `d8`** (1-5) to existing 4-dim rubric (Coverage / Insight / Instruction-following / Clarity). Schema = extension, NOT replacement — 4-dim canonical rubric preserved · legacy-parser backward compatibility retained.
- **d8 rubric (single 1-5)**: Combined visual quality rollup of 3 semantic axes — **dual-encoding** (color + symbol/text dual-encoding — color-blind safety) + **WCAG-AA contrast** (text 4.5:1 / UI 3:1 — SoT: d8-thresholds.json) + **typography-levels** (≤3 levels — H1/H2/Body + Pretendard for Korean — SoT: d8-thresholds.json). 1=many critical violations · 2=many violations · 3=minor violations · 4=mostly compliant · 5=fully compliant.
- **Pass threshold (AND)**: 4-dim sum ≥ 12 AND `d8` ≥ 3 → pass · failing either one → rework
- **Localization on d8 < 3**: identify in one line which visual axis falls short (dual-encoding missing / contrast below threshold / typography monotone) · list all when multiple axes fall short · writing/modifying code or naming specific APIs FORBIDDEN (locate only — aligns with the parent Gradient localization)
- **qa_score record format**: `cov=N,ins=N,instr=N,clar=N,d8=N` (5th field — a legacy parser that only recognizes the 4-dim form still works correctly)
- **Mechanical / semantic split**: column-cap (≤5 columns — SoT: d8-thresholds.json) + sandbox-safe interactivity (CSP) → html-validator / sanitize automatic gate (deterministic · outside glass-atrium-qa-code-reviewer scope) · dual-encoding / WCAG-AA contrast / typography-levels → this sub-pass (semantic LLM-as-judge · within glass-atrium-qa-code-reviewer scope)
- **Threshold SoT**: canonical D8 numeric thresholds (comparison-table maxColumns / WCAG contrast / typography levels) live in `monitor/src/server/clauded-docs/d8-thresholds.json` — server-enforced source-of-truth (code `JSON.parse`-loads it at module init). The literals quoted above are a documented MIRROR synced at review time — do NOT treat the prose number as the source · changing a prose number without updating the JSON FORBIDDEN.

## HTML Primary Doc Anchoring [QA]

When reviewing HTML primary deliverables (user-requested HTML per `scope-report.md` / `scope-planning.md` Output Format Routing), cite findings by section anchor — not line number:
- Prefer `<section id="...">` id when present (stable across HTML re-rendering)
- Fallback: heading text exact match (e.g., `# Self-Evaluation`)
- Cross-reference Markdown companion is no longer applicable for HTML primary deliverables — no MD companion is generated. Primary review target = HTML payload (monitor-internal root) via `<section id>` anchor citation. The wiki domain is a permanent exception to this policy (the wiki is an Atrium-internal, git-ignored, LLM-only markdown store at `~/.glass-atrium/wiki/` managed by the wiki daemon — see `scope-wiki.md`).

## Regression Risk Estimation [QA]

On every code review, tag the change with a regression-risk label:
- **High** — core business logic changed AND no test added; OR removed an existing test
- **Med** — non-core change covered by existing tests
- **Low** — config / docs / non-executable artifact only

High-risk reviews MUST list the affected test paths in the review output, so the orchestrator can route the next-step verification correctly.

## Workflow Log Preservation (Process Trace) [QA]

- glass-atrium-qa-code-reviewer reviews process logs in addition to deliverables
- Logs older than 30 days → Summarize and move to `memory/qa-log-archive/YYYY-MM/`; delete originals after the move completes.
