# Maintainer note — agents/glass-atrium-dev-node.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 of the frontmatter | the turn-budget meter is sized from it |
| `lib/ga-doctor.sh` → `get_integrity_drift` | live frontmatter identity keys (name, tools, scope) and text outside EDITABLE regions | a live edit to either is reported as drift, never blocked |

## `## Prohibitions` is not a required heading

- `autoagent/autoagents-eval.sh` requires no body heading: its eval prompt states that body section headings are a ceiling, not a floor.
- The body has no `## Prohibitions`: every prohibition sits in `## Guardrails`, so do not re-add the section.

## What moved out of the body, and why

- **Self line budget** — it constrains whoever edits the body, not a Node task, so it stays out: an addition replaces or merges rather than appends.
- **The `acceptance_criteria.md` Guardrails bullet** — went with the `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]` branch it mirrored; do not re-add it.
  - Ground: no `acceptance_criteria*` file exists in the tree, and a plan carries an acceptance-criteria section only on request (`scoped/scope-planning.md`; `rules/glass-atrium/core-outcome-record.md` → `metric_pass`, the `plan` bar).
  - In its place: the gate's table, plus the body's feature-side duty ("MUST verify implementation against acceptance criteria (not just unit-test passage)").
- **Guardrails items re-listed under Red Flags and Prohibitions** — Red Flags lists only what has no Guardrails entry; the "unverified pattern" prohibition merged into the library-verification Guardrail.
- **Success Criteria restating Guardrails or Work Rules** (`node:` prefix, sync fs, `Buffer()`, Zod, splice order) — one site each; the section keeps only the test bar and the schema fallback.
- **Generic Error Recovery rows** (build, test, runtime; symptom-string and permission-denial restatements) — the rows obliged nothing beyond Guardrails and `scoped/shared-investigation-discipline.md`; domain rows stay.
- **Restatements of rules the agent already receives** — do not re-add them:

  | Removed from the body | Canonical that reaches the agent |
  |---|---|
  | Effort/thinking blockquote, including its `effort=high default` clause | `GLASS_ATRIUM_GLOBAL_RULES.md` → Thinking Budget Policy (host), which defaults to the parent tier |
  | Guardrails "MUST NOT hardcode secrets or credentials" | `rules/glass-atrium/core-security.md` → Secret Management (host) |
  | Guardrails Project Convention Probe bullet | `scoped/scope-dev.md` → Pre-Execution Verification → Project Convention Probe (`rules.scope`) |
  | Prohibitions "npm package added without an `npm audit` / provenance check" | `rules/glass-atrium/core-security.md` → Dependency Auditing (host) |
  | Comments & Logs clauses (why-only, TODO format, `console.*` ban, empty catch, log+rethrow) and the matching Red Flags | `scoped/shared-comment-logging.md` (`rules.shared`) |
  | FINAL STEP line and emit-mode table; only the no-`completion_block` fallback stays in Success Criteria | `rules/glass-atrium/core-outcome-record.md` → Completion Report Output Obligation (host) + the slot-1 emit-format block |
  | Architecture SRP, dependency injection and "Avoid over-engineering" | `scoped/shared-code-structure.md` · `scoped/scope-dev.md` → `## Complexity Proportionality` |
  | Dependencies "Check existing before adding" | `scoped/shared-search-first.md` → `## Principles` (`rules.shared`) |
  | Pre-Execution **Paths** | `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Verified References` (host) |

## Decisions worth keeping

- **Completion-verification Guardrail**: its task-type item points at `core-outcome-record.md` → `metric_pass`, since a restated bar drifts from the per-type canonical.
  - The refactor, multi-site and removal checks stay as body deltas.
- **`### Comments & Logs` under Work Rules** carries only the Node CLI carve-out: `console` on stdout/stderr is the output channel by design.

## Daemon-evolved `## Guardrails` lines — all dropped

None of these EDITABLE lines is valid against this body plus the rules the agent receives; a proposal re-adding one fails on the same ground.

| Quote | Class | Reason |
|---|---|---|
| "MUST default to `effort=medium` for routine implementations" | contradicts | a body line cannot set its spawn's tier; the `effort:` key or `agent()` option does (Thinking Budget Policy) |
| "MUST consolidate tool exploration (Grep/Read results) into one exploratory pass" | unsupported | no outcome evidence it caused or cured anything |
| "confirm all Grep/Read is complete and documented before first Write/Edit" | contradicts | injected BUDGET-DEV staging (1-2 files at a time, verify each) and the first-failure retry both need mid-work reads |
| "MUST NOT perform secondary Grep/Read exploration on previously-examined targets" | contradicts | "1st failure → reformulate hypothesis + retry" needs re-tracing; post-edit re-reads verify work |
| "On effort=medium qualification: straightforward literal edits/moves with known targets only" | contradicts | a body line cannot set its spawn's tier |
