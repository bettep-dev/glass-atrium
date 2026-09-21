# Maintainer note — `scoped/shared-investigation-discipline.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: no heading of the rule file is externally cited, so it carries no companion pointer. Its duty-half citation is rule-file prose naming `rules/glass-atrium/orchestrator-role.md` → `### Failure Recovery Loop`, permitted under the last bullet.

## Provenance of the move

- The core came from `skills/glass-atrium-core-iron-laws/SKILL.md` → `### Investigation Discipline [DEV+ORCHESTRATOR]`, plus the three attachments that are dead weight once it leaves: `## Common Rationalizations` rows 1-5, `## Red Flags` bullets 1, 2, 3, 5 and 6, and `## Verification` items 1, 2 and 5.
- The four-step sequence, its four step bullets and the hypothesis-free prohibition moved byte-identically, as did all five rationalization rows and all eight scan items. ONE line was deliberately restated — see the next section.
- The skill carried no `AGENT-INJECT` marker of any kind, so nothing extracts from it: the move is a plain relocation with no byte budget attached.
- Where the skill's remainder went when it retired in W7:
  - Debugger Escalation → `**Debugger evidence gate**` in `rules/glass-atrium/orchestrator-role.md` → `### Failure Recovery Loop`; the rest deleted as restated.
  - Prompt Injection Refusal → `rules/glass-atrium/core-security.md` → `## Prompt & Tool Input Security [LLM01:2025]`.
  - Excessive Agency → the `core-security.md` rationalization row plus the permission-widening sub-bullet under `## Agent Tool Authorization`.
  - Unbounded Consumption Stop → deleted, covered by the charter's `### Turn Budget & Graceful Exit` and `core-security.md` Unbounded consumption.
  - The disabled-surface row ("One surface is disabled…") → this file's `## Common Rationalizations`.

## The one line that did not move verbatim, and the tag that changed

- `2nd failure → escalate to glass-atrium-qa-debugger (rules below)` became a DEV-side STOP rule: stop and hand the bug over, with routing and the evidence-rejection duty named as the orchestrator's, now at `rules/glass-atrium/orchestrator-role.md` → `### Failure Recovery Loop` (Escalate stage and **Debugger evidence gate**).
- This is a duty SPLIT, not a copy. The DEV agent's duty is to stop; the orchestrator's is to route and to reject a conclusion carrying no logs, reproduction or code reference. The original `(rules below)` phrasing pointed at a section that is no longer below it, so leaving it verbatim would have produced a dangling reference.
- The heading tag moved from `[DEV+ORCHESTRATOR]` to `[DEV+QA]` for the same reason: the original tag covered the duty PAIR, and only the DEV/QA half travelled. The orchestrator is not a registry agent and takes no Tier-3 row here; it loads its half as part of the ORCHESTRATOR pair.

## Membership

- DEV unconditionally (all 13) and QA unconditionally (BOTH agents) — the only Tier-3 file besides `shared-comment-logging.md` that both QA agents take, so its Compliance Matrix `✓` needs no subset qualifier and no footnote marker. `glass-atrium-qa-debugger` is its heaviest consumer: diagnosis IS the investigation sequence.
- Declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`. Both halves are scope defaults — `SCOPE_SHARED_RULE_FILES["DEV"]` and `["QA"]` in `scripts/agent_lifecycle/registry_ops.py` — so a newly ADDed DEV or QA agent inherits the file without a hand-add.

## Delivery

- The part-slot channel (`hooks/inject-scope-part-*.sh` → `hooks/lib/inject_chunk.py`) packs this file for every DEV and QA agent. `python3 hooks/lib/inject_chunk.py --audit`, run with `GA_CHUNK_RULES_ROOT` set to the tree under test, must report `events=none`.
- No skill preload carries this file's content: the `glass-atrium-core-iron-laws` preload retired with its skill.

## Readers and coupled tests

- No code reads this file's TEXT. The path is pinned in `SCOPE_SHARED_RULE_FILES` for both DEV and QA (and therefore `RULE_FILES`) in `scripts/agent_lifecycle/registry_ops.py`, asserted by exact list equality in two tests in `scripts/test/test_agent_lifecycle_overhaul.py`, cited by 15 `agent-registry.json` rows, and hashed in the manifest.
- `hooks/validate-compliance-matrix.sh` Layer A reconciles `scoped/` basenames against matrix rows, so the file and its row land together or one direction reports a gap.
- `monitor/src/server/architecture/governance-membership.ts` treats every inline-code `scoped/…md` path in the matrix as a declared document and reports it absent when no such file exists.
- Prose citations of the duty half resolve to `rules/glass-atrium/orchestrator-role.md` → `### Failure Recovery Loop`: `rules/glass-atrium/core-compliance-matrix.md` (QA bullet), `skills/glass-atrium-ops-verify-gate/SKILL.md` (Loop termination cap) and this rule file's 2nd-failure bullet.
- The manifest is NOT regenerated here: a new `scoped/` member leaves `manifest.json` stale, and the regeneration is a whole-tree barrier belonging to the combined pre-PR deploy.
