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

- Every duty in the rule file binds `glass-atrium-qa-code-reviewer`. None binds `glass-atrium-qa-debugger` — stated in the rule file's opening line, because it is the most useful fact the debugger can learn from the file, which it receives whole.
- Most of the duty text is the Stage-2 gate, which fires only on a `{glass-atrium-qa-code-reviewer, DEV}` plan-verification spawn; the rule file states that condition at the section itself.

## Retention ledger — who reads each section

A section stays when it obliges `glass-atrium-qa-code-reviewer` (delivery: **How the reviewer reaches this file** below). This table records each section's reader and the outside sites that cite it by name.

| Section | Established reader | Where the inbound pointer lives |
|---|---|---|
| `## Plan Direction Verification Gate [DEV+QA]` | glass-atrium-qa-code-reviewer on a Stage-2 spawn; the orchestrator composing it | `agents/glass-atrium-qa-code-reviewer.md` · `skills/glass-atrium-ops-orchestrator-role.md` · `scoped/scope-report.md` · `scoped/scope-planning.md` · `skills/glass-atrium-ops-orchestrator.md` |
| `## Delegation Bars and Convergence Notes [QA]` | glass-atrium-qa-code-reviewer on every review spawn, the Stage-2 gate included | `skills/glass-atrium-ops-orchestrator.md` → `#### Review rounds and reviewer prompts` |
| `## Deliverable Quantitative Evaluation (LLM-as-Judge 4 Dimensions) [QA+REPORT]` | the reviewer, the reporter, and anyone weighing a recorded `qa_score` | both QA and REPORT bodies · `scoped/scope-report.md` · `core-outcome-record.md` `qa_score` row · the 5-axis-critique skill |
| `### Evaluator-independence posture` | a Tier-1 reader — the `qa_score` row names this file as where the caveat lives | `rules/glass-atrium/core-outcome-record.md` → `### Role-scoped fields` → `qa_score` |
| `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` | glass-atrium-qa-code-reviewer scoring an HTML primary; the designer's veto line (`agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role`), which names the P1-P5 invariants | `agents/glass-atrium-qa-code-reviewer.md` · `skills/glass-atrium-design-html-co-emission/SKILL.md` (its P1-P5 `## Cross-References` bullet) · `scoped/scope-report.md` · `agents/glass-atrium-intel-planner.md` |
| `### Mechanical / semantic split` (the P-label table) | glass-atrium-qa-code-reviewer — its delivered body emits P1 / P4 / P5 and no other file defines them | none of its own — reached through the `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` row above |
| `### Threshold SoT` | a maintainer reconciling the corpus's prose mirrors against the JSON | none of its own — reached through the `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` row above |
| `## Regression Risk Estimation [QA]` | glass-atrium-qa-code-reviewer — the triggers that select the label its template emits live here and nowhere else | `agents/glass-atrium-qa-code-reviewer.md` |

- **Heading stability — named verbatim from outside `scoped/scope-qa.md`**: every `##` heading in the table above, plus these `###` headings. Renaming one of these dangles a live citation.
  - `### Reviewer verdict` — cited by `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md` → `## Team composition and verdicts`.
  - `### The four dimensions` and `### Rubric` — cited by `agents/glass-atrium-qa-code-reviewer.md` → `#### Template field notes`.
  - `### Load-bearing premise check` and `### Comparand for scope-fidelity` (by prefix) — cited by `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md`.
- **Heading stability — not named from outside**: every other `###` heading in the rule file, `### Mechanical / semantic split` and `### Threshold SoT` included — each is reached through the `##` heading above it, never by a citation of its own.
  - The `html-validator.ts` comment naming "the scope-qa mechanical/semantic split" names the concept, not the heading.
  - Renaming one dangles nothing today and is still a deliberate act, not a cleanup.

## What was moved here, and what was dropped

Dropped outright (not moved) — each would preserve a claim a future editor could act on:

- The Tier-2 loading stanza and the 2026-09-10 delivery-status block, including its three consequence bullets and the disposition rule. Self-refuting the moment the file is read by the agent it names, and superseded by the per-section condition lines now in the rule file.
- `### Reader — why this section survives the disposition rule` — a disposition argument for a decision already taken. Its factual finding survives in the ledger row above.
- The Sprint Contract Gate's "Heading kept, body removed" note and its Sizable-task pair note — both restated the canonical's location.
- The rubric pair note, the D8 pair note and the Threshold SoT pair note — five-, three- and two-site edit registers. The linkage they carried is in the ledger table above.
- The Regression Risk "Undelivered, and a RELOCATE candidate for the reviewer body" note — superseded: the rule file reaches the reviewer whole (**How the reviewer reaches this file** below).
- Duplicates of text the reviewer's own body already delivers: the D8 skip list, the pass threshold, gradient localization, the `qa_score` record format, the 20-point total's restatement inside the D8 section, and the score-trend sentence.
- The enforcement-state clause "the verify stage is text-mode by design and declares no schema, so no required key can force an answer into existence", and "Shape borrowed from the corpus's own self-enforce precedent" with its no-evidence-record tail.
  - Their operative halves now live in `## Plan Direction Verification Gate [DEV+QA]` → **Honest backing, for every job in this section** (merge record under "Removed as redundant or false" below).

