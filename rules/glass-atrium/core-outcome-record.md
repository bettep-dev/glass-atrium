# Outcome Record Rules (Cross-Cutting Concern)

Applies to all agents. [ALL]

## Core

- Every completed task records its outcome, success or not; the recorder stores it in PostgreSQL `core.outcomes`.
  - An Outcome Record is never a `.md` file: agents write and read none under the outcomes directory (`~/.glass-atrium/data/outcomes/`, which `hooks/post-edit-outcome-sync.sh` still syncs).
- **Lesson-free read**: every agent and main session reads prior Outcome Records only through this command — the search listing, with the `lesson` key deleted from every row before any output reaches the reader:

  ```
  curl -sSf "http://127.0.0.1:$(bash -c '. "${GA_ROOT:-$HOME/.glass-atrium}/scripts/lib/atrium-config.sh" && atrium_monitor_port')/api/outcomes/search?limit=20" | jq 'del(.rows[].lesson)'
  ```

  - To narrow it, change only the query string (e.g. `agent=<name>`, `days=7|30|90`); keep the `jq` stage exactly as written.
  - Never read a record through `/api/outcomes/<id>` or its body: both return `lesson` in full.
  - Why: `lesson` is the writer's own unverified advice; result, summary, concerns, revision count and review flags are the facts a read needs.

### task_type set (canonical 9-type contract — SoT)

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

- Each agent self-selects only within its role's allowlist; no agent is instructed to emit a task_type its role cannot satisfy.

| Agent role | Allowed task_types |
|------------|--------------------|
| DEV agents (dev-*) | `bug-fix`, `feature`, `refactor`, `cleanup`, `research`, `plan` |
| glass-atrium-qa-code-reviewer | `review` |
| glass-atrium-qa-debugger | `diagnosis` (read-only by role — can never author tests, so never `bug-fix`) |
| glass-atrium-intel-planner | `plan`, `doc` |
| glass-atrium-intel-reporter | `doc` |
| glass-atrium-wiki-curator | `doc` |
| glass-atrium-design-designer | `doc`, `review` (design-review maps to `review`) |
| glass-atrium-sec-guard | `review`, `diagnosis` (verdict-only) |
| glass-atrium-meta-prompt-engineer | `doc`, `cleanup`; plus code-adjacent `refactor` only when it edits prompt/code files |

### result values

| Value | Selected when | Routing |
|-------|---------------|---------|
| `done` | per the Result-selection criterion below | — |
| `done_with_concerns` | the one state the Result-selection criterion below names | review needed → `concerns:` field |
| `blocked` | a technical impediment stops the work | escalation target |
| `needs_context` | information is insufficient | user response needed — not an escalation target |
| `fail` | the task failed | glass-atrium-qa-debugger escalation target |

### Whose outcome `result` describes

- `result` reports the emitting agent's own task outcome.
- A verdict, diagnosis, or finding about another artifact is deliverable content, and is never by itself a reason to downgrade.
- A caveat about the agent's own work goes in `concerns:` on whatever result the criterion below yields.
- Disclosing a caveat stays mandatory; only the result value is gated.

### Result-selection criterion (binding)

| State of the agent's own tasked deliverable | Selects |
|---------------------------------------------|---------|
| incomplete, unverified beyond its sanctioned role/constraint envelope, or left needing follow-up action | `done_with_concerns` — only this state selects it |
| complete and verified, every caveat being of a kind listed below | `done` |

- Caveat kinds that still select `done`: role-inherent limits · user-instructed deferrals · scope-external observations · deviation disclosures.
  - Role-inherent limit, for example: a read-only role that structurally never runs checks.

## Completion Report Output Obligation

A completion that meets `### Emit Boundary` → Mandatory must end with the block below; `track-outcome.sh` parses it into the Outcome Record. Per-field criteria: `### Field Input Guide`.

