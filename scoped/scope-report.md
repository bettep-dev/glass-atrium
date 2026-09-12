# REPORT Scope Rules

Canonical rule text for the REPORT scope (glass-atrium-intel-reporter). The copy the reporter applies is its own body, `agents/glass-atrium-intel-reporter.md`; the sections below are the maintained source those copies derive from, plus the rules no body carries.

Maintainer material — co-edit rosters, drift reports, the machine-read byte contract, the server-400 gate list and the mirrors this pass removed together with the pointers still naming them — is in `scoped/maintainers/scope-report.md`.

## Absolute Rules [REPORT]

- **Citation format**: cite every external source as `URL + collected_at(YYYY-MM-DD)`; label a date-unknown source `[Date Unknown]` and never treat it as current.
  - Sole copy: `collected_at` appears in no agent body, and Tier-1 `rules/glass-atrium/core-wiki-reference.md` carries the `[Date Unknown]` half for wiki documents only.
- **Summary table** and **monitor-POST save location**: delivered at `agents/glass-atrium-intel-reporter.md` → `## Deliverable Class Detection` and `### Storage is ALWAYS the monitor POST (self-enforcing, delegation-phrasing-proof — MUST)`. Stated there rather than here, because the summary-table rule reads unconditional away from the agent-only exemption that qualifies it.

## Output Format Routing [REPORT]

Format follows two request signals — did the user request a document, and did the user explicitly ask for a shareable HTML artifact. There is no document category or prefix. The wiki store is a permanent exception (`scoped/scope-wiki.md`).

### Three emission modes

Agent-only record (default fallback) · user-requested HTML · user-requested non-HTML. The trigger/format/storage triple, and the branching order that applies the HTML request test before body composition, are delivered at `agents/glass-atrium-intel-reporter.md` → `## Output Format Routing` and `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`.

### HTML request test

HTML primary is produced only on an explicit format request (HTML / web / PDF form) or an explicit share intent; visual richness and an LLM's own "this looks visual" judgment are not triggers, and a bare document request routes to non-HTML md. The signal literals — Korean included, where translating one disables the detector — are delivered at `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test` and `rules/glass-atrium/orchestrator-role.md` → `#### Deliverable exposure and designer composition (Decision phase)`.

### Visual-Maximization Floor

The baseline requirement list, the d8 validator-safe color rule and the content-driven escalation are delivered at `agents/glass-atrium-intel-reporter.md` → `### Visual-Maximization Floor`.

- **Residual anti-slop patterns (a supplement to the SoT, not a mirror of it)**: purple/indigo/lavender AI-brand gradients · gradient text on headings (`background-clip:text`) · equal `grid-cols-3` (prefer asymmetric 1fr/3fr) · `rgba(0,0,0,X)` shadows on dark surfaces · at most 1 gradient per layer, 2 stops max · decoration stacking (one treatment per element).
  - Sole copy: none of these six is carried by an agent body or by the prohibited-pattern SoT at `agents/glass-atrium-design-designer.md` → `## Red Flags` → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)`.
  - Glassmorphism is not on this list: the over-text readability case is a baseline item, and the broader blur+gradient+shadow case is the SoT's **Glassmorphism overuse** entry.

### Dark base default

The dark canvas, light text, the dual-encoded semantic badge palette and the print-branch carve-out are delivered at `agents/glass-atrium-intel-reporter.md` → `### Dark Theme & Typography (MUST)`.

### Threshold SoT

- The D8 numeric thresholds live in `monitor/src/server/clauded-docs/d8-thresholds.json`, which the HTML validator `JSON.parse`-loads at module init.
- Every prose number in the corpus is a mirror of that JSON: editing a prose number without editing the JSON is FORBIDDEN.

### Emission contract