Compressed rather than dropped: the comparand section's persist-duty and decision-tree pointers (three files deep, none of which a read-only reviewer acts on) were cut to the one fact the reviewer needs — that the root is persisted immutably so the comparison has an origin.

Removed as redundant or false — do not re-add:

- `## Sprint Contract Gate [DEV+QA]`, heading and stub together. Its last form was a pointer at `scoped/scope-dev.md` → `## Sprint Contract Gate [DEV+QA]`, a file neither QA agent receives, and it stated no duty of its own.
  - No agent body, rule, skill, hook or test cites the heading in this file; the canonical and its orchestrator half stay in `scoped/scope-dev.md` and `scoped/maintainers/scope-dev.md` → `## Sprint Contract Gate (orchestrator side)`.
  - Re-add only as a duty the reviewer itself performs — pre-defining a sizable task's criteria — and only once an orchestrator path spawns the reviewer for it.
- This note's `## Accepted shape overage` heading — false once the comparand H3 fell under the 3 KB cap, and cited from nowhere.
  - `## Shape caps` is a new heading in its place, not a rename of it.
- The gate's verdict-vocabulary bullet — redundant with `agents/glass-atrium-qa-code-reviewer.md` → `### Stage-2 plan-verification spawn`, which reaches the same reader on every spawn (pair table below).
- The pointer at the DEV half of the standing jobs — the **Operational test for load-bearing** pointer already lands on the same `scoped/scope-dev.md` heading.
- The three per-job honest-backing notes (scope-fidelity axis, comparand, premise check) and the non-waiver "Honest ceiling" — merged into the one gate-level **Honest backing** bullet; every operative half survives there.
- The comparand's opening "the axis is only as honest as what it compares against" line — the table's first row states the same reason.
- `**Partial mitigation**`'s "column semantics live in Tier-1 `core-outcome-record.md` → Field Input Guide" clause — false since those semantics moved to `scoped/maintainers/core-outcome-record.md` → `### Grader verdict`, and a retarget would cite a companion from a rule file.
- The rubric's "bodies that self-score point back here" clause, and the designer routing's "both are 20-point scales, so the signal stays comparable" line — neither obliges a reader.
- The D8 split's "you score the three semantic axes" bullet — the table's `Yours to score` column states it.
- Regression Risk's "a test that cannot fail counts as no test added" — the High row's third trigger already labels that case; the line kept is the pointer to what cannot-fail means.
- The gate-operation bullet's pointer at `skills/glass-atrium-ops-orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)` — that file tells subagents to ignore it, so the reviewer acts on nothing there; the bullet keeps "not yours".
- The comparand's "Never substitute `[SCOPE]` for the missing root" line — the heading and the non-comparand table's first row already rule `[SCOPE]` out unconditionally, the fallback case included.
- The **Deletion duty** path pointer in Regression Risk — `scoped/shared-testing.md` is a `rules.shared` member of the reviewer row, so the bold names already land in its context.

## How the three conflicts landed

- **Untagged-claim rule vs. the delivered Direction-not-completeness rule** (`skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md` → `## Team composition and verdicts`). The tag-PRESENCE revise limb was DELETED, not narrowed.
  - It was already absorbed by "the planner's marking widens your list and never shrinks it", and narrowing it to load-bearing premises would have collided with the CONFIRMED / REFUTED / UNVERIFIABLE ladder four lines above it.
  - What survives is the malformed-tag case phrased ON that ladder — a load-bearing premise whose self-checked tag names no instrument is reported UNVERIFIABLE — plus an explicit statement that tag absence is not itself a finding.
  - The direction-not-completeness limit is stated in the rule file's `### Reviewer verdict` section, in the reviewer's own terms, which is what that orchestrator clause now points at for the reviewer half.
- **Verdict vocabulary** — `pass` / `revise` here against `Pass / Conditional Pass / Reject` in the reviewer's delivered template. Closed by scoping:
  - Closure: the gate section's condition line says which spawn you are in, and its `### Reviewer verdict` emits `pass` / `revise`.
  - Body-line site: the reviewer body's `### Stage-2 plan-verification spawn` states that the three-value line is never emitted there.
  - Single site: that body line is the closure's only site.
- **Non-waiver vs. the reviewer body's in-flight budget discipline**. Closed by stating the precedence in the non-waiver section: under budget pressure, "narrow the reading, never the job list".
  - A premise left unsettled is reported UNVERIFIABLE by name, and the narrowing is stated in Review Coverage Limits.
  - The two rules now govern different objects instead of contradicting.

## How the reviewer reaches this file

The rule file is the `rules.scope` member of both QA registry rows, so `hooks/lib/inject_chunk.py` packs it whole into the reviewer's part slots at spawn. The reviewer body keeps plain pointers, each naming the section it lands on, with no Read instruction:

