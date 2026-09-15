# Maintainer note — `scoped/scope-dev.md`

Companion to `scoped/scope-dev.md`, which now carries DEV-agent-facing duties only. Everything here addresses a maintainer, the orchestrator, glass-atrium-meta-prompt-engineer, or the `agent_lifecycle` CLI operator — no running DEV agent is obliged by any of it.

Deliberately absent from this file: the compressed cores' lead-line needles and the first-link sentence literal. Each is counted or machine-extracted out of the rule file itself, and `scoped/` is a recursive grep root — a copy here is a second hit, never a convenience.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine-read shape of the rule file

| What is read | Reader | The shape it depends on |
|---|---|---|
| the Tier-2 loading stanza's brace-delimited DEV roster | `scripts/agent_lifecycle/readers.py` → `parse_scope_dev_roster` (re-parsed on every edit by `stanza.py`) | an `agent_scope`-anchored brace list; absent → `ReaderError`/`StanzaError` aborts the lifecycle add/delete |
| the same brace list | `autoagent/lib/roster_merge.py` → `_get_markdown_slots` | EXACTLY ONE brace-delimited membership list FILE-WIDE — its regex does not require the `agent_scope` prefix, so a second brace list of that shape anywhere in the file makes the updater refuse the whole file at deploy and strand every unrelated edit in it |
| the whole file, as rule text for DEV spawns | `hooks/lib/inject_chunk.py`, selected by each DEV agent's `agent-registry.json` → `rules.scope` | heading boundaries — the chunker splits at headings and packs whole sections into capped parts, so a section too large for one part is named in an oversize marker instead of delivered; no `AGENT-INJECT` marker or extraction range applies |
| the first-link question's quoted sentence | `hooks/test/enforce-workflow-verify-stage-firstlink.bats`, cross-read against `FIRST_LINK_LITERAL` in `hooks/enforce-workflow-verify-stage.sh` | see Extraction constraints below |
| the whole file, as a rule excerpt | `autoagent/daemon_cycle.py` verify prompt (char cap 120,000, no heading anchor) | nothing — restructure freely |
| the file's basename | `hooks/validate-compliance-matrix.sh` (Layer A, `find -maxdepth 1` over `scoped/`) | a Compliance Matrix row for `scope-dev.md`. That scan is depth-1, which is why this companion sits in a SUBDIRECTORY and needs no matrix row of its own |

### Extraction constraints (the first-link question)

The suite runs a `sed` line RANGE over the rule file and then pulls the backticked sentence out of it. Four properties are load-bearing, and breaking any of them fails the suite as drift:

- the bullet label carrying the capitalised phrase occurs EXACTLY ONCE and is the FIRST such occurrence in the file — the range opens on a case-sensitive substring match, so an earlier occurrence opens early and empties this bullet's own range;
- the sentence sits on the NEXT line as a two-space-indented blockquote whose entire content is one backticked sentence;
- a two-space-indented list bullet (`  - `) follows it, because that is what CLOSES the range — a three- or four-space bullet does not;
- no SECOND two-space blockquote-backtick line falls inside the range, or the extraction yields two candidates and mismatches.

Every other mention of that question in the rule file is deliberately lower-case for the first property. Keep it that way.

### Retired slot-1 blocks — what remains in the rule file

- The rule file carries no `AGENT-INJECT` marker. `hooks/inject-scope-rules.sh` extracts nothing from it; DEV agents receive the whole file through the part slots by `rules.scope` membership.
- **Kept as ordinary content**: the style_ref core (after `### Project Convention Probe`) and the minimalism core (closing `## Complexity Proportionality`).
  - Several rules in the minimalism core — the `ponytail:` corner-cut mark, the heavy-machinery rule, the ≤3-line output rule — are stated nowhere else in the file, so the core cannot be deleted as a duplicate.
- **Deleted outright**: the plan-gate core. Every clause it carried is stated in `## Plan Direction Verification Gate [DEV+QA]`, including the three-part first-link answer shape the byte cap had cut from it.
- **Folding each kept core into its canonical section is open work**: it needs a per-bullet audit, and it is the only way to remove the in-file restatement a DEV agent now reads twice within one part.
- **Keep each kept core's bold lead phrase** (the words before its parenthetical): `hooks/test/inject-scope-rules-nodrop.bats` → `RETIRED_NEEDLES` asserts them ABSENT from slot 1, and the check proves nothing once a phrase no longer exists in the source.
- **Precondition the retirement rests on**: `python3 hooks/lib/inject_chunk.py --audit` MUST report `events=none` for every DEV agent. An OVERFLOW displaces a member band, and no slot-1 copy remains behind it.
- **Degraded installs**: an install with no runnable python3 or an unreadable registry delivers none of this file's rules; `lib/ga-doctor.sh` MUST warn on that state.

