# Outcome Record Rules (Cross-Cutting Concern)

Applies to all agents. [ALL]

## Core

- Every completed task records its result, whatever that result is; for a team, the orchestrator consolidates the records.
- **Location**: PostgreSQL `core.outcomes`, a DB-only sink written via `_pg_outcome_dualwrite.py`. Its `body_md` column carries the full markdown body, which the renderer CLI re-synthesizes to frontmatter.
  - Per-outcome `.md` files under `~/.claude/data/outcomes/` are RETIRED — no longer written or read.
- **Required fields**: `agent` · `task_type` · `result`.
- **Session-end fallback**: if no Outcome Record exists at session end, record at least the required fields.
- **Record-side names**: the record stores the template's `files` as `files_modified`, and `cid` both as `cid` and as `correlation_id`; `metric_type` shares the 9-type task_type value set.

### task_type set (canonical 9-type contract — SoT)

- A writer picks only within its role's allowlist (`### Role → Allowed task_types`).

| task_type | Class | Means |
|-----------|-------|-------|
| `bug-fix` | code | failing test → passing test code change |
| `feature` | code | new-capability code change; a new test is expected |
| `refactor` | code | behavior-preserving code change |
| `research` | evidence | investigation synthesizing cited sources |
| `plan` | evidence | direction-only plan: goal, chosen direction, work streams in execution order |
| `review` | non-code | code, design or security review verdict; no code change authored |
| `diagnosis` | non-code | root-cause analysis without code change — read-only by role, so it never writes tests |
| `doc` | non-code | document, report, plan-doc, wiki or design-doc deliverable |
| `cleanup` | non-code | config, import or dependency hygiene with no test obligation; also prompt compression |

### Role → Allowed task_types

- Each agent self-selects ONLY within its role's allowlist; no agent is instructed to emit a task_type its role cannot satisfy.
- This table is the single authority that `guess_task_type`, the grader's unknown-case branch and the dual-write `_norm_task_type` helper MUST agree on — divergence is a defect.

| Agent role | Allowed task_types |
|------------|--------------------|
| DEV agents (dev-*) | `bug-fix`, `feature`, `refactor`, `cleanup`, `research`, `plan` |
| glass-atrium-qa-code-reviewer | `review` |
| glass-atrium-qa-debugger | `diagnosis` (read-only by role — can NEVER author tests, so NEVER `bug-fix`) |
| glass-atrium-intel-planner | `plan`, `doc` |
| glass-atrium-intel-reporter | `doc` |
| glass-atrium-wiki-curator | `doc` |
| glass-atrium-design-designer | `doc`, `review` (design-review maps to `review`) |
| glass-atrium-sec-guard | `review`, `diagnosis` (verdict-only) |
| glass-atrium-meta-prompt-engineer | `doc`, `cleanup`; plus code-adjacent `refactor` ONLY when it edits prompt/code files |

### result values

| Value | Selected when | Routing |
|-------|---------------|---------|
| `done` | per the Result-selection criterion below | — |
| `done_with_concerns` | the one state the Result-selection criterion below names | review needed → `concerns:` field |
| `blocked` | a technical impediment stops the work | escalation target |
| `needs_context` | information is insufficient | user response needed — not an escalation target |
| `fail` | the task failed | glass-atrium-qa-debugger escalation target |

- **Circuit breaker**: `fail` is the ONLY value that accrues the per-agent counter — 3 consecutive writes a suspension signal. Any other value, `blocked` included, resets it.
- **Survival packet**: a `blocked` row's CID is carried into the pre-compact survival packet as active; a `fail` row's is not.

### Whose outcome `result` describes

- `result` reports the emitting agent's OWN task outcome.
- A verdict, diagnosis, or finding ABOUT another artifact is deliverable content, and is never by itself a reason to downgrade.
- A caveat about the agent's own work goes in `concerns:` on WHATEVER result the criterion below yields.
- Disclosing a caveat stays mandatory; only the result value is gated.

### Result-selection criterion (binding)

| State of the agent's OWN tasked deliverable | Selects |
|---------------------------------------------|---------|
| incomplete, unverified beyond its sanctioned role/constraint envelope, or left needing follow-up action | `done_with_concerns` — ONLY this state selects it |
| complete and verified, the only caveats being role-inherent limits, user-instructed deferrals, scope-external observations or deviation disclosures | `done` |

- Role-inherent limit, for example: a read-only role that structurally never runs checks.

## Completion Report Output Obligation