```
[COMPLETION]
result: done|done_with_concerns|blocked|needs_context|fail
task_type: bug-fix|feature|refactor|research|plan|review|diagnosis|doc|cleanup  # self-select within your role allowlist (Role → Allowed task_types table)
metric_pass: true|false                                  # REQUIRED, blank forbidden; writer self-report — grader never overwrites it
confidence: high|medium|low                              # REQUIRED, blank forbidden
revision_count: 0                                        # OPTIONAL, integer (default 0); set to N when user requested rework N times
evaluative_signal: 0                                     # OPTIONAL, -1|0|+1; emit -1 when the user corrected/rejected/asked-to-redo this work
directive_hint: one-line distilled English summary       # OPTIONAL, emit only with evaluative_signal:-1; distilled (never verbatim), English-only
files: changed_file1, changed_file2                      # omit if no file changes
summary: 1-line summary                                  # REQUIRED
concerns: condition1, condition2                         # OPTIONAL, valid on any result — one item per condition; on done rows it carries caveats that do not meet the done_with_concerns criterion
lesson: discovered pattern or know-how (1-2 sentences)   # RECOMMENDED — see ### Content fields → lesson
token_usage: input=N, output=N                           # OPTIONAL, OTel gen_ai.usage.* mapping
agent_version: 1.0.0                                     # OPTIONAL, instruction-version tracking
qa_score: cov=N,ins=N,instr=N,clar=N                     # OPTIONAL, QA review only — coverage/insight/instruction-following/clarity (each 1-5)
style_ref: relative/path/to/sibling.ts                   # OPTIONAL, populated by Project Convention Probe — see ### Role-scoped fields → style_ref
confidence_observed: 0.0-1.0                             # OPTIONAL, daemon-populated empirical posterior — writer does not fill
grader_verdict: verified_pass|unverified|verified_fail   # OPTIONAL, grader-populated — writer does not fill; advisory, never overwrites metric_pass
downgrade_origin: writer_true_downgraded|writer_false|synthesized  # OPTIONAL, grader-populated — writer does not fill
cid: correlation_id from orchestrator                    # OPTIONAL, omit if not delegated
[/COMPLETION]
```

- **Spawn-injected copy**: `hooks/inject-scope-rules.sh` → `build_emit_format_block` restates the multi-line mandate, the inline-tolerance rule and the schema-mode `completion_block` rule as a shell `printf` literal delivered to every subagent.
- **Multi-line form**: emit the block exactly as templated — the `[COMPLETION]` tag alone on its own line, each field on its own line, closed by `[/COMPLETION]` alone on its own line — on every emit (subagent, schema-mode, main session). The inline single-line form is not sanctioned.
  - **Schema-mode / workflow (`agent({schema})`)**: spawns MUST put the multi-line form in the StructuredOutput payload's `completion_block` string property.
    - Absent or unparseable → `structuredoutput-derived` synthesis (`scoped/maintainers/core-outcome-record.md` → `### Recorder parse outcomes`).
    - Reserving the property in the schema is an authoring-time duty: Workflow pre-flight item 8 (`skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode`).
    - Honest backing: `hooks/enforce-workflow-verify-stage.sh` checks the declaration, advisory only; nothing checks that the property is filled.
- **Correction-emission rule (agent owns the boolean "a correction happened")**: when the user's latest message corrected, rejected or asked to redo this work, the agent MUST emit all three: `revision_count` ≥ 1 + `evaluative_signal: -1` + `directive_hint: <one-line distilled English summary>`.
  - Judge the correction semantically, in any language.
  - The three are the trigger that populates `core.correction_signals`; what each value means, including which values are not a correction: `### Correction fields`.
  - **Omitting `directive_hint` is a correction gap**: `evaluative_signal: -1` without it makes `track-outcome.sh` raise an aggregation-visible `review_flag` plus a 1-line stderr note.
    - The recorder never distills the hint from the user message, so it MUST come from your own emit.
  - A request that only resumes or pushes the same work forward MUST NOT emit the three fields, e.g. `진행해` / `이어서 진행해` / `계속` / `다시 이어서` / `resume` / `continue` / `try again to continue` / a status check.
    - Why: it is an episodic one-off signal, not a correction of the work's content.