### Removed from the premise check, said once so it is not re-derived

The register-wide sweep, the unregistered-claim flag duty and the claim-class mandatory-instrument rule were removed. The per-handle vocabulary was near-absent from the recorded verdict corpus (instrumented window 2026-08-18 → 2026-09-09) while the direction errors this gate caught came from reading code against a plan claim — the bookkeeping was the cost, the code-reading the value. The window is named because it is the instrument the removal rests on; without it a later editor cannot tell a measured decision from a preference.

### Ultracode enforcement note (orchestrator/authoring side)

- Under ultracode the `enforce-verification-gate.sh` `PreToolUse(Agent)` hook is BYPASSED for engine `agent()` spawns, so the in-script verify stage is the PRIMARY (honor-system) authoring obligation.
- It is backstopped by the `enforce-workflow-verify-stage.sh` `PreToolUse(Workflow)` declaration-contract gate, which catches decidable author errors only — missing / malformed / code-inconsistent declaration · zero reviewer · declared-impl-before-reviewer ordering. Declaration TRUTHFULNESS stays honor-system; never describe it as full enforcement.
- Declaration grammar + skeletons canonical: `skills/glass-atrium-ops-orchestrator.md` → Pipeline Acceptance Criteria "In-script verify-stage"; rule SoT: the same file → `### Ultracode / Workflow-tool Mode`.

## DEV Agent Fleet Governance

The DEV fleet roster (SoT) is the rule file's Tier-2 loading stanza. This section governs when that roster may grow. Readers: the orchestrator, which routes a capability gap back to this gate rather than self-authoring an agent · glass-atrium-meta-prompt-engineer, which writes the body · the maintainer of the CLI and of the two stanza parsers above.

Cross-ref: `rules/glass-atrium/orchestrator-role.md` capability-based routing (the "starting reference, not a routing contract" clause) — concern-based separation is what keeps `domains` arrays distinct enough for that routing.

Pair note: the growth decision is also stated at `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria` (the DEV-fleet-growth-authority clause, which declares extension the default and routes creation back here) and the flow that executes it at `skills/glass-atrium-ops-orchestrator.md` → `### In-Context Agent-Lifecycle Ceremony (CREATE/EXTEND — ceremony SoT)`, so a reader loosening the gate here is loosening a rule two other files also state.

### Separation Axis

DEV agents are separated by **concern (execution responsibility)**, never by language or framework version. A concern = the artifact set an agent exclusively owns + the decisions it is solely accountable for.

An agent boundary is justified only when the two sides hold **ALL THREE** (any one absent → merge, not split):

- **Disjoint artifact types** — the files each agent produces are structurally distinct (`.tsx` component logic vs. `.css`/`tailwind.config` styling · `.sql` DDL vs. `.ts` service layer).
- **Disjoint decision domain** — the expertise for correct decisions is non-overlapping (React lifecycle vs. GSAP timeline · NestJS DI/CQRS vs. Node ESM stream pipeline · retrieval tuning vs. API routing).
- **Non-transferable quality judgment** — a quality review in one concern cannot be performed by an agent holding only the other's expertise (EXPLAIN ANALYZE index calls need DB-specialist judgment a NestJS agent cannot substitute).

Two things are NOT axes:

- **Code-quality rules**: every DEV agent declares an identical rule membership in its `agent-registry.json` entry (`rules.scope` = scope-dev · `rules.shared` = the Tier-3 cross-cutting set); quality consistency is centralised at the rule layer. An agent proposed solely to enforce a different quality standard is invalid — update the shared rule instead.
- **Language alone**: a new language/framework runtime justifies a new agent only when it ALSO introduces a concern meeting all three criteria. Counter-example: `glass-atrium-dev-python` covers FastAPI + Litestar + Django + CLIs + data pipelines in one agent (the Python-runtime concern is unified).

### New-Agent Creation Gate

Default = **extend an existing agent**; creation is the exception. Before creating a DEV agent, the requester (orchestrator or glass-atrium-meta-prompt-engineer) MUST answer all three affirmatively — any "no" blocks creation:

