# Learning Log & Correction Signal Rules (Cross-Cutting Concern)

Applies to all agents. [ALL]

## Learning Log Auto-Aggregation

- Auto-extract patterns from accumulated Outcome Records:
  - Same agent fails 3+ times → Tag as instruction improvement candidate
  - Same task_type average revision_count 2+ → Process improvement target
- Extracted patterns auto-recorded in `memory/core-learning-log.md` (duplicate pattern append prevention: if same pattern + agent combo already exists, update frequency only)
- Instruction improvement approval = 2-tier (Auto + Safety) — see "Instruction Improvement Approval Tier" section below
- Each tier MAY generate up to 3 candidate variants (EvoPrompt-style) — chosen variant goes to apply, non-chosen variants logged to Solution History for future cycle reference

## Instruction Improvement Approval Tier

The self-improvement loop (daemon_cycle.py) user-approval queue is **safety-only**. The spec is 2-tier (auto + safety).

**Tier 1 — Auto (default)**:
- Regular instruction improvements (single agent, 5+ occurrences, 1-line change basis)
- daemon-apply.sh auto-applies
- Conditions: classification == "apply" + haiku_status == "ok" + diff non-empty + non-safety scope
- Pre-verify quality issue (rule-scope misapplication / failure to add ≤5-line body, etc.) → 1 Haiku LLM retry, then Auto if re-verification passes / reject if it fails (entry into the user queue forbidden)

**Tier 2 — Safety**:
- **trigger** — irreversible + external-effect only (reuses the `core-security.md` "High-impact actions" definition):
  - file deletion / DB drop (`rm` · `DROP TABLE`)
  - external network call (external host API)
  - git push --force / rebase published branch
  - security-permission change (chmod / TCC / launchctl bootstrap)
  - monitor plist change (com.claude.monitor / autoagent-daemon)
  - frontmatter identity field (name / tools / scope) change
  - weakening of GLASS_ATRIUM_GLOBAL_RULES / core-security.md absolute rules
- **non-safety quality issue** (rule-scope misapplication / minor instruction tuning, etc.) → absorbed by Tier 1 Auto + LLM retry — creating a user pending queue forbidden

> Cross-ref: this section is the **approval-rule canonical (SoT)** for the 2-tier policy · `orchestrator-role.md` Self-Improvement User-Approval Trigger carries only the orchestrator-side operational delta (Monitoring-phase routing + dashboard surfacing) and points here

## Solution History (OPRO-style)

- Each instruction-improvement attempt is recorded as 3-tuple: `(instruction_version, score 1–5, applied_date)`.
- Top-20 entries (sorted ascending by score) provided as meta-context for the next optimization cycle — ascending order maximizes in-context learning effect.
- Successful patches (score ≥ 4) → CTM bucket. Repeated failures (revision_count ≥ 2 OR result=fail) → EPM bucket.

## Memory Type Classification (CTM / EPM)

- **CTM** (Correct-Template Memory): reusable success patterns — instruction variants that achieved score ≥ 4 on a given task_type
- **EPM** (Error-Pattern Memory): repeated failure patterns — revision_count ≥ 2 or result=fail accumulations
- New task start → query CTM for similar success examples + EPM for patterns to avoid
- Both buckets stored in `memory/core-learning-log.md` under labelled sub-sections (`### CTM` / `### EPM`); separate files NOT required at this stage
- **Episodic vs semantic boundary**: episodes are session-scoped, lessons are durable — only a distilled `lesson` enters CTM (internal `memory/core-learning-log.md`). CTM/EPM accumulation is internal self-improvement signal and is NOT subject to the Long-Term Memory Write-Gate's explicit-user-instruction condition — that condition gates only USER-FACING memory (`feedback_*.md` + `MEMORY.md` in the personal dir). See Correction Signal Capture + Long-Term Memory Write-Gate below.

## Correction Signal Capture

User corrections (rejection / "redo this" / "change it like this") = evaluative signal (-1) + directive signal. A raw correction is an **episodic** signal — session-scoped, discarded after the session. It does NOT enter long-term memory directly; only its distilled `lesson` (when semantic) is persisted (see Long-Term Memory Write-Gate below).

**Not a correction (negative example)**: continuation/urging/retry/status utterances that merely resume or push the SAME work forward (e.g. `진행해` / `이어서 진행해` / `계속` / `다시 이어서` / `resume` / `continue` / `try again to continue` / a status check) are NOT corrections — they MUST NOT fire `evaluative_signal: -1` / `revision_count` / `directive_hint`. These are the episodic one-off (retry / continue / status) signals already discarded by the Long-Term Memory Write-Gate's content-type condition below; consistent wording in `core-outcome-record.md` → Correction-emission rule.

