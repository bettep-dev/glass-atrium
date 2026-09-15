# Maintainer note — agents/glass-atrium-dev-node.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 of the frontmatter | the turn-budget meter is sized from it |
| `hooks/enforce-harness-critical.sh` | live-install frontmatter identity keys (name, tools, scope) and the fence-line count | a live edit touching either is blocked for every caller (LLM06) |

## `## Prohibitions` is not a required heading

- `autoagent/autoagents-eval.sh` requires no body heading: its eval prompt states that body section headings are a ceiling, not a floor.
- Its five checks are global-rules consistency, role boundaries, frontmatter name + description, `skills:` list shape, and English body.
- `## Prohibitions` stays in this body only because it carries an item Guardrails does not.
  - Once it carries none, delete the section rather than justify it.

## What moved out of the body, and why

- **Effort/thinking blockquote** — duplicate of `GLASS_ATRIUM_GLOBAL_RULES.md` → Thinking Budget Policy, a Tier-1 rule that reaches every subagent.
- **Self line budget** — a constraint on whoever edits the body, not a duty on a Node task. The body's length is carried almost entirely by the Guardrails list, so an addition should replace or merge rather than append.
- **"Measurable pass conditions only (binding guardrail rules live in the Guardrails section)"** — framing for the editor, not a duty.
- **The `acceptance_criteria.md` Guardrails bullet** — deleted together with the `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]` branch it mirrored.
  - Ground: no `acceptance_criteria*` file exists in the tree, and a plan carries an acceptance-criteria section only on request (`scoped/scope-planning.md`; `rules/glass-atrium/core-outcome-record.md` → `metric_pass`, the `plan` bar).
  - In its place: the gate's table routes the DEV to the delegation's criteria or to its own turn-0 `Assumptions:` line, and the body keeps its feature-side duty ("MUST verify implementation against acceptance criteria (not just unit-test passage)").
- **Guardrails items re-listed under Red Flags and Prohibitions** — both sections name Guardrails as the owner and list only what has no Guardrails entry, the shape `agents/glass-atrium-dev-shell.md` uses.
- **Restatements of rules the agent already receives** — do not re-add them:

  | Removed from the body | Canonical that reaches the agent |
  |---|---|
  | Guardrails "MUST NOT hardcode secrets or credentials" | `rules/glass-atrium/core-security.md` → Secret Management (host) |
  | Guardrails Project Convention Probe bullet | `scoped/scope-dev.md` → Pre-Execution Verification → Project Convention Probe (`rules.scope`) |
  | Prohibitions "npm package added without an `npm audit` / provenance check" | `rules/glass-atrium/core-security.md` → Dependency Auditing (host) |
  | Comments & Logs clauses (why-only, TODO format, `console.*` ban, empty catch, log+rethrow) and the matching Red Flags | `scoped/shared-comment-logging.md` (`rules.shared`) |
  | FINAL STEP emit-mode table, except the no-`completion_block` fallback, which stays in the body under the pointer line | `rules/glass-atrium/core-outcome-record.md` → Completion Report Output Obligation (host) plus the slot-1 emit-format block |

## Decisions worth keeping

- **Completion-verification Guardrail**: its task-type item points at `core-outcome-record.md` → `metric_pass` rather than restating a bar, since a restated bar drifts from the per-type canonical. The refactor, multi-site and removal checks stay as body deltas.
- **`### Comments & Logs` under Work Rules** carries only the Node CLI carve-out: `console` on stdout/stderr is the output channel by design. Everything else it once held is in the table above.

## Daemon-evolved `## Guardrails` lines — all dropped

Five daemon-evolved EDITABLE lines were judged against this body plus the rules the agent receives. None is valid, so none is integrated; a proposal re-adding one fails on the same ground.

| Quote | Proposal | Class | Reason |
|---|---|---|---|
| "MUST default to `effort=medium` for routine implementations" | 1709 | contradicts | Thinking Budget Policy defaults `effort=high`; effort is set by the caller, not the spawned agent |
| "MUST consolidate tool exploration (Grep/Read results) into one exploratory pass" | 1709 | unsupported | no outcome evidence it caused or cured anything |
| "confirm all Grep/Read is complete and documented before first Write/Edit" | 6790 | contradicts | injected BUDGET-DEV staging (1-2 files at a time, verify each) and the retry after a first failure both need reads mid-implementation |
| "MUST NOT perform secondary Grep/Read exploration on previously-examined targets" | 3386 | contradicts | "1st failure → reformulate hypothesis + retry" needs re-tracing; post-edit re-reads verify work |
| "On effort=medium qualification: straightforward literal edits/moves with known targets only" | 3386 | contradicts | same effort conflict as the first row |
