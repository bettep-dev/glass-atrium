# Learning Log & Correction Signal Rules (Cross-Cutting Concern)

Applies to all agents. [ALL]

## Learning Log Auto-Aggregation

Patterns are auto-extracted from accumulated Outcome Records and recorded in `memory/core-learning-log.md`.

| Trigger | Tagged as |
|---|---|
| same agent fails 3+ times | instruction improvement candidate |
| same task_type average revision_count 2+ | process improvement target |

- **Duplicate-append prevention**: if the same pattern + agent combo already exists, update its frequency only — never append a second entry.
- **Approval**: instruction improvement approval is 2-tier (Auto + Safety) — see "Instruction Improvement Approval Tier" below.
- **Candidate variants**: each tier MAY generate up to 3 variants; the chosen variant goes to apply, the rest are logged to Solution History for the next cycle.
  - Honest backing: SPEC, not running code — a read of `autoagent/daemon_cycle.py` found no multi-variant generation path (the loop builds one proposal per candidate agent), so nothing writes the non-chosen variants today.

## Instruction Improvement Approval Tier

The self-improvement loop (`autoagent/daemon_cycle.py`) user-approval queue is **safety-only**. The spec is 2-tier (auto + safety).

**Tier 1 — Auto (default)**:
- Scope: single agent, 5+ occurrences, ≤5 added lines per edit (`daemon_cycle.py` → `BODY_AUTO_LINE_LIMIT`).
- `autoagent/daemon-apply.sh` auto-applies.
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
    - This project's live labels are `com.glass-atrium.*` — monitor, autoagent-daemon, daemon-daily-restart, …
    - A plist under any other label prefix is not matched by this path-pattern set.
  - frontmatter identity field (name / tools / scope) change
  - weakening of GLASS_ATRIUM_GLOBAL_RULES / core-security.md absolute rules, or any change to `core-learning-log.md` — the Tier-2 trigger list's own home
    - Honest backing for that last clause: POLICY, not a path matcher. The daemon's sensitive-PATH tuple carries no row for this file, and both of its consumers are handed an `agents/<name>.md` body path, so a benign edit to this file classifies auto — `autoagent/test/test_sensitive_patterns.py` → `RuleFileRowsAreOutOfReach` pins exactly that. The sensitive-DIFF axis is what still catches a patch here, because several trigger lines above are themselves command-shaped: re-adding one as a `+` line routes the patch to safety. Never reflow those lines for tidiness — a reflowed line is an added line.
- **non-safety quality issue** (rule-scope misapplication / minor instruction tuning, etc.) → absorbed by Tier 1 Auto + LLM retry — creating a user pending queue forbidden

> Cross-ref: this section is the **approval-rule canonical (SoT)** for the 2-tier policy · `skills/glass-atrium-ops-orchestrator.md` Self-Improvement User-Approval Trigger carries only the orchestrator-side operational delta (Monitoring-phase routing + dashboard surfacing) and points here

## Solution History (OPRO-style)

- Each instruction-improvement attempt is recorded as 3-tuple: `(instruction cell = agent + task_type, score 1–5, applied_date)`, plus a `directive_hint` field (`autoagent/daemon_cycle.py` → `SolutionAttempt`).
  - Honest backing: the generation path (`run_cycle` → `solution_attempt_from_outcome`) passes no hint, so `directive_hint` is empty today.
- Retention keeps the per-cell Pareto-nondominated frontier over (score, recency): multiple winners per cell survive, so an older-higher-score and a newer-lower-score variant both feed the next cycle. A cell with fewer than 5 attempts carries insufficient evidence and is dropped (`autoagent/daemon_cycle.py` → `retain_pareto_winners`).
  - Honest backing: the cross-cycle durable store does NOT exist. Retention runs within one cycle — every attempt shares an `applied_date`, so the recency objective is constant and cells rarely reach the 5-attempt floor — and lands in the cycle report only. Nothing yet carries a frontier into the next optimizer's context.

## Correction Signal Capture

- User corrections (rejection / "redo this" / "change it like this") = evaluative signal (-1) + directive signal.
- A raw correction is an **episodic** signal — session-scoped, discarded after the session.
- It does NOT enter long-term memory directly; only a fact distilled from it (when semantic) is persisted, under the Long-Term Memory Write-Gate below.