- **Q1 — Concern novelty**: does the proposed agent own a concern meeting ALL THREE Separation-Axis criteria? A sub-variant of an existing concern (new framework on the same runtime, new API version) → "no".
- **Q2 — Extend test**: can the closest-concern existing agent absorb the new knowledge via its `description` + `domains` array + body, without degrading routing precision or exceeding a single-budget turn? Yes → EXTEND, do not create.
- **Q3 — Fleet-size cost**: does the addition keep every agent's `domains` array semantically distinct enough that capability-based routing stays precise? Heavily overlapping `domains` indicate a merge, not a creation.

**On creation**, all of the following, atomically:

- add the name to the rule file's loading stanza;
- add an `agent-registry.json` entry with a non-overlapping `domains` array;
- give that entry the standard `rules` object — `rules.scope` / `rules.shared` identical to every other DEV agent (no custom quality rules);
- add a `compatibility` field when the agent has runtime preconditions (pattern: `glass-atrium-dev-animator`).

**In-context lifecycle wiring (decision tree → CLI)**: the orchestrator's in-context flow (ceremony SoT: `skills/glass-atrium-ops-orchestrator.md` → In-Context Agent-Lifecycle Ceremony) realises this gate through the `agent_lifecycle` CLI.

- **DEFAULT branch = EXTEND** — `extend.py` via `--add-domain` / `--append-section`, additive append-only.
- **CREATE only when Q1/Q2/Q3 are all affirmative** — the three map to `evaluate_add_gate` (`add.py`), and Q3 is the codified domain-overlap hard-block in `overlap.py` (`OVERLAP_THRESHOLD`; read the bar from that constant, never from a figure copied into prose).
- **The gate (`gate.py` + `overlap.py`) stays SOLE authority**: the flow SUPPLIES the Q1/Q2 attestation verdicts (`--gate-q1`/`--gate-q2`, each `pass`/`fail`) but NEVER computes `allowed` and NEVER re-implements the overlap predicate.
- **The orchestrator never self-authors the body** — glass-atrium-meta-prompt-engineer is the author.

### Doc-sync note (CLI auto-writes vs. manual matrix update)

A successful `add` writes some of the sites a new name must appear in, and not others.

- **Auto-written**: the agent file · the `agent-registry.json` entry (whose `rules` object selects the scope and Tier-3 files the part slots deliver) · (via the post-commit reconcile gate) the reconcile-tracked arrays `BUDGET_DEV_AGENTS` in `hooks/inject-scope-rules.sh` and `STYLEREF_AGENTS` in `hooks/lib/styleref-roster.sh`.
- **Deliberately UNTRACKED by that gate**: the manual-curated rosters `BUDGET_ANALYSIS_AGENTS` and `WIKI_UNTRUSTED_AGENTS`. Their membership is a governance decision rather than a roster-derivable set, so their absence from the auto-written set is design, never an omission for a later editor to repair.
- **NOT written at all**: the `core-compliance-matrix.md` **Scope Legend** DEV row and the **Compliance Matrix** rows — a SEPARATE post-creation doc update for the new agent name.
- **Mirror pointer**: the same tracked-array list is stated at `skills/glass-atrium-ops-orchestrator.md` → the numbered step **Reconcile (MANDATORY post-commit gate)** and at `skills/glass-atrium-ops-reconcile-inject/SKILL.md` → the **Names reconciled** bullet — edit those sites together with this one.

### glass-atrium-dev-front exposed-doc HTML participation = EXTEND, not creation

glass-atrium-dev-front's narrow role co-authoring viewer-exposed clauded-docs HTML primaries — bespoke interactive component / hand-authored CSS beyond Tailwind-CDN utilities, via the skeleton-first non-parallel handoff — is an EXTEND of the existing glass-atrium-dev-front concern (Creation-Gate Q2 = yes: markup craft already belongs to it), NOT a new agent.

- **Disjoint concern boundary**: glass-atrium-design-designer = philosophy / Mermaid-type / section-composition / palette verdict (consultative, no markup) · glass-atrium-intel-reporter | glass-atrium-intel-planner = content + the single POST · glass-atrium-dev-front = the bespoke styled-skeleton markup only.
- **glass-atrium-dev-front is NOT a default co-author** (default = `{author, glass-atrium-design-designer}`).
  - The entry/handoff mechanics (author `needs_devfront_markup` signal → orchestrator Monitoring-phase capability judgment, NOT user approval) are canonical in `orchestrator-role.md` → glass-atrium-dev-front markup-exception Monitoring judgment.
