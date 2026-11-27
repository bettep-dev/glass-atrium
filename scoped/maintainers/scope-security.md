# Maintainer note — `scoped/scope-security.md`

Maintainer-facing material for that source file, and the record of text cut from it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the file's one heading carries its whole payload rather than a stub, so the source file takes no pointer back to this note.

## Status in the corpus

- **The source file is a Tier-2 safety trigger by path.** `autoagent/daemon_cycle.py` → `_SAFETY_SENSITIVE_PATH_PATTERNS` matches `(^|/)scope-security\.md$`, so any daemon-proposed edit to it enters the user-approval queue rather than auto-applying.
  - `autoagent/test/test_sensitive_patterns.py` → `_RETAINED_SENSITIVE` pins the path as a retained sensitive pattern; `scripts/test/glass-atrium-update.bats` names it in an update fixture.
  - The matcher and both suites are path-only and indifferent to the content.
- **This note's own path matches the same pattern.** `autoagent/test/test_sensitive_patterns.py` → `_REFUSED_MANIFEST_ROWS` lists both paths and compares that set with the manifest rows the matcher refuses.
  - Keep this note's path unchanged (no rename or move); a text edit is free.

## Delivery of the thresholds

- The source file is glass-atrium-sec-guard's `rules.scope` in `agent-registry.json`, so the part slots pack its thresholds into that agent's context whole at spawn; no body copy is owed.
  - Re-check delivery with `python3 hooks/lib/inject_chunk.py --audit`.
- What the body holds of each threshold:
  - The LLM01 BLOCK-vs-WARN split — only the detection criterion.
  - The LLM06 BLOCK-vs-WARN split — only the symptom.
  - The tool-authorization gate — nothing; it is stated nowhere else, and is the only BLOCK condition that keys on the definition's tool declaration alone.
- `agents/glass-atrium-sec-guard.md` carries no pointer to the source file:
  - A pointer would add no duty: the delivered file opens `Verdict thresholds for glass-atrium-sec-guard.`
  - No Read instruction either: `maxTurns: 3` at `effort: low` leaves no turn to locate or re-read a file already delivered.

## What the cut removed, and why

Each duty already lives at the site named, except the up-to-3 cap flagged below.

- **The `> **Loading**` / `> **Inherits**` / `> **See**` stanza and `Rules specific to SECURITY agents: …`** — membership lives on the registry row's `rules.scope`.
- **The `## Absolute Rules [SECURITY]` section** — all three bullets live in the delivered body:
  - Verdict-only role → `## Guardrails` · `## Deliverable Format`.
  - Conservative judgment → `## Guardrails` · `## Deliverable Format`.
  - Verdict + remediation hint → `## Deliverable Format`, which holds the defence layers and the no-code / no-API-names prohibition; its `short bullet list` carries no number, so the cut bullet's up-to-3 cap has no live site.
  - No signpost heading stands in its place: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution` makes the assigned scope file the final authority, the whole file and never a named section.
    - A heading over the verdict table would state no rule and label the wrong content.
- **`LLM07 System Prompt Leakage`** — the body's `## Assessment Criteria (OWASP LLM Top 10 Based)` line is near-verbatim and broader.
- **The section preamble relating these criteria to `rules/glass-atrium/core-security.md`** — `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution` settles the precedence it asserted.

## Shape note

- The tool-authorization gate stays a bullet beside the WARN/BLOCK table: its own condition is BLOCK-only, and a `—` cell would make a non-uniform rule look uniform.
  - A wider declaration takes its verdict from the LLM06 row, never from the gate: WARN, or BLOCK when that row's BLOCK condition also holds.
  - An uncertain reading reaches WARN through the `agents/glass-atrium-sec-guard.md` guardrail, never through the gate.
