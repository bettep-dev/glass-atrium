# Maintainer note — agents/glass-atrium-dev-react.md

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
| `hooks/test/inject-scope-rules.bats` · `hooks/test/inject-scope-rules-nodrop.bats` | their own carrier literals; the dev-react case asserts no BUDGET-DEV block | carrier status — `## Budget carrier` |
| `autoagent/daemon_cycle.py` → `match_sensitive_diff` | added lines of any patch to this body | a bare or popping stash invocation in the baseline recipe routes the patch to safety |
| `autoagent/lib/editable_merge.py` | EDITABLE region count, local vs release | a count change routes the merge to the manual structural-change ceremony |

- No suite reads this body's prose; the autoagent and scripts tests that name this agent use its name or path as fixture data.
  - `autoagent/test/test_sensitive_patterns.py` carries its own fixture copy of the **Inherited-tree baseline (no bare stash)** bullet, so a body edit never reddens it; keep the bold lead, which the `daemon_cycle.py` pattern comment names.
- `scoped/maintainers/shared-naming.md` names this body as the citer of **Booleans — stative-first**; keep that pointer text in the Design Principles **Composition** bullet.
- The **Tooling and parsing awareness** bullet is monitor-repo specific: it binds while this agent edits `monitor/public/src`, and the seams it names live in `monitor/test/`.

## Budget carrier

- This agent is excluded from the injected `AGENT-INJECT:BUDGET-DEV` roster: `scripts/agent_lifecycle/inject_sync.py` → `_BUDGET_DAEMON_CARRIERS` names it, and the hook's roster is the DEV roster minus that set.
- So `scoped/shared-turn-budget.md` reaches it at no spawn, and the Guardrails **Budget sizing** bullet is its only copy of the sizing rule.
  - Deleting that bullet as a duplicate deletes the rule while reddening nothing.
- The bullet states a judgment, not a formula: intake fit against one agent budget, each swept reference site counted as an edit, and a stop once the remaining budget no longer covers the remaining work.
  - The injected block's multiplier and split threshold stay out of the body; the orchestrator-side `[SIZE-EST]` calibration is separate.
- Carrier status stays: leaving the carrier set would deliver the BUDGET-DEV block and its advisory numbers to this agent.
- The checkpoint itself is `GLASS_ATRIUM_GLOBAL_RULES.md` → Work-unit checkpoint dimension (host-delivered).

## Canonicals the body states no copy of

- host: `core-outcome-record.md` → Completion Report Output Obligation (plus the slot-1 emit-format block) · `core-security.md` → Input Validation (user-supplied URLs) · `core-git-workflow.md` → `## Commits` (the staging ban behind the baseline recipe).
- `rules.scope`: `scoped/scope-dev.md` → Project Convention Probe (import order and layout mirror the sibling) and Pre-Edit Facts Disclosure.
- `rules.shared`: `scoped/shared-search-first.md` · `scoped/shared-type-safety.md` (`any` ban, `unknown` plus a type guard) · `scoped/shared-design-token-consumption.md` (`## Motion Tokens`, reduced motion) · `scoped/shared-naming.md`.
- glass-atrium-dev-front owns a11y, responsive layout and tokens — the body's `>` routing line.
- The Success Criteria no-`completion_block` fallback stays: neither canonical states it.