- **`shared-design-token-consumption.md` does NOT gate this** — a self-contained Tailwind-CDN exposed doc is a markup-craft surface, not a token-consumption one, but markup craft is still glass-atrium-dev-front's concern.
- **Pair note**: this passage holds the EXTEND verdict only; the exception itself is stated per actor at:
  - `scoped/scope-report.md` → `## Designer Co-Emission Trigger [REPORT]` → **Markup exception (narrow)** — author side;
  - `rules/glass-atrium/orchestrator-role.md` → `#### Monitoring-phase notes` — the judgment canonical, which cites the rule file's `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]` stub for the EXTEND verdict;
  - `agents/glass-atrium-dev-front.md` → `## Exposed-Doc HTML Co-Emission (narrow exception)` — the dev-front side.

## Sprint Contract Gate (orchestrator side)

The rule file states what the gate obliges a DEV agent; the classification below is the orchestrator's and fires before the DEV agent exists.

Pair note: reviewer- and orchestrator-side copies sit at `scoped/scope-qa.md` → `## Sprint Contract Gate [DEV+QA]` and `rules/glass-atrium/orchestrator-role.md` → `## Delegation Workflow` (Decision row, which condenses the sizable criteria inline rather than pointing only). Both cite the definition below as their SoT.

### Sizable-task definition (single SoT — the positive entry floor)

A DEV task is **SIZABLE** (MUST enter the Document-Driven Workflow — plan authoring + Stage-2 entry) when **ANY ONE** of the criteria below holds.

- **Read this FIRST (governing)**: this is an **orchestrator-judgment criterion, not a hook-computed value** — size is not statically computable at delegation time (target-file count is free prose, turn count is post-spawn), and no hook reads or parses it. Apply the criteria as conservative judgment cues, not mechanical bright-lines.
- (a) **multi-file blast radius — ~3+ COORDINATED target files**. 3+ files is a STRONG sizable signal (blast radius, a proxy for ripple); borderline → SIZABLE — only genuinely independent trivial multi-file edits (no shared contract/behavior) are not auto-sizable.
- (b) **cross-module change** — the change spans ≥ 2 distinct modules / packages / bounded contexts (server route + DB schema; mobile UI + native bridge), even at low file count.
- (c) **≥ 3 expected agent turns** — the orchestrator's pre-delegation estimate is 3+.
- (d) **public-contract change** — the change alters a public API signature, a persisted data schema, or a cross-agent / cross-service contract (a 1-file change can still be sizable via blast radius — ripple, not line count).
- **SIMPLE** (entry-exempt) = NONE of the four holds — typically a single-file typo / import addition / config-value edit / formatting, or a 1-2 file behavior-preserving change with no contract impact.

### Spawn-time entry gate (BLOCKING — exit 2)

A DEV implementation spawn carrying NEITHER a plan reference NOR an `[ENTRY-CLASS] simple-task` token is BLOCKED at spawn time (channel-a, stderr + exit 2).

- **Both delegation paths are covered**: the manual path via the `enforce-verification-gate.sh` `PreToolUse(Agent)` hook (which reads `subagent_type` from the spawn payload), and the ultracode path via the `enforce-workflow-verify-stage.sh` static scan of the workflow script.
- **The `[ENTRY-CLASS] simple-task: <reason>` token is the escape hatch** for legitimate small DEV work — a spawn judged simple/exempt emits it to pass the gate (per `orchestrator-role.md` Decision phase classify-always rule).
- **Ultracode placement**: on that path the token is recorded IN the workflow script (canonical home: a `log()` string or `meta.description`) rather than in a delegation prompt.
  - This is a greppability convention, NOT a comment prohibition — the gate raw-scans, so any placement passes; the plan-ref token shares it.
  - See `skills/glass-atrium-ops-orchestrator.md` → `### Ultracode / Workflow-tool Mode` (Workflow pre-flight item 1) and its Pipeline Acceptance Criteria "Entry-class token placement".