### Emit Boundary (Mandatory / Exempt / Gray-zone)

Emit on the terminal turn only: an every-turn emit is noise, and a skipped emit loses the learning signal.

- **Mandatory**: 1+ `tool_use` occurred and it contributed to a deliverable → file write/edit · code change · research synthesis · document creation · decision artifact · externally observable state change · referenceable output
- **Exempt**: conversation only (0 tool_use) · context-gathering-only tool_use (e.g. a single Read with no downstream artifact) · mid-task status/heartbeat · clarification question / simple confirmation
- **Gray-zone**: ambiguous → emit; a false-positive emit costs less than a false-negative non-emit
- **Closing-turn discipline (prevention layer)**: emit the `[COMPLETION]` block as the run's terminal act — never end the run on a tool-result turn assuming the work is done.
  - MANUAL / TEXT mode → a dedicated final assistant text turn carrying the block, after the last tool action.
  - SCHEMA / WORKFLOW mode → the StructuredOutput call carrying `completion_block` stays the last action.
  - The SubagentStop transcript-synthesis net is the deterministic backstop; this discipline is its prevention complement.
- **Channel asymmetry (subagent vs. main/orchestrator) — the block is a machine-facing record artifact, not user-facing prose**:
  - Subagent: its final message returns to the orchestrator as a user-invisible tool result — emit the raw block there unchanged. `track-outcome.sh` records it on SubagentStop, or synthesizes on omission, so this MUST is mechanically backed.
  - Main / orchestrator session: its final message is user-visible, so it MUST NOT print the raw block — summarize outcomes in prose. No Stop-channel recorder is wired for it, so its emit duty is honor-system.

## Field Reference

### Field Input Guide

Field rules: `#### Self-assessment fields` · `### Correction fields` · `### Content fields` · `### Role-scoped fields`.

| Field | Required | Blank fallback | Filled by |
|-------|----------|----------------|-----------|
| `confidence` | Yes | `low` | writer |
| `metric_pass` | Yes | `false` | writer |
| `grader_verdict` | No | omit — absent means not yet graded | grader |
| `downgrade_origin` | No | omit | grader |
| `confidence_observed` | No | omit | daemon |
| `concerns` | No | omit | writer |
| `lesson` | Recommended | omit | writer |
| `revision_count` | No | `0` | writer |
| `evaluative_signal` | No | omit | writer |
| `directive_hint` | No | omit | writer |
| `token_usage` | No | omit | writer |
| `agent_version` | No | omit | writer |
| `qa_score` | No | omit | writer |
| `style_ref` | No | see `### Role-scoped fields` → `style_ref` | writer |

#### Self-assessment fields

| `confidence` | Means |
|--------------|-------|
| `high` | all steps verified, expected behavior, no side effects |
| `medium` | core works; some edge cases unverified or worked around |
| `low` | guess-based, or only partially working |

- **`metric_pass`**: your honest claim that the task_type's bar below was met — authoritative for its own column.

| task_type | Bar for `metric_pass=true` |
|-----------|----------------------------|
| `bug-fix` | failing test → passing test, exit code 0 required |
| `feature` | a test observed to fail before the implementation existed now passes, and the full suite passes |
| `refactor` | behavior unchanged + existing test suite passes |
| `research` | 3+ sources cited with cross-verification |
| `plan` | goal + chosen direction and why + work streams in execution order, each naming its files + an Open Questions section |
| `review` / `diagnosis` / `doc` / `cleanup` | no test bar — the verdict, diagnosis, document or hygiene change was produced |