**Signal origin (agent-emitted, semantic — regex is legacy fallback only)**: the correction signal originates from the agent's `[COMPLETION]` emit. When the user's latest message corrected/rejected/asked-to-redo the work, the agent judges this SEMANTICALLY in ANY language and emits `revision_count` ≥ 1 + `evaluative_signal: -1` + `directive_hint` (per `core-outcome-record.md` Correction-emission rule). track-outcome.sh keys `core.correction_signals` on these emitted fields; a Korean/English keyword regex on the user message is a legacy fallback that fires only when NO correction field was emitted. The hook's prior+1 cross-outcome accumulation is currently STUBBED to 0 (DB-only tracking has no cwd/project key), so the agent-emitted `revision_count` is the effective numeric source until a project-keyed PG restoration lands — the agent fields are the trigger and, for now, the count.

**Procedure**:
1. Increment revision_count (transient session signal) — the hook's prior+1 accumulation is currently stubbed to 0 (no project-safe key in DB-only mode), so the agent-emitted value is the effective count; the agent emit is the trigger
2. Distill the directive into a one-line English `directive_hint` (transient session signal — NOT raw verbatim, NOT Korean, NOT a persistence target as-is)
3. **No auto-persistence to user-facing memory**: a correction signal NEVER auto-writes `feedback_*.md` / `MEMORY.md` in the personal memory dir. The daemon `directive_hint`→`feedback_*.md` auto-clustering path is NOT implemented in the current code — no such clustering / user-facing-memory-persistence logic exists in learning-aggregator.py — so the prohibition holds by absence of the code path, not by a runtime gate; the policy prohibition stands regardless. Internal CTM/EPM accumulation (`memory/core-learning-log.md`) may still record the distilled pattern, but writing user-facing memory requires an explicit user instruction to remember — see Long-Term Memory Write-Gate condition 4.
4. If confined to a specific agent → tag as an instruction-update candidate for that agent (independent of persistence — the tag is a transient routing signal, not a long-term memory write)

### Long-Term Memory Write-Gate

Repetition alone does NOT justify persistence. Before writing any `feedback_*.md` file or `MEMORY.md` line in the personal memory dir, the distilled signal MUST pass all FOUR conditions (AND — any failure → discard, no write):

- **explicit user instruction to remember (OVERRIDING gate)**: a user-facing memory write fires ONLY when the user explicitly instructed it to be remembered (e.g. `기억해` / `이거 기억해둬` / "remember this" / "save this to memory", judged semantically in ANY language). The main session MUST NOT proactively/automatically persist memory, and the daemon MUST NOT auto-generate `feedback_*.md` from clustered `directive_hint`s — both auto-paths are FORBIDDEN (the daemon auto-clustering path is NOT implemented in the current code: no `directive_hint`→`feedback_*.md` clustering / user-facing-memory-persistence logic exists in learning-aggregator.py, so the prohibition is a policy contract enforced by absence of the code path, not an in-code runtime gate). This condition is necessary on its own: the three conditions below stay required but are not SUFFICIENT without it.
- **content-type is durable**: the distilled fact ∈ {`preference`, `rule`, `project-fact`, `reusable-pattern`}. EPISODIC one-off task talk (retry / continue / permission-check / completion-ack / status-question) is NOT durable → discard.
- **future-session relevant**: an unrelated future session could change its behavior from this fact. Signals bound to one-off state (a since-deleted document, a point-in-time permission or progress status) fail this → discard.
- **not a semantic duplicate**: the fact is not already captured in indexed memory by MEANING (not raw-token match) → if a semantic duplicate exists, discard.

The persisted value is the distilled English `lesson` (a reusable, context-independent pattern — see `core-outcome-record.md` Field Input Guide → `lesson`), never the raw directive_hint (which is time- and context-bound = the pollution source). Episodes are dropped; only lessons are kept. All persisted learning-log / memory record data is English (the user-facing reply language is separate). **Internal-vs-user-facing boundary**: internal CTM/EPM learning under `memory/core-learning-log.md` (instruction-improvement signal for the self-improvement loop) is NOT gated by the explicit-instruction condition — only writes to the user-facing personal memory dir (`feedback_*.md` + `MEMORY.md`) are.
