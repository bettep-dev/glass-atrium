# Maintainer note — `rules/glass-atrium/core-learning-log.md`

Corpus-maintenance companion to that Tier-1 rule file; this note reaches no agent. Read it before editing the rule file, `hooks/learning-aggregator.py` or the daemon's approval tiers; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Coupled readers

- `autoagent/test/test_tier1_rule_parity.py` reads the span from `**Tier 1 — Auto (default)**:` up to `**Tier 2 — Safety**:` and pins it to the daemon code it describes.
  - Present: the anchors of what the cycle ships (`run_trial_stage`, `run_graduation_stage`, `regression_gate_live_enabled`) and the gate's opt-in env var.
  - Equal to the code constants: the added-line cap, the `haiku_status` prefix and the safety-routed storage tier.
  - Every `` `<file>.py` → `<symbol>` `` anchor resolves to a top-level definition; every cited `daemon_cycle.py` function has a production caller.
  - Its stale-claim scan runs a fixed list of retired literals over the whole `## Instruction Improvement Approval Tier` section and fails on any hit: the generation-closed and no-auto-apply wording, and the `_GENERATION_CLOSED_REASON` text.
    - Each list rides on a code fact the row also asserts — `run_cycle` reaching generation or graduation, or the closed-rationale writer having no production caller — so a row fails once its fact no longer holds.
    - A contradicted claim outside the list passes it.
  - It pins each span bound to one occurrence — the two Tier markers above, `## Instruction Improvement Approval Tier` and `## Correction Signal Capture` — so renaming either heading fails it.
  - It pins the Tier-2 trigger lines byte-identical.
- `autoagent/test/test_sensitive_patterns.py` → `RuleFileRowsAreOutOfReach` names the file's path, not its text, as a row the daemon's sensitive-path matchers never refuse; both matcher consumers are handed an `agents/<name>.md` body path.
  - Renaming the file is a multi-site edit.
  - So the trigger clause "any change to `core-learning-log.md`" is policy, not a path matcher: a benign edit to the rule file classifies auto.
- `autoagent/daemon_cycle.py` → `_SAFETY_SENSITIVE_DIFF_PATTERNS`: the command-shaped Tier-2 trigger lines match its diff patterns, and its comment names the clause line as a residual fire.
  - A patch re-adding one of those lines as a `+` line routes to safety, so keep every trigger line byte-identical when editing — a reflowed line is an added line.
- Aggregation table numbers: `hooks/learning-aggregator.py` → `AUTO_FAILURE_THRESHOLD` and `_get_fleet_emits` (the revision-average floor) are the table's two triggers.
  - `hooks/_outcome_signal.py` → `NEGATIVE_REVISION_MIN` and `monitor/public/src/screens/outcomes.jsx` cite the "revision_count 2+" bar.
  - Change the table with them.
- Correction signal: `hooks/track-outcome.sh` keys `core.correction_signals` on the three correction fields; a Korean/English keyword regex on the user message is a fallback that fires only when no correction field was emitted.
- Write-Gate overriding gate: on the daemon path the gate is held by the absence of code, not by a runtime check — `hooks/learning-aggregator.py` carries no `directive_hint`→`feedback_*.md` clustering.
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Learning Log & Correction Signal [ALL]` states the ban; this note is the backing's only site.
- Cited headings: `## Learning Log Auto-Aggregation`, `## Instruction Improvement Approval Tier` and `### Long-Term Memory Write-Gate` are cited from skills, agent bodies, code comments and maintainer notes.
  - Grep the corpus before renaming one.