- **Recommended reason form** (honor-system AUDIT CONVENTION — the gate's prefix match is unchanged): `[ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line>` (each key = one sizable criterion honestly negated; any key not honestly negatable → the task is SIZABLE, author a plan).
- **Honest caveat**: the gate enforces signal ABSENCE, not size — it blocks only the "no plan-ref AND no token" case and never computes whether a task is genuinely sizable.
  - The token is self-emitted, so a gamed token (a sizable task mislabeled simple) still passes — the gate stops the unsignalled entry, not the misclassified one.
  - Fail-open is preserved (internal error / missing tooling → exit 0).
- **Not-gaming clarification (honesty, not bias)**: emitting the simple-task token after an HONEST judgment that NONE of the four criteria hold is the CORRECT use of it.
  - Gaming is ONLY the dishonest inverse.
  - Error-direction asymmetry: under-classifying sizable work as simple is the DANGEROUS error (it skips the plan + Stage-2 the work actually needed); over-escalating a genuinely simple task is the SAFE error — on a borderline case prefer SIZABLE.
- **Sibling token — `[SIZE-EST]`**: this gate answers "is this DEV spawn classified?"; `[SIZE-EST]` is a separate self-attestation answering "how big is THIS delegation?" (bundle count + rough tool_use estimate, gating per-delegation packing split vs no split).
  - Contract SoT: `orchestrator-role.md` → `### Spawn Budget` → Delegation-size discipline (do not restate the format here).
  - BOTH tokens' PRESENCE (never the estimate's correctness) is gate-enforced on both paths: manual via `enforce-verification-gate.sh` (`has_size_est_token`, guarded by `hook_is_subagent` → orchestrator-origin spawns only), ultracode via `enforce-workflow-verify-stage.sh` (`BLOCK_SIZEEST` under `ENTRY_OK`).

Cross-ref: the `core-outcome-record.md` Field Input Guide `metric_pass` row's per-task-type check matrix operates as the Code-Based grader tier (author-side outcomes only); the Sprint Contract Gate pass/fail record applies that tier's acceptance-criteria branch.

## Ambiguity Gate — pair note

- The six weighted axes in the rule file are restated at `scoped/scope-planning.md` → `## Ambiguity Gate [PLANNING]`.
  - A weight changed in one file changes by hand in the other.
- `agents/glass-atrium-intel-planner.md` → `### Ambiguity Gate (banded, not a single threshold)` points at the planning copy rather than restating the axes.
- `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Absolute Rules [ALL]` points at the rule file for the Assumptions Disclosure obligation.

## Inbound citations to the rule file

Headings other files resolve to — renaming or deleting one dangles a live reference. Instrument for a fresh set: grep the heading name over `rules skills scoped agents hooks`.

| Heading in `scoped/scope-dev.md` | Cited from |
|---|---|
| `## DEV Agent Fleet Governance [DEV+ORCHESTRATOR+META]` (stub) | `rules/glass-atrium/orchestrator-role.md` |
| `## Sprint Contract Gate [DEV+QA]` (stub) | `rules/glass-atrium/orchestrator-role.md` · `scoped/scope-qa.md` · `scoped/maintainers/glass-atrium-dev-node.md` · operator-facing messages in `hooks/enforce-verification-gate.sh` and `hooks/enforce-workflow-verify-stage.sh` |
| `## Plan Direction Verification Gate [DEV+QA]` | `rules/glass-atrium/orchestrator-role.md` · `scoped/scope-qa.md` · `scoped/scope-planning.md` · `skills/glass-atrium-ops-orchestrator.md` (comment) · `hooks/enforce-workflow-verify-stage.sh` (comment) |
| `## Ambiguity Gate (Ambiguity Score)` → Assumptions Disclosure | `agents/GLASS_ATRIUM_GLOBAL_RULES.md` · `agents/glass-atrium-dev-animator.md` · `scoped/scope-planning.md` |
| `## Pre-Execution Verification` → `### Project Convention Probe` | `rules/glass-atrium/core-outcome-record.md` (`style_ref` row) · `agents/glass-atrium-dev-android.md` · `agents/glass-atrium-dev-shell.md` · `agents/glass-atrium-dev-swift.md` |
| `### Pre-Edit Facts Disclosure` | `hooks/advisory-preedit-facts.sh` (header and the operator-visible `missing`-verdict message) |
| `## Agent-Level Tool Exceptions` | `agents/glass-atrium-dev-rag.md` (frontmatter NOTE, itself a fixture in `hooks/test/enforce-harness-critical-frontmatter.bats`) |
| `### Dead Code Non-Touch Principle` | `scoped/shared-comment-logging.md` (disambiguates itself against it by name) |

- `## Vendor-Routing Awareness [DEV]` has no external citer; the `Vendor-Routing` hits in `scoped/scope-design.md` and the designer body are their own sections.

## Inbound citations to this note