A completion that meets `### Emit Boundary` → Mandatory MUST end with the block below; `track-outcome.sh` parses it into the Outcome Record. Per-field criteria: `### Field Input Guide`.

- **Mandate scope**: which channel backs the MUST, and where the block goes — `### Emit Boundary` → Channel asymmetry.

```
[COMPLETION]
result: done|done_with_concerns|blocked|needs_context|fail
task_type: bug-fix|feature|refactor|research|plan|review|diagnosis|doc|cleanup  # self-select WITHIN your role allowlist (Role → Allowed task_types table)
metric_pass: true|false                                  # REQUIRED, blank forbidden; writer self-report — grader NEVER overwrites it
confidence: high|medium|low                              # REQUIRED, blank forbidden
revision_count: 0                                        # OPTIONAL, integer (default 0); set to N when user requested rework N times
evaluative_signal: 0                                     # OPTIONAL, -1|0|+1; emit -1 when the user corrected/rejected/asked-to-redo this work
directive_hint: one-line distilled English summary       # OPTIONAL, emit ONLY with evaluative_signal:-1; distilled (never verbatim), English-only
files: changed_file1, changed_file2                      # omit if no file changes
summary: 1-line summary                                  # REQUIRED
concerns: condition1, condition2                         # OPTIONAL, valid on ANY result — one item per condition; on done rows it carries caveats that do NOT meet the done_with_concerns criterion
lesson: discovered pattern or know-how (1-2 sentences)   # RECOMMENDED, core signal for AutoAgent self-improvement loop
token_usage: input=N, output=N                           # OPTIONAL, OTel gen_ai.usage.* mapping
agent_version: 1.0.0                                     # OPTIONAL, instruction-version tracking
qa_score: cov=N,ins=N,instr=N,clar=N                     # OPTIONAL, QA review only — coverage/insight/instruction-following/clarity (each 1-5)
style_ref: relative/path/to/sibling.ts                   # OPTIONAL, populated by Project Convention Probe — see Field Input Guide
confidence_observed: 0.0-1.0                             # OPTIONAL, daemon-populated empirical posterior — writer does NOT fill; see Field Input Guide
grader_verdict: verified_pass|unverified|verified_fail   # OPTIONAL, grader-populated — writer does NOT fill; advisory, never overwrites metric_pass
downgrade_origin: writer_true_downgraded|writer_false|synthesized  # OPTIONAL, grader-populated — writer does NOT fill; see Field Input Guide
cid: correlation_id from orchestrator                    # OPTIONAL, omit if not delegated
[/COMPLETION]
```

- **Spawn-injected copy**: `hooks/inject-scope-rules.sh` → `build_emit_format_block` restates the multi-line mandate, the inline-tolerance rule and the schema-mode `completion_block` rule as a shell `printf` literal delivered to every subagent.
  - An edit to those rules reaches a running agent only once that literal is edited too.
  - **Honest backing — MANUAL, unenforced.** No test or hook compares the two; `hooks/test/inject-scope-rules-nodrop.bats` pins only the needle `REQUIRED by the outcome recorder`. Why that block stays a literal is stated at the function.
- **Multi-line form**: emit the block EXACTLY as templated — the `[COMPLETION]` tag ALONE on its own line, EACH field on its own line, closed by `[/COMPLETION]` ALONE on its own line — on EVERY emit (subagent, schema-mode, main session). The inline single-line form is NOT sanctioned.
  - **Schema-mode / workflow (`agent({schema})`)**: spawns MUST put the multi-line form in the StructuredOutput payload's `completion_block` string property. The engine consumes ONLY the StructuredOutput call, so a printed text turn is not recorded.
    - `track-outcome.sh` recovers that property from the terminal StructuredOutput input as WRITER-emitted (attribution `structuredoutput-completion`, a healthy row); absent or unparseable → `structuredoutput-derived` synthesis (`### Recorder parse outcomes`).
    - Whether a schema reserves the property is settled at authoring time — Workflow pre-flight item 8 (`skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode`). `hooks/enforce-workflow-verify-stage.sh` checks the declaration, advisory only; whether the property is filled is unchecked.
