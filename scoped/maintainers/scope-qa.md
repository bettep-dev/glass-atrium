# Maintainer note — `scoped/scope-qa.md`

Companion to `scoped/scope-qa.md`, which carries QA-agent-facing duties only. Everything here addresses a maintainer, the orchestrator or a corpus editor — no running QA agent is obliged by any of it. Read it before editing that file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- `scoped/scope-qa.md`'s one stub heading (`## Sprint Contract Gate [DEV+QA]`) resolves to the duty canonical in `scoped/scope-dev.md`, not here, so the rule file carries no pointer to this note.

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
| `## Sprint Contract Gate [DEV+QA]` | a maintainer or the orchestrator following a citation | `rules/glass-atrium/orchestrator-role.md` (Stage-2 activation scope) · `scoped/maintainers/scope-dev.md` |
| `## Plan Direction Verification Gate [DEV+QA]` | glass-atrium-qa-code-reviewer on a Stage-2 spawn; the orchestrator composing it | `agents/glass-atrium-qa-code-reviewer.md` · `rules/glass-atrium/orchestrator-role.md` · `scoped/scope-report.md` · `scoped/scope-planning.md` · `skills/glass-atrium-ops-orchestrator.md` |
| `## Deliverable Quantitative Evaluation (LLM-as-Judge 4 Dimensions) [QA+REPORT]` | the reviewer, the reporter, and anyone weighing a recorded `qa_score` | both QA and REPORT bodies · `scoped/scope-report.md` · `core-outcome-record.md` `qa_score` row · the 5-axis-critique skill |
| `### Evaluator-independence posture` | a Tier-1 reader — the `qa_score` row names this file as where the caveat lives | `rules/glass-atrium/core-outcome-record.md` → Field Input Guide `qa_score` row |
| `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` | glass-atrium-qa-code-reviewer scoring an HTML primary; the designer's veto line (`agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role`), which names the P1-P5 invariants | `agents/glass-atrium-qa-code-reviewer.md` · `skills/glass-atrium-design-html-co-emission/SKILL.md` (its P1-P5 `## Cross-References` bullet) · `scoped/scope-report.md` · `agents/glass-atrium-intel-planner.md` |
| `### Mechanical / semantic split` (the P-label table) | glass-atrium-qa-code-reviewer — its delivered body emits P1 / P4 / P5 and no other file defines them | none of its own — reached through the `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` row above |
| `### Threshold SoT` | a maintainer reconciling the corpus's prose mirrors against the JSON | none of its own — reached through the `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` row above |
| `## Regression Risk Estimation [QA]` | glass-atrium-qa-code-reviewer — the triggers that select the label its template emits live here and nowhere else | `agents/glass-atrium-qa-code-reviewer.md` |

- **Heading stability — named verbatim from outside `scoped/scope-qa.md`**: every `##` heading in the table above, plus these `###` headings. Renaming one of these dangles a live citation.
  - `### Reviewer verdict` — cited by `rules/glass-atrium/orchestrator-role.md` → `#### Team composition and verdicts`.
  - `### The four dimensions` and `### Rubric` — cited by `agents/glass-atrium-qa-code-reviewer.md` → `#### Template field notes`.
  - Open, and owned elsewhere: most of `rules/glass-atrium/orchestrator-role.md`'s pointers at `## Plan Direction Verification Gate [DEV+QA]` drop the `[DEV+QA]` suffix and so resolve by prefix. Repointing them is that file's own edit; no maintainer companion exists for it yet.
- **Heading stability — not named from outside**: every other `###` heading in the rule file, `### Mechanical / semantic split` and `### Threshold SoT` included — each is reached through the `##` heading above it, never by a citation of its own.
  - Renaming one dangles nothing today and is still a deliberate act, not a cleanup.

## What was moved here, and what was dropped

Dropped outright (not moved) — each would preserve a claim a future editor could act on:

