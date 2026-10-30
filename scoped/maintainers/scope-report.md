# Maintainer note — `scoped/scope-report.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Delivery status

- The rule file reaches glass-atrium-intel-reporter whole at spawn through the part slots, selected by its `agent-registry.json` row (`rules.scope`).
  - Mechanism: `rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`.
  - No other agent's row names it: the planner's names `scoped/scope-planning.md`.
- A reporter-body passage restating a section of the rule file is a redundant mirror — reduce it to a reference plus the reporter-only delta.
- A canonical homed in the reporter body stays there, and the rule-file section names it as canonical: the mode table, the HTML Request Test signal literals, the Visual-Maximization Floor baseline and escalation, and the dark-base contract.
- A planner-body copy of a report-side rule is the copy the planner applies — never cut it as a duplicate of the rule file.

## Coupled readers

| Reader | Reads | Consequence of deleting what it reads |
|---|---|---|
| glass-atrium-intel-reporter, at spawn | the whole file, as its Tier-2 rule text | the rule leaves the reporter's context, and the body pointer naming that section dangles |
| `scripts/test/doctrine-budget-parity.bats` | `## Pre-drawing Doctrine [REPORT]`, as the SoT it compares against the monitor sources | the suite reds — that section is machine-load-bearing in this file and cannot move here |
| `autoagent/daemon_cycle.py` | the whole file, excerpted as the C3 axis of the rule-improvement verify prompt | an empty file directs `C3: FAIL`; a rename or a move out of `scoped/` breaks its agent→scope-file map |
| `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → Monitor address | `### Emission contract`, for what to POST and when | every agent's Tier-1 pointer dangles |
| agent bodies, skills, `scoped/scope-planning.md`, maintainer notes | the H2/H3 headings by name — find them with a corpus grep of the heading | a rename or deletion dangles them; fix every citer in the same pass |

- No outside citer: `#### Who closes` and `#### Supersede vs new`, the sub-headings under `### Document Lifecycle — completion + exposure routing`.

## Machine-read byte contract — `## Pre-drawing Doctrine [REPORT]`

- `scripts/test/doctrine-budget-parity.bats` extracts the cap numbers, the warn/fail ratios and the size-preset class names from that section's own text.
- It compares them against the monitor sources — the preset names against the viewer `monitor/public/src/screens/clauded-docs.jsx` and the export `monitor/src/server/clauded-docs/html-export.ts`.
- Byte-fragile as a result:
  - the heading must begin its line, and the suite reads from it to the next `##` heading — so no further `##` heading may be opened inside the section;
  - the cap line and the band line each stay one line, keeping their `·` separators and their comparison glyphs; the suite's mutation row rewrites the first cap in place, so that line's `nodes` spelling is fixed too;
  - the Budget step must keep naming a `content-budget.ts` path — a section naming none fails the cap and band rows rather than reading as parity against nothing;
  - the preset class names are matched by prefix, so the section must not introduce a further token sharing `doc-diagram-`.
- The reporter body points at that section and restates no value; the planner-body copy, which the suite does not read, is the **Pre-drawing Doctrine numbers** co-edit entry below.

## Co-edit rosters (what moves together when a rule changes)

Each entry is keyed by the rule text; its copies change with it.

- **Three emission modes**: `agents/glass-atrium-intel-reporter.md` → `## Output Format Routing` (canonical mode table) · `agents/glass-atrium-intel-planner.md` → `### Three emission modes (evaluate in order)`.
- **HTML request test**:
  - `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test (explicit-request-only — heuristic auto-HTML FORBIDDEN)` (canonical literals);
  - `agents/glass-atrium-intel-planner.md` → `### HTML request test (explicit-request-only — heuristic auto-HTML FORBIDDEN)`;
  - the orchestrator's copy: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Deliverable exposure and designer composition (Decision phase)` plus `skills/glass-atrium-ops-delegation-contracts/references/deliverable-exposure.md` → `## Exposure Determination — signals and routing`.
- **Visual-Maximization Floor**: `agents/glass-atrium-intel-reporter.md` → `### Visual-Maximization Floor` (authoring canonical) · `agents/glass-atrium-intel-planner.md` → `### Visual-Maximization Floor — Baseline (always)` and `### Visual-Maximization Floor — Content-driven escalation`.
- **Dark base default**: `agents/glass-atrium-intel-reporter.md` → `### Dark Theme & Typography (MUST)` (canonical) · `agents/glass-atrium-intel-planner.md` → `### Dark base, typography and status vocabulary`.
- **Emission contract / POST tuple**:
  - `agents/glass-atrium-intel-reporter.md` → `### POST tuple + copy-paste curl`, the curl block and optional-field values · `agents/glass-atrium-intel-planner.md` → `### Emission contract (POST tuple)`.
  - The authority is the route source `monitor/src/server/routes/clauded-docs.ts`, not any prose copy.