| Heading in this note | Cited from |
|---|---|
| `## DEV Agent Fleet Governance` | `scoped/scope-dev.md` (stub) · `skills/glass-atrium-ops-orchestrator.md` |
| `### New-Agent Creation Gate` | `skills/glass-atrium-ops-orchestrator.md` |
| `### Doc-sync note (CLI auto-writes vs. manual matrix update)` | `rules/glass-atrium/core-compliance-matrix.md` → Scope Legend doc-sync note |
| `## Sprint Contract Gate (orchestrator side)` · `### Sizable-task definition (single SoT — the positive entry floor)` | `scoped/scope-dev.md` (stub) |
| `### glass-atrium-dev-front exposed-doc HTML participation = EXTEND, not creation` | `scoped/maintainers/shared-design-token-consumption.md` → `## Readers, coupled tests, and one stale citation` |

## Open item

Owned by a later pass, outside this wave's file set:

- `rules/glass-atrium/orchestrator-role.md` and `scoped/scope-qa.md` still reach the moved gate bodies (fleet governance · the orchestrator-side Sprint Contract Gate) through the rule-file stubs, one hop more than needed. Repointing them at this note removes the hop; `core-compliance-matrix.md` and `skills/glass-atrium-ops-orchestrator.md` already point here.

## Follow-up fix pass — what changed in the rule file

- The maintainer preamble pointing here was removed, and so was the companion pointer in the first-link LITERAL bullet: neither sat under an externally-cited stub heading, so neither is sanctioned by the companion-citation convention in this note's header. The literal bullet keeps its caution — the sentence and the two lines bracketing it are machine-read — stated without the pointer.
- The two sanctioned pointers remain, one each under `## DEV Agent Fleet Governance` and `## Sprint Contract Gate [DEV+QA]`, which are the two headings external files cite into.
- The three `<!-- … Detail: scoped/maintainers/scope-dev.md -->` comments that sat beside the marker blocks went with the markers when the slot-1 blocks retired (`### Retired slot-1 blocks — what remains in the rule file`); no machine-extracted block remains for them to address.
- The loading stanza regained its `> **Inherits**:` and `> **See**:` lines for parity with the other scope files. Neither line contains a brace, so the single-brace-list invariant both stanza parsers depend on is untouched.

## Sections dropped in this pass

Removed from the rule file, recorded so they are not re-derived as omissions:

- The delivery-status preamble and the four "Readers (NOT UNUSED)" retention paragraphs: each justified a section by naming a `> scope-dev pointers:` line in the DEV bodies, and that line was deleted from every body. The sections they protected are kept on their own duty content or on the citations tabled above.
- The pointer-only sections for naming conventions, code structure/function/type design, and the iron-law escalation pointer.
  - Their skills load globally at session start and the naming rules additionally reach DEV agents through `scoped/shared-naming.md` membership, so each line obliged nothing and was cited by nothing.
- The package-provenance bullet: `core-security.md` → Dependency Auditing states it, is Tier 1, and measurably reaches every agent.
- The reuse-order ladder bullet under vendor routing: the minimalism core carries the ladder and the never-hand-roll-crypto carve-out verbatim.

## Pre-Edit Facts Disclosure — restored

- **Citers**: `hooks/advisory-preedit-facts.sh`, a Stop-bound advisory, names the rule twice in its header and once in the operator-visible `missing`-verdict message, and `test/advisory-preedit-facts.bats` pins the declaration shape.
  - Binding SoT: `lib/ga-env.sh` → `EXPECTED_HOOK_BINDINGS`, upserted by `wire_hooks`; `settings.template.json` does NOT carry that row.
- **Disposition taken**: the section is restored to the rule file verbatim from `32a0685^`, placed after the style_ref core and before `## Context Engineering [DEV]`, so it opens a clean sibling section under `## Pre-Execution Verification [DEV]`.
- **Why restore rather than retire the hook**: the restore costs no extra file and makes the operator-visible citation resolve.
- **Delivery rides the part slots, never a marker block**: the rule file reaches every DEV agent whole through `rules.scope` membership, and slot 1 carries no scope-file text. A new marker block is NOT a sanctioned route for this duty.

## Leave-deleted verdicts here are dated, not closed

Every leave-deleted verdict in this companion, and in the audits behind it, was reasoned under a delivery regime in which a `scoped/` body reached no agent at spawn. That regime has ended: the part slots deliver this rule file whole to every DEV agent (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).

- Re-examine a leave-deleted verdict against current delivery before relying on it; the retired premise settles none of them.
- Relocating a duty into an agent body to route around a delivery gap stays FORBIDDEN: it manufactures body-versus-rule-file drift.
