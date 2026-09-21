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
- Pre-verify quality issue (rule-scope misapplication / failure to add ≤5-line body, etc.) → 1 Haiku LLM retry, then Auto if re-verification passes / reject if it fails
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

- Each instruction-improvement attempt is recorded as 3-tuple: `(instruction cell = agent + task_type, score 1–5, applied_date)`, carrying the reflective signal (`lesson` + `directive_hint`) the next cycle mutates on.
- Retention keeps the per-cell Pareto-nondominated frontier over (score, recency): multiple winners per cell survive, so an older-higher-score and a newer-lower-score variant both feed the next cycle. A cell with fewer than 5 attempts carries insufficient evidence and is dropped (`autoagent/daemon_cycle.py` → `retain_pareto_winners`).
  - Honest backing: the cross-cycle durable store does NOT exist. Retention runs within one cycle — every attempt shares an `applied_date`, so the recency objective is constant and cells rarely reach the 5-attempt floor — and lands in the cycle report only. Nothing yet carries a frontier into the next optimizer's context.
- Successful patches → CTM bucket via the tiered admission rule: high confidence admits immediately at the injectable floor (score ≥ 4); medium confidence stores a provisional sub-floor score (3, non-injectable) and promotes to the floor on corroborating re-observation (frequency ≥ 2); a `grader_verdict` of `verified_fail` never admits. Repeated failures (revision_count ≥ 2 OR result=fail) → EPM bucket.

## Memory Type Classification (CTM / EPM)

- **CTM** (Correct-Template Memory): reusable success patterns — tiered admission per task_type: a high-confidence variant enters at the injectable floor (score ≥ 4) immediately, a medium-confidence one enters provisional (sub-floor score 3) and promotes at frequency ≥ 2, and `grader_verdict=verified_fail` is never admitted
- **EPM** (Error-Pattern Memory): repeated failure patterns — revision_count ≥ 2 or result=fail accumulations
- New task start → query CTM for similar success examples + EPM for patterns to avoid
- Both buckets are labelled sub-sections (`### CTM` / `### EPM`) of the `memory/core-learning-log.md` narrative; the runtime store is the separate JSON file described below.
- **Episodic vs semantic boundary**: episodes are session-scoped, lessons are durable — only a distilled `lesson` enters CTM. That accumulation is internal self-improvement signal and is exempt from the Long-Term Memory Write-Gate below, which binds USER-FACING memory only.

> **Four-position lockstep — do NOT de-duplicate the tiered admission rule.** It is stated deliberately at four contract positions: the Solution-History routing bullet, the CTM definition bullet above, the lesson-store intro paragraph below, and the spawn-time-injection bullet below. `hooks/test/test_lesson_store_integrity.py` (`DocLockstep`) reads this file and asserts that each of those four lines still states the tiered rule on ONE physical line, and that no stale score-only phrasing remains. Collapsing the four into a single site fails that test — the repetition is a machine-checked contract, not accidental duplication.

### CTM/EPM Lesson Store (size-capped, consolidation-op ingest)

The runtime CTM/EPM buckets are materialized as a machine-readable lesson store — a JSON file the learning-aggregator writes (`hooks/learning-aggregator.py`, `ingest_outcome_lessons`) and the spawn-time injector reads (`hooks/inject-scope-rules.sh`). This is the operational store distinct from the human-readable `memory/core-learning-log.md` narrative; both hold the same CTM (tiered success admission: high immediate at the injectable floor, medium provisional sub-floor until corroborated at frequency ≥ 2, `verified_fail` excluded) / EPM (failure) lesson classification.

- **AD-1 — size-capped labeled blocks**: each bucket carries a per-bucket char cap (`CTM_BUCKET_MAX_CHARS` / `EPM_BUCKET_MAX_CHARS`, 4000 each).
  - On overflow, `enforce_bucket_cap` evicts with a digest: tombstoned dead-weight goes first, then live entries ascending by (score, frequency), until the ACTIVE (non-tombstoned) lesson-text sum is ≤ cap. The hook holds no LLM, so the evicted set leaves a count/tag digest footer rather than a true summary.
  - **Invariant**: a bucket's active size never exceeds its cap.
  - Capacity eviction is the SOLE hard-removal path, and is distinct from the AD-2 tombstone below (staleness, not capacity).
- **AD-2 — consolidation ops on ingest**: lesson ingest is ADD / UPDATE / MERGE / TOMBSTONE — NEVER a hard-delete.
  - A DUPLICATE lesson (same agent + task_type + numeric/case/space-normalized text) bumps frequency and keeps the max score (`UPDATE`); it never appends a new row.
  - A re-observed tombstoned lesson resurrects (`MERGE`).
  - A STALE lesson is soft-deleted via `tombstone_lesson` (row retained, `tombstoned: true`), excluded from injection and the active-cap sum but resurrectable.
- **AD-3 — spawn-time lesson injection**: on SubagentStart, `inject-scope-rules.sh` injects the current agent's top-K (K=5) live CTM lessons (score ≥ 4 — the injectable floor; a provisional medium lesson sits below it at sub-floor score 3 until its frequency ≥ 2 promotion) + EPM warnings, agent-matched, hard-capped at `LESSON_MAX_BYTES` (1200 B), as the LOWEST-priority (first-dropped) injection block so the proven scope blocks always win the ~9984 B assembly ceiling.
  - Matching is agent-keyed because task_type is not known at spawn (the envelope carries only agent_type); each lesson carries its task_type as an inline tag.
  - A no-match spawn (or absent store) is left unchanged (fail-open).

## Correction Signal Capture

User corrections (rejection / "redo this" / "change it like this") = evaluative signal (-1) + directive signal. A raw correction is an **episodic** signal — session-scoped, discarded after the session. It does NOT enter long-term memory directly; only its distilled `lesson` (when semantic) is persisted (see Long-Term Memory Write-Gate below).

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
3. **No auto-persistence to user-facing memory**: a correction signal NEVER auto-writes `feedback_*.md` / `MEMORY.md` in the personal memory dir. Internal CTM/EPM accumulation (`memory/core-learning-log.md`) may still record the distilled pattern, but a user-facing write requires the explicit user instruction — condition and honest backing both in **Long-Term Memory Write-Gate** below
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

- **Persisted value**: the distilled English `lesson` — a reusable, context-independent pattern (see `core-outcome-record.md` Field Input Guide → `lesson`), never the raw directive_hint, which is time- and context-bound and is the pollution source. Episodes are dropped; only lessons are kept.
- **Language**: all persisted learning-log / memory record data is English (the user-facing reply language is separate).
- **Internal-vs-user-facing boundary**: internal CTM/EPM learning under `memory/core-learning-log.md` (instruction-improvement signal for the self-improvement loop) is NOT gated by the explicit-instruction condition — only writes to the user-facing personal memory dir (`feedback_*.md` + `MEMORY.md`) are.