**Not a correction (negative example)**: continuation/urging/retry/status utterances that merely resume or push the SAME work forward (e.g. `진행해` / `이어서 진행해` / `계속` / `다시 이어서` / `resume` / `continue` / `try again to continue` / a status check) are NOT corrections — they MUST NOT fire `evaluative_signal: -1` / `revision_count` / `directive_hint`.
- These are the episodic one-off (retry / continue / status) signals already discarded by the Long-Term Memory Write-Gate's content-type condition below.
- Consistent wording in `core-outcome-record.md` → Correction-emission rule.

**Signal origin (agent-emitted, semantic — regex is legacy fallback only)**: the correction signal originates from the agent's `[COMPLETION]` emit.
- When the user's latest message corrected/rejected/asked-to-redo the work, the agent judges this SEMANTICALLY in ANY language and emits `revision_count` ≥ 1 + `evaluative_signal: -1` + `directive_hint` (per `core-outcome-record.md` Correction-emission rule).
- track-outcome.sh keys `core.correction_signals` on these emitted fields; a Korean/English keyword regex on the user message is a legacy fallback that fires only when NO correction field was emitted.
- The hook's prior+1 cross-outcome accumulation is currently STUBBED to 0 (DB-only tracking has no cwd/project key), so the agent-emitted `revision_count` is the effective numeric source until a project-keyed PG restoration lands — the agent fields are the trigger and, for now, the count.

**Procedure**:
1. Increment `revision_count` (transient session signal) — per **Signal origin** above, your emitted value is both the trigger and the effective count
2. Distill the directive into a one-line English `directive_hint` (transient session signal — NOT raw verbatim, NOT Korean, NOT a persistence target as-is)
3. **No auto-persistence to user-facing memory**: a correction signal NEVER auto-writes `feedback_*.md` / `MEMORY.md` in the personal memory dir — the aggregation exemption, the explicit-instruction condition and their honest backing: **Long-Term Memory Write-Gate** below
4. If confined to a specific agent → tag as an instruction-update candidate for that agent (independent of persistence — the tag is a transient routing signal, not a long-term memory write)

### Long-Term Memory Write-Gate

Repetition alone does NOT justify persistence. Before writing any `feedback_*.md` file or `MEMORY.md` line in the personal memory dir, the distilled signal MUST pass every condition below (AND — any failure → discard, no write):

- **explicit user instruction to remember (OVERRIDING gate)**: a user-facing memory write fires ONLY when the user explicitly instructed it to be remembered (e.g. `기억해` / `이거 기억해둬` / "remember this" / "save this to memory", judged semantically in ANY language).
  - The main session MUST NOT proactively/automatically persist memory, and the daemon MUST NOT auto-generate `feedback_*.md` from clustered `directive_hint`s — both auto-paths are FORBIDDEN.
  - Honest backing: the daemon auto-clustering path is NOT implemented in the current code (`hooks/learning-aggregator.py` carries no `directive_hint`→`feedback_*.md` clustering and no user-facing-memory-persistence logic), so the prohibition is a policy contract enforced by absence of the code path, not an in-code runtime gate — and the policy prohibition stands regardless.
  - This condition is necessary on its own: the conditions below — durable content-type, future-session relevance, not a semantic duplicate — stay required but are not SUFFICIENT without it.
- **content-type is durable**: the distilled fact ∈ {`preference`, `rule`, `project-fact`, `reusable-pattern`}. EPISODIC one-off task talk (retry / continue / permission-check / completion-ack / status-question) is NOT durable → discard.
- **future-session relevant**: an unrelated future session could change its behavior from this fact. Signals bound to one-off state (a since-deleted document, a point-in-time permission or progress status) fail this → discard.
- **not a semantic duplicate**: the fact is not already captured in indexed memory by MEANING (not raw-token match) → if a semantic duplicate exists, discard.

Beyond those conditions:

- **Persisted value**: a distilled English fact — a reusable, context-independent pattern, never the raw directive_hint, which is time- and context-bound and is the pollution source.
- **Language**: all persisted learning-log / memory record data is English (the user-facing reply language is separate).
- **Internal-vs-user-facing boundary**: the learning-log aggregation (`## Learning Log Auto-Aggregation` — instruction-improvement signal for the self-improvement loop) is NOT gated by the explicit-instruction condition — only writes to the user-facing personal memory dir (`feedback_*.md` + `MEMORY.md`) are.