- Every emission mode POSTs to `POST /api/clauded-docs` (`127.0.0.1:16145`). "Agent-only record" names the body FORMAT, never a filesystem target.
- **Required tuple** (route source: `monitor/src/server/routes/clauded-docs.ts`): `title` (non-empty, ≤500) + `author` (non-empty, ≤64) + EXACTLY ONE of `{html_body, md_body, yaml_body, json_body, txt_body}`.
  - There is no `prefix` field: the supplied body field IS the format discriminator.
  - Optional: `audience`, `supersedes_id`, `folder_id`, `doc_status`.
  - Zero body fields or two or more → `400`; a missing or over-length `title`/`author` → `400 invalid_body`; success → `201`.
- An HTML primary is stored as a single file in the monitor-internal root, with no MD companion generated (`md_copy_path` null).
- `memory/` is never a deliverable store — it holds session-internal `progress-*.md` state only, so writing any deliverable there is a hard violation.
- Delegation phrasing does not override this routing.
- **The one sanctioned carve-out is the delegation-side stamp** `log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>')`, attesting that the USER explicitly asked for that local destination. Canonical stamped form: `rules/glass-atrium/orchestrator-role.md` → `## Delegation Criteria`.
  - Stamping without an actual user request is a violation.
  - Absent the stamp, the author bodies' turn-0 refusal of an orchestrator-supplied local target stands unchanged.
- On a user-requested HTML generation failure, halt for scope clarification — an automatic non-HTML fallback is FORBIDDEN.
- **Sensitivity self-check before the POST of an exposed HTML primary** — one triggered by either HTML request test signal, an explicit format request included.
  - Record one line before POSTing: `sensitivity_scan: clear` or `sensitivity_scan: N items (category §locator, …)`.
  - Any finding blocks the POST until the user confirms; zero findings is a silent pass, and a generic "may contain sensitive data" caveat is FORBIDDEN.
  - The report is count + category + locator only — never the flagged text, in the narrative, the `[COMPLETION]`, `concerns` or any log, so the scanner cannot become the leak path.
  - Honor-system semantic judgment: no hook reads it. Delivered at `agents/glass-atrium-intel-reporter.md` → `### Schema Gates (Server-Enforced)`.

### Document Lifecycle — completion + exposure routing

- **Done transition**: the completing agent transitions `doc_status→done` through `PUT /api/clauded-docs/:id`, re-sending the document body plus the optimistic-lock `expected_hash`; a bare `{"doc_status":"done"}` is rejected `400 invalid_body`.
- **Supersede vs new**: same topic as a `done` document → supersede POST carrying `supersedes_id` · unrelated topic → new POST · uncertain relatedness → new POST, never reopening a `done` document.
- **Stage-2 revise cycle (carve-out)**: a plan returned `revise` or `infeasible` persists as a supersede POST even though the predecessor is still `progress`, so the reviewed revision becomes an immutable chain root the revising actor cannot rewrite. An instruction to PUT-edit such a document is refused.
- **Chain-root content**: the first version carries the original user instruction VERBATIM plus the instruction-NAMED file set. An empty named set is the common shape and falls back to the instruction's named SUBJECT set, the file-count leg being skipped rather than measured against a zero baseline.
- **Exposure routing**: viewer-exposed only on an explicit HTML/share signal; everything else is viewer default-hidden, and an ambiguous form defaults to non-HTML md.
- An agent-only record follows the same done-transition and supersede rules — exposure is a routing choice, not a lifecycle exemption.
- Delivered at `agents/glass-atrium-intel-reporter.md` → the bolded lead `**Document lifecycle duties — you are the completing agent and you own these:**`, and at `agents/glass-atrium-intel-planner.md` → `### Document lifecycle duties (delivered copy — the completing agent owns these)`.
- The reviewer-side consumer of the chain root is `scoped/scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]`.

## Diagram Standard [REPORT]

