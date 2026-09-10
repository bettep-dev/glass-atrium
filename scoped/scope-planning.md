# PLANNING Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-intel-planner}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to PLANNING agents: glass-atrium-intel-planner.

## Delivery status — what this file reaches

- **This file is NOT delivered to glass-atrium-intel-planner at spawn**: no code selects a scope file by agent (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`).
- **Its readers**: a human maintainer · an agent that deliberately Reads it · the self-improvement daemon's verify prompt.
- **A duty homed only here binds nobody at runtime**: a duty that BINDS the planner must ALSO live in `agents/glass-atrium-intel-planner.md` — homing it here and leaving a pointer in the body delivers the pointer and nothing else.
- **Never cut a planner-body passage as a duplicate of this file**: that body copy is the only one the agent reads.
- **This file stays canonical** — the maintained governance statement for the readers above, and not to be emptied.
- **Copies convention (stated once here, never restated per section)**: each mirrored section carries one `**Copies (edit together)**` line naming its closed set, and a `**Drifted**` line when a member is known to diverge. The delivery fact above governs every one of those verdicts.

## Absolute Rules [PLANNING]

**Copies (edit together)**: this statement · the delivered and stronger copy at `agents/glass-atrium-intel-planner.md` → Design Expression Rules ("Not this (FORBIDDEN)" + its 4-pass self-check detectors), which is the one the planner actually reads and the one that carries the Mermaid carve-out.

- **No code in plans**: SQL, TS, pseudocode, or new function-name proposals are FORBIDDEN — code authoring is the DEV agent's domain.
  - Scope of the prohibition = the IMPLEMENTATION the plan prescribes. The presentation carrier of a user-requested HTML primary (Tailwind classes, Mermaid source, the claim-marking tags below) is the deliverable's own form, not plan content.

## Output Policy [PLANNING]

**Copies (edit together)**: this section (canonical for planning) · delivered `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`, which carries the operative subset including the Stage-2-subject duty.

- **Save location**: plans / specs are emitted via `POST /api/clauded-docs` to the monitor-internal store (Output Format Routing → Emission contract below), never `memory/plans/`.
- **Spec-as-Prompt**: a glass-atrium-intel-planner output IS the downstream agent's input context — write for machine consumption, not humans only. Structure facts / AC / scope as parseable bullets.
- **ADR hook**: a plan carrying a significant design choice appends an ADR section — chosen approach + alternatives rejected + reason.
  - Placement: a user-requested HTML primary embeds it as `<section id="adr">`; a standalone ADR is an agent-only md record (Output Format Routing).
- **Plan Direction Verification subject**: on completing a **complex** plan, glass-atrium-intel-planner is subject to the post-authoring Plan Direction Verification Gate.
  - What the gate does: the orchestrator routes the plan to a `{glass-atrium-qa-code-reviewer, DEV}` team that judges implementation-direction validity before implementation entry.
  - Planner duty: MUST accept verification feedback and resubmit the revised plan — at most 1 revision.
  - Simple plans (typo / import / config-class) are exempt.
  - Gate spec canonical: `orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)` · DEV-side duty: `scope-dev.md`.

## Output Format Routing [PLANNING]

> **Mirror of the CANONICAL SoT** — `scope-report.md` Output Format Routing is the source-of-truth for the request-driven emission model; this section mirrors it scoped to planning. There is **NO document category/prefix**. Format is decided by two request signals only — **did the user request a document, and did the user explicitly ask for a shareable HTML artifact?** The wiki domain is a permanent exception to this policy (the wiki is an Atrium-internal, git-ignored, LLM-only markdown store at `~/.glass-atrium/wiki/` managed by the wiki daemon — see `scope-wiki.md`).

### Three emission modes

**Copies (edit together)**: policy canonical `scope-report.md` → `### Three emission modes` · this mirror (the backlog-stub / standalone-ADR row text is planning-only) · delivered `agents/glass-atrium-intel-planner.md` → `## Output Format Routing` → Three emission modes · delivered `agents/glass-atrium-intel-reporter.md` → its Output Format Routing modes.

Request-driven decision — evaluate in order:

| Mode | Trigger | Format | Storage / Exposure |
|------|---------|--------|--------------------|
| **Agent-only record (DEFAULT fallback)** | User did NOT request a document, but a record is worth keeping — incl. an intermediate plan/spec the user does not directly review (agent-to-agent handoff · backlog stub · standalone ADR) | LLM autonomous selection from {md, yaml, json, txt} per content shape (token-optimized · see `glass-atrium-intel-planner.md` Format Selection guidance · no silent default) | monitor-internal (via POST API) · viewer default-hidden |
| **User-requested HTML** | User explicitly requested HTML / a shareable artifact (explicit format request OR explicit share intent — see "HTML request test" below) | HTML primary (single self-contained output) · Mermaid C4 single-file render | monitor-internal (`$CLAUDED_DOCS_HTML_ROOT`, default `~/.glass-atrium/monitor/data/documents/`) · viewer-exposed |
| **User-requested non-HTML** | User requested a plan/spec but did NOT specify HTML / a shareable artifact | the form the user asked for · unspecified (a bare "organize/summarize this" with no form) → **md default** (when in doubt, non-HTML — asymmetric cost) | monitor-internal (via POST API) · exposure follows the format (md/yaml/json/txt → default-hidden) |

