# Maintainer note — `scoped/scope-dev.md`

Companion to `scoped/scope-dev.md`, which carries DEV-agent-facing duties only. Everything here addresses a maintainer, the orchestrator, glass-atrium-meta-prompt-engineer or the `agent_lifecycle` CLI operator; no running DEV agent is obliged by it.

- Keep out of this file the `RETIRED_BLOCKS` lead-line needles and the first-link sentence literal: each is counted or extracted from the rule file, and `scoped/` is a recursive grep root, so a copy here is a second hit.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine-read shape of the rule file

| What is read | Reader | The shape it depends on |
|---|---|---|
| the loading stanza's DEV roster | `scripts/agent_lifecycle/readers.py` → `parse_scope_dev_roster`, re-parsed by `stanza.py` | an `agent_scope`-anchored brace list |
| the same brace list | `autoagent/lib/roster_merge.py` → `_get_markdown_slots` | exactly one brace-delimited list file-wide |
| the whole file, as DEV rule text | `hooks/lib/inject_chunk.py`, via each DEV row's `rules.scope` | heading boundaries |
| the first-link question's quoted sentence | `hooks/test/enforce-workflow-verify-stage-firstlink.bats` vs `FIRST_LINK_LITERAL` | `### Extraction constraints (the first-link question)` |
| the style_ref, minimalism and non-waiver lead lines | `hooks/test/inject-scope-single-delivery.bats` → `RETIRED_BLOCKS` | each anchor on one line, that line in no other member file |
| the premise-audit lead | `skills/glass-atrium-ops-orchestrator.md` → `PREMISE_AUDIT_Q` | byte-identical with `scoped/scope-qa.md`; no scan reads it |
| the `Pre-Edit Facts: <file_path>` header shape | `hooks/advisory-preedit-facts.sh`, parsing agent transcripts | change it only with the hook and `test/advisory-preedit-facts.bats` |
| the whole file, as a rule excerpt | `autoagent/daemon_cycle.py` verify prompt (`RULE_EXCERPT_CHAR_CAP`) | nothing — restructure freely |
| the file's basename | `hooks/validate-compliance-matrix.sh` Layer A (depth-1 `find` over `scoped/`) | a Compliance Matrix row for `scope-dev.md` |

- `FIRST_LINK_LITERAL`: defined in `hooks/enforce-workflow-verify-stage.sh`, cross-read by the firstlink suite.
- `parse_scope_dev_roster`: an absent list raises `ReaderError`/`StanzaError` and aborts the lifecycle add/delete.
  - Keep the stanza's `> **Inherits**:` and `> **See**:` lines brace-free, so the single-brace-list invariant holds.
- `_get_markdown_slots`: its regex does not require the `agent_scope` prefix, so a second brace list anywhere makes the updater refuse the whole file at deploy and strand every unrelated edit in it.
- `inject_chunk.py`: it packs whole sections into capped parts; a section too large for one part is named in an oversize marker instead of delivered. No `AGENT-INJECT` marker or extraction range applies.
- `advisory-preedit-facts.sh`: bound on `Stop` through `lib/ga-env.sh` → `EXPECTED_HOOK_BINDINGS`, not `settings.template.json`.
- `validate-compliance-matrix.sh`: the scan is depth-1, so this companion, in a subdirectory, needs no matrix row.
- Rule-file pointers here: one each under `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]` and `## Sprint Contract Gate [DEV+QA]`, the two externally-cited stub headings.
  - No preamble pointer and none in the first-link bullet: neither sits under an externally-cited stub, so the convention above sanctions neither.

### Extraction constraints (the first-link question)

The suite runs a `sed` line range over the rule file, then pulls the backticked sentence out of it. Breaking any property below fails the suite as drift:

- the bullet label carrying the capitalised phrase occurs exactly once and first in the file — the range opens on a case-sensitive substring match, so an earlier occurrence empties this bullet's own range;
  - every other mention of the question in the rule file stays lower-case for this reason;