- Every diagram in a user-requested HTML primary is Mermaid, authored as a `<pre class="mermaid">` block; a triple-backtick fence renders only inside an MD agent-only record.
- A block requires the external UMD runtime `<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>`: the monitor sanitizer strips every inline `<script>`, so an inline `mermaid.initialize()` init ships the diagram as raw literal text standalone. No block → no runtime.
- That tag is the only permitted non-Tailwind `<script>` in an exposed HTML primary.
- **FORBIDDEN as the diagram primitive**: ad-hoc graph notation in prose · hand-drawn inline SVG · third-party chart libraries (Chart.js · D3 · Plotly · ECharts) · ASCII art in a `<pre>` block · `<iframe>` embeds.
- **Permitted types** = the adopted set in `monitor/src/server/clauded-docs/diagram-types.json`, enumerated at the Type step below; renderable by Mermaid is not the same as adopted.
- Drawing an excluded type is a doctrine violation, not a server rejection: the validator's diagram scan is report-only and attaches an exclusion notice to a document that still passes.
- **Agent-only branch**: prefer a bullet, table or ASCII tree; a Mermaid block there uses the fence, and a diagram whose purpose is visual fidelity belongs in a requested HTML artifact.

## Pre-drawing Doctrine [REPORT]

<!-- Machine-read section. scripts/test/doctrine-budget-parity.bats parses this section's own cap line, band line and preset class names. Byte contract: scoped/maintainers/scope-report.md -->

Apply the order below to EVERY Mermaid block in a user-requested HTML primary, not only the first; an agent-only record stays on the Diagram Standard agent-only branch. Each step builds on the previous.

1. **Type** — SoT: `monitor/src/server/clauded-docs/diagram-types.json`.
   - Adopted (draw): `flowchart` · `sequenceDiagram` · `stateDiagram-v2` · `erDiagram` · `classDiagram` · `gitGraph` · C4 (`C4Context` / `C4Container` / `C4Component`).
   - Excluded (do not draw — presentation shapes, not development judgment): `quadrantChart` · `radar` · `pie` · `timeline` · `journey` · `mindmap` · `sankey` · `xychart` · `gantt` · `block`; express that content as a table or prose.
2. **Direction** — hold ONE primary flow per diagram; a single held direction is what makes rank alignment readable.
   - `TD` is the default.
   - `LR` only after re-measuring the rendered width against the preset container (Preset step).
   - `RL` / `BT` are forbidden (`diagram-types.json` `flowDirection.forbidden`).
3. **Budget** — SoT: `BUDGET_CAPS.balanced` in `monitor/src/server/architecture/content-budget.ts`; the numbers here are a mirror, never the source.
   - Caps: nodes ≤ 9 · edges ≤ 6 · label chars ≤ 45 · subgraph depth ≤ 1.
   - Band: ≥ 0.9 of a cap warns, > 1.0 fails; depth is an invariant (equal passes, over fails).
   - Census rules an author respects when counting against those caps: every arrow token counts, so a chained `A --> B --> C` line is 2 edges · quoted spans are stripped before arrows are counted · a `name(` / `name[` / `name{` token counts as a node · a `---` line counts as an edge.
   - Over budget: split into one overview diagram plus detail diagram(s), each inside the caps on its own; never raise a cap, never trim a label below its meaning.
4. **Preset** — attach the size preset as a second class on the block: `<pre class="mermaid doc-diagram-body">`.
   - `doc-diagram-body` — default, column width.
   - `doc-diagram-wide` — ranks ≥ 4 along the primary flow OR a label overflows the column width.
   - `doc-diagram-full` — zones (subgraphs) ≥ 3.
   - Those width rules are the same selectors carried by `monitor/public/src/screens/clauded-docs.jsx` (viewer) and `monitor/src/server/clauded-docs/html-export.ts` (export).
5. **Semantic-role `classDef`** — the closed role-class set, nothing outside it: `focal` · `external` · `store` · `optional` · `security`.
   - `focal` is the accent: assigned to ≤ 2 nodes.
   - Values are hex only, derived from the `monitor/public/styles/tokens.css` dark block — a parenthesized value such as `rgb(` matches the node-census opener and inflates the node count.
   - Hex-only is scoped to mermaid `classDef` / `themeVariables` values, which sit in the diagram source outside the d8 `inline-color-literal` scan surface; the d8 no-hex rule keeps governing every CSS surface.
