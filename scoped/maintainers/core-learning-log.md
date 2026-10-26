# Maintainer note — `rules/glass-atrium/core-learning-log.md`

Corpus-maintenance companion to that Tier-1 rule file. The rule file reaches every agent on the host channel; this note reaches none. Read it before editing the rule file, `hooks/learning-aggregator.py` or the daemon's approval tiers; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Coupled readers

- `autoagent/test/test_tier1_rule_parity.py` reads the span from `**Tier 1 — Auto (default)**:` up to `**Tier 2 — Safety**:`.
  - Each bound appears exactly once in the file.
  - The span carries `no generator call` and `no auto-apply until live trials`, and never `auto-applies`.
  - Every `` `<file>.py` → `<symbol>` `` anchor in the span resolves to a top-level definition in `autoagent/daemon_cycle.py` or `scripts/_pg_dual_write_daemon.py`.
- `autoagent/test/test_sensitive_patterns.py` names the file's path, not its text, as a row the daemon's sensitive-path matchers never refuse, so renaming the file is a multi-site edit.
- `autoagent/daemon_cycle.py` → `_SAFETY_SENSITIVE_DIFF_PATTERNS`: the command-shaped Tier-2 trigger lines match its diff patterns. That match is why the rule file forbids reflowing them.
- Cited headings: `## Learning Log Auto-Aggregation`, `## Instruction Improvement Approval Tier`, `## Correction Signal Capture` and `### Long-Term Memory Write-Gate` are each cited from skills, agent bodies, code comments or other rule files. Grep the corpus before renaming one.
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` names the Write-Gate as "4-condition", so a fifth condition or a dropped one is a co-edit there.

## Specs with no agent reader

Moved out of the rule file: each binds aggregator or daemon code, never an agent.

- **Duplicate-append prevention**: if the same pattern + agent combo already exists, update its frequency only — never append a second entry.
  - Backing: `hooks/learning-aggregator.py` UPSERTs `core.learning_log` keyed on `pattern_signature`.
- **Candidate variants**: each tier MAY generate up to 3 variants; the chosen variant goes to apply, and the rest are not kept.
  - Honest backing: a spec, not running code — the generation loop builds one proposal per candidate agent (`autoagent/daemon_cycle.py` → `_run_generation_loop`), so no non-chosen variant exists.

## Restructure + diet pass — dispositions

- The aggregation sink line now names `core.learning_log`: the aggregator writes PostgreSQL only, and the daemon neither reads nor writes a learning-log markdown file.
- The **Approval** pointer to the next section was dropped as a dup-in of that section's own opening line.
- **Not a correction (negative example)** was dropped: its literal list and the three fields it must not fire are canonical in `rules/glass-atrium/core-outcome-record.md` → **Correction-emission rule**, which reaches the same reader, and **Signal origin** already points there.
- **Signal origin** lost its emission restatement, the STUBBED-accumulation line and the lead's "regex is legacy fallback only" clause.
  - The first two are canonical in `core-outcome-record.md` (**Correction-emission rule**, `#### Correction fields`); the clause restated the sub-bullet.
  - The keyword-regex fallback sub-bullet stayed — it has no other site.
- **Procedure** was dropped. Its first two steps restated the `revision_count` / `directive_hint` field rules; the third restated the Write-Gate; the fourth (tag an instruction-update candidate) named a tag no field carries and no code reads.
- Write-Gate: the auto-path ban, the "not SUFFICIENT without it" line, **Language** and **Internal-vs-user-facing boundary** were dropped.
  - The AND lead already makes each condition necessary.
  - `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Learning Log & Correction Signal [ALL]` carries the ban, its absence-of-code backing and the aggregation exemption; `### Output Language` and **Persisted value** carry English.
  - Kept: the honest-backing line naming `hooks/learning-aggregator.py`, which `scoped/maintainers/GLASS_ATRIUM_GLOBAL_RULES.md` relies on this file to carry.
- Approval tiers: the Tier-1 span and every Tier-2 trigger line are byte-identical. The path-matcher honest backing (one bullet over the 300-char cap) was split into sub-bullets at its sentence boundaries, and its claims and the "Never reflow" duty are unchanged.
  - "Never reflow" stays in the rule file: it binds whoever edits the trigger list, and a pointer stating it would be as long as the rule.