- **Correction-emission rule (agent owns the boolean "a correction happened")**: when the user's latest message corrected, rejected, or asked to redo this work — judged SEMANTICALLY in ANY language — the agent MUST emit all three: `revision_count` ≥ 1 + `evaluative_signal: -1` + `directive_hint: <one-line distilled English summary>`.
  - The three are the TRIGGER that populates `core.correction_signals`; what each value means, including which values are not a correction, is in `### Field Input Guide`.
  - **Omitting `directive_hint` is a lesson-less correction**: `evaluative_signal: -1` without it makes `track-outcome.sh` raise an aggregation-visible `review_flag` plus a 1-line stderr note. The recorder NEVER distills the hint from the user message, so it MUST come from your own emit.
  - A request that only resumes or pushes the SAME work forward MUST NOT emit the three fields, e.g. `진행해` / `이어서 진행해` / `계속` / `다시 이어서` / `resume` / `continue` / `try again to continue` / a status check.
    - It is an episodic one-off signal (`core-learning-log.md` → Correction Signal Capture), not a correction of the work's content.
- **`## Summary` section**: `track-outcome.sh` copies the `summary` field into the record body's required `## Summary` section, so fill `summary` faithfully.

### Recorder parse outcomes

What `track-outcome.sh` records for each emit shape.

| Emit shape | Recorded as |
|------------|-------------|
| multi-line block closed by `[/COMPLETION]` | writer-parsed row |
| block opened, closing sentinel missing | `parse_tier=2`, `truncated_completion` — writer-parsed, fields kept; attribution degrades to a truncation signal |
| inline single-line with ≥1 core field | `parse_tier=1` via the inline tolerance tier — fields preserved |
| no core field, or no block after ≥1 tool_use | synthesized: `done_with_concerns` / `confidence=low` / `metric_pass=false`, guessed `task_type` |
| schema-mode run whose terminal StructuredOutput was consumed, `completion_block` unusable | `structuredoutput-derived` synthesis: `result=done`, NOT `done_with_concerns` — still `confidence=low` / `metric_pass=false` / lesson-absent, writer-unverified |

- **Inline single-line emit (not sanctioned above) — what the recorder does with one**: the one-line form (`[COMPLETION] result: done | task_type: … | metric_pass: …` — pipe/middot-delimited, no newline after the tag, no closing sentinel) misses the multi-line tiers, which anchor on the `[COMPLETION]\n` boundary.
  - A tolerance tier tried only after they miss recovers it: a line-anchored regex plus a guard requiring ≥1 of {result, task_type, metric_pass, confidence, summary}, with complete-block semantics.
- **Unparseable emit → synthesized**: e.g. prose merely mentioning `[COMPLETION]` with a stray delimiter. `task_type` is keyword-guessed (reduced accuracy); the attribution is `completion-synthesized` or `budget-truncation`.

### Emit Boundary (Mandatory / Exempt / Gray-zone)

Emit on the terminal turn only: an every-turn emit is noise, and a skipped emit loses the learning signal.

- **Mandatory**: 1+ `tool_use` occurred AND it contributed to a deliverable → file write/edit · code change · research synthesis · document creation · decision artifact · externally observable state change · referenceable output
- **Exempt**: conversation only (0 tool_use) · context-gathering-only tool_use (e.g. a single Read with no downstream artifact) · mid-task status/heartbeat · clarification question / simple confirmation
- **Gray-zone**: ambiguous → emit; a false-positive emit costs less than a false-negative non-emit
- **Hook safety net**: `hooks/track-outcome.sh` skips exempt turns itself (`attribution_source="conversation-only"`), so emit accurately on the mandatory condition and do nothing extra for exempt turns
- **Closing-turn discipline (prevention layer)**: emit the `[COMPLETION]` block as the run's terminal act — never end the run on a tool-result turn assuming the work is done.
  - MANUAL / TEXT mode → a DEDICATED FINAL assistant text turn carrying the block, after the last tool action.
  - SCHEMA / WORKFLOW mode → the block travels in `completion_block` and the StructuredOutput call stays the LAST action; a schema-mode run never ends on prose (`GLASS_ATRIUM_GLOBAL_RULES.md` → `### Turn Budget & Graceful Exit`).
  - The SubagentStop transcript-synthesis net is the deterministic backstop; this discipline is its prevention complement.
- **Channel asymmetry (subagent vs. main/orchestrator) — the block is a MACHINE-FACING record artifact, not user-facing prose**:
  - Subagent: its final message returns to the orchestrator as a user-invisible tool result — emit the raw block there UNCHANGED. `track-outcome.sh` records it on SubagentStop, or synthesizes on omission, so this MUST is mechanically backed.
  - Main / orchestrator session: its final message IS user-visible, so it MUST NOT print the raw block — summarize outcomes in prose. No Stop-channel recorder is wired for it, so its emit duty is honor-system.

### Field Input Guide