- The Tier-2 loading stanza and the 2026-09-10 delivery-status block, including its three consequence bullets and the disposition rule. Self-refuting the moment the file is read by the agent it names, and superseded by the per-section condition lines now in the rule file.
- `### Reader — why this section survives the disposition rule` — a disposition argument for a decision already taken. Its factual finding survives in the ledger row above.
- The Sprint Contract Gate's "Heading kept, body removed" note and its Sizable-task pair note — both restated the canonical's location, which the stub line now states once.
- "Two pointers were DELETED from this list" — deletion bookkeeping for an edit two waves old.
- The rubric pair note, the D8 pair note and the Threshold SoT pair note — five-, three- and two-site edit registers. The linkage they carried is in the ledger table above.
- The Regression Risk "Undelivered, and a RELOCATE candidate for the reviewer body" note — superseded: the rule file reaches the reviewer whole (**How the reviewer reaches this file** below).
- Duplicates of text the reviewer's own body already delivers: the D8 skip list, the pass threshold, gradient localization, the `qa_score` record format, the 20-point total's restatement inside the D8 section, and the score-trend sentence.
- The enforcement-state clause "the verify stage is text-mode by design and declares no schema, so no required key can force an answer into existence", and "Shape borrowed from the corpus's own self-enforce precedent" with its no-evidence-record tail.
  - The operative halves — *the verdict content is honor-system*, *do not describe it as verification*, *honor-system and unverifiable* — stayed in the rule file.

Compressed rather than dropped: the comparand section's persist-duty and decision-tree pointers (three files deep, none of which a read-only reviewer acts on) were cut to the one fact the reviewer needs — that the root is persisted immutably so the comparison has an origin.

## How the three conflicts landed

- **Untagged-claim rule vs. the delivered Direction-not-completeness rule** (`rules/glass-atrium/orchestrator-role.md` → `#### Team composition and verdicts`). The tag-PRESENCE revise limb was DELETED, not narrowed.
  - It was already absorbed by "the planner's marking WIDENS your list and never shrinks it", and narrowing it to load-bearing premises would have collided with the CONFIRMED / REFUTED / UNVERIFIABLE ladder four lines above it.
  - What survives is the malformed-tag case phrased ON that ladder — a load-bearing premise whose self-checked tag names no instrument is reported UNVERIFIABLE — plus an explicit statement that tag absence is not itself a finding.
  - The direction-not-completeness limit is stated in the rule file's `### Reviewer verdict` section, in the reviewer's own terms, which is what that orchestrator clause now points at for the reviewer half.
- **Verdict vocabulary** — `pass` / `revise` here against `Pass / Conditional Pass / Reject` in the reviewer's delivered template. Closed by scoping, in words, at the gate section: `pass` / `revise` is the gate's verdict, the three-value line is the code-review template's, and the condition line says which spawn you are in.
- **Non-waiver vs. the reviewer body's in-flight budget discipline**. Closed by stating the precedence in the non-waiver section: budget pressure narrows the READING, never the job list; a premise left unsettled is reported UNVERIFIABLE by name and the narrowing is stated in Review Coverage Limits. The two rules now govern different objects instead of contradicting.

## How the reviewer reaches this file

The rule file is the `rules.scope` member of both QA registry rows, so `hooks/lib/inject_chunk.py` packs it whole into the reviewer's part slots at spawn. The reviewer body keeps plain pointers, each naming the section it lands on, with no Read instruction:

| Spawn | Lands on | Where the pointer lives |
|---|---|---|
| a Stage-2 `{glass-atrium-qa-code-reviewer, DEV}` plan-verification spawn | `## Plan Direction Verification Gate [DEV+QA]` | `agents/glass-atrium-qa-code-reviewer.md` → `### Stage-2 plan-verification spawn` |
| every code review, for the `Regression Risk` label | `## Regression Risk Estimation [QA]` | `agents/glass-atrium-qa-code-reviewer.md` → `#### Template field notes` → **Regression Risk** |

- **Pointers, not mirrors**: each section stays single-sited here and already sits in the reviewer's context. A Read route would re-fetch it; a body mirror would add a drift pair.
- **The Stage-2 pointer also scopes the verdict vocabulary**: the body states that `pass` / `revise` is this gate's and `Pass / Conditional Pass / Reject` is its own template's — the same closure the rule file makes from its side.
- Slot 1 injects no plan-gate block: `hooks/test/inject-scope-rules-nodrop.bats` lists its lead among the retired needles, so this rule file is the gate's only delivered copy.

## Accepted shape overage

``### Comparand for scope-fidelity — the CHAIN ROOT, never the delegation's current `[SCOPE]` `` sits marginally over the 3 KB H3 shape-cap guide. The overage is deliberate: splitting it would separate the cumulative-from-the-root rule and the netting rule from the table of what they compare against, and the whole axis is reached through one inbound pointer. Prefer trimming prose inside it over adding a second heading.

## What reads the rule file mechanically

- **Pins**: no reader pins a sentence inside it — it carries no marker block, no extracted literal and no pinned needle, and slot 1 extracts nothing from it.
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