- `feature`: a test file merely added is not the bar.
  - A test written after its implementation qualifies only through the deliberate-break exception, made and run as `scoped/shared-testing.md` → **Qualifier on the last row (the deliberate-break exception)** states — including where the break is made.
- `plan`: an empty Open Questions section is valid.
  - A dependency DAG, per-task acceptance criteria or any other exhaustive structure joins the bar only when the user asked for that kind of deliverable (spec · PRD · ADR · roadmap) or for that structure by name.
- **Blank value policy**: a blank `confidence` or `metric_pass` degrades the learning signal — when judgment is impossible, write `low` / `false` explicitly.

### Correction fields

- **`revision_count`**: N = the times the user asked to rework this same task (first try complete = 0).
- **`evaluative_signal`**: `-1` only on a correction (Correction-emission rule) · `+1` explicit praise or acceptance · `0` an explicitly neutral signal · no signal → omit the field.
  - Absent and `0` are distinct — the parser preserves the raw value, so never collapse `0`↔absent.
  - Any one of `revision_count` ≥ 1, `evaluative_signal: -1` or a non-empty `directive_hint` trips the correction trigger, so emit none of them beside `+1`/`0`.
- **`directive_hint`**: one distilled English line naming what the user wanted changed — never raw verbatim, never a transcript quote (e.g. `User wanted the API gate moved, not the regex removed`).

### Content fields

- **`concerns`**: one item per condition, comma-separated — the same array shape as `files:`, since the recorder splits on commas.
  - On a `done_with_concerns` row the caveat goes here rather than into `summary` — the per-item column an operator filters, counts and clusters on.
- **`lesson`**: 1-2 sentences of discovery from this task (e.g. "X must go through Y — direct call forbidden").

### Role-scoped fields

- **`qa_score`**: format `cov=N,ins=N,instr=N,clar=N`, each 1-5 — reserved for QA agents (glass-atrium-qa-code-reviewer / glass-atrium-qa-debugger) reviewing other agents' outputs.
  - It rates the reviewed artifact and never selects the reviewer's own `result`, which follows the Result-selection criterion alone.
  - What a low sum obliges the reviewer to do, and the evaluator-independence caveat: `scope-qa.md` → "Deliverable Quantitative Evaluation".
- **`style_ref`**: the relative path of the sibling file used as convention reference — a file you opened with the Read tool this turn, because the recorder corroborates the value against your `Read` history and a Bash/Grep/Glob read carries no `file_path`.
  - Read during: Project Convention Probe (`scope-dev.md` → Pre-Execution Verification → Project Convention Probe) or Step 2 Read (`shared-search-first.md` → Pattern recognition → Step 2 Read / Step 3 Mirror).
  - **Greenfield** (no sibling in the first-touch directory and no AGENTS.md/CLAUDE.md anchor) → emit the literal `style_ref: greenfield` and declare `convention: greenfield` in the turn-0 Assumptions line.
  - **Omission** on a non-greenfield `feature`, `bug-fix` or `refactor` row from an agent that receives `scope-dev.md` → `review_flag: true`.

## Automatic Verification Criteria

> See also: `shared-testing.md` → Mechanical Success Metrics.

**Mismatch Review Trigger**: any row below auto-tags the Outcome Record `review_flag: true`, the learning-aggregator signal.

| Trigger | Condition |
|---------|-----------|
| Polar mismatch (overconfidence) | `confidence=high` + `metric_pass=false` |
| Polar mismatch (underconfidence) | `confidence=low` + `metric_pass=true` |
| Empty signal | `metric_pass` empty, any `confidence` |
| Grader disagreement (advisory) | `metric_pass=true` + `grader_verdict=verified_fail`; `downgrade_origin=writer_true_downgraded` records it |

- **Grader disagreement fires narrowly**: only the two `verified_fail` emitters in `scoped/maintainers/core-outcome-record.md` → `### Grader verdict` reach it.
