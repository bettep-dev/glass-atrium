# Learning Log & Correction Signal Rules (Cross-Cutting Concern)

Applies to all agents. [ALL]

## Learning Log Auto-Aggregation

`hooks/learning-aggregator.py` extracts patterns from accumulated Outcome Records into PostgreSQL `core.learning_log`.

| Trigger | Tagged as |
|---|---|
| same agent fails 3+ times | instruction improvement candidate |
| same task_type average revision_count 2+ | process improvement target |

## Instruction Improvement Approval Tier

The self-improvement loop (`autoagent/daemon_cycle.py`) has two approval tiers, Auto and Safety; only Safety proposals reach the user-approval queue.

**Tier 1 — Auto (default)**:
- A writing cycle (any cycle outside `--dry-run` / `--skip-loop-emit`) runs the trial stage and graduation ahead of generation (`daemon_cycle.py` → `run_cycle`).
- Trial:
  - Each writing cycle judges every open trial's stored rows and writes its canary (`daemon_cycle.py` → `run_trial_stage`).
    - The canary is the pre-registered text injected at SubagentStart into treatment-arm spawns.
  - The trial stage also voids the trial on a foreign canary hash, or on no start by the pre-registered horizon.
  - A look is a pre-registered interim reading of the two arms (`daemon_cycle.py` → `run_shadow_stage`).
    - A look can end the trial at a harm stop, a win or a retire.
    - A validity void takes precedence wherever an outcome is due.
  - Only a win changes the body.
- Graduation:
  - For each won trial whose row is still pending, the cycle calls the single-proposal apply as the machine actor (`daemon_cycle.py` → `run_graduation_stage`).
  - On a pre-registered row, `autoagent/daemon-apply.sh --proposal-id` judges the actor by its trial's state:
    - It refuses every actor while the trial is open or decided without a win (exit 27, `autoagent/daemon-apply.sh` → `assert_trial_decision_state`).
    - On a win it admits only the machine actor (graduation); any other actor is refused the same way.
  - `autoagent/daemon-apply.sh` batch mode selects and applies nothing; `--proposal-id` is the only apply path.
- Generation:
  - Only a pattern passing the power check reaches the generator; any other verdict parks it for that cycle (`daemon_cycle.py` → `check_pattern_power`).
  - Generation skips an agent holding a live trial — open, or won with its row still pending.
  - A verified non-safety candidate is stored pending `auto`, bound to a live pre-registration.
  - An `auto` candidate bound to no live pre-registration is rewritten to the terminal `unadjudicated` status (`daemon_cycle.py` → `resolve_floor_terminalization`).
- After graduation: no survival watch and no automatic removal — a graduated text leaves the body only through a human revert.
  - The post-apply regression watch is detection-only: a WARN loop event, never a revert (`daemon_cycle.py` → `alert_post_apply_regression`).
    - It is the one harm signal keyed to an applied proposal.
  - The attribution-confound watch is detection-only too: one loop event per agent whose patches applied while the rate behind them stayed flat (`daemon_cycle.py` → `alert_attribution_confound`).
  - The regression gate runs dry by default (`daemon_cycle.py` → `regression_gate_live_enabled`).
    - Its would-block set is the pattern rows covered by a post-apply regression warning still inside its liveness window (`REGRESSION_LIVENESS_DAYS`).
    - It publishes that set and drops none from generation unless `AUTOAGENT_REGRESSION_GATE_LIVE` opts in.
- Eligibility gate:
  - A safety-routed proposal is stored under the `user` approval tier, never `auto`, so the apply backlog cannot select it (`scripts/_pg_dual_write_daemon.py` → `_APPROVAL_TIER_TO_ENUM`).
  - Scope: single agent, ≤5 added lines per edit (`daemon_cycle.py` → `BODY_AUTO_LINE_LIMIT`).
  - Conditions: classification == "apply" + `haiku_status` starting with `ok` + diff non-empty + non-safety scope.
    - Prefix, never equality: the legitimate `ok:retried` / `ok:fuzzy-parsed` variants must pass the same gate, and a missing or `skipped:*` status fails closed (`daemon_cycle.py` → `is_apply_eligible_haiku_status`).
  - Pre-verify (`daemon_cycle.py` → `route_failed_pre_verify`):
    - A verifier refusal rejects the candidate.
    - A verifier that never adjudicated (timeout / missing CLI / non-zero exit) leaves it pending, re-verified next cycle.
    - Entry into the user queue is forbidden on this path.

**Tier 2 — Safety**:
- **trigger** — irreversible + external-effect only (reuses the `core-security.md` "High-impact actions" definition). Any one of the following is a Tier-2 trigger:
  - forced/recursive file deletion / DB drop (`rm -r`/`-f` · `DROP TABLE`)
  - external network call (external host API)
  - git push --force / rebase published branch
  - security-permission change (chmod / TCC / launchctl daemon lifecycle (bootstrap/bootout/kickstart/load/unload))
  - launchd plist change — any path whose FINAL component matches `com.claude.*.plist` or `com.glass-atrium.*.plist`
  - frontmatter identity field (name / tools / scope) change
  - weakening of GLASS_ATRIUM_GLOBAL_RULES / core-security.md absolute rules, or any change to `core-learning-log.md` — the Tier-2 trigger list's own home
- **non-safety quality issue** (rule-scope misapplication / minor instruction tuning, etc.) → absorbed by Tier 1 Auto through its pre-verify gate (`Eligibility gate` → `Pre-verify`), never a user pending queue.

> This section is the approval-rule canonical for the 2-tier policy. The orchestrator-side operational delta lives in `skills/glass-atrium-ops-orchestrator.md` → `### Self-Improvement User-Approval Trigger`.

## Correction Signal Capture

- A raw user correction is an episodic signal: it is session-scoped and never enters long-term memory itself — only a fact distilled from it can be persisted, and only through the Long-Term Memory Write-Gate below.
- **Signal origin (agent-emitted, semantic)**: the correction signal comes from the agent's own `[COMPLETION]` emit — the three correction fields of `core-outcome-record.md` → **Correction-emission rule**.

### Long-Term Memory Write-Gate

Before writing any `feedback_*.md` file or `MEMORY.md` line in the personal memory dir, the distilled signal must pass every condition below; any failure means discard, no write:

- **explicit user instruction to remember (overriding gate)**: a user-facing memory write fires only when the user explicitly instructed it to be remembered (e.g. `기억해` / `이거 기억해둬` / "remember this" / "save this to memory", judged semantically in any language).
- **content-type is durable**: the distilled fact ∈ {`preference`, `rule`, `project-fact`, `reusable-pattern`}; episodic one-off task talk (retry / continue / permission-check / completion-ack / status-question) is not.
- **future-session relevant**: an unrelated future session could change its behavior from this fact; a signal bound to one-off state (a since-deleted document, a point-in-time permission or progress status) fails.
- **not a semantic duplicate**: indexed memory does not already hold the fact by meaning, not merely by raw-token match.

Beyond those conditions:

- **Persisted value**: a distilled English fact — a reusable, context-independent pattern, never the raw directive_hint, which is time- and context-bound and is the pollution source.