| Spawn | Lands on | Where the pointer lives |
|---|---|---|
| a Stage-2 `{glass-atrium-qa-code-reviewer, DEV}` plan-verification spawn | `## Plan Direction Verification Gate [DEV+QA]` | `agents/glass-atrium-qa-code-reviewer.md` → `### Stage-2 plan-verification spawn` |
| every code review, for the `Regression Risk` label | `## Regression Risk Estimation [QA]` | `agents/glass-atrium-qa-code-reviewer.md` → `#### Template field notes` → **Regression Risk** |

- **Pointers, not mirrors**: each section stays single-sited here and already sits in the reviewer's context. A Read route would re-fetch it; a body mirror would add a drift pair.
- **The Stage-2 pointer also scopes the verdict vocabulary**: the body states that `pass` / `revise` is this gate's and `Pass / Conditional Pass / Reject` is its own template's. It is the closure's single site — the rule file no longer restates it.
- Slot 1 injects no plan-gate block: `hooks/test/inject-scope-rules-nodrop.bats` lists its lead among the retired needles, so this rule file is the gate's only delivered copy.

## Shape caps

- `## Plan Direction Verification Gate [DEV+QA]` and ``### Comparand for scope-fidelity — the CHAIN ROOT, never the delegation's current `[SCOPE]` `` sit inside the H2 8 KB and H3 3 KB caps.
- On growth, trim prose inside the comparand before adding a heading: a split would separate the cumulative and netting rules from the table of what they compare against.

## Pair classifications

| Pair | Class | Disposition |
|---|---|---|
| the verdict-vocabulary scoping ↔ the reviewer body's `### Stage-2 plan-verification spawn` | redundant, resolved | the body line survives; both reach the reviewer on every spawn |
| `### Non-waiver (binding on YOU, not on the delegation)` ↔ scope-dev's non-waiver bullet | false pair | both stay: different actor, own verdict tokens |
| the premise-audit lead ↔ the same lead in scope-dev | canonical + mirror | both stay byte-identical, capitals included — `PREMISE_AUDIT_Q` quotes one home per actor |
| **Direction, never completeness** ↔ the reference's **Direction, not completeness** | canonical + mirror | both stay: the reference holds the detail, this file the reviewer's delivered copy |

- Paths: the reviewer body is `agents/glass-atrium-qa-code-reviewer.md`; scope-dev is `scoped/scope-dev.md`; `PREMISE_AUDIT_Q` sits in `skills/glass-atrium-ops-orchestrator.md`.
  - The reference is `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md`.
- The non-waiver false pair is also recorded in `scoped/maintainers/scope-dev.md` → `## Pair classifications`.
- The Direction pair's example lists match, "a premise tag" included: it carries the untagged-claim closure (`## How the three conflicts landed`), so an edit to either list edits both.

## What reads the rule file mechanically

- **Pins**: no reader pins a sentence inside it — it carries no marker block, no extracted literal and no pinned needle, and slot 1 extracts nothing from it.
  - One quoted literal, read by no scan: the bold lead **Attack each load-bearing premise FROM THE CODE, never from the list**, quoted as `PREMISE_AUDIT_Q` (pair table above). Keep it byte-identical.
  - The rule file must never carry the whole `scoped/scope-dev.md` non-waiver bullet line: `hooks/test/inject-scope-single-delivery.bats` → `RETIRED_BLOCKS` counts that line as zero for every non-member of `scoped/scope-dev.md`.
- Two readers take the whole body: `hooks/lib/inject_chunk.py` packs it into both QA agents' part slots at spawn, and `autoagent/daemon_cycle.py` excerpts it (below).
- The remaining couplings are on the path spelling and the file's existence:
  - the `rules.scope` arrays in `agent-registry.json` — permitted values are the closed frozenset in `scripts/agent_lifecycle/registry_ops.py`, pinned by `scripts/test/test_agent_lifecycle_overhaul.py`.
  - the basename-to-matrix-row check in `hooks/validate-compliance-matrix.sh` — a `-maxdepth 1` enumeration over `scoped/`, which is why this companion needs no matrix row.
  - the inline-code path in `rules/glass-atrium/core-compliance-matrix.md` that `monitor/src/server/architecture/governance-membership.ts` treats as a declared document.
  - the agent-to-basename map in `autoagent/daemon_cycle.py`, and the manifest hash.
- Renaming or moving the file is therefore a multi-site edit (registry frozenset, its pin, the compliance matrix, the daemon map), not a rule edit.
- One content-shaped constraint survives: `autoagent/daemon_cycle.py` reads the whole file as a rule excerpt for its verify prompt and treats an EMPTY scope file as a failing verdict. Dieting is free; emptying is not.
- Growth moves the QA part count: after an edit, `python3 hooks/lib/inject_chunk.py --audit` should still report `events=none` for both QA agents.
- The manifest hash for `scoped/scope-qa.md` and the row for this companion both come from `scripts/generate-manifest.sh`, a whole-tree regeneration barrier — a branch carrying an edit to either fails the manifest check until that regeneration runs.
