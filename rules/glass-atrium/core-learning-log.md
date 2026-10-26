# Learning Log & Correction Signal Rules (Cross-Cutting Concern)

Applies to all agents. [ALL]

## Learning Log Auto-Aggregation

`hooks/learning-aggregator.py` extracts patterns from accumulated Outcome Records into PostgreSQL `core.learning_log`.

| Trigger | Tagged as |
|---|---|
| same agent fails 3+ times | instruction improvement candidate |
| same task_type average revision_count 2+ | process improvement target |

## Instruction Improvement Approval Tier

The self-improvement loop (`autoagent/daemon_cycle.py`) user-approval queue is **safety-only**. The spec is 2-tier (auto + safety).

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
    - This project's live labels are `com.glass-atrium.*` — monitor, autoagent-cycle, wiki-compile, …
    - A plist under any other label prefix is not matched by this path-pattern set.
  - frontmatter identity field (name / tools / scope) change
  - weakening of GLASS_ATRIUM_GLOBAL_RULES / core-security.md absolute rules, or any change to `core-learning-log.md` — the Tier-2 trigger list's own home
    - Honest backing for that last clause: policy, not a path matcher — a benign edit to this file classifies auto.
      - The daemon's sensitive-path tuple carries no row for this file: both of its consumers are handed an `agents/<name>.md` body path (`autoagent/test/test_sensitive_patterns.py` → `RuleFileRowsAreOutOfReach` pins this).
      - The sensitive-diff axis still catches a patch here: several trigger lines above are command-shaped, so re-adding one as a `+` line routes the patch to safety.
      - Never reflow those lines for tidiness — a reflowed line is an added line.
- **non-safety quality issue** (rule-scope misapplication / minor instruction tuning, etc.) → absorbed by Tier 1 Auto + LLM retry, never a user pending queue; while Tier 1 is closed, nothing is generated for it.

> This section is the approval-rule canonical for the 2-tier policy. The orchestrator-side operational delta (Monitoring-phase routing, dashboard surfacing) lives in `skills/glass-atrium-ops-orchestrator.md` → `### Self-Improvement User-Approval Trigger`.

## Correction Signal Capture

- User corrections (rejection / "redo this" / "change it like this") = evaluative signal (-1) + directive signal.
- A raw correction is an **episodic** signal — session-scoped, discarded after the session.
- It does not enter long-term memory directly; only a fact distilled from it (when semantic) is persisted, under the Long-Term Memory Write-Gate below.
- **Signal origin (agent-emitted, semantic)**: the correction signal originates from the agent's `[COMPLETION]` emit — the three correction fields of `core-outcome-record.md` → **Correction-emission rule**.
  - `track-outcome.sh` keys `core.correction_signals` on those fields; a Korean/English keyword regex on the user message is a legacy fallback that fires only when no correction field was emitted.

### Long-Term Memory Write-Gate

Repetition alone does not justify persistence. Before writing any `feedback_*.md` file or `MEMORY.md` line in the personal memory dir, the distilled signal MUST pass every condition below (AND — any failure → discard, no write):

- **explicit user instruction to remember (overriding gate)**: a user-facing memory write fires only when the user explicitly instructed it to be remembered (e.g. `기억해` / `이거 기억해둬` / "remember this" / "save this to memory", judged semantically in any language).
  - Honest backing: no daemon auto-clustering path exists (`hooks/learning-aggregator.py` carries no `directive_hint`→`feedback_*.md` clustering), so on that path this gate is held by the absence of code, not by a runtime check.
- **content-type is durable**: the distilled fact ∈ {`preference`, `rule`, `project-fact`, `reusable-pattern`}. Episodic one-off task talk (retry / continue / permission-check / completion-ack / status-question) is not durable → discard.
- **future-session relevant**: an unrelated future session could change its behavior from this fact. Signals bound to one-off state (a since-deleted document, a point-in-time permission or progress status) fail this → discard.
- **not a semantic duplicate**: the fact is not already captured in indexed memory by meaning (not raw-token match) → if a semantic duplicate exists, discard.

Beyond those conditions:

- **Persisted value**: a distilled English fact — a reusable, context-independent pattern, never the raw directive_hint, which is time- and context-bound and is the pollution source.