- the sentence sits on the next line as a two-space-indented blockquote whose entire content is one backticked sentence;
- a two-space-indented list bullet (`  - `) follows it and closes the range — a three- or four-space bullet does not;
- no second two-space blockquote-backtick line falls inside the range, or the extraction yields two candidates and mismatches.

- `skills/glass-atrium-ops-orchestrator.md` → `FIRST_LINK_Q` quotes the sentence verbatim into the workflow verify-stage goal text: quote it, never restate it.
- The rule file carries no editor caution beside the literal: a DEV agent answers the question and never quotes it, so the caution obliged no reader. The suite is the guard.

### Retired slot-1 blocks — what remains in the rule file

- No slot-1 block reads the rule file: DEV agents receive it whole through the part slots by `rules.scope` membership.
  - The retirement rests on the overflow audit and the degraded-mode warning: `rules/glass-atrium/core-compliance-matrix.md` → `### Membership declaration and SubagentStart channels`.
- Keep the style_ref emit bullet lead and the minimalism lead's words before its parenthetical.
  - Why: `hooks/test/inject-scope-rules-nodrop.bats` → `RETIRED_NEEDLES` asserts them absent from slot 1, and the check proves nothing once a phrase leaves the source.
- The minimalism core closing `## Complexity Proportionality` is content, not a duplicate: the `ponytail:` corner-cut mark, the heavy-machinery rule and the output rule are stated nowhere else in the file.
- The plan-gate core is gone: every clause it carried, the three-part first-link answer included, is in `## Plan Direction Verification Gate [DEV+QA]`.

### Removed from the premise check, said once so it is not re-derived

- Removed: the register-wide sweep, the unregistered-claim flag duty and the claim-class mandatory-instrument rule.
- Why: in the recorded verdict corpus (window 2026-08-18 → 2026-09-09) the per-handle vocabulary was near-absent, while the direction errors the gate caught came from reading code against a plan claim — the bookkeeping was the cost, the code-reading the value.

## DEV Agent Fleet Governance

The rule file's Tier-2 loading stanza is the DEV roster SoT; this section governs when that roster may grow.

- Readers: the orchestrator, which routes a capability gap back to this gate rather than self-authoring an agent · glass-atrium-meta-prompt-engineer, the body author · the maintainer of the CLI and both stanza parsers.
- Concern-based separation keeps `domains` arrays distinct enough for capability routing (`skills/glass-atrium-ops-orchestrator-role.md` → `## Delegation Criteria` → **starting reference**).
- Co-edit sites — the growth decision is also stated at:
  - `skills/glass-atrium-ops-orchestrator-role.md` → `### DEV fleet growth authority` (extension the default, creation routed here);
  - `skills/glass-atrium-ops-orchestrator.md` → `#### Skill Document Auto-Generation` → **New DEV agent gate** (a digest of the gate questions);
  - `skills/glass-atrium-ops-orchestrator.md` → `### In-Context Agent-Lifecycle Ceremony (CREATE/EXTEND — ceremony SoT)` (the flow that executes it).
  - Loosening the gate here loosens a rule those files also state.

### Separation Axis

DEV agents are separated by **concern (execution responsibility)**, never by language or framework version. A concern = the artifact set an agent exclusively owns + the decisions it alone is accountable for.

A boundary is justified only when the two sides hold all three; any one absent → merge, not split:

- **Disjoint artifact types** — the files each agent produces are structurally distinct (`.tsx` component logic vs. `.css`/`tailwind.config` styling · `.sql` DDL vs. `.ts` service layer).
- **Disjoint decision domain** — the expertise for correct decisions is non-overlapping (React lifecycle vs. GSAP timeline · NestJS DI/CQRS vs. Node ESM stream pipeline · retrieval tuning vs. API routing).
- **Non-transferable quality judgment** — a quality review in one concern cannot be performed by an agent holding only the other's expertise (EXPLAIN ANALYZE index calls need DB-specialist judgment a NestJS agent cannot substitute).

