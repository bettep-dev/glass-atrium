# Maintainer note — `scoped/shared-investigation-discipline.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: no heading of the rule file is externally cited, so it carries no companion pointer. Its two citations of `skills/glass-atrium-core-iron-laws/SKILL.md` are rule-file prose naming the duty-half and the safety laws that stayed behind, permitted under the last bullet and recorded below.

## Provenance of the move

- The core came from `skills/glass-atrium-core-iron-laws/SKILL.md` → `### Investigation Discipline [DEV+ORCHESTRATOR]`, plus the three attachments that are dead weight once it leaves: `## Common Rationalizations` rows 1-5, `## Red Flags` bullets 1, 2, 3, 5 and 6, and `## Verification` items 1, 2 and 5.
- The four-step sequence, its four step bullets and the hypothesis-free prohibition moved byte-identically, as did all five rationalization rows and all eight scan items. ONE line was deliberately restated — see the next section.
- The skill carried no `AGENT-INJECT` marker of any kind, so nothing extracts from it: the move is a plain relocation with no byte budget attached.
- What STAYED in the skill, and why:
  - `### Debugger Escalation [ORCHESTRATOR]`, whole. Its membership is ORCHESTRATOR, which this file does not carry.
  - All three `[hardcoded]` safety sections — Prompt Injection Refusal, Excessive Agency Refusal, Unbounded Consumption Stop — **byte-untouched**, verified by hashing each section against `HEAD` before and after (681 / 792 / 706 bytes, identical digests). W7 reads exactly the text this wave found and W3 decides nothing about them.
  - Rationalization rows 6, 7 and 8; Red Flag 4 (debugger evidence); Verification items 3, 4, 6, 7 and 8.
  - One `>` pointer stub under a retained `### Investigation Discipline` heading, so `rules/glass-atrium/scope-orchestrator.md` → "Iron Law & Debugging Escalation" and `agents/glass-atrium-qa-debugger.md` still resolve in one hop.
  - The `## Overview` opening paragraph was corrected in the same pass: it claimed the skill "defines the mandatory investigation sequence", which the split makes false. The `**Rule classification**` paragraph beside it was left as written — it classifies both process rules, and Investigation Discipline still appears in the skill's map through the stub.

## The one line that did not move verbatim, and the tag that changed

- `2nd failure → escalate to glass-atrium-qa-debugger (rules below)` became a DEV-side STOP rule: stop and hand the bug over, with routing and the evidence-rejection duty named as the orchestrator's and left in the skill.
- This is a duty SPLIT, not a copy. The DEV agent's duty is to stop; the orchestrator's is to route and to reject a conclusion carrying no logs, reproduction or code reference. The original `(rules below)` phrasing pointed at a section that is no longer below it, so leaving it verbatim would have produced a dangling reference.
- The heading tag moved from `[DEV+ORCHESTRATOR]` to `[DEV+QA]` for the same reason: the original tag covered the duty PAIR, and only the DEV/QA half travelled. The orchestrator is not a registry agent and takes no Tier-3 row here; its half is reachable through the skill it already cites.

## Membership

- DEV unconditionally (all 13) and QA unconditionally (BOTH agents) — the only Tier-3 file besides `shared-comment-logging.md` that both QA agents take, so its Compliance Matrix `✓` needs no subset qualifier and no footnote marker. `glass-atrium-qa-debugger` is its heaviest consumer: diagnosis IS the investigation sequence.
- Declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`. Both halves are scope defaults — `SCOPE_SHARED_RULE_FILES["DEV"]` and `["QA"]` in `scripts/agent_lifecycle/registry_ops.py` — so a newly ADDed DEV or QA agent inherits the file without a hand-add.

## Delivery — the W3-to-W4 gap, and HOLD-3

- **This rule reaches no agent yet.** The core is in place and awaiting its channel. Membership is declared end to end (matrix row + 15 registry rows + the lifecycle vocabulary), but no spawn path reads a Tier-3 membership row and `hooks/inject-scope-rules.sh` delivers marker blocks only — never a scope-file body. W4 is the wave that builds the channel; until it lands, this text binds nobody.
- The gap's LIVE duration is zero by construction: the cycle deploys once, at W9, behind the manifest barrier. The exposure is shipping a cycle in which the channel removal landed and W4 did not, which HOLD-1 gates.
- **HOLD-3 — the `glass-atrium-core-iron-laws` preload SURVIVES this wave on purpose.** W3 part two removes `glass-atrium-dev-naming` and `glass-atrium-dev-patterns` from the `skills:` lists and KEEPS `glass-atrium-core-iron-laws` in every body that has it. Part two is therefore DELIBERATELY PARTIAL; this is not an oversight and must not be recorded as one.
  - Reason: the three `[hardcoded]` safety laws are `[ALL]`-scope, they sit in NO `scoped/` file, and the frontmatter preload is their ONLY channel to the 13 DEV agents and `glass-atrium-qa-code-reviewer`. W4 delivers `scoped/` members only, and W7's own outcome may be that the laws do not move at all. Stripping the preload now would silently drop three safety laws for an open-ended interval.
  - W7 owns the remainder: it decides the home of the three safety laws, and only then can the preload be retired.
  - The two facts are independent and both hold — Investigation Discipline moves out of the skill in this wave, AND the skill stays preloaded for the safety laws.
- Correction to the wave's design input, measured against the file: `agents/glass-atrium-qa-debugger.md` does NOT already restate all three of its iron laws. Its Absolute Rules name **Investigation Discipline, Debugger Escalation and Excessive Agency** — Prompt Injection Refusal and Unbounded Consumption Stop appear nowhere in that body. The design's mitigation claim ("the debugger cannot lose Investigation Discipline because its body carries it") is true only for the one law it happens to name, and it is no argument at all about the other two.

## Readers and coupled tests

- No code reads this file's TEXT. The path is pinned in `SCOPE_SHARED_RULE_FILES` for both DEV and QA (and therefore `RULE_FILES`) in `scripts/agent_lifecycle/registry_ops.py`, asserted by exact list equality in two tests in `scripts/test/test_agent_lifecycle_overhaul.py`, cited by 15 `agent-registry.json` rows, and hashed in the manifest.
- `hooks/validate-compliance-matrix.sh` Layer A reconciles `scoped/` basenames against matrix rows, so the file and its row land together or one direction reports a gap.
- `monitor/src/server/architecture/governance-membership.ts` treats every inline-code `scoped/…md` path in the matrix as a declared document and reports it absent when no such file exists.
- Prose citations of the SKILL that survive untouched, each resolving to text that stayed: `rules/glass-atrium/scope-orchestrator.md` (Debugger Escalation), `skills/glass-atrium-ops-verify-gate/SKILL.md` (Debugger Escalation + Unbounded Consumption Stop), `skills/SKILL-od-extension-pattern.md` (names the skill as a shape example), `rules/glass-atrium/orchestrator-role.md` ("Iron Law: 2 consecutive fail").
- `agents/glass-atrium-qa-debugger.md` cites the skill for three laws by semantic name, one of which — Investigation Discipline — now lives here. Splitting that citation is an agent-body edit this wave's declared file set excludes; it belongs with the part-two scripted pass that already touches bodies.
- The manifest is NOT regenerated here: a new `scoped/` member leaves `manifest.json` stale, and the regeneration is a whole-tree barrier belonging to W9.

## Open

- Whether a subagent can still invoke a skill once its frontmatter no longer lists it is unsettled. Nothing read so far answers it; neither the rule file nor this note asserts it either way. It matters here only for the skill's retained halves, since this file carries the moved core in full.
