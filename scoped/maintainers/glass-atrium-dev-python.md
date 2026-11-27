# Maintainer note — agents/glass-atrium-dev-python.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` · `hooks/test/inject-scope-single-delivery.bats` | `^maxTurns:` at column 0 | turn-budget meter sizing and its above-floor presence |
| `lib/ga-doctor.sh` → `get_integrity_drift` | live frontmatter identity keys (name, tools, scope) and text outside EDITABLE regions | a live edit to either is reported as drift, never blocked |
| `hooks/test/inject-scope-rules-nodrop.bats` | frontmatter `maxTurns`, through the hook; its own `BUDGET_DEV_CARRIERS` literal | meter bytes · carrier status — `## Budget carrier` |
| `autoagent/daemon_cycle.py` → `match_sensitive_diff` | added lines of any patch to this body | a dynamic-exec call form written with its paren routes the patch to safety |
| `autoagent/lib/editable_merge.py` | EDITABLE region count, local vs release | a count change routes the merge to the manual structural-change ceremony |

- No suite reads this body's prose; other tests that name this agent use its name or path as fixture data.

## Budget carrier

- This agent is excluded from the injected `AGENT-INJECT:BUDGET-DEV` roster: `scripts/agent_lifecycle/inject_sync.py` → `_BUDGET_DAEMON_CARRIERS` names it.
- So `scoped/shared-turn-budget.md` reaches it at no spawn, and the Guardrails **Budget sizing** bullet is its only copy of the sizing rule.
  - Deleting that bullet as a duplicate deletes the rule while reddening nothing.
- The bullet states a judgment, not a formula: the injected block's multiplier and split threshold stay out of the body.
- Carrier status stays: it keeps those advisory numbers from reaching this agent.
- `[SIZE-EST]` is the orchestrator's delegation token, calibrated on its side; the body names it only as the starting estimate.

## Canonicals the body states no copy of

- host: `core-outcome-record.md` → Completion Report Output Obligation (plus the slot-1 emit-format block).
- host: `core-security.md` → Execution Security (dynamic execution), Input Validation (Pydantic at external boundaries) and Dependency Auditing.
- host: `GLASS_ATRIUM_GLOBAL_RULES.md` → 3-Tier Boundary (installation is a Confirm action) and Work-unit checkpoint dimension (the checkpoint **Budget sizing** names).
- `rules.scope`: `scoped/scope-dev.md` → Ambiguity Gate, Project Convention Probe and **Bug fix = root cause, not symptom**.
- `rules.shared`: `scoped/shared-testing.md` (naming, test data, test depth) · `scoped/shared-investigation-discipline.md` (failure sequence, debugger handoff) · `scoped/shared-comment-logging.md` (TODO format).
- The Success Criteria no-`completion_block` fallback stays: neither `core-outcome-record.md` nor the emit-format block states it.

## Pointers the body keeps

- `rules/glass-atrium/shared-self-improve-hygiene.md` stays named under `### Error Handling`, with its reason.
  - The agent edits `autoagent/` and `scripts/agent_lifecycle/` code, and that file reaches it only on a path-glob Read whose delivery is unmeasured (`core-compliance-matrix.md` → **Path-scoped delivery**).
  - The absorption-annotation convention is not named: `scripts/audit-absorption.sh` scopes it to shell files.