| Field | Required | Blank fallback | Filled by |
|-------|----------|----------------|-----------|
| `confidence` | Yes | `low` | writer |
| `metric_pass` | Yes | `false` | writer |
| `grader_verdict` | No | omit — absent means not yet graded | grader |
| `downgrade_origin` | No | omit | grader |
| `confidence_observed` | No | omit — empty is valid, not a `review_flag` trigger | daemon |
| `concerns` | No — valid on any result | omit — absent is an empty array | writer |
| `lesson` | Recommended | omit | writer |
| `revision_count` | No — integer | `0` | writer |
| `evaluative_signal` | No — `-1`/`0`/`+1` | omit | writer |
| `directive_hint` | No — only with `evaluative_signal: -1` | omit | writer |
| `token_usage` | No | omit | writer |
| `agent_version` | No | omit | writer |
| `qa_score` | No — QA review only | omit | writer |
| `style_ref` | No | see `#### Role-scoped fields` → `style_ref` | writer |

#### Self-assessment fields

| `confidence` | Means |
|--------------|-------|
| `high` | all steps verified, expected behavior, no side effects |
| `medium` | core works; some edge cases unverified or worked around |
| `low` | guess-based, or only partially working |

- **`metric_pass`**: your honest claim that the task_type's bar below was met — AUTHORITATIVE for its own column.
  - The grader NEVER force-overwrites it: its view goes to `grader_verdict` (advisory), provenance to `downgrade_origin`, and a disagreement surfaces through `review_flag`.

| task_type | Bar for `metric_pass=true` |
|-----------|----------------------------|
| `bug-fix` | failing test → passing test, exit code 0 required |
| `feature` | a test observed to FAIL before the implementation existed now passes, and the full suite passes |
| `refactor` | behavior unchanged + existing test suite passes |
| `research` | 3+ sources cited with cross-verification |
| `plan` | goal + chosen direction and why + work streams in execution order, each naming its files + an Open Questions section |
| `review` / `diagnosis` / `doc` / `cleanup` | no test bar — the verdict, diagnosis, document or hygiene change was produced |

- `feature`: a test confirmed to fail by deliberately breaking the implementation also qualifies; a test file merely added is NOT the bar.
- `plan`: an empty Open Questions section is valid.
  - A dependency DAG, per-task acceptance criteria or any other exhaustive structure joins the bar ONLY when the user asked for that kind of deliverable (spec · PRD · ADR · roadmap) or for that structure by name.
- **Blank value policy**: a blank `confidence` or `metric_pass` degrades the learning signal — when judgment is impossible, write `low` / `false` explicitly.

#### Grader verdict

- **Grader tier**: the Code-Based deterministic grader covers author-side outcomes only; infra attribution failures are out of scope.
  - Model-Based (LLM-as-Judge) and Human-Based (`done_with_concerns` escalation) layers stack on top via `track-outcome.sh`.
- **`grader_verdict`**: a deterministic 3-state signal computed by `track-outcome.sh`, in a SEPARATE column from `metric_pass`.
- **Input-surface invariant**: the grader reads ONLY the `[COMPLETION]` block text, its `files:` paths and the emitting session's OWN Write/Edit history.
  - `hooks/lib/code-based-grader.sh` mirrors this surface; the two MUST NOT drift.
  - That history corroborates AUTHORSHIP of paths the block already declares; it is never deliverable evidence by itself.
  - The off-surface deliverable is invisible to it — a plan or research doc lives in `monitor.ClaudedDoc`, a diff or test file in the repo.
  - So a verdict keys ONLY on block-resident structured signal, and ABSENCE of an off-surface artifact is NOT failure evidence.
- **Structured fields only**: gate every check on a structured field; magic-phrase prose is FORBIDDEN as a pass/fail signal.

| task_type | Grader behavior |
|-----------|-----------------|
| `bug-fix` | an EXISTING test/spec file path in `files:` → `verified_pass`; absent → `unverified`, NOT fail |
| `feature` | a test/spec file path in `files:` → `verified_pass`; absent or empty `files:` → `unverified`, NOT fail |
| `refactor` | `unverified` by default — no block-resident structured signal exists for "behavior preserved" |
| `plan` / `research` | `unverified` by task_type alone — markers (`## Open Questions`, `Sources:`, cited URLs) live in the doc |
| `review` / `diagnosis` / `doc` / `cleanup` | explicit skip → `unverified` — no test artifact expected |