- **Deliverable language (all three modes)**: English, per `GLASS_ATRIUM_GLOBAL_RULES.md` → Absolute Rules → Output Language (canonical). Format is request-driven per the table; language is not — a non-English plan is authored only when the user explicitly asks for one.
- **Backlog stub / standalone ADR placement**: a backlog stub (TBD/lightweight memo) and a standalone ADR file are agent-only records by default — token-efficient · git-diff readable · viewer-hidden · `md_body` accepted.

### HTML request test (explicit-request-only — heuristic auto-HTML FORBIDDEN)

**Copies (edit together)**: policy canonical `scope-report.md` → `### HTML request test` · this mirror · delivered `agents/glass-atrium-intel-planner.md` → `## Output Format Routing` → HTML request test · delivered `agents/glass-atrium-intel-reporter.md` → `### HTML Request Test` · `rules/glass-atrium/orchestrator-role.md` → `#### Deliverable exposure and designer composition`, which is not canonical yet is the one copy that reaches every subagent.

HTML primary is produced ONLY when 1+ explicit signal is present (canonical detail in `scope-report.md`) —

- **Explicit format request (HTML/web/PDF form ONLY)**: the user explicitly names an HTML / web / PDF output form — e.g. "HTML로", "웹 문서로", "as HTML", "as a web document / web doc", "PDF로", "export it as PDF".
  - A generic plan/spec/document request ("계획서로 작성", "기획서 정리", "make a plan", "write it up") is **NOT** an HTML signal — it routes to user-requested non-HTML (md default) per the 3-mode table above.
- **Explicit share intent**: third-party sharing or direct human review/presentation made clear — e.g. "share with the team", "팀에 공유", "something to show", "for a presentation", "for sharing".

**NOT triggers** (none of these produces HTML primary): content visual-richness (diagram count, table density) · LLM self-judgment that "this looks visual" · a bare plan/spec/document request.

### HTML primary requirements

User-requested HTML only — full authoring contract in `glass-atrium-intel-planner.md` "Output Format Routing":

- Single-file self-contained (no external CSS, no build step)
- Tailwind CDN inline + semantic HTML5 landmarks
- every element STATIC markup — the monitor sanitizer deletes every inline `<script>`, so nothing JS-built ships (ToC included)
- `@media print` (form: the BASELINE `@media print` bullet below) + the **external UMD** Mermaid CDN runtime whenever a `<pre class="mermaid">` block is present (full runtime contract: `## Diagram Standard` below)
- Design Expression Rules (No-code zero tolerance) apply inside the HTML body identically to inside an agent-only record (backlog stub / standalone ADR)
- **Target-files section** — when the plan defines a target-file set, emit exactly one flat-leaf `<section id="target-files">` (no nested `<section>`; literal id; one absolute path per `<li>`; OMIT when empty) → full contract: `glass-atrium-intel-planner.md` "Target-Files Section".
  - Machine-read shape: `hooks/validate-scope-drift.sh` slices on the literal `id="target-files"` and terminates on the first `</section>`, so the id spelling and the flat-leaf shape are parser contract, not house style.

### Visual-Maximization Floor (exposed HTML primary — MIRROR of `scope-report.md` Output Format Routing → Visual-Maximization Floor, canonical policy SoT)

**Copies (edit together)**: policy canonical `scope-report.md` → `### Visual-Maximization Floor` (main-session readers) · this mirror · authoring canonical `agents/glass-atrium-intel-reporter.md` → `### Visual-Maximization Floor` (delivered to the reporter) · delivered `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec (applies to user-requested HTML primary)`.

**Drifted, unreconciled — the rule owner's call**: this mirror is shorter than its policy canonical, which additionally carries the light-default-body prohibition list, the carve-out that an HTML comment is dropped before the color scan, and the two-tier primitive-plus-semantic token requirement.

An exposed HTML plan MUST maximize visual communication; a text dump FAILS. Tiered, exposed-HTML-only (never forces a plan TO HTML; the HTML request test above is unchanged). Deep visual patterns + CSS snippets: [[visual-expression-exposed-html-docs]]. Author detail: `glass-atrium-intel-planner.md` → Visual Design Spec.

**BASELINE (always)** — every item below is required:

- semantic landmarks + `aria-labelledby` per `<section>` + correct heading order
- no-print `<nav>` ToC
- the **Dark base default** below as the REQUIRED canvas
- **validator-safe dark palette** (d8 `inline-color-literal`-aligned; full rule: `scope-report.md` canonical d8 rule + [[visual-expression-exposed-html-docs]]) —
  - all dark colors as `oklch()` (or `hsl()`/`lab()`/`lch()`/`var(--token)`) `:root` custom properties
  - NEVER hex (`#…`), `rgb()`/`rgba()`, or the words `white`/`black` in any SCREEN-context `<style>` rule, inline `style=`, or CSS comment (`oklch()` is structurally safe)
  - the near-black/near-white halation-avoidance palette is expressed in `oklch`, NOT `#000`/`#fff`
