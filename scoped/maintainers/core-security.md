# Maintainer note — `rules/glass-atrium/core-security.md`

Corpus-maintenance companion to that Tier-1 rule file. The rule file reaches every agent on the host channel; this note reaches none. Read it before editing the rule file or building a runtime per-agent tool-grant layer; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no stub heading and no pointer to this note.

## Coupled readers

- No test reads the rule file's body text.
- Path readers — renaming the file is a multi-site edit:
  - `autoagent/test/test_sensitive_patterns.py` names the path as a row the daemon's sensitive-path matchers never refuse.
  - `autoagent/test/test_aa_harness.py` uses the path as a hashed rule-file row.
  - `monitor/test/architecture.governance-membership.unit.test.ts` reads the real compliance matrix and asserts it declares the path.
  - `scripts/test/ci-change-filter-coverage.bats` names it as a bash-filter path.
  - `scripts/test/glass-atrium-update.bats` seeds the path as a release row the updater must apply.
  - `scripts/test/mirror-farm.bats` drives the path through the merge-claimed-path classifiers.
  - `hooks/test/inject-scope-chunker.bats` puts the path in a fixture registry row and asserts the part slots never deliver it.
  - Fixtures and comments only — they name the bare file or an old path, so a rename leaves them green but stale:
    - `hooks/test/validate-compliance-matrix.bats` (temp-dir rules tree) · `scripts/fixtures/retired-seed.json` (the retired `rules/core-security.md` path).
    - `autoagent/test/test_dead_reference_guard.py` (dead-reference strings) · `hooks/test/corpus/*.js` · `test/comment-audit/fixtures/fx-extref.*`.
    - Comments in `test/ga-db-sql-binding.bats` and `test/deps-preflight-noninteractive.bats`.
  - Before renaming, grep `core-security.md` across `scripts/test`, `hooks/test`, `autoagent/test`, `monitor/test`, `test` and `scripts/fixtures`; this list goes stale as tests change.
- Cited phrases — grep the corpus before rewording one:
  - "High-impact actions": `autoagent/daemon_cycle.py`, `autoagent/daemon-apply.sh`, `rules/glass-atrium/core-learning-log.md` (the Tier-2 trigger reuses the definition) and `rules/glass-atrium/shared-self-improve-hygiene.md`.
  - **Prompt Injection Refusal**: `rules/glass-atrium/core-wiki-reference.md` → its untrusted-data clause, which is machine-extracted.
  - `## Secret Management`, `## Input Validation`, `## Execution Security`, `## Dependency Auditing`, `## Agent Tool Authorization [LLM06:2025]` → `### Enforcement boundary`, Unbounded consumption: hook and script comments, agent bodies under `agents/` and other maintainer notes.

## Runtime per-agent tool-grant layer — why it is not built

The rule file states only that the layer is not implemented. The rationale and the entry gate for building it:

- Not because the caller is unidentifiable: the caller's `agent_type` is recoverable at pre-tool time from the `agent-<agent_id>.meta.json` sidecar, even though the `tool_use` envelope carries only an opaque `agent_id`.
  - `hooks/block-doc-routing-leak.sh` blocks on it; `hooks/advisory-subagent-budget.sh` only advises.
- That recovery fails open (missing sidecar / unresolved anchor / absent `jq` → empty type → the call proceeds), so a layer built on it is detective, never preventive.
  - The one blocking use is a single hardcoded file-routing rule keyed on two agent types, not a per-agent tool-grant allowlist.
- Deferred, not impossible: the entry gate is a measurement of sidecar-resolution success across real spawns, which does not exist yet.

## Restructure + diet pass — dispositions

- `### Enforcement boundary`:
  - The per-agent layer's rationale moved here (no agent acts on it). The rule file keeps the not-implemented lead as its honest backing.
  - "Each bullet's verdict covers its own object alone" was dropped: each bullet already states its own object.
  - The not-implemented lead lost its "and not because the caller is unidentifiable" tail with the sidecar sub-bullets moved here; it now ends by naming the absent layer — no hook adds a per-agent tool-grant check on top of the spawn-time freeze.
  - The critical-FILE layer now matches `hooks/enforce-harness-critical.sh` → its header list: the matcher names MultiEdit, and the live `~/.glass-atrium/` hooks and scheduled-execution dirs were added to the protected surfaces.
- `## OWASP LLM Top 10 (2025) Reference` was dropped. Its one line was a navigation note that obliged no reader, and no site cited the heading. All ten `[LLMxx:2025]` tags stay inline at their rules.
- Input Validation: the command/query/dynamic-code ban now reads "built from user input … enters only as bound data". The old "based on user input" wording read as banning every query that carries user input, which conflicts with the parameterized-binding bullet.
- Shape caps:
  - **Prompt Injection Refusal**, **Runtime critical-FILE layer** and the OWASP Top 10 bullet each went over 300 chars and were split at clause boundaries.
  - Two rebuttal cells went over 120 chars and were compressed; the in-file "(Agent Tool Authorization)" pointer was dropped from one of them.
  - The rate-limit sentence became a sub-bullet of **Unbounded consumption** (one line, one rule).
- Caps: emphasis capitals outside bolded leads were lowercased (freezes, live, every, and, new, per-file, not). Constraint modals (MUST, REQUIRED, FORBIDDEN, STRICTLY FORBIDDEN) were kept.
- `## Secret Management` is unchanged: secrets is a fragile operation, so its wording stays.
  - Recorded pair: its read ban, handoff ban and masking line overlap `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Absolute Rules [ALL]`.
  - Classed canonical + mirror: this file is the security canonical that overrides the other ALL rules, and the charter copy sits in the frozen `agents/` tree.