6. **Layout** — ELK is the global layout default from the shared mermaid init; a diagram carries no layout configuration of its own.
   - Never a YAML frontmatter block in a mermaid source: each `---` line is counted as an edge (Budget step).
   - Never encode the engine into the type keyword: the header is `flowchart TD`, never a `flowchart-<engine>` variant.
   - Opt-out is exactly one physical line, the first line, JSON-quoted keys: `%%{init: {"layout":"dagre"}}%%` — a one-line directive contributes 0 nodes and 0 edges to the census.

## Designer Co-Emission Trigger [REPORT]

Gated on "is this a user-requested HTML primary?" — an agent-only record never triggers it. At 2+ co-occurring indicators the deliverable routes to the `{glass-atrium-intel-reporter, glass-atrium-design-designer}` Pre-draft consultation mode; at 1 or fewer, glass-atrium-intel-reporter solo.

| Code | Indicator | Threshold |
|------|-----------|-----------|
| T1 | Mermaid diagrams | ≥ 3 (or ≥ 4 with 2+ mixed types — strict variant) |
| T2 | comparison tables | ≥ 3 instances AND each ≥ 4 rows (or ≥ 20 cells total) |
| T3 | KPI cards / dashboard-class sections | ≥ 5 |
| T4 | non-canonical status badges | palette expansion beyond the canonical 4-badge (✓/⚠/✕/ℹ) needed |
| T5 | user states design quality matters OR declares explicit external-share intent | 1+ |

- **Pre-draft consultation order**: the author self-assesses T1-T5 at the turn-0 outline stage → 1-2 turns of advance consultation from glass-atrium-design-designer → verdict received → author composes the HTML solo → one POST. Full parallel co-emission and a post-draft edit pass are both rejected: the POST contract is atomic (1 doc = 1 emission).
- **Designer contribution scope**: Mermaid type mapping and section composition are primary; non-canonical badge palette expansion (T4) and table-splitting axis selection are conditional; typography levels and the canonical 4-badge palette are mechanical and excluded.
- **glass-atrium-dev-front is never probe-composed**: an exposed HTML primary is self-contained Tailwind CDN, not a design-token-consumption surface.
- **Markup exception (narrow)**: markup genuinely beyond Tailwind-CDN utilities AND beyond the designer's verdict scope routes through the author's `needs_devfront_markup: true` signal and the orchestrator's Monitoring-phase judgment, at `rules/glass-atrium/orchestrator-role.md` → `#### Monitoring-phase notes`.
- The indicators are counted by three actors from their own copies: the author bodies' `## Designer Handoff Contract`, the designer's `## HTML Primary Co-Emission Role`, and the orchestrator's Visual-Weight Probe.

## Report Structure [REPORT]

Every report is navigable in skim-only mode. The layers are format-agnostic — a user-requested HTML primary carries them as `<section>` landmarks, an agent-only record as headings or another author-chosen structure.

- **Skim layer**: summary table + 3-line conclusion, decision-ready without further reading. **Agent-only record exempt** — it keeps only the 1-line Pyramid conclusion.
- **Scan layer**: per-section digest + recommendation list.
- **Read layer**: full analysis + complete source list.
- Burying the conclusion in body paragraphs is FORBIDDEN.

## Self-Evaluation Obligation [REPORT]

- After completing a report, self-assess on the G-Eval-style 4 dimensions — Coverage / Insight / Instruction-following / Clarity, each 1-5. Rubric canonical: `scoped/scope-qa.md` → `## Deliverable Quantitative Evaluation (LLM-as-Judge 4 Dimensions) [QA+REPORT]`.
- Total < 12 → rework before delivery.
- Record the scores at the report bottom — an HTML primary as a `<section id="self-evaluation">`, an agent-only record as a `## Self-Evaluation` section in whatever form parses most cheaply.
