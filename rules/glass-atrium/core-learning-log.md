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
- Interim, closed on every install: no generator call and no auto-apply until live trials, so the safety queue receives no new rows meanwhile.
  - The cycle skips per-candidate generation; every other cycle step still runs (`daemon_cycle.py` → `run_cycle`).
  - Each cycle outside no-write mode (`skip_loop_emit`, set by `--dry-run` or `--skip-loop-emit`) terminalizes stored pending `auto` proposals, rationale prefixed `generation closed until live trials` (`daemon_cycle.py` → `update_generation_closed_proposals`).
  - `autoagent/daemon-apply.sh` selects and applies nothing in batch mode; `--proposal-id` is its only apply path.
  - No flag, env or data-root input reopens either path, so every install behaves alike.
- Eligibility gate, kept for that reopening:
  - A safety-routed proposal is stored under the `user` approval tier, never `auto`, so the apply backlog cannot select it (`scripts/_pg_dual_write_daemon.py` → `_APPROVAL_TIER_TO_ENUM`).
  - Scope: single agent, 5+ occurrences, ≤5 added lines per edit (`daemon_cycle.py` → `BODY_AUTO_LINE_LIMIT`).
  - Conditions: classification == "apply" + `haiku_status` starting with `ok` + diff non-empty + non-safety scope.
    - Prefix, never equality: the legitimate `ok:retried` / `ok:fuzzy-parsed` variants must pass the same gate, and a missing or `skipped:*` status fails closed (`daemon_cycle.py` → `is_apply_eligible_haiku_status`).
  - Pre-verify quality issue (rule-scope misapplication / failure to add ≤5-line body, etc.) → 1 LLM retry on the daemon worker model (`WORKER_MODEL`), then Auto if re-verification passes / reject if it fails
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
- **non-safety quality issue** (rule-scope misapplication / minor instruction tuning, etc.) → absorbed by Tier 1 Auto + LLM retry, never a user pending queue; while Tier 1 is closed, nothing is generated for it.

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
