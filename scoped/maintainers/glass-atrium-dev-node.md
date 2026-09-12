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

## Correction landed in this pass

The `## Prohibitions` section carried a justification for restating Guardrails: that `autoagent/autoagents-eval.sh` scores every body on "Required sections present exactly: Goal, Guardrails, Prohibitions". **That is false against the live script.** Its eval prompt evaluates five checks (global-rules consistency, role boundaries, frontmatter name + description, `skills:` list shape, English body) and states the opposite of the quoted rule: body section headings are a ceiling, not a floor, and no heading may be required. The quoted string appears nowhere in the script. The justification was removed with the restatement it defended; `## Prohibitions` survives as a section because it now carries items Guardrails does not.

## What moved out of the body, and why

- **Effort/thinking blockquote** — duplicate of `GLASS_ATRIUM_GLOBAL_RULES.md` → Thinking Budget Policy, a Tier-1 rule that measurably reaches every subagent.
- **Self line budget ("keep this file ≤180 lines, largest DEV body, compress before appending")** — a maintenance constraint on whoever edits the body plus its recurrence-prevention provenance, neither of which changes what the agent does on a Node task. It is recorded here instead: this body is the longest DEV body in the corpus, its length is carried almost entirely by the Guardrails list, and an addition should replace or merge rather than append.
- **"Measurable pass conditions only (binding guardrail rules live in the Guardrails section)"** — framing for the editor, not a duty.
- **The `acceptance_criteria.md` Guardrails bullet** ("MUST read `acceptance_criteria.md` (if present in repo) or plan's `## Acceptance Criteria` section before starting…") — DELETED, not rewritten, together with the `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]` branch it mirrored.
  - Ground: no `acceptance_criteria*` file exists anywhere in the tree (globbed this pass), and a plan carries an acceptance-criteria section only on request (`scoped/scope-planning.md`; `rules/glass-atrium/core-outcome-record.md` → `metric_pass`, the `plan` bar).
  - What stands in its place: the gate's surviving table routes the DEV to the delegation's criteria or to its own turn-0 `Assumptions:` line, and this body keeps its feature-side duty ("MUST verify implementation against acceptance criteria (not just unit-test passage)").
  - The `## Machine constraints on the body` row telling an editor to keep the bullet went with it — it was the only thing standing on that bullet.
    - That row also asserted that `scoped/scope-dev.md` → Sprint Contract Gate *cites* this body's `## Guardrails`. It does not: grep over that rule file returns only the Tier-2 loading roster naming this agent.
- **Guardrails items re-listed under Red Flags and Prohibitions** — both sections now name Guardrails as the owner and list only what has no Guardrails entry, the shape `agents/glass-atrium-dev-shell.md` already uses.

## Decisions worth keeping

- **Naming subordination (this wave)**: the one site naming a naming axis is the Project Convention Probe bullet, and it sits INSIDE the Guardrails editable region. The change there was held to the minimum the disposition needs — the probe now mirrors import order and error+log patterns and subordinates identifier naming to the `scoped/shared-naming.md` canon; the rest of the bullet, including the greenfield branch, is unchanged. A live install with local edits resolves that region through a merge, which is why nothing else in it was touched.
- **The `### Comments & Logs` block under Work Rules duplicates the injected comment-rule core** (why-only, TODO owner/ticket, no production `console.*`). It was left in place because it sits inside an editable region and no disposition covers it; the Node-only clause about CLI `console` on stdout/stderr is genuine residue. A later pass owning that region should cut the duplicated clauses and keep the CLI carve-out.
