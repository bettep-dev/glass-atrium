# Maintainer note — `rules/glass-atrium/core-learning-log.md`

Corpus-maintenance companion to that Tier-1 rule file. The rule file reaches every agent on the host channel; this note reaches none. Read it before editing the rule file, `hooks/learning-aggregator.py` or the daemon's approval tiers; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Coupled readers

- `autoagent/test/test_tier1_rule_parity.py` reads the span from `**Tier 1 — Auto (default)**:` up to `**Tier 2 — Safety**:`.
  - Each bound appears exactly once in the file.
  - The span carries `no generator call` and `no auto-apply until live trials`, and never `auto-applies`.
  - Every `` `<file>.py` → `<symbol>` `` anchor in the span resolves to a top-level definition in `autoagent/daemon_cycle.py` or `scripts/_pg_dual_write_daemon.py`.
- `autoagent/test/test_sensitive_patterns.py` → `RuleFileRowsAreOutOfReach` names the file's path, not its text, as a row the daemon's sensitive-path matchers never refuse; both matcher consumers are handed an `agents/<name>.md` body path.
  - Renaming the file is a multi-site edit.
  - So the trigger clause "any change to `core-learning-log.md`" is policy, not a path matcher: a benign edit to the rule file classifies auto.
- `autoagent/daemon_cycle.py` → `_SAFETY_SENSITIVE_DIFF_PATTERNS`: the command-shaped Tier-2 trigger lines match its diff patterns, and its comment names the clause line as a residual fire.
  - A patch re-adding one of those lines as a `+` line routes to safety, so keep every trigger line byte-identical when editing — a reflowed line is an added line.
- Aggregation table numbers: `hooks/learning-aggregator.py` → `AUTO_FAILURE_THRESHOLD` (3) and its revision-average floor (2) are the table's two triggers.
  - `hooks/_outcome_signal.py` → `NEGATIVE_REVISION_MIN` and `monitor/public/src/screens/outcomes.jsx` cite the "revision_count 2+" bar.
  - Change the table with them.
- Correction signal: `hooks/track-outcome.sh` keys `core.correction_signals` on the three correction fields; a Korean/English keyword regex on the user message is a legacy fallback that fires only when no correction field was emitted.
- Write-Gate overriding gate: no daemon auto-clustering path exists (`hooks/learning-aggregator.py` carries no `directive_hint`→`feedback_*.md` clustering), so on that path the gate is held by the absence of code, not by a runtime check.
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Learning Log & Correction Signal [ALL]` states the ban this backing holds; the backing itself lives only here.
- Cited headings: `## Learning Log Auto-Aggregation`, `## Instruction Improvement Approval Tier`, `## Correction Signal Capture` and `### Long-Term Memory Write-Gate` are each cited from skills, agent bodies, code comments or other rule files.
  - Grep the corpus before renaming one.

## Specs with no agent reader

The spec below binds aggregator code, never an agent.

- **Duplicate-append prevention**: if the same pattern + agent combo already exists, update its frequency only — never append a second entry.
  - Backing: `hooks/learning-aggregator.py` UPSERTs `core.learning_log` keyed on `pattern_signature`.