Not axes:

- **Code-quality rules**: every DEV agent declares the same rule membership in its `agent-registry.json` entry (`rules.scope` = scope-dev · `rules.shared` = the Tier-3 set), so quality is centralised at the rule layer.
  - An agent proposed only to enforce a different quality standard is invalid — update the shared rule instead.
- **Language alone**: a new language or framework runtime justifies an agent only when it also brings a concern meeting all three criteria.
  - Counter-example: `glass-atrium-dev-python` covers FastAPI + Litestar + Django + CLIs + data pipelines in one agent.

### New-Agent Creation Gate

Default = **extend an existing agent**; creation is the exception. Before creating a DEV agent, the requester (orchestrator or glass-atrium-meta-prompt-engineer) MUST answer all three affirmatively — any "no" blocks creation:

- **Q1 — Concern novelty**: does the proposed agent own a concern meeting all three Separation-Axis criteria? A sub-variant of an existing concern (new framework on the same runtime, new API version) → "no".
- **Q2 — Extend test**: can the closest-concern existing agent absorb the new knowledge via its `description` + `domains` array + body, without degrading routing precision or exceeding a single-budget turn? Yes → EXTEND, do not create.
- **Q3 — Fleet-size cost**: does the addition keep every agent's `domains` array distinct enough that capability-based routing stays precise? Heavily overlapping `domains` indicate a merge, not a creation.

#### On creation

All of the following, atomically:

- add the name to the rule file's loading stanza;
- add an `agent-registry.json` entry with a non-overlapping `domains` array;
- give that entry the standard `rules` object — `rules.scope` / `rules.shared` identical to every other DEV agent (no custom quality rules);
- add a `compatibility` field when the agent has runtime preconditions (pattern: `glass-atrium-dev-animator`).

#### In-context lifecycle wiring (decision tree → CLI)

The ceremony (`skills/glass-atrium-ops-orchestrator.md` → In-Context Agent-Lifecycle Ceremony) realises this gate through the `agent_lifecycle` CLI.

- **Default branch = EXTEND** — `extend.py` via `--add-domain` / `--append-section`, additive append-only.
- **CREATE only when Q1/Q2/Q3 all pass** — the three map to `evaluate_add_gate` (`add.py`); Q3 is the domain-overlap hard block in `overlap.py` (`OVERLAP_THRESHOLD` — read the bar from that constant, never from prose).
- **The gate (`gate.py` + `overlap.py`) stays the sole authority**: the flow supplies the Q1/Q2 attestation verdicts (`--gate-q1`/`--gate-q2`, each `pass`/`fail`) but never computes `allowed` or re-implements the overlap predicate.

### Doc-sync note (CLI auto-writes vs. manual matrix update)

A successful `add` writes some of the sites a new name must appear in, and not others.

- **Auto-written**: the agent file · its `agent-registry.json` entry (whose `rules` object selects what the part slots deliver) · via the post-commit reconcile, `BUDGET_DEV_AGENTS` in `hooks/inject-scope-rules.sh` and `STYLEREF_AGENTS` in `hooks/lib/styleref-roster.sh`.
- **Deliberately untracked by that reconcile**: `BUDGET_ANALYSIS_AGENTS` and `WIKI_UNTRUSTED_AGENTS`, governance-curated rosters (`rules/glass-atrium/core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)`).
  - Their absence from the auto-written set is design, never an omission to repair.
- **Not written at all**: the `core-compliance-matrix.md` **Scope Legend** DEV row and the **Compliance Matrix** rows — a separate post-creation doc update.
  - `hooks/validate-compliance-matrix.sh` Layer C detects a registered name missing from the Scope Legend.
- **Mirror pointer**: the same tracked-array list is stated at `skills/glass-atrium-ops-reconcile-inject/SKILL.md` → **Names reconciled**; edit that site together with this one.

