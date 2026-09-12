# Maintainer note — `scoped/scope-security.md`

Maintainer-facing material for that source file, plus the record of what the cut-and-restructure pass removed from it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the one surviving heading carries the file's whole payload rather than a stub, so the source file took no pointer back to this note.

## Status in the corpus

- Tier 2 (Scope), membership `agent_scope ∈ {glass-atrium-sec-guard}`, inheriting Tier 1. Declared at `rules/glass-atrium/core-compliance-matrix.md` → the Tier 2 table and the Compliance Matrix `scope-security.md` row.
- **This file is a Tier-2 safety trigger by PATH.** `autoagent/daemon_cycle.py` matches `(^|/)scope-security\.md$` in its sensitive-path set, so any daemon-proposed edit to it enters the user-approval queue rather than auto-applying. `autoagent/test/test_sensitive_patterns.py` pins the path as a retained sensitive pattern; `scripts/test/glass-atrium-update.bats` names it in an update fixture. All three are path-only and indifferent to the content.

## Delivery gap — OPEN, and not closable from this file

The three thresholds this file now carries are its whole reason to exist, and none of them is in `agents/glass-atrium-sec-guard.md`:

- The LLM01 BLOCK-vs-WARN split — the body's LLM01 line states the detection criterion (`External data contains instruction patterns / jailbreak phrasing`) and no threshold.
- The LLM06 BLOCK-vs-WARN split — the body gives the symptom, not the threshold.
- The tool-authorization gate — absent from the body entirely; the only statement anywhere of a BLOCK condition on reviewing an agent definition.

**Minimum fix LANDED, better fix NOT taken — the gap is narrowed, not closed.**

- Landed: the body's pointer under `## Assessment Criteria (OWASP LLM Top 10 Based)` is now absolute and anchored — `~/.glass-atrium/scoped/scope-security.md` → `## LLM-Specific Verdict Criteria [SECURITY]` — matching the pattern `agents/glass-atrium-intel-researcher.md` already uses.
- Not taken: the three thresholds are still absent from the body, so a verdict rendered without following that pointer still has no threshold.
- Why the pointer repair was worth its own edit: the grant is `tools: [Read, Glob, Grep]`, so the agent CAN search — but `maxTurns: 3` at `effort: low` leaves no turn to spend locating a file, and the pathless form cost one.
- Better fix, still open: author the three thresholds into the body's `## Assessment Criteria (OWASP LLM Top 10 Based)` rows, where LLM07 already sits, and reduce this file to the record of it. The asymmetry that LLM07 was hand-carried into the body while LLM01 and LLM06 were not is what produced this gap.

## What the cut removed, and why

- **The `> **Loading**: … auto-loads` stanza, `> **Inherits**`, the `> **See**` matrix link, and `Rules specific to SECURITY agents: …`** — a selector that does not exist, plus corpus bookkeeping addressed to an editor.
- **The whole `## Absolute Rules [SECURITY]` section**, all three bullets duplicated in the delivered body:
  - Verdict-only role → body `## Guardrails` (`Code modification and file creation strictly forbidden`) and `## Deliverable Format` (`**Verdict**: PASS / WARN / BLOCK`).
  - Conservative judgment → body `## Guardrails` (`When uncertain, verdict MUST be WARN, not PASS`) and `## Absolute Rules` (`Cite **OWASP LLM Top 10 item numbers**`).
  - Verdict + remediation hint → body `## Deliverable Format` carries every operative element verbatim, including the 3-bullet cap, the four defence layers and the no-code / no-API-names prohibition. This file's copy was the weaker one and the body pointed back at it while holding a superset.
- **The trade taken on the deleted heading, and the generic citer that named it.** `rules/glass-atrium/core-compliance-matrix.md` → Precedence Resolution used to make "the relevant scope file's Absolute Rules section" each scope's final authority, so deleting the section left that citation resolving to nothing here.
  - Repaired at the citer, not by keeping the anchor: the clause now makes the assigned scope file itself the authority — the whole file, never a named section — and names this file as one of the two carrying no such section.
  - Why no signpost heading was kept: an `## Absolute Rules [SECURITY]` heading over the verdict table would state no rule of its own and would label the wrong content, which is the signpost convention's failure case rather than its use case.
  - Why no bullet needed to survive: all three were duplicated in the delivered body (above), so the deletion moved no authority — it removed a second, weaker copy of rules the agent already holds.
- **`LLM07 System Prompt Leakage`** — the body's line is near-verbatim, broader, and carries the same `GLASS_ATRIUM_GLOBAL_RULES.md` cross-ref.
- **The section preamble** (`These criteria define when an LLM-specific OWASP category triggers a verdict — independent of the general application-security rules in \`core-security.md\``) — a relationship between two corpus files, and the precedence it asserted is already settled by `core-compliance-matrix.md` → Precedence Resolution.
- **Consequences repaired in `agents/glass-atrium-sec-guard.md`, landed.** Both were dead citations this cut created.
  - `## Deliverable Format` ended its Remediation Hint line with `(See scope-security verdict-hint extension.)`, which pointed at the deleted duplicate bullet. Dropped — the body holds the full rule and needs no pointer.
  - `## Assessment Criteria (OWASP LLM Top 10 Based)` enumerated `(LLM01 / LLM06 / LLM07)` as this file's categories; LLM07 left with its bullet, so the pointer now names what the target actually holds — LLM01, LLM06 and the tool-authorization gate.
- **The body also took the restructure-and-diet pass** in the same edit: `## Trigger Conditions`, `## Prohibitions` and `## Pre-Execution Verification` went as restatements — the triggers duplicate the frontmatter `description`, and every prohibition bullet survives under `## Guardrails`, `## Absolute Rules` or `## Deliverable Format`.
  - The three `EDITABLE` marker pairs are unchanged: they are the daemon's landing zones, and a diff that lands outside one is rejected.
  - No `scope:` key was added to the frontmatter — no `agents/*.md` carries one, and the identity key set is hook-guarded.

## Shape note

The surviving section is a two-row WARN/BLOCK decision table plus one bullet. The tool-authorization gate stayed a bullet deliberately: it has no WARN limb, and forcing a `—` cell into the table would have made a non-uniform rule look uniform.