- `refactor`: free text such as `existing tests pass` / `no behavioral change` is NOT a valid signal (Gaming-the-Judge avoidance).
- **`verified_fail` has two emitters**, each marked at its site in `hooks/lib/code-based-grader.sh`: `VERIFIED_FAIL_EMITTER: LLM09 zero-evidence guard` · `VERIFIED_FAIL_EMITTER: total transcript-authorship contradiction`.
  - Machine-checked: `hooks/test/emit-discipline-doc-consistency.bats` (its two `EMITTER` tests) matches this file's marker count and both names to the grader source — never reword, drop or add a mention without the same edit there.
- **LLM09 misinformation guard**: `result=done` + `metric_pass=true` + ZERO deliverable evidence of any kind (no `files:`, no sources, no block body) → `grader_verdict=verified_fail` + `review_flag=true`, still advisory.
  - The mere absence of a document heading is not zero evidence.
- **Transcript write cross-check (code types only)**: the `files:` paths of a promotable `bug-fix`/`feature` row are compared against the session's own Write/Edit history.

| Cross-check outcome | Verdict |
|---------------------|---------|
| TOTAL mismatch — every path-shaped entry absent from a NON-EMPTY history, zero matched | `verified_fail` — the fabrication signal |
| PARTIAL mismatch — ≥1 unmatched WITH ≥1 matched | promotion withheld → `unverified` |
| EMPTY write history | withheld → `unverified` |
| unverifiable OR unwired scan | withheld → `unverified` |
| ARTIFACT-ONLY — every path-shaped entry is a recognized tool-generated artifact | withheld → `unverified`, never a promotion |

- PARTIAL: a tool-generated sibling (manifest / migration / snapshot) is a collector blind spot, not demonstrated absence.
- EMPTY: an empty history cannot DEMONSTRATE absence — Write/Edit is blind to Bash-authored writes.
- **Neither matched nor unmatched**: non-path-shaped prose entries, and recognized tool-generated artifacts — a CLOSED two-shape set: basename exactly `manifest.json`, or a path under the live install root `$HOME/.glass-atrium/`.
  - Those artifacts are written through a regeneration script or the sanctioned updater seam, invisible to the Write/Edit collector — so such an entry rescues no contradiction and blocks no otherwise-verified row.

#### Grader and daemon provenance

- **`downgrade_origin`**: how the graded outcome arose, recorded beside `grader_verdict`.

| `downgrade_origin` | Means |
|--------------------|-------|
| `writer_true_downgraded` | writer claimed `metric_pass=true`; the grader returned `verified_fail`/`unverified` — logged, never force-flipped |
| `writer_false` | writer self-reported `metric_pass=false` — an honest negative |
| `synthesized` | assembled by the SubagentStop transcript-synthesis backstop — no writer-emitted block |

- **`confidence_observed`**: a Beta-Binomial posterior mean (float `0.0`-`1.0`) the daemon computes from the empirical tuple `revision_count` + `result` + `evaluative_signal`.
  - It corrects the systematically inflated writer `confidence` enum and is NOT the same field.
  - Backing: its storage column is the `core.autoagent_proposals` per-pattern aggregate; the parser only recognizes the field passively and does not persist it yet, so an absent value is silently ignored.

#### Correction fields

- **`revision_count`**: N = the times the user asked to rework this same task (first try complete = 0). Missing or non-integer → `track-outcome.sh` falls back to 0.
  - Your emitted value is the effective count: the hook's prior+1 cross-outcome accumulation is STUBBED to 0 until a project-keyed PG restoration lands.
  - Why: DB-only tracking has no cwd/project key, so a same-task_type prior lookup would miscount another project's correction.
- **`evaluative_signal`**: `-1` ONLY on a correction (Correction-emission rule) · `+1` explicit praise or acceptance · `0` an explicitly neutral signal · no signal → omit the field.
  - Absent and `0` are DISTINCT — the parser preserves the raw value, so never collapse `0`↔absent.
  - `+1`/`0` MUST NOT trigger a correction signal — any one of `revision_count` ≥ 1, `evaluative_signal: -1` or a non-empty `directive_hint` trips it.
- **`directive_hint`**: one DISTILLED English line naming what the user wanted changed — NEVER raw verbatim, never a transcript quote (e.g. `User wanted the API gate moved, not the regex removed`).
  - A stray `directive_hint` without `evaluative_signal: -1` still trips the correction trigger, so emit it only on an actual correction.

#### Content fields

