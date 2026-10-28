# Maintainer note — agents/glass-atrium-dev-nestjs.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | turn-budget meter sizing |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys (name, tools, scope) and the fence-line count | edits to them blocked for every caller (LLM06) |
| `hooks/test/inject-scope-rules-nodrop.bats` | its own `BUDGET_DEV_CARRIERS` literal | carrier status — `## Budget carrier` |
| `autoagent/daemon_cycle.py` → `match_sensitive_diff` | added lines of any patch to this body | a dynamic-exec call form written with its paren routes the patch to safety |

- No suite reads this body's prose; the autoagent tests that name this agent write fixture bodies.
- `scoped/maintainers/shared-testing.md` names the Success Criteria **Tests** lead verbatim; keep that lead text.

## Budget carrier

- This agent is excluded from the injected `AGENT-INJECT:BUDGET-DEV` roster: `scripts/agent_lifecycle/inject_sync.py` → `_BUDGET_DAEMON_CARRIERS` names it, and the hook's roster is the DEV roster minus that set.
- So `scoped/shared-turn-budget.md` reaches it at no spawn, and the Guardrails **Upfront scope + budget check (multi-file work)** bullet is its only copy of the sizing rule.
  - Deleting that bullet as a duplicate deletes the rule while reddening nothing.
- The bullet states a judgment, not a formula: intake fit against one agent budget, each audited reference site counted as an edit.
  - The injected block's multiplier and split threshold stay out of the body; the orchestrator-side `[SIZE-EST]` calibration is separate.
- Carrier status stays: leaving the carrier set would deliver the BUDGET-DEV block and its advisory numbers to this agent.

## Canonicals the body states no copy of

- host: `core-outcome-record.md` → Completion Report Output Obligation (plus the slot-1 emit-format block) · `core-security.md` → Execution Security and Input Validation.
- `rules.scope`: `scoped/scope-dev.md` → Ambiguity Gate, Pre-Edit Facts Disclosure and Project Convention Probe.
- `rules.shared`: `scoped/shared-testing.md` (spec before code) · `scoped/shared-search-first.md`.
- The Success Criteria no-`completion_block` fallback stays: neither canonical states it.