### glass-atrium-dev-front exposed-doc HTML participation = EXTEND, not creation

glass-atrium-dev-front's exposed-doc HTML co-authoring extends its existing concern; it is not a new agent.

- Scope: a bespoke interactive component or hand-authored CSS beyond Tailwind-CDN utilities, via the skeleton-first non-parallel handoff.
- Why: Creation-Gate Q2 = yes — markup craft already belongs to it.

- **Disjoint concern boundary**:
  - glass-atrium-design-designer = philosophy / Mermaid-type / section-composition / palette verdict (consultative, no markup);
  - glass-atrium-intel-reporter | glass-atrium-intel-planner = content + the single POST;
  - glass-atrium-dev-front = the bespoke styled-skeleton markup only.
- **glass-atrium-dev-front is not a default co-author** (default = `{author, glass-atrium-design-designer}`); how it enters is stated by the judgment canonical under **Pair note**.
- **`shared-design-token-consumption.md` does not gate this** — a self-contained Tailwind-CDN exposed doc is a markup-craft surface, not a token-consumption one.
- **Pair note**: this passage holds the EXTEND verdict only; the exception itself is stated per actor at:
  - author side — `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]` → **Markup exception (narrow)**;
  - judgment canonical — `skills/glass-atrium-ops-orchestrator-role.md` → `#### Monitoring-phase notes` plus `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md` → `## glass-atrium-dev-front markup exception — detail`;
    - that reference cites the rule file's `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]` stub for the EXTEND verdict;
  - dev-front side — `agents/glass-atrium-dev-front.md` → `## Exposed-Doc HTML Co-Emission (narrow exception)`.

## Sprint Contract Gate (orchestrator side)

The rule file states what the gate obliges a DEV agent; the classification below is the orchestrator's and fires before the DEV agent exists.

- Condensed copy: `skills/glass-atrium-ops-orchestrator-role.md` → the Decision `SIZABLE =` action row of `## Delegation Workflow`, which `#### Entry classification (DEV delegations)` names as the copy and points here directly — edit the two together.
- Per-criterion completion reporting is the rule file's; the Code-Based grader reads none of it, keying on task_type and the block's `files:` (`scoped/maintainers/core-outcome-record.md` → `### Grader verdict`).

### Sizable-task definition (single SoT — the positive entry floor)

A DEV task is **SIZABLE** — it MUST enter the Document-Driven Workflow (plan authoring + Stage-2 entry) — when any one criterion below holds.

- **Governing qualifier**: an orchestrator-judgment criterion, not a hook-computed value — size is not statically computable at delegation time (target-file count is free prose, turn count is post-spawn), and no hook reads it.
  - Apply the criteria as conservative judgment cues, not mechanical bright lines.
- **multi-file** — ~3+ coordinated target files, a strong signal (blast radius, a proxy for ripple); borderline → SIZABLE. Only genuinely independent trivial multi-file edits (no shared contract or behavior) are not auto-sizable.
- **cross-module** — the change spans ≥ 2 distinct modules / packages / bounded contexts (server route + DB schema; mobile UI + native bridge), even at low file count.
- **turns** — the orchestrator's pre-delegation estimate is 3+ agent turns.
- **contract** — the change alters a public API signature, a persisted data schema, or a cross-agent / cross-service contract; a 1-file change can still be sizable through ripple, not line count.
- **SIMPLE** (entry-exempt) = none of the four holds — typically a single-file typo / import addition / config-value edit / formatting, or a 1-2 file behavior-preserving change with no contract impact.

### Spawn-time entry gate (BLOCKING — exit 2)

A DEV implementation spawn carrying neither a plan reference nor an `[ENTRY-CLASS] simple-task` token is blocked at spawn time (channel-a, stderr + exit 2).