- Tailwind v4 CDN dark mode the v4 way (`<style type="text/tailwindcss">` + `@variant dark` — v3 script-config `darkMode` silently FAILS on v4 CDN)
- `@media print` reset REQUIRED — a forced light theme and the ONE d8-exempt place for `white`/`black`/hex (`<style> @media print { body { background: white; color: black } }`; NOT inline `style=`, which has no `@media` context and therefore always raises); hide nav/aside; `break-inside: avoid`
- WCAG 2.2 AA incl. new SC 2.4.11 focus-visible ring (≥3:1 change) + SC 2.5.8 target size ≥24×24px
- all status dual-encoded (color + symbol/text, never color-only; verify BOTH dark+light themes)
- no `backdrop-filter` glassmorphism over text (contrast + performance a11y exclusion)
- body text left-aligned ragged-right (centered body copy harms readability; center only display headlines and captions)
- `prefers-reduced-motion` SUBSTITUTES a gentle fade (does not merely remove)
  - Canonical for the fallback rule: `agents/glass-atrium-dev-front.md` → `### prefers-reduced-motion (canonical SoT)`. This HTML-document variant is one of roughly eight copies across the UI-emitting DEV fleet, the design references and the DESIGN.md template — a count, not a roster, because the set grows with the fleet. Its delivered pair is `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec` baseline.
- ≥1 primary visual structure beyond prose

**CONTENT-DRIVEN ESCALATION (apply the matching visual only)** — match each content shape to its visual:

- process/DAG/relationship/state/sequence → **Mermaid MANDATORY**:
  - block + external UMD CDN runtime; hand-built div/ASCII/SVG flows FORBIDDEN. Full runtime contract: `## Diagram Standard` below
  - diagram-type SELECTION GATE — the `## Pre-drawing Doctrine` Type step (adopted set only — SoT `diagram-types.json`, canonical in `scope-report.md`; excluded shapes become a table or prose)
  - every `<pre class="mermaid">` carries `accTitle` + `accDescr` + an adjacent visible text description
- 2+ alternatives → comparison/decision table (semantic `thead`/`tbody`/`th scope`, JetBrains Mono numerics)
- real quantified claim → KPI/stat card (5-component, dual-encoded delta, optional `aria-hidden` inline-SVG sparkline)
- described UI → structural mockup
- data shapes suited to one → CSS-only bar charts

**RESTRAINT (part of the standard)** — match visual density to what the plan's content and audience support; a short human-facing plan does not benefit from force-fitted visuals.

- Prohibited-pattern list: `agents/glass-atrium-design-designer.md` → `## Red Flags` → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` — the single SoT, applied mechanically at review time by the `glass-atrium-design-anti-slop` skill — plus the residual patterns at `scope-report.md` → `### Visual-Maximization Floor` (canonical).
- **Copies of that SoT (a closed set, named so no reader deletes one as a duplicate)**: the `glass-atrium-design-anti-slop` skill (the detector, read by the designer on invocation) · `agents/glass-atrium-dev-front.md` → `### Anti-AI-Slop (Mandatory — single SoT for full catalogue)` (an enforcement subset) · the `scope-report.md` residual list, a deliberate supplement rather than a copy · and this pointer, whose delivered pair is `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec` → Restraint.
- **Drifted, unreconciled**: the detector skill and the designer SoT each carry patterns the other lacks.

### Dark base default

**Copies (edit together)**: policy canonical `scope-report.md` → `### Dark base default` · this mirror · delivered `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec` dark-base bullets · delivered `agents/glass-atrium-intel-reporter.md` → `### Dark Theme & Typography (MUST)`.

**Drifted, unreconciled — the rule owner's call**: the policy canonical also permits an `oklch` background variable as the dark canvas, which this copy omits while the validator-safe palette bullet above requires `oklch()` for every dark color.