- **`[DOC-ROUTE]` stamp**:
  - the `### Emission contract` carve-out bullet;
  - `agents/glass-atrium-intel-reporter.md` → `## Output Format Routing`, the exception lead inside the turn-0 routing hard gate;
  - `agents/glass-atrium-intel-planner.md` → `### Turn-0 routing hard gate`, the stamp table and the `The stamp attests` bullet;
  - the delegation-side canonical `skills/glass-atrium-ops-orchestrator-role.md` → `## Delegation Criteria`.
- **Document lifecycle**:
  - `agents/glass-atrium-intel-reporter.md` → the bolded lead `**Document lifecycle duties — you are the completing agent and you own these:**`, the reporter-only deltas;
  - `agents/glass-atrium-intel-planner.md` → `### Document lifecycle duties (delivered copy — the completing agent owns these)` + its sibling `### Document stages and closing`.
- **D8 requirement list**:
  - `agents/glass-atrium-intel-reporter.md` → `### Pre-Emission HTML Validation (D8 + Schema)`, the maintained source;
  - `agents/glass-atrium-intel-planner.md` → `## Pre-Emission Verification Gate [PLANNING]`;
  - `scoped/scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]`.
- **Server schema gates** (the `html_body` 400 codes; payload 400s are the route's — **Emission contract / POST tuple**): the authority is `monitor/src/server/clauded-docs/html-validator.ts` → `validateHtmlStructure`, whose pipeline comment lists each stage.
  - The prose copy is `agents/glass-atrium-intel-reporter.md` → `### Schema Gates (Server-Enforced)`; a gate change corrects it in the same pass.
- **Diagram Standard runtime-load contract**: `agents/glass-atrium-intel-reporter.md` → `### Sandbox-Safe Interactivity (MUST)` · `agents/glass-atrium-intel-planner.md` → `### Pre-Emission HTML Gates (user-requested HTML primary only)`.
- **Pre-drawing Doctrine numbers**: `agents/glass-atrium-intel-planner.md` → `### Pre-drawing decision core (delivered copy — apply to EVERY Mermaid block, not only the first)`.
- **Mermaid adopted-set copies**: `monitor/src/server/clauded-docs/diagram-types.json` governs; every prose member list is a hand-synced copy, corrected against the JSON.
  - `scoped/scope-report.md` → `## Pre-drawing Doctrine [REPORT]`, the Type step.
  - `agents/glass-atrium-intel-planner.md` → `### Pre-drawing decision core (delivered copy — apply to EVERY Mermaid block, not only the first)`.
  - `skills/glass-atrium-design-html-co-emission/SKILL.md` → `### Mermaid type mapping`.
  - Unpinned: no suite compares a copy's member list with the JSON; `monitor/test/clauded-docs.diagram-types.test.ts` checks only the JSON's own invariants and mermaid's behaviour.
- **Designer Co-Emission Trigger**:
  - `agents/glass-atrium-intel-reporter.md` → `## Designer Handoff Contract` (declaration form) · `agents/glass-atrium-intel-planner.md` → `## Designer Handoff Contract` (table copy);
  - `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role` · `skills/glass-atrium-design-html-co-emission/SKILL.md`, whose `## Cross-References` designer bullet records the stub↔skill pair;
  - `skills/glass-atrium-ops-orchestrator-role.md` → Visual-Weight Probe, and its Monitoring-phase markup-exception judgment (`#### Monitoring-phase notes`).
  - The designer stub keeps its trigger, output-field names and veto line; the designer body carries no pair map.
- **D8 numeric thresholds**: `monitor/src/server/clauded-docs/d8-thresholds.json` is the authority, and every prose number is a mirror of it.
  - A threshold change lands in the JSON first; every prose mirror is corrected to it in the same pass — the sites of the **D8 requirement list** entry.
  - A prose-only number edit is forbidden.

## Standing drift reports (reported, not reconciled — the rule owner's call)

- The planning-side visual copies compressed away items the reporter body's authoring canonical keeps: the `light-default-body` prohibition list, the HTML-comment-dropped-pre-scan carve-out and the `oklch` background option.
  - The drift sits between `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec (applies to user-requested HTML primary)` and that canonical.
- The anti-slop SoT (`agents/glass-atrium-design-designer.md`) and its mechanical detector (`skills/glass-atrium-design-anti-slop/SKILL.md`) are drifted in both directions.
  - The detector carries patterns the SoT never adopted, including a pure-white-on-dark numeric floor with no canonical home.
  - The detector omits the SoT's mixed-radius and workflow entries.
- The `prefers-reduced-motion` fallback is canonical at `scoped/shared-design-token-consumption.md` → `## Motion Tokens` → the **`prefers-reduced-motion`** bullet, which forbids a hard cut.
  - Copies and pointers spread across the UI-emitting DEV fleet, the design references and the DESIGN template; some omit that prohibition. The reporter body carries an HTML-doc variant that points there.
  - No roster is kept, because the set grows with the fleet.

## Restructure + diet pass — dispositions

The rule file keeps the rules no body carries, the sections a coupled reader or a live pointer reads, and one pointer per externally-cited heading.

- **Kept as sole copies**: the `URL + collected_at(YYYY-MM-DD)` citation format (`collected_at`: 0 hits across `agents/*.md`) and the residual anti-slop patterns (`background-clip`, `lavender`, `grid-cols-3`: 0 hits across `agents/*.md`, and self-declared absent from the designer SoT).
- **Kept because a Tier-1 pointer lands there**: `### Emission contract` — the `agents/GLASS_ATRIUM_GLOBAL_RULES.md` row of `## Coupled readers`.
- **Kept because a live pointer calls this file the canonical for it**: `## Diagram Standard [REPORT]` ban/allow list, `## Report Structure [REPORT]`, `## Self-Evaluation Obligation [REPORT]`, `### Document Lifecycle`, `### Threshold SoT`, the T1-T5 table — each at its operative statement only.
- **Dropped as duplicated in the reporter body** — each verbatim-equivalent in `agents/glass-atrium-intel-reporter.md`, where its canonical lives:
  - the BASELINE requirement list · the d8 validator-safe color rule · the content-driven escalation · the dark-base detail
  - the D8 requirement list · the agent-only record authoring guide · the HTML-primary requirement list · the branching-order MUST
- **Dropped as a stated contradiction**: the unconditional "Summary table REQUIRED" absolute, which the agent-only exemption contradicts.
  - The rule stands once, at `## Report Structure [REPORT]`: the Skim layer carries the summary table, and the section intro exempts agent-only records from every layer and the table.
- **Removed as redundant or unused — do not re-add**:
  - the rationale prose behind the kept canonicals (the rejected-alternative reasoning, the Mermaid rationale trio, the trigger-path steps) — duplicated in the bodies that act on it.
  - the head-of-file pointer to this note — a rule-file citation of a companion, which the companion-citation convention above drops.
  - "There is no document category or prefix" — the `prefix` bullet under `### Emission contract` carries the operative half.
  - the fixed `127.0.0.1:16145` on the POST line — `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → Monitor address carries it, with the non-default resolution a fixed address would contradict.
  - "Stamping without an actual user request is a violation" — it binds the stamping orchestrator, whose canonical (`skills/glass-atrium-ops-orchestrator-role.md` → `## Delegation Criteria`) states it.
  - the "Canonical stamped form" pointer at `skills/glass-atrium-ops-orchestrator-role.md` → `## Delegation Criteria` — the carve-out bullet quotes the full stamp, and that file tells subagents to ignore it; the **`[DOC-ROUTE]` stamp** co-edit entry above holds the linkage.
  - "An omitted `last_status_model` stores a null status actor" — the Done-transition requirement and the Optional-field line state it.
  - the supersede table's "the monitor closes the predecessor" on the `done`-predecessor row, and the open-predecessor sub-bullet — folded into **Every supersede-POST** and the `implementing` · `impl_review` · `impl_done` row.
  - the chain-root "file-count leg is then skipped" clause — the reviewer's half, canonical at `scoped/scope-qa.md` → **Empty named file set → skip the numeric leg, never zero-baseline it**.
  - the Preset step's viewer/export selector line — parity the suite checks (byte contract above), obliging no author.
  - the "Who counts" sentence naming the planner, designer and orchestrator counters — the **Designer Co-Emission Trigger** co-edit entry above holds that roster.
  - the `diagram-types.json` path on the Diagram Standard **Permitted types** bullet — the Type step it points to names the same SoT.
  - the `#### Monitoring-phase notes` pointer on the **Markup exception (narrow)** bullet — it locates the orchestrator's judgment, which the reporter never performs; the **Designer Co-Emission Trigger** co-edit entry above holds the linkage.
