# Maintainer note — `scoped/shared-turn-budget.md`

Corpus-maintenance companion to that source file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Status in the corpus

- No tier membership and no matrix row → `rules/glass-atrium/core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)` → the `scoped/shared-turn-budget.md` is an injection-text source only bullet.
- `hooks/validate-compliance-matrix.sh` → `EXEMPT_FILES` carries the file for that reason, so its Layer A drift check skips it.
  - Keep it on that list; `hooks/test/validate-compliance-matrix.bats` fixtures the exemption.

## Rosters

- Roster curation and where the arrays live → `rules/glass-atrium/core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)`.
- Delivering the source file wholesale to a DEV agent would ship it the analysis block, whose roster has no DEV member.

## The meter block, and why it stays a shell literal

- The rejected marker-block refactor, its blocker and what landing it takes → `hooks/inject-scope-rules.sh` → the `build_meter_block` header comment.
- That comment cites the source file's `## Meter block` heading as its reciprocal pointer, so the heading stays.
- Why the source file bars a dormant meter copy: a copy no code reads is a drift surface.

## Readers and coupled tests

- Marker readers:
  - `hooks/inject-scope-rules.sh` → `BUDGET_SRC_FILE` (overridable by env for tests) → `extract_block`.
  - `autoagent/daemon_cycle.py` → `_read_marker_block`, its deliberate mirror.
- A broken or renamed marker empties the block silently at the hook (fail-open).
- These suites read the live file and catch that:
  - `hooks/test/inject-scope-rules-nodrop.bats`: a first-line needle per block, plus a hard byte bound on the DEV block.
  - `hooks/test/inject-scope-single-delivery.bats`: the same needles, counted per agent.
  - `autoagent/test/test_pre_verify_budget_injection.py`: each block non-empty, both readers agreeing.
- The needle and non-empty checks survive almost any rewording, so no test backs the source file's by-hand re-compression of the policy.
- `hooks/test/h2-untrusted-ingest.bats` and `hooks/test/inject-scope-rules-canary.bats` only spawn the hook against the live file.
- `hooks/test/inject-scope-rules.bats` does not read it — it synthesizes its own two-marker fixture.
- The byte-budget guard comments stay in the source file, above the blocks they cap, because that is where the edit that would breach the cap happens.
