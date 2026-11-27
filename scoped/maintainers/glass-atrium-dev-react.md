# Maintainer note — agents/glass-atrium-dev-react.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | turn-budget meter sizing |
| `lib/ga-doctor.sh` → `get_integrity_drift` | live frontmatter identity keys (name, tools, scope) and text outside EDITABLE regions | a live edit to either is reported as drift, never blocked |
| `autoagent/daemon_cycle.py` → `match_sensitive_diff` | added lines of any patch to this body | `git stash` bare, or with any subcommand but `push`, `apply` or `list`, routes the patch to safety |
| `autoagent/lib/editable_merge.py` | EDITABLE region count, local vs release | a count change routes the merge to the manual structural-change ceremony |

- `autoagent/test/test_sensitive_patterns.py` carries its own fixture copy of the **Inherited-tree baseline (no bare stash)** bullet, so a body edit never reddens it; keep the bold lead, whose `Inherited-tree baseline` words the `daemon_cycle.py` pattern comment names.
- `scoped/maintainers/shared-naming.md` names this body as the citer of **Booleans — stative-first**; keep that pointer text in the Design Principles **Composition** bullet.

## Budget carrier

- This agent is excluded from the injected `AGENT-INJECT:BUDGET-DEV` roster: `scripts/agent_lifecycle/inject_sync.py` → `_BUDGET_DAEMON_CARRIERS` names it, and the hook's roster is the DEV roster minus that set.
- So `scoped/shared-turn-budget.md` reaches it at no spawn, and the Guardrails **Budget sizing** bullet is its only copy of the sizing rule.
  - Deleting that bullet as a duplicate deletes the rule while reddening nothing.
- The bullet stays a judgment, not a formula: the injected block's multiplier and split threshold stay out of the body.
- Carrier status stays: leaving the carrier set would deliver the BUDGET-DEV block and its advisory numbers to this agent.
  - Leaving it also reddens `hooks/test/inject-scope-rules.bats` (the dev-react case asserts no BUDGET-DEV block), `hooks/test/inject-scope-rules-nodrop.bats` (its `BUDGET_DEV_CARRIERS` literal) and `scripts/test/test_inject_sync.py` → `test_budget_daemon_carriers_pin`.

## Canonicals the body states no copy of

- host: `core-outcome-record.md` → Completion Report Output Obligation (plus the slot-1 emit-format block) · `core-security.md` → Input Validation (user-supplied URLs).
  - The Success Criteria no-`completion_block` fallback stays: neither the obligation nor the slot-1 block states it.
- host: `core-git-workflow.md` → `## Commits` (the staging ban behind the baseline recipe) · `GLASS_ATRIUM_GLOBAL_RULES.md` → Work-unit checkpoint dimension.
- `rules.scope`: `scoped/scope-dev.md` → Project Convention Probe (import order and layout mirror the sibling) and Pre-Edit Facts Disclosure.
- `rules.shared`: `scoped/shared-search-first.md` · `scoped/shared-type-safety.md` (`any` ban, `unknown` plus a type guard) · `scoped/shared-design-token-consumption.md` (`## Motion Tokens`, reduced motion) · `scoped/shared-naming.md`.
- glass-atrium-dev-front owns a11y and responsive layout (the body's `>` routing line) and tokens (the body's **TailwindCSS** bullet).