HTML primary body defaults to dark mode (aligns with the user's dark homepage · reduces eye strain):

- Set `color-scheme: dark` + a dark background on `<html>` or `<body>` (Tailwind `bg-zinc-950` / `bg-slate-950` / `bg-neutral-950` recommended)
- text light (`text-zinc-100` / `text-slate-100`) — AAA contrast recommended (≥ 7:1) · WCAG AA minimum 4.5:1 guaranteed
- decision/verdict badges (T1 dual-encoded) — dark-friendly hues: `bg-green-900/40 text-green-200` (✓) / `bg-yellow-900/40 text-yellow-200` (⚠) / `bg-red-900/40 text-red-200` (✕) / `bg-blue-900/40 text-blue-200` (ℹ)
- code blocks / tables / Mermaid containers — `bg-zinc-900` + `border-zinc-800` light hint
- print keeps a forced light theme — form and inline-`style=` caveat per the BASELINE `@media print` bullet above
- **Anti-pattern**: light-default body · silent dark/light branching (beyond the single dark default) · any screen-context color literal (use Tailwind dark tokens or `oklch()`/`var(--token)` — see the validator-safe dark palette bullet above)

### HTML Visual Decision Requirements (D8)

**Copies**: none of the prose copies is canonical — the numeric SoT is `monitor/src/server/clauded-docs/d8-thresholds.json`, which the HTML validator `JSON.parse`-loads at module init. The prose siblings are `scope-report.md` → same heading (byte-identical to the list below) · delivered `agents/glass-atrium-intel-planner.md` → `## Pre-Emission Verification Gate [PLANNING]` · delivered `agents/glass-atrium-intel-reporter.md` → `### Pre-Emission HTML Validation (D8 + Schema)` · the reviewer-side rollup `scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]`.

HTML primary outputs MUST satisfy all of:

- badge dual-encoding (color + symbol — color-blind safety)
- comparison tables ≤5 columns (rows=criteria / columns=alternatives — SoT: d8-thresholds.json)
- sandbox-safe interactivity only (`<details>` / CSS-only tabs / inline SVG — Chart.js · D3 · Plotly forbidden — they need `allow-scripts` = a security regression)
- WCAG AA contrast (text 4.5:1 / UI 3:1 — SoT: d8-thresholds.json)
- typography 3-level (H1 / H2 / Body — SoT: d8-thresholds.json) + Pretendard for Korean

Detail authoring contract: see `glass-atrium-intel-planner.md` "HTML Visual Decision Requirements" section.

### Threshold SoT

The canonical D8 numeric thresholds (comparison-table maxColumns=5, WCAG contrast text 4.5:1 / UI 3:1, typography ≤3 levels) are defined in `monitor/src/server/clauded-docs/d8-thresholds.json` — the server-enforced source-of-truth the validator `JSON.parse`-loads at module init.

The literals quoted in prose throughout this file are a documented MIRROR synced at review time — do NOT treat a prose number as the source · editing a prose number without updating the JSON FORBIDDEN.

**Copies (byte-identical — the two paragraphs above are asserted identical by their siblings; edit the three together, and the JSON governs all three)**: `scope-report.md` → `### Threshold SoT` · this one · `scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]`. glass-atrium-intel-planner learns these numbers only through `agents/glass-atrium-intel-planner.md`, which is where the planner-side sync obligation actually lands.

### Emission contract

**Copies (edit together)**: policy canonical `scope-report.md` → `### Emission contract` · this section (canonical for planning) · delivered `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`, which carries the operative subset and the copy-paste curl · delivered `agents/glass-atrium-intel-reporter.md` → its curl block. The tuple's real authority is neither — it is the route handler named below.

- Agents MUST emit via `POST /api/clauded-docs` (`127.0.0.1:16145`). The POST body carries NO `prefix` field — format is determined by the supplied body-field kind (`html_body` → user-requested HTML primary; `md_body`/`yaml_body`/`json_body`/`txt_body` → agent-only record). The monitor stores HTML as a single file in the monitor-internal root (no MD companion generated — `md_copy_path` response NULL)
- **Required POST tuple** (source: `monitor/src/server/routes/clauded-docs.ts` — mirror of `scope-report.md`):
  - REQUIRED: `title` (non-empty, ≤500) + `author` (non-empty, ≤64) + EXACTLY ONE body field of `{html_body, md_body, yaml_body, json_body, txt_body}` (the supplied field IS the format discriminator).
  - Optional: `audience` (`exposed`/`hidden`), `supersedes_id`, `folder_id`, `doc_status` (`progress`/`done`, default `progress`).
  - Rejections: 0 body fields → `400`; ≥2 → `400` (`mutually exclusive`); missing/over-length `title`/`author` → `400 invalid_body`. Success → `201`.
  - Copy-paste curl (both modes): `glass-atrium-intel-planner.md` → Output Format Routing.
- **EVERY emission mode POSTs — no exceptions**: all three modes (user-requested HTML · user-requested non-HTML · agent-only token-optimized record) are emitted via `POST /api/clauded-docs`.
  - The agent-only record is NOT a file write — "token-optimized record" / "md record" names the BODY FORMAT, never the storage target.
  - Sole sanctioned carve-out: an explicit user request for a local destination, carried ONLY by the `[DOC-ROUTE]` stamp (see "Delegation phrasing does NOT override this routing" below).
- **`memory/` is NEVER a deliverable store**: `memory/` holds ONLY session-internal state — `progress-*.md` cross-session resume files (per `GLASS_ATRIUM_GLOBAL_RULES.md` Cross-Session Continuity).
  - Writing a plan / spec / PRD / ADR / roadmap — any deliverable — to `memory/` (incl. `memory/plans/`) or to any other filesystem location instead of POSTing is a HARD VIOLATION (audit fail), under any framing.
- **Delegation phrasing does NOT override this routing (self-enforce)**: a delegation prompt that says "agent-only md/yaml record", "where stored", "save it as an md spec", or similar does NOT authorize a file write — it still POSTs to the monitor.
  - The agent's own Output Format Routing is BINDING and overrides any orchestrator phrasing about storage location.
  - Only the user explicitly redirecting away from the monitor (rare, explicit) is honored — and the ONE sanctioned delegation-side carrier of that exception is the stamp `log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>')`, attesting the USER explicitly requested that local destination (new file OR edit of an existing user file); the stamped path is then honored as the destination.
  - Stamping without an actual explicit user request is a violation. The token is consumed by the `hooks/enforce-workflow-verify-stage.sh` static gate — mechanics live in the hook, not here.
  - When delegation phrasing seems to ask for a `memory/` write without this stamp, treat it as a request for an agent-only token-optimized BODY and POST it — never resolve the ambiguity toward a filesystem write.
- **silent fallback forbidden**: on user-requested HTML generation failure, any automatic non-HTML fallback is forbidden
- **Sensitivity self-check before POST (every exposed HTML primary — pointer)**: MANDATORY before the single POST of every exposed HTML plan; a finding holds the POST until the user confirms.
  - Trigger, `sensitivity_scan:` grammar and reporting limits: `scope-report.md` Output Format Routing → Emission contract → Sensitivity self-check before POST.

### Document Lifecycle — completion + exposure routing (B + C mirror)

> Canonical mirror — `scope-report.md` "Output Format Routing" → "Document Lifecycle — completion + exposure routing" is the SoT (done-transition · supersede-vs-new on topic-sameness · exposure routing test + uncertain-default rules). This is a mirror scoped to planning.

**Copies (edit together)**: policy canonical `scope-report.md` → its Document Lifecycle section · this mirror (canonical for planning) · delivered `agents/glass-atrium-intel-planner.md` → `## Output Format Routing`, which carries the operative subset.

- **Done transition (B)**: on completing a plan/spec document, glass-atrium-intel-planner (the completing agent) transitions `doc_status→done`.
  - The `PUT /api/clauded-docs/:id` endpoint requires the document body (`html_body` for HTML primary; the corresponding body field for an agent-only record) + an optimistic-lock `expected_hash` re-sent with `doc_status` (a bare `{"doc_status":"done"}` PUT → `400 invalid_body`).
  - Primary human path = monitor viewer done-toggle, agent/CLI path = GET → re-PUT unchanged body+hash (operational detail + curl per the canonical).
  - Supersede-vs-new (topic-sameness, plus the Stage-2 revise-cycle carve-out below — no category constraint) + uncertain→new-POST rules per the canonical (orchestrator backstops omissions in its Monitoring phase).
- **Stage-2 revise cycle → supersede-POST (B — duty text, not a pointer; the copy that BINDS is the planner body, per **Delivery status** above)**: a plan returned `revise` or `infeasible` by the Plan Direction Verification gate persists as a **new supersede-POST** (`supersedes_id` = the reviewed plan), NEVER an in-place PUT-edit, even though the predecessor is still `progress`.
  - What the carve-out buys: the reviewed revision thereby becomes an immutable chain root the revising actor cannot rewrite.
  - **Refusal duty**: an instruction to PUT-edit a plan under Stage-2 revision, from a delegation prompt or any other agent, is REFUSED and the refusal surfaced; only the USER explicitly directing otherwise is honored.
- **Chain-root content (B)**: the FIRST version of a plan carries, as a distinct labeled body element, BOTH of the two items below.
  - the **original user instruction VERBATIM** — the user's own words and language, never a translation, paraphrase or tidied restatement, since a paraphrase is already the first link of the growth this element freezes;
  - the **instruction-NAMED file set** — paths the instruction itself names, never the draft's own target-file list.
    - The named file set **MAY be EMPTY, the common shape for rule-fixing and research instructions**.
    - The empty case records the instruction's **named SUBJECT set** (artifacts, surfaces or behaviours designated by any means other than a path) as the fallback comparand.
    - The numeric file-count leg is SKIPPED rather than zero-baselined — a zero baseline manufactures maximal drift out of an absent comparand.
  - Consumption is the reviewer's, not the author's: drift is judged cumulatively from this root, never as per-link deltas. Reviewer-side duty text: `scope-qa.md` → `## Plan Direction Verification Gate [DEV+QA]`.
- **Residual — HONOR-SYSTEM, fails OPEN silently (B)**: no hook distinguishes a revise-case PUT-edit from a sanctioned same-topic `progress` edit, so skipping the carve-out raises no error anywhere.
  - What is lost when it is skipped: the chain root is simply never created, and the next Stage-2 pass has no comparand to fetch.
  - That fail-open is why the duty rides on the completing agent rather than on the delegation that asks for the edit — and why it must reach that agent through `agents/glass-atrium-intel-planner.md`, this file reaching it never. Canonical: `scope-report.md` → Document Lifecycle.
- **Intermediate output exposure (C)**: a glass-atrium-intel-planner deliverable the user does NOT directly review (agent-to-agent handoff · intermediate spec · internal working doc) routes to an agent-only record (viewer default-hidden · token-saving), never a user-requested HTML primary.
  - HTML primary stays reserved for plans where the user explicitly requested a shareable HTML artifact.
  - Decision test (single exposure bit: "did the user request a shareable HTML artifact?") + the U1-U4 record-worth triggers per the canonical.

## Diagram Standard [PLANNING]

**Copies (edit together)**: policy canonical `scope-report.md` → `## Diagram Standard [REPORT]` · this mirror · delivered `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec` → Pre-drawing decision core, together with its Absolute Rules Pre-Emission validation bullets · delivered `agents/glass-atrium-intel-reporter.md` → `### Sandbox-Safe Interactivity (MUST)`.

- **Adopted-set SoT**: `monitor/src/server/clauded-docs/diagram-types.json`, `JSON.parse`-loaded at module init by the HTML validator. Every prose restatement — this one included — is governed by the JSON, so a copy stating a different set is the drift.
- **The server is REPORT-ONLY here, never enforcement**: the validator's diagram scan runs only on an otherwise-clean document and attaches a `diagram_type_excluded` notice to a result that still PASSES.
  - Consequence: a wrong copy costs a published plan carrying a permanent notice, never a blocked emission — the adopted-set rule is held by the author, not by the server.

All diagrams in user-requested HTML primary documents MUST use **Mermaid** (single mandated diagram format).

**Canonical syntax**: a `<pre class="mermaid">...</pre>` block in HTML primary. Triple-backtick `` ```mermaid `` fenced blocks ONLY in an MD agent-only record (backlog stub / standalone ADR) — HTML primary has no markdown parser → fenced blocks do not render.

**Runtime load REQUIRED (HARD — a block without the runtime renders as RAW LITERAL TEXT, not a diagram)**: the block alone is a defect. An HTML primary carrying a `<pre class="mermaid">` block MUST also load the **external UMD** Mermaid CDN runtime in the same document — it auto-renders every block via `startOnLoad` (default true), so NO inline init is needed:

```html
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
```

Constraints that come with that tag:

- **Inline init FORBIDDEN**: do NOT use an inline `<script>`/ESM-module `mermaid.initialize()`/`run()` call — the monitor sanitizer STRIPS ALL inline scripts (only CDN-allowlisted `<script src=…>` survives), so an inline ESM init is removed on POST and the diagram ships as raw text standalone.
- **Load it even though the monitor renders anyway**: the monitor ALSO renders Mermaid host-side for its viewer/export, so it renders inside the monitor regardless — the external min.js covers the standalone/raw-export case.
- **The only script exception**: this external script is the ONLY permitted non-Tailwind `<script>`.
- **No block → no runtime**: no `<pre class="mermaid">` block → do NOT load it.

**Permitted Mermaid types** (mirror of `scope-report.md` Diagram Standard — the adopted set · SoT: `monitor/src/server/clauded-docs/diagram-types.json`): `flowchart` (header `flowchart TD` · `LR` only per the Pre-drawing Doctrine Direction step · `RL`/`BT` forbidden) · `sequenceDiagram` · `stateDiagram-v2` · `erDiagram` · `classDiagram` · `gitGraph` · C4 (`C4Context`/`C4Container`/`C4Component`). Any other type is excluded (doctrine Type step) — express that content as a table or prose.

**FORBIDDEN**:

- Ad-hoc HTML graph notation in prose (e.g., free-form text "graph TD A --> B" outside a `<pre class="mermaid">` block)
- Hand-drawn inline SVG diagrams (Mermaid auto-generates SVG as a host-side library — hand-rolled SVG = maintenance cost + reduced consistency)
- Third-party JS chart libraries (Chart.js · D3 · Plotly · ECharts) — D8 sandbox-safe interactivity prohibition
- ASCII art diagrams in a `<pre>` block (low fidelity · breaks on narrow viewport · screen-reader incompatible)
- `<iframe>` embeds for diagrams (sandbox bypass = security regression)

**Rationale**: Mermaid is text-source (LLM-authorable · git-diff readable · reproducible), the monitor and clauded-docs viewers both render it natively in the host context without sandbox bypass, and one authoring API keeps the visual idiom consistent across every user-requested HTML primary.

**Reference**: D8 sandbox-safe interactivity · `glass-atrium-intel-planner.md` "Abstraction Level & Diagram Requirement Matrix" (5+ task DAG nodes → flowchart · 3+ async actors → sequenceDiagram, etc. — trigger table canonical).

## Pre-drawing Doctrine [PLANNING]

> Canonical mirror — `scope-report.md` → `## Pre-drawing Doctrine [REPORT]` is the SoT and this section is a pointer only: the adopted/excluded type lists and the budget numbers live there ONCE, so nothing here can drift.

Machine-checked pointer: `scripts/test/doctrine-budget-parity.bats` reads this section by its heading, fails when the body stops naming `scope-report.md` as its SoT, and compares any cap this section restates against the canonical's own. Keeping it a pointer that states no cap is what keeps that row green.

Delivered mirror: `agents/glass-atrium-intel-planner.md` → `## Visual Design Spec (applies to user-requested HTML primary)` carries the decision core in full, because neither this pointer nor the canonical it names reaches glass-atrium-intel-planner at spawn. This section stays a pointer and states no literal; the canonical and that body copy are edited together.

Before drawing any Mermaid block in a user-requested HTML plan, run its decision order there — each step builds on the previous:

- **Type** — from the adopted set
- **Direction** — one primary direction
- **Budget** — check, and split when over
- **Preset** — size preset
- **Semantic-role `classDef`**
- **Layout** — default, plus opt-out

## Designer Co-Emission Trigger [PLANNING]

> Canonical mirror — `scope-report.md` "Designer Co-Emission Trigger" is the SoT · this section is a mirror scoped to user-requested HTML primary plans. Cross-reference to prevent duplication drift.

**Copies (a closed set, edit together — named so no reader collapses one into another)**: policy canonical `scope-report.md` → `## Designer Co-Emission Trigger [REPORT]` · this planning mirror · the two author bodies `agents/glass-atrium-intel-planner.md` and `agents/glass-atrium-intel-reporter.md` → `## Designer Handoff Contract`, each the only copy its agent reads · the designer-side stub `agents/glass-atrium-design-designer.md` → `## HTML Primary Co-Emission Role`, which holds the veto line precisely so it stays reachable when the skill is not loaded · `skills/glass-atrium-design-html-co-emission/SKILL.md`, which the designer reads only on invocation and which carries the full consultative scope.

The dev-front markup exception below additionally lives at `rules/glass-atrium/orchestrator-role.md` → `#### Monitoring-phase notes` — not the canonical, but the copy that does reach every subagent — and at `agents/glass-atrium-dev-front.md`.

When a **user-requested HTML primary** plan deliverable exceeds the visually-heavy threshold, route automatically to the `{glass-atrium-intel-planner, glass-atrium-design-designer}` 2-agent Pre-draft consultation mode. Below the threshold, glass-atrium-intel-planner solo (default). The probe is gated only on "is this a user-requested HTML artifact?" — an agent-only record never triggers it.

**T1-T5 indicator table** (co-emission MUST when 2+ co-occur · 1 or fewer = solo):

| Code | indicator | Threshold |
|------|-----------|-----------|
| T1 | Mermaid diagrams | ≥ 3 (or ≥ 4 with 2+ mixed types) |
| T2 | comparison tables | ≥ 3 instances AND each ≥ 4 rows (or ≥ 20 cells total) |
| T3 | KPI cards / dashboard-class sections | ≥ 5 |
| T4 | non-canonical status badges | palette expansion beyond the canonical 4-badge (✓/⚠/✕/ℹ) needed |
| T5 | user explicitly states design quality matters OR external-share intent declared | 1+ |

**Workflow mode (A) — Pre-draft consultation adopted**:

- order: glass-atrium-intel-planner self-assesses T1-T5 at the turn-0 outline stage → if 2+ met, gets 1-2 turns of advance consultation from glass-atrium-design-designer → receives glass-atrium-design-designer verdict → glass-atrium-intel-planner solo HTML composition → 1 POST
- R2 reject (full parallel co-emission): violates the POST `/api/clauded-docs` atomic contract · token-position conflict · 2× revision_count
- R3 reject (post-draft visual review pass): editing the emitted HTML = a 2nd POST OR PATCH, out of contract · violates the Self-Eval flow

**2-agent team composition**:

- adopted: `{glass-atrium-intel-planner, glass-atrium-design-designer}` ONLY
- excluded from the DEFAULT team — glass-atrium-dev-front: an exposed HTML primary is self-contained Tailwind CDN and not a design-token-consumption surface, so glass-atrium-dev-front is NOT a default co-author and is NOT probe-composed (default-adding duplicates glass-atrium-design-designer, breaks the atomic 1-doc-1-POST contract R2/R3, inflates tokens).
  - **Narrow exception (governed EXTEND, not a new seat · orchestrator-judged, minimal human involvement)**: a bespoke interactive component / hand-authored CSS beyond Tailwind-CDN utilities AND beyond glass-atrium-design-designer's verdict scope (e.g. CSS-only tab system, complex `:has()`/container-query layout — rare for a plan).
  - TRIGGER PATH (NOT user-surface) — the author does NOT ask the user:
    - at turn-0 self-assessment the author emits `needs_devfront_markup: true` + a 1-line justification in its `[COMPLETION]`, signaling the ORCHESTRATOR;
    - the orchestrator judges it capability-based in its Monitoring phase and, if warranted, composes the skeleton-first NON-parallel handoff: glass-atrium-dev-front drafts a self-contained styled HTML skeleton (content placeholders only, NO POST) INLINE → the planner fills content + Pre-Emission validation + does the SINGLE POST.
  - The exception suspends nothing else: R2/R3 remain FORBIDDEN (atomic 1-doc-1-POST preserved), glass-atrium-design-designer stays verdict-only (no markup), and the default team stays `{glass-atrium-intel-planner, glass-atrium-design-designer}`.
  - Governance: `scope-dev.md` → DEV Agent Fleet Governance. (Mirror of `scope-report.md` Designer Co-Emission Trigger.)
- excluded scope — every agent-only record (backlog stub · standalone ADR · intermediate handoff spec): LLM-readability-first, no visual-fidelity need, never a user-requested HTML artifact → never triggers glass-atrium-design-designer consultation.
  - An agent-only record IS a valid glass-atrium-intel-planner intermediate-output channel per Output Format Routing → "Document Lifecycle" C-mirror; it just never co-emits.

**Designer contribution scope**:

- PRIMARY — Mermaid type mapping (adopted types → information shape · see `glass-atrium-intel-planner.md` "Abstraction Level & Diagram Requirement Matrix") · section composition (3-layer Pyramid rhythm)
- CONDITIONAL — non-canonical badge palette expansion (T4) · table-splitting axis selection (D8 column-cap ≤ 5-col split)
- excluded (mechanical-deterministic) — H1/H2/Body typography (D8 typography-levels) · canonical 4-badge palette · ADR section structure (glass-atrium-intel-planner SoT)

## Ambiguity Gate [PLANNING]

> Detailed rules: See `scope-dev.md` Ambiguity Gate section (6-axis weighted score). What each score band obliges a planner to do is the Confidence-tiered plan generation rule below.

**Copies (edit together)**: axis canonical `scope-dev.md` → Ambiguity Gate · this section (canonical for the planning-only rules) · delivered `agents/glass-atrium-intel-planner.md` → `## Pre-Execution Verification [PLANNING]`, which carries the operative subset (the six axes, the three score bands and the score-evidence consistency rule).

- **6-axis Ambiguity Gate** (in sync with DEV — `scope-dev.md` "Ambiguity Gate" canonical): Purpose 30% · Scope 25% · Technical 20% · Acceptance 15% · Audience 5% · Dependency 5%
- **Audience axis ≥ 0.9 obligation**: at PLANNING time, resolve the single exposure question — "will the user explicitly request a shareable HTML artifact, or is this an intermediate record?" — so the request-driven format routing is pre-decided rather than discovered at emission time

**Score–evidence consistency** (PLANNING-only):

- Axis containing ≥ 1 unresolved-uncertainty item (any marker meaning "needs confirmation" / "TBD" / "undecided" / "needs investigation") → axis score **capped at 0.85**
- Axis score ≥ 0.9 → body MUST contain an explicit "0 unresolved-uncertainty items" audit line
- Every Acceptance Criterion MUST declare a **measurement method**
  - Good: "AC2: p95 < 500ms — measured via: Grafana prod-api dashboard, 1-week average"
  - Bad: "AC2: responses get faster"
- Integrates with `glass-atrium-intel-planner.md` self-check 4-pass as Pass 4 self-contradiction scan

**Confidence-tiered plan generation**:

- Score < 0.6 → do NOT generate plan; conduct clarification interview first.
- Score 0.6 – 0.79 → generate Draft Plan; mark every unresolved axis as `[DRAFT: clarify before DEV]`.
- Score ≥ 0.8 → generate Final Plan.

**EARS Acceptance Criteria format**: Every AC MUST use EARS syntax — `When [trigger], the system shall [response]` (with optional `unless [exception]`).

- The AC example format above ("AC2: p95 < 500ms — measured via: …") stays valid as measurement-method reinforcement; the EARS sentence itself is required for every AC.

## Claim Marking & Consultation [PLANNING]

Extends the Ambiguity Gate above from axis granularity to claim granularity: the gate marks which AXIS is uncertain, this marks which CLAIM is — so the verification team receives a question list rather than a score.

**Copies (edit together — a change to either tag literal here is hand-carried)**: this section (canonical) · delivered `agents/glass-atrium-intel-planner.md` → `## Open Questions Section (plan body slot)`, which carries the operative subset (the two tag forms, the unmarked-is-UNCHECKED default and the which-claims test).

- **Marking format** — every substantive claim the plan rests on carries an inline tag at the end of its own bullet:
  - `[SELF-CHECKED: <instrument you ran this turn>]` — names the INSTRUMENT, never the conclusion: the file you Read, the pattern you Grepped, the command you ran and what it returned. A tag naming no instrument is not a self-check.
  - `[UNCHECKED: <the question that would settle it>]` — carries a QUESTION, not a restated claim, because that string becomes another actor's work item verbatim.
  - **An unmarked substantive claim is UNCHECKED.** Omission and self-report inflation can therefore only WIDEN the downstream question list, never exempt a claim from it.
  - **Which claims carry a tag**: the ones whose falsity would change the plan — what code does, capacity/performance figures, "X already exists", "Y is unused", "this is the only caller". A structural fact you looked at (the file exists, the symbol is defined) needs none.
  - The tag is metadata, not code — the no-code prohibition in `## Absolute Rules [PLANNING]` is untouched.
- **`## Open Questions` section of the plan body**: every `[UNCHECKED:]` question appears there once, verbatim, each entry naming the task ids that rest on it. This is the list the Stage-2 team reads.
  - **An empty section is a valid value and is written as such** — deleting the section is not how you have none.
- **Load-bearing marking inside Open Questions**: each entry additionally carries `load-bearing: yes|no` + a one-line reason, judged by the operational test defined ONCE at `scope-dev.md` → `## Plan Direction Verification Gate [DEV+QA]`. Pointer only — cross-read at review, restated here never.
- **Consultation while authoring — two lawful routes, in this order**:
  - **Self-settle first**: you hold `Read`, `Glob`, `Grep`, `Bash`. A claim those can settle, you settle — then it is `[SELF-CHECKED: <instrument>]`. Converting your own assumption is cheaper than routing it.
  - **Domain consult second**: a claim needing a domain agent's judgment you cannot supply → emit `needs_domain_consult: <agent-type> — <the question>` in your `[COMPLETION]`, mirroring the `needs_devfront_markup:` signal precedent above.
    - The orchestrator judges it in its Monitoring phase and composes a pre-authoring consultation; the lawful shapes already exist (`skills/glass-atrium-ops-orchestrator.md` → Pipeline Acceptance Criteria, 3-phase Discovery hatches (a) and (b)).
  - **FORBIDDEN — spawning an agent yourself**: your `tools:` array is frozen at spawn [LLM06] and carries no Agent/SendMessage tool, and MAX_DEPTH=2 forbids the nesting.
    - Stated explicitly because "the planner just calls the domain agent" is otherwise re-proposed as though it were an option.
- **Pre-commitment against this mechanism's own growth**: when the Open Questions list grows past what the plan can carry, do NOT extend the list — that is the Ambiguity Gate `< 0.6` clarification-interview band and the plan is not ready to be written. The existing score bands are the bound; no new cap, no count.
- **Honest backing**: all of the above is honor-system — nothing checks that a `[SELF-CHECKED:]` instrument was run, and nothing checks that marking is complete.
  - The only structural property is the unmarked-is-UNCHECKED default above, which makes under-marking widen the downstream question list instead of shrinking it. Do NOT describe claim marking as verification.

## CQRS Exception [META+PLANNING+DESIGN]

> Detailed rules: See `scope-meta.md` CQRS Exception section (read+write allowed; self-review mandatory)