- **Both delegation paths are covered**: manual via the `enforce-verification-gate.sh` `PreToolUse(Agent)` hook (reads `subagent_type` from the spawn payload) · ultracode via the `enforce-workflow-verify-stage.sh` static scan of the workflow script.
- **The `[ENTRY-CLASS] simple-task: <reason>` token is the escape hatch** for legitimate small DEV work: a spawn judged simple emits it to pass the gate (`skills/glass-atrium-ops-orchestrator-role.md` Decision phase classify-always rule).
- **Ultracode placement**: on that path the token is recorded in the workflow script (canonical home: a `log()` string or `meta.description`), not in a delegation prompt.
  - A greppability convention, not a comment ban — the gate raw-scans, so any placement passes; the plan-ref token shares it.
  - Detail: `skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode` (Workflow pre-flight item 1) and `##### Entry-class token placement (ultracode — DEV workflow)`.
- **Recommended reason form** (honor-system audit convention; the gate's prefix match is unchanged): `[ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line>`.
  - Each key honestly negates one sizable criterion; a key that cannot be negated → the task is SIZABLE, author a plan.
- **Honest caveat**: the gate enforces signal absence, not size — it blocks only the "no plan-ref and no token" case and never computes whether a task is sizable.
  - The token is self-emitted, so a sizable task mislabeled simple still passes: the gate stops the unsignalled entry, not the misclassified one.
  - Fail-open is preserved (internal error / missing tooling → exit 0).
- **Not-gaming clarification**: emitting the token after an honest judgment that none of the four criteria hold is its correct use; gaming is only the dishonest inverse.
  - Error direction: under-classifying sizable work skips the plan + Stage-2 it needed (the dangerous error); over-escalating a simple task is the safe one — on a borderline case prefer SIZABLE.

### Sibling token — `[SIZE-EST]`

- `[SIZE-EST]` answers "how big is this delegation?" (bundle count + rough tool_use estimate, gating a packing split); `### Spawn-time entry gate (BLOCKING — exit 2)` answers "is this DEV spawn classified?".
- Contract SoT: `skills/glass-atrium-ops-delegation-contracts/references/delegation-size-discipline.md` → **`[SIZE-EST]` self-attestation token** (do not restate the format here).
- Standing obligation and split triggers: `skills/glass-atrium-ops-orchestrator-role.md` → `### Spawn Budget` → Delegation-size discipline.
- Both tokens' presence, never the estimate's correctness, is gate-enforced:
  - manual — `enforce-verification-gate.sh` (`has_size_est_token`, guarded by `hook_is_subagent` → orchestrator-origin spawns only);
  - ultracode — `enforce-workflow-verify-stage.sh` (`BLOCK_SIZEEST` under `ENTRY_OK`).

## Ambiguity Gate — pair note

- The six weighted axes in the rule file are restated at `scoped/scope-planning.md` → `## Ambiguity Gate [PLANNING]`.
  - A weight changed in one file changes by hand in the other.
- `agents/glass-atrium-intel-planner.md` → `### Ambiguity Gate (banded, not a single threshold)` points at the planning copy rather than restating the axes.

## Inbound citations to the rule file

Headings and bold leads other files resolve to — renaming or deleting one dangles a live reference. For a fresh set, grep the name over `rules skills scoped agents hooks test`; an `agents/` citer is frozen while the A/A window is open.

- `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]` (stub) ← `skills/glass-atrium-ops-orchestrator-role.md` · `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md`
- `## Sprint Contract Gate [DEV+QA]` ← `scoped/maintainers/glass-atrium-dev-node.md` · operator-facing messages in `hooks/enforce-workflow-verify-stage.sh`
- `## Plan Direction Verification Gate [DEV+QA]`
  - rules ← `scoped/scope-qa.md` · `scoped/scope-planning.md` · `scoped/maintainers/orchestrator-role.md`
  - skills ← `skills/glass-atrium-ops-orchestrator-role.md` · `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md` · `skills/glass-atrium-ops-delegation-contracts/references/scan-provenance.md`
  - agents ← `agents/glass-atrium-intel-planner.md` (the gate's name, Stage-2 bullet)
  - code ← `skills/glass-atrium-ops-orchestrator.md` (script comment) · `hooks/enforce-workflow-verify-stage.sh` (comment and message) · `hooks/test/inject-scope-single-delivery.bats` (comment) · `scripts/gate-audit.sh` (header)
- `## Ambiguity Gate (Ambiguity Score) [DEV+PLANNING]` and its Assumptions Disclosure ← `agents/GLASS_ATRIUM_GLOBAL_RULES.md` · `agents/glass-atrium-dev-animator.md` · `scoped/scope-planning.md`
- `## Pre-Execution Verification` → `### Project Convention Probe`
  - rules and agents ← `rules/glass-atrium/core-outcome-record.md` (`style_ref` row) · `agents/glass-atrium-dev-android.md` · `agents/glass-atrium-dev-swift.md`
  - notes in `scoped/maintainers/` ← `glass-atrium-dev-android.md` · `glass-atrium-dev-nestjs.md` · `glass-atrium-dev-node.md` · `glass-atrium-dev-python.md` · `glass-atrium-dev-react.md` · `glass-atrium-dev-shell.md` · `glass-atrium-dev-swift.md` · `shared-search-first.md`
  - code comments ← `hooks/lib/style-ref-consts.sh` · `hooks/lib/styleref-roster.sh` · `hooks/test/style-ref-flag-predicate.bats`
  - **Anchor file (SECONDARY)** ← `skills/glass-atrium-ops-orchestrator.md` → `### Quality Gates [ORCHESTRATOR]` → **Team termination**, which proposes drift notes into the anchor file; the rule file carries no back-link because DEV readers act on none of it.
- `### Pre-Edit Facts Disclosure` ← `hooks/advisory-preedit-facts.sh` (header and the operator-visible `missing`-verdict message) · `scoped/maintainers/glass-atrium-dev-nestjs.md` · `scoped/maintainers/glass-atrium-dev-react.md`
- `## Agent-Level Tool Exceptions` ← `agents/glass-atrium-dev-rag.md` (frontmatter NOTE, itself a fixture in `hooks/test/enforce-harness-critical-frontmatter.bats`)
- `## Modification Scope Constraint (Surface Area Constraint) [DEV]` ← `scoped/shared-testing.md` · `scoped/shared-search-first.md` (**Fact-ownership search**) · `agents/glass-atrium-intel-planner.md`
- **Bug fix = root cause, not symptom** ← `scoped/shared-search-first.md` (**Fact-ownership search**, which names the difference from it)
- **Minimalism reflex** and **Rule of Three before abstraction** ← `scoped/shared-comment-logging.md`
- `### Dead Code Non-Touch Principle` ← `scoped/shared-comment-logging.md` (disambiguates itself against it by name)
- `## Vendor-Routing Awareness [DEV]` has no external citer; the `Vendor-Routing` hits in `scoped/scope-design.md` and the designer body are their own sections.

## Inbound citations to this note

- `## DEV Agent Fleet Governance` ← `scoped/scope-dev.md` (stub) · `skills/glass-atrium-ops-orchestrator.md`
- `### New-Agent Creation Gate` ← `skills/glass-atrium-ops-orchestrator.md`
- `### Doc-sync note (CLI auto-writes vs. manual matrix update)` ← `rules/glass-atrium/core-compliance-matrix.md` → Scope Legend doc-sync note
- `## Sprint Contract Gate (orchestrator side)` ← `scoped/scope-dev.md` (stub) · `skills/glass-atrium-ops-orchestrator-role.md` → `#### Entry classification (DEV delegations)` · `scoped/maintainers/scope-qa.md`
- `### Sizable-task definition (single SoT — the positive entry floor)` ← `hooks/enforce-verification-gate.sh` (`entry_fix=` block text, VGATE-ENTRY-001) · `scoped/maintainers/orchestrator-role.md`
- `### glass-atrium-dev-front exposed-doc HTML participation = EXTEND, not creation` ← `scoped/maintainers/shared-design-token-consumption.md` → `## Readers, coupled tests, and one stale citation`
- `## Ambiguity Gate — pair note` ← `scoped/maintainers/scope-planning.md` (reads its six-axes assertion)
- `## Inbound citations to the rule file` ← `scoped/maintainers/glass-atrium-dev-android.md`
- `## Pair classifications` ← `scoped/maintainers/scope-qa.md`

## Open item

- `skills/glass-atrium-ops-orchestrator-role.md` → `### DEV fleet growth authority` reaches fleet governance through the rule-file stub, one hop more than needed; repointing it at this note's `## DEV Agent Fleet Governance` removes the hop. The fix edits that file, so it is owned outside this note.

## Sections dropped in this pass

Removed from the rule file, recorded so they are not re-derived as omissions:

- The delivery-status preamble and the "Readers (NOT UNUSED)" retention paragraphs: the `> scope-dev pointers:` body lines they named are gone, and each kept section stands on its own duty content or on `## Inbound citations to the rule file`.
- The pointer-only sections for naming conventions, code structure/function/type design, and the iron-law escalation pointer: each obliged nothing and was cited by nothing.
  - Naming also reaches DEV agents through `scoped/shared-naming.md` membership.
- The package-provenance bullet: Tier-1 `core-security.md` → Dependency Auditing states it.
- The reuse-order ladder bullet under vendor routing: the minimalism core carries the ladder and the never-hand-roll-crypto carve-out.
- **Surface, don't suppress**: merged into `## Modification Scope Constraint (Surface Area Constraint) [DEV]` → **Everything outside that set is surfaced, never performed**, with its `concerns:` channel.
- The Quality Self-Check reconciliation paragraph: the copy-paste row and **Rule of Three before abstraction** both fire at three, and the Rule of Three bullet already forbids abstracting at two.
- The EARS restatement under Pre-Edit Facts: it restated the hook bullet.
- The option-form pointer under the Ambiguity Gate: Tier-1 Position Bias Mitigation reaches every agent.
- The DEV-selection and simple-task-skip sentences under the plan gate: both are the orchestrator's acts.

## Pair classifications

| Pair | Class | Disposition |
|---|---|---|
| the rule file's non-waiver bullet ↔ `scoped/scope-qa.md` → its `### Non-waiver` heading | false pair | both stay: different actor, own verdict tokens (`feasible`/`infeasible` vs `pass`/`revise`) |
| the rule file's **Operational test** ↔ `scoped/scope-qa.md` and `scoped/scope-planning.md` | redundant, resolved | the rule file is the single site; both other files carry a pointer |
| the rule file's premise-audit lead ↔ the same lead in `scoped/scope-qa.md` | canonical + mirror | both stay byte-identical — `PREMISE_AUDIT_Q` quotes one home per actor |
| the rule file's **Sibling probe (PRIMARY)** code-form list ↔ `scoped/shared-search-first.md` → **Step 3 — Mirror** | redundant, resolved | search-first is the single site and reaches every DEV agent; the probe points at it |

- Non-waiver pair: each file is its reader's only channel.
- Flag, open (의미 상충): the Assumptions Disclosure and Pre-Edit Facts exemption lines list `typo / import / config` and call it the Ambiguity Gate's condition, whose list is typo fixes and import additions only.
  - Kept as is: aligning either list narrows or widens a rule, so the owner decides which list holds.

## Leave-deleted verdicts here are dated, not closed

- Every leave-deleted verdict in this companion, and in the audits behind it, was reasoned when a `scoped/` body reached no agent at spawn; the part slots now deliver this rule file whole to every DEV agent (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).
  - Re-examine a leave-deleted verdict against current delivery before relying on it.
- Relocating a duty into an agent body to route around a delivery gap stays FORBIDDEN: it manufactures body-versus-rule-file drift.