- **`concerns`**: one item per condition, comma-separated — the same array shape as `files:`, since the recorder splits on commas.
  - On a `done_with_concerns` row the caveat goes HERE rather than into `summary` — the structured per-item column an operator filters, counts and clusters on.
  - No quality bar and no length expectation: a rough entry beats an empty column. Filling it never changes `result` (``### Whose outcome `result` describes``).
  - Recorder: `track-outcome.sh` copies the value into the record's `## Concerns` section, reads that section back when a `done_with_concerns` row has no `concerns:` line, and clamps the stored value to 800 chars.
- **`lesson`**: 1-2 sentences of discovery that saves time on future tasks (e.g. "X must go through Y — direct call forbidden") — the core signal the AutoAgent self-improvement loop learns from.
- **`token_usage`**: record when cost tracking is needed; pairs with OTel `gen_ai.usage.*` for external integration.
- **`agent_version`**: the instruction file version (e.g. from frontmatter), enabling before/after performance comparison across instruction edits.

#### Role-scoped fields

- **`qa_score`**: format `cov=N,ins=N,instr=N,clar=N`, each 1-5 — reserved for QA agents (glass-atrium-qa-code-reviewer / glass-atrium-qa-debugger) reviewing other agents' outputs.
  - It rates the REVIEWED artifact and never selects the reviewer's own `result`, which follows the Result-selection criterion alone.
  - A self-emitted Model-Based signal, NOT a deterministic verdict: the LLM evaluator's own score, layered ABOVE the Code-Based grader, never overriding `metric_pass`.
  - What a low sum obliges the reviewer to do, and the evaluator-independence caveat: `scope-qa.md` → "Deliverable Quantitative Evaluation".
- **`style_ref`**: the relative path of the sibling file used as convention reference — MUST be a path you actually read this turn.
  - Read during: Project Convention Probe (`scope-dev.md` → Pre-Execution Verification → Project Convention Probe) or Step 2 Read (`shared-search-first.md` → Pattern recognition → Step 2 Read / Step 3 Mirror).
  - **Greenfield** (no sibling in the first-touch directory AND no AGENTS.md/CLAUDE.md anchor) → emit the literal `style_ref: greenfield` AND declare `convention: greenfield` in the turn-0 Assumptions line.
  - **Omission** on a non-greenfield row → `review_flag: true`. Parser logic: `~/.glass-atrium/hooks/lib/style-ref-consts.sh::style_ref_compute_review_flag`, whose task_type allowlist is the single SoT for the production hook and its Bats test.
  - **Corroboration**: on SubagentStop `track-outcome.sh` checks the value against the transcript's `Read` tool_use history and records `style_ref_verified`.
    - `true` = corroborated in that history · `null` = greenfield or absent, verification N/A.
    - `false` = NOT corroborated through the `Read` channel — a coverage fact, never an honesty verdict: a Bash/Grep/Glob read carries no `file_path`, and a session with no `Read` calls corroborates nothing.
  - **Mandatory graduation** is a separate future cycle requiring user approval, gated by `styleRefGradeBadgeI` in `monitor/public/src/screens/improvement.jsx`: emission ≥ 50% AND the uncorroborated share of the ADJUDICATED subset < 10% across the DEV agents.
    - Adjudicated = corroborated + uncorroborated, never eligible — an eligible denominator could be passed by widening the blind spot.
    - Publish corroborated / uncorroborated / unverifiable as three counts, not one derived rate that reads as an honesty verdict.

## Automatic Verification Criteria

> See also: `shared-testing.md` → Mechanical Success Metrics.

**Mismatch Review Trigger**: any row below auto-tags the Outcome Record `review_flag: true`, the learning-aggregator signal.

| Trigger | Condition |
|---------|-----------|
| Polar mismatch (overconfidence) | `confidence=high` + `metric_pass=false` |
| Polar mismatch (underconfidence) | `confidence=low` + `metric_pass=true` |
| Empty signal | `metric_pass` empty, any `confidence` |
| Grader disagreement (advisory) | `metric_pass=true` + `grader_verdict=verified_fail`; `downgrade_origin=writer_true_downgraded` records it |

- `review_flag` feeds learning-log aggregation only — it never rewrites `metric_pass`.
- **Empty signal**: a missing self-assessment is read as instruction ambiguity, not an evaluation failure, and is still a learning target.
- **Grader disagreement fires narrowly**: only the two `verified_fail` emitters in `### Field Input Guide` → `grader_verdict` reach it.
- **`grader_verdict=unverified` is NOT a mismatch and does NOT set `review_flag`** — this covers the non-code types and every off-surface or absent-signal code-type row.
