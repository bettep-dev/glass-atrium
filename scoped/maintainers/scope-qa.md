# Maintainer note — `scoped/scope-qa.md`

Companion to `scoped/scope-qa.md`, which carries QA-agent-facing duties only. Everything here addresses a maintainer, the orchestrator or a corpus editor — no running QA agent is obliged by any of it. Read it before editing that file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- `scoped/scope-qa.md` carries no stub heading, so it carries no pointer to this note.

## Membership

- The rule file is the QA scope file: `glass-atrium-qa-code-reviewer` and `glass-atrium-qa-debugger`.
- Membership is declared on the registry rows (`agent-registry.json` → each agent's `rules.scope`) and in `rules/glass-atrium/core-compliance-matrix.md`; the rule file does not restate it.
- QA's Tier-3 members sit on the same registry rows (`rules.shared`, and `rules.conditional` for the hook-review file) and in the matrix Tier-3 table — not in the rule file.

## Which agent the file binds

- Every duty in the rule file binds `glass-atrium-qa-code-reviewer`; none binds `glass-atrium-qa-debugger`.
  - The rule file's opening line states it: the debugger receives the file whole, and this is the most useful fact the file holds for it.
- Most duty text is the Stage-2 gate, which fires only on a `{glass-atrium-qa-code-reviewer, DEV}` plan-verification spawn.

## Retention ledger — who reads each section

A section stays when it obliges `glass-atrium-qa-code-reviewer`, which receives the rule file whole (`## How the reviewer reaches this file`).

| Section | Established reader |
|---|---|
| `## Plan Direction Verification Gate [DEV+QA]` | the reviewer on a Stage-2 spawn; the orchestrator composing that spawn |
| `## Delegation Bars and Convergence Notes [QA]` | the reviewer on every review spawn, the Stage-2 gate included |
| `## Deliverable Quantitative Evaluation (LLM-as-Judge 4 Dimensions) [QA+REPORT]` | the reviewer, the reporter, and anyone weighing a recorded `qa_score` |
| `### Evaluator-independence posture` | a Tier-1 reader: the `core-outcome-record.md` `qa_score` row names this file for the caveat |
| `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` | the reviewer scoring an HTML primary; the designer's P1-P5 veto line |
| `### Mechanical / semantic split` (the P-label table) | the reviewer — its body emits P1 / P4 / P5, and no other file defines the labels |
| `### Threshold SoT` | the reviewer, which never raises a finding against a prose number; a maintainer reconciling mirrors |
| `## Regression Risk Estimation [QA]` | the reviewer — the label triggers its template emits live here only |

- **Heading stability — named verbatim from outside `scoped/scope-qa.md`**: every `##` heading in the table above, plus these `###` headings. Renaming one dangles a live citation; before renaming or changing a listed section's content, grep its heading literal for the current citers and mirrors.
  - `### Reviewer verdict` — cited by `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md` → `## Team composition and verdicts`.
  - `### The four dimensions` and `### Rubric` — cited by `agents/glass-atrium-qa-code-reviewer.md` → `#### Template field notes`.
  - `### Load-bearing premise check` and `### Comparand for scope-fidelity` (by prefix) — cited by `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md`.
- **Heading stability — not named from outside**: every other `###` heading in the rule file, `### Mechanical / semantic split` and `### Threshold SoT` included — each is reached through the `##` heading above it, never by a citation of its own.
  - The `html-validator.ts` comment naming "the scope-qa mechanical/semantic split" names the concept, not the heading.
  - Renaming one dangles nothing today and is still a deliberate act, not a cleanup.

## What was moved here, and what was dropped

Decided removals from the rule file — do not re-add any of them:

- `## Sprint Contract Gate [DEV+QA]`, heading and stub: it pointed at `scoped/scope-dev.md`, which neither QA agent receives, and stated no duty of its own.
  - The canonical and its orchestrator half stay in `scoped/scope-dev.md` and `scoped/maintainers/scope-dev.md` → `## Sprint Contract Gate (orchestrator side)`.
  - Re-add only as a duty the reviewer itself performs — pre-defining a sizable task's criteria — once an orchestrator path spawns the reviewer for it.
- A Tier-2 loading stanza or delivery-status block: each section's opening line states when it fires.
- Text the reviewer body already delivers: the D8 skip list, the pass threshold, gradient localization, the `qa_score` record format, the 20-point total inside the D8 section, the score-trend sentence.
- The gate's verdict-vocabulary bullet: redundant with the reviewer body (`## Pair classifications`).
- A tag-presence `revise` limb in `### Load-bearing premise check`, in any form.
  - "The planner's marking widens your list and never shrinks it" already absorbs it, and a limb narrowed to load-bearing premises collides with the CONFIRMED / REFUTED / UNVERIFIABLE ladder.
  - It also contradicts **Direction, not completeness** (`skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md` → `## Team composition and verdicts`).
  - The malformed-tag case stays on the ladder, and the rule file states that tag absence is not itself a finding.
- Per-job honest-backing notes, a separate "Honest ceiling", and enforcement-state clauses: the one gate-level **Honest backing** bullet carries every operative half.
- The comparand's persist-duty and decision-tree pointers: the read-only reviewer acts on none of them; the rule file keeps only that the root is persisted immutably.
- Pointers that give the reviewer nothing to act on:
  - the DEV half of the standing jobs — **Operational test for load-bearing** already lands on the same `scoped/scope-dev.md` heading;
  - `skills/glass-atrium-ops-orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)` — that file tells subagents to ignore it;
  - the **Deletion duty** path — `scoped/shared-testing.md` is a `rules.shared` member of the reviewer row, so the bold names already land.
- Restatements of a line that stays:
  - the comparand's "only as honest as what it compares against" opener — the non-comparand table's first row;
  - "Never substitute `[SCOPE]` for the missing root" — the comparand heading and the non-comparand table's first row;
  - D8's "you score the three semantic axes" — the `Yours to score` column;
  - Regression Risk's "a test that cannot fail counts as no test added" — the High row's third trigger.
- False or reader-less clauses:
  - **Partial mitigation**'s pointer at `core-outcome-record.md` → Field Input Guide for column semantics — they live in a companion, which a rule file never cites;
  - the rubric's "bodies that self-score point back here" and the designer routing's "both are 20-point scales" lines — neither obliges a reader.

## How the reviewer reaches this file

- Through its `rules.scope` membership, `hooks/lib/inject_chunk.py` packs the rule file whole into both QA agents' part slots at spawn.
- The reviewer body's pointers into it — `### Stage-2 plan-verification spawn` and `#### Template field notes` — name the section they land on and carry no Read instruction.
- **Pointers, not mirrors**: each section stays single-sited in the rule file and already sits in the reviewer's context. A Read route would re-fetch it; a body mirror would add a drift pair.

## Shape caps

- `## Plan Direction Verification Gate [DEV+QA]` and ``### Comparand for scope-fidelity — the CHAIN ROOT, never the delegation's current `[SCOPE]` `` sit inside the H2 8 KB and H3 3 KB caps.
- On growth, trim prose inside the comparand before adding a heading: a split would separate the cumulative and netting rules from the table of what they compare against.

## Pair classifications

| Pair | Class | Disposition |
|---|---|---|
| the verdict-vocabulary scoping ↔ the reviewer body's `### Stage-2 plan-verification spawn` | redundant, resolved | the body line is the single site; both reach the reviewer on every spawn |
| `### Non-waiver (binding on YOU, not on the delegation)` ↔ scope-dev's non-waiver bullet | false pair | both stay: different actor, own verdict tokens |
| **Under budget pressure, narrow the reading, never the job list** ↔ the body's **In-flight budget** | false pair | both stay: the rule bullet keeps every job, the body bullet sets reading depth |
| the premise-audit lead ↔ the same lead in scope-dev | canonical + mirror | both stay byte-identical, capitals included — `PREMISE_AUDIT_Q` quotes one home per actor |
| **Direction, never completeness** ↔ the reference's **Direction, not completeness** | canonical + mirror | both stay: the reference holds the detail, the rule file the reviewer's delivered copy |

- Paths: the reviewer body is `agents/glass-atrium-qa-code-reviewer.md`; scope-dev is `scoped/scope-dev.md`; `PREMISE_AUDIT_Q` sits in `skills/glass-atrium-ops-orchestrator.md`.
  - The reference is `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md`.
- The non-waiver false pair is also recorded in `scoped/maintainers/scope-dev.md` → `## Pair classifications`.
- The Direction pair's example lists match, "a premise tag" included: it carries the tag-presence removal (`## What was moved here, and what was dropped`), so an edit to either list edits both.

## What reads the rule file mechanically

- **Pins**: no reader pins a sentence inside it — no marker block, no extracted literal, no pinned needle, and slot 1 extracts nothing from it.
  - The premise-audit lead is quoted as `PREMISE_AUDIT_Q` and read by no scan; keep it byte-identical (`## Pair classifications`).
  - The rule file must never carry the whole `scoped/scope-dev.md` non-waiver bullet line: `hooks/test/inject-scope-single-delivery.bats` → `RETIRED_BLOCKS` counts that line as zero for every non-member of `scoped/scope-dev.md`.
  - Slot 1 delivers no plan-gate block — `hooks/test/inject-scope-single-delivery.bats` → `RETIRED_LEFTOVERS` asserts the retired marker and lead reach no agent — so the rule file is the gate's only delivered copy.
- Two readers take the whole body: `hooks/lib/inject_chunk.py` (`## How the reviewer reaches this file`) and `autoagent/daemon_cycle.py`, which excerpts it into its verify prompt.
  - The daemon treats an empty scope file as a failing verdict (`SCOPE_EMPTY_SIGNAL`): dieting is free; emptying is not.
  - Growth moves the QA part count: after an edit, `python3 hooks/lib/inject_chunk.py --audit` should still report `events=none` for both QA agents.
- The remaining couplings are on the path spelling and the file's existence:
  - the `rules.scope` arrays in `agent-registry.json` — permitted values are the closed frozenset in `scripts/agent_lifecycle/registry_ops.py`, pinned by `scripts/test/test_agent_lifecycle_overhaul.py`.
  - the basename-to-matrix-row check in `hooks/validate-compliance-matrix.sh` — a `-maxdepth 1` enumeration over `scoped/`, which is why this companion needs no matrix row.
  - the inline-code path in `rules/glass-atrium/core-compliance-matrix.md` that `monitor/src/server/architecture/governance-membership.ts` treats as a declared document.
  - the agent-to-basename map in `autoagent/daemon_cycle.py`, and the manifest hash.
- Renaming or moving the file is therefore a multi-site edit across every coupling above, not a rule edit.
- The manifest hash for `scoped/scope-qa.md` and the row for this companion both come from `scripts/generate-manifest.sh`, a whole-tree regeneration barrier — a branch carrying an edit to either fails the manifest check until that regeneration runs.
