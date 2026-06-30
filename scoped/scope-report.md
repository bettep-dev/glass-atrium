# REPORT Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {intel-reporter}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to REPORT agents: intel-reporter.

## Absolute Rules [REPORT]

- **Summary table REQUIRED**: Every report MUST include a summary table at the top (skim-friendly format)
- **Save location**: Reports MUST be emitted via `POST /api/clauded-docs` to the monitor-internal store (per this file's Output Format Routing → Emission contract), not `memory/`
- **Citation format**: External sources MUST cite `URL + collected_at(YYYY-MM-DD)`; date-unknown sources → label `[Date Unknown]` and never treat as current information.

## Output Format Routing [REPORT]

> **CANONICAL SoT (request-driven model)** — this section is the source-of-truth for document emission format. `scope-planning.md` Output Format Routing and the agent/orchestrator files mirror this contract. There is **NO document category/prefix**. Format is decided by two request signals only — **did the user request a document, and did the user explicitly ask for a shareable HTML artifact?** The wiki domain is a permanent exception to this policy (the wiki is an Atrium-internal, git-ignored, LLM-only markdown store at `~/.glass-atrium/wiki/` managed by the wiki daemon — see `scope-wiki.md`).

**Two emission modes** (request-driven decision — evaluate in order):

| Mode | Trigger | Format | Storage / Exposure |
|------|---------|--------|--------------------|
| **Agent-only record (DEFAULT fallback)** | User did NOT request a document, but the agent judges a record is worth keeping (Case 1) | LLM autonomous selection from {md, yaml, json, txt} per content shape (token-optimized · see `intel-reporter.md` Format Selection Matrix · no silent default) | monitor-internal (via POST API) · viewer default-hidden (not-exposed bit) |
| **User-requested HTML** | User explicitly requested HTML / a shareable artifact (Case 2 + HTML trigger — see "HTML request test" below) | HTML primary (single self-contained output) | monitor-internal (`$CLAUDED_DOCS_HTML_ROOT`, default `~/.claude/monitor/data/documents/` — outside the vault) · viewer-exposed (visual artifact) |
| **User-requested non-HTML** | User requested a document but did NOT specify HTML / a shareable artifact (Case 2, no HTML trigger) | the form the user asked for · unspecified (a bare "organize/summarize this" with no form) → **md default** (when in doubt, non-HTML — asymmetric cost) | monitor-internal (via POST API) · exposure follows the format (md/yaml/json/txt → default-hidden) |

**HTML request test (explicit-request-only — heuristic auto-HTML FORBIDDEN)**: HTML primary is produced ONLY when 1+ of these explicit signals is present —
- **Explicit format request (HTML/web/PDF form ONLY)**: the user explicitly names an HTML / web / PDF output form — e.g. "HTML로", "웹 문서로", "as HTML", "as a web document / web doc", "PDF로", "export it as PDF" (HTML-via-export). A generic document/report/plan request ("보고서로 정리", "문서로 작성", "write it up as a report", "make a plan") is **NOT** an HTML signal — it routes to user-requested non-HTML (md default) per the 3-mode table above.
- **Explicit share intent**: the user makes third-party sharing or direct human review/presentation clear — e.g. "share with the team", "팀에 공유", "something to show", "for a presentation", "for sharing".

Content visual-richness (diagram count, table density), LLM self-judgment that "this looks visual", and a bare document/report/plan request are **NOT triggers** — that is the abolished prefix-heuristic reappearing. EARS: `When the user utterance contains 1+ explicit HTML/web/PDF-form or share signal, the system shall emit HTML primary; otherwise (0 signals) the system shall fall back to an agent-only token-optimized format (or user-requested non-HTML md when a document was requested).`

**HTML primary requirements** (user-requested HTML only — full authoring contract in `intel-reporter.md` "Output Format Routing"):
- Single-file self-contained (no external CSS, no build step)
- Tailwind CDN inline + semantic HTML5 landmarks (`<header><main><article><section><footer>`)
- Inline JS auto-ToC + `@media print` for PDF export

**Visual-Maximization Floor (exposed HTML primary — CANONICAL policy SoT)**: an exposed HTML doc MUST maximize visual communication; a headings-plus-paragraphs text dump FAILS. TIERED, NOT a flat quota — applies only to exposed HTML primaries (never forces a doc TO HTML; HTML request test above unchanged). Deep visual patterns + exact CSS snippets: cite `wiki/raw/` note [[visual-expression-exposed-html-docs]] (do NOT inline here).

- **BASELINE (always)**: semantic landmarks + `aria-labelledby` per `<section>` + correct heading order (single h1, no level skip) · no-print `<nav>` ToC · the **Dark base default** below as the REQUIRED canvas · OKLCH 2-tier color tokens (primitive + semantic; near-black/near-white perceptual darks, never pure `#000`/`#fff` — halation), authored validator-safe per the d8 rule below · Tailwind v4 CDN dark mode the v4 way (`<style type="text/tailwindcss">` + `@variant dark`; the v3 script-config `darkMode` silently FAILS on v4 CDN) · `@media print` PDF reset layer REQUIRED not optional (hide nav/aside, `break-inside: avoid`) · WCAG 2.2 AA incl. the two NEW criteria — SC 2.4.11 focus appearance (`:focus-visible` ring, ≥3:1 change-of-contrast) + SC 2.5.8 target size (interactive ≥24×24px) · all status dual-encoded (color + symbol/text + `aria-label`, never color-only) · `prefers-reduced-motion` SUBSTITUTES a gentle fade (does not merely remove) · **≥1 primary visual structure beyond prose** (Mermaid diagram OR comparison table OR KPI/stat-card row).
- **d8 validator-safe color rule (HARD — the live monitor `d8_style_violation` / `inline-color-literal` gate rejects the idiom research otherwise mandates; following the floor literally was POST-rejected twice)**: deliver ALL dark colors as `oklch()` (or `hsl()`/`lab()`/`lch()`/`var(--token)`) — none match the validator's `COLOR_LITERAL_PATTERN`. Put the palette in `:root` custom properties + reference via `var()` (`:root{ --bg: oklch(0.16 0.01 260); --fg: oklch(0.96 0.005 260) } body{ background: var(--bg); color: var(--fg) }`). In ANY screen context — inline `style=` attributes, screen-context `<style>` rules, AND screen-context CSS `/* … */` comments — NEVER use hex (`#fff`/`#000`/`#1a2b3c`), `rgb()`/`rgba()`, or the words `white`/`black` (`near-black`/`near-white` trip the match — `-` is a word boundary; HTML `<!-- … -->` comments are dropped pre-scan and are safe). Hex + the words `white`/`black` are permitted ONLY inside a `<style>` `@media print { body{ background: white; color: black } }` block (the print branch is range-scan-exempt) — keep the print reset there, never inline `style=` (inline has no `@media` notion → always raises). Separately, `bg-{slate,zinc,neutral,gray}-{50,100,200}` / `bg-white` / `background:white|#fff` / `color-scheme:light` on `<html>`/`<body>` trip the `light-default-body` rule — use a dark Tailwind class (`bg-zinc-950`) or `oklch` background + optional `color-scheme:dark`. From [[visual-expression-exposed-html-docs]] apply the OKLCH `:root` idiom + its near-black/near-white token NAMES (fine; its print-block `#fff`/`#000` is print-exempt), but never lift any hex/`white`/`black`/`rgba()` into a screen-context rule or comment.
- **CONTENT-DRIVEN ESCALATION (apply the matching visual only)**: process/flow/relationship/state/sequence → Mermaid MANDATORY (block + external UMD CDN runtime per `## Diagram Standard`; hand-built div-arrow flows / ASCII / hand-drawn SVG / inline-ESM init FORBIDDEN — the sanitizer strips inline scripts), select the type by data shape (flowchart=process · sequenceDiagram=interaction · stateDiagram-v2=states · erDiagram=data model · pie ≤6 slices) + add `accTitle` + `accDescr` inside the block + an adjacent visible text description (3-layer a11y) · 2+ alternatives → comparison table (semantic `thead/tbody/th scope`, JetBrains Mono numerics) · real quantified claim → KPI/stat card (5-component, dual-encoded delta, optional `aria-hidden` inline-SVG sparkline — no invented numbers) · described UI/screen → structural mockup with labeled placeholders · CSS-only bar charts (flex-height / horizontal table inlay) for the matching data shapes.
- **RESTRAINT (part of the standard, via an EXPLICIT PROHIBITION LIST — prohibition lowers the LLM default-trope probability better than positive description)**: match density to content + audience — do NOT force 5 KPI cards / 3 diagrams onto a short human-facing brief. Prohibited: purple/indigo/lavender AI-brand gradients · glassmorphism / `backdrop-filter` (also an a11y exclusion) · gradient text on headings · centered body text (left-align ragged-right) · equal `grid-cols-3` (prefer asymmetric 1fr/3fr) · decoration stacking (one treatment per element) · emoji-as-icons · unverified stat banners · Inter/Roboto/Arial as the sole font · max 1 gradient per layer, 2-stop max. The mandated zinc/OKLCH dark canvas is the REQUIRED base — this anti-slop guard targets zinc-ONLY accent monotony + uniform `rounded-lg` EVERYWHERE (no-shadcn-ification), NOT the dark canvas itself.

Author-side authoring detail: `intel-reporter.md` → Visual Design Spec → Visual-Maximization Floor.

**Dark base default** — HTML primary body defaults to dark mode (aligns with the user's dark homepage · reduces eye strain):
- Set `color-scheme: dark` + a dark background on `<html>` or `<body>` (Tailwind `bg-zinc-950` / `bg-slate-950` / `bg-neutral-950`, or an `oklch` background var — NEVER `bg-white` / `bg-{slate,zinc,neutral,gray}-{50,100,200}` / `color-scheme:light` → trips `light-default-body`)
- text light (`text-zinc-100` / `text-slate-100`) — AAA contrast recommended (≥ 7:1) · WCAG AA minimum 4.5:1 guaranteed
- semantic badges (T1 dual-encoded) — dark-friendly hues: `bg-green-900/40 text-green-200` (✓) / `bg-yellow-900/40 text-yellow-200` (⚠) / `bg-red-900/40 text-red-200` (✕) / `bg-blue-900/40 text-blue-200` (ℹ)
- code blocks / tables — `bg-zinc-900` + `border-zinc-800` light hint
- environment alignment — monitor dark viewer + dark document body = visual consistency + zero eye strain
- the `@media print` (S-7) branch keeps a forced light theme — `@media print{ body{ background: white; color: black } }` inside a `<style>` block (the validator-exempt print branch; per the d8 rule above, the ONLY place `white`/`black`/hex are permitted — never a screen rule or inline `style=`)
- **Anti-pattern**: light-default body · silent dark/light branching (beyond the single dark default) · screen-context hex / `rgb()`/`rgba()` / `white`/`black` (use `oklch`/`var()` dark tokens — see the d8 validator-safe color rule above)

**Agent-only record authoring guide (token-optimized fallback)**:

The agent-only record mode is the DEFAULT fallback (no user document request). The author LLM chooses autonomously based on content shape — {md, yaml, json, txt} 4 formats are equally adoptable. **User readability explicitly abandoned** (viewer default-hide). HTML · markdown formatting flourishes (toc · emphasis · decorative tables) forbidden — useless beyond aiding LLM parsing. Format-selection decision matrix + POST API body field mapping (`md_body`/`yaml_body`/`json_body`/`txt_body`) canonical: `intel-reporter.md` Authoring Contract → Format Selection Matrix.

Agent-only documents MUST minimize token cost and use the language system / format easiest for an LLM to parse — user readability is fully abandoned (plain token-optimized output), since the user rarely inspects an LLM-targeted reference document. MD MUST NOT be forced as a silent default — the LLM selects the most readable, token-efficient format per content shape.

The server `/api/clauded-docs` `parseCreateBody` natively accepts md/yaml/json/txt 4 formats — the format is determined by the body-field kind supplied (`md_body`/`yaml_body`/`json_body`/`txt_body`), with NO `prefix` field. The author LLM chooses autonomously based on content shape (intel-reporter.md Format Selection Matrix · MD is no longer a silent default · explicit per-content-shape selection required). The token-efficiency rationale (improvingagents YAML 62.1% · MD 34-38% savings) is preserved as matrix justification.

- **Storage location**: POST API via monitor-internal storage — all clauded-docs document bodies route through `POST /api/clauded-docs` to the monitor-internal root (see the Emission contract above + `orchestrator-role.md` Harness Path Protection). The POST body carries NO `prefix` field (DocPrefix taxonomy abolished).
- **Owner = intel-reporter** (intel-researcher handles only `wiki/raw/` · orchestrator self-execution violates the no-execution principle · intel-planner out of CQRS scope · a new agent costs more than extending the existing one)
- **Exposure bit (audience collapsed to 2 values)**: the former 3-tier audience axis collapses into a single exposure bit driven by the one question "did the user request a shareable HTML artifact?" —
  - **user-requested HTML** → viewer-exposed (visual artifact); HTML primary carries no YAML frontmatter — metadata lives on the monitor.ClaudedDoc DB row (server-managed)
  - **agent-only record** → viewer default-hidden (not-exposed); carries the minimal identity fields (`agent` author declaration + `tokens_estimate` for cost visibility) in a format-adaptive carrier (MD=YAML frontmatter / YAML/JSON=top-level keys / TXT=POST body fields)
- **agent-only body recommended patterns** (a guide, not mandatory — author chooses by LLM-efficiency judgment):
  - prefer key-value pairs (drop unnecessary verbose prose)
  - table / YAML / JSON preferred over prose (higher LLM token efficiency — improvingagents benchmark: YAML 62.1% · Markdown 34-38% token savings)
  - 5+ token repeated expressions → reference (e.g., cite a previous record)
  - compress 4-6 lines of prose → 3-5 bullets
  - conclusion → 1 line (Pyramid alignment)
- **agent-only selection trigger**: the agent-only record is the DEFAULT — emit it whenever the user did NOT request a document but a record is worth keeping (U1 explicit user instruction to record · U2 intermediate deliverable in a multi-agent chain · U3 cross-session search catalog · U4 token-heavy raw-source synthesis). Prefer an existing mechanism when it can substitute (`memory/progress` session self-resume · one-off in-prompt handoff · `~/.claude/data/outcomes` after-action · `learning-log` accumulated patterns). Detailed use-cases + boundary definition: `intel-reporter.md` Authoring Contract → `Use-Case Triggers` section canonical.
- **monitor UI exposure policy (no regression)**:
  - agent-only record → frontend filter default hidden (prevents UX confusion)
  - user-requested HTML → shown in UI
- **silent fallback forbidden**:
  - on user-requested HTML generation failure, any automatic non-HTML fallback is forbidden — halt + scope clarification
  - HTML · visual decoration forbidden for an agent-only record (token waste → audit fail)
- **HTML vs agent-only branching spec**:
  - **user-requested HTML** → HTML primary single contract (dark base + D8 visual invariants (dual-encoding · column-cap · sandbox-safe interactivity · WCAG-AA contrast · typography-levels) + compliance with the intel-reporter.md "Canonical HTML Skeleton" inline skeleton)
  - **agent-only record** → LLM autonomous {md, yaml, json, txt} selection (MD default forcing discontinued) · decision matrix canonical `intel-reporter.md` Format Selection Matrix — HTML · TOC · visual-decoration toggle FORBIDDEN · viewer default-hide
  - branching decision order MUST: apply the HTML request test (§ above — explicit format/share signal?) → if no signal, fall back to agent-only and apply content shape → format matrix → body composition. Reversing the order FORBIDDEN (entering body silently = audit fail)

**Emission contract**:
- Agents MUST emit via `POST /api/clauded-docs` (`127.0.0.1:7842`). The POST body carries NO `prefix` field — format is determined by the supplied body-field kind (`html_body` → HTML primary; `md_body`/`yaml_body`/`json_body`/`txt_body` → agent-only record). The monitor stores HTML as a single file in the monitor-internal root (no MD companion generated — `md_copy_path` response NULL)
- **Required POST tuple** (source: `monitor/src/server/routes/clauded-docs.ts`): `title` (non-empty, ≤500) + `author` (non-empty, ≤64) + EXACTLY ONE body field of `{html_body, md_body, yaml_body, json_body, txt_body}` (the supplied field IS the format discriminator). 0 body fields → `400`; ≥2 → `400` (`mutually exclusive`); missing/over-length `title`/`author` → `400 invalid_body`. Optional: `audience` (`exposed`/`hidden`), `supersedes_id`, `folder_id`, `doc_status` (`progress`/`done`, default `progress`). Success → `201`. Copy-paste curl (both modes): `intel-reporter.md` → Output Format Routing.
- **EVERY emission mode POSTs — no exceptions (self-enforcing, delegation-phrasing-proof)**: ALL three modes (user-requested HTML · user-requested non-HTML · agent-only token-optimized record) are emitted via `POST /api/clauded-docs`. The agent-only record is NOT a file write — "token-optimized record" / "md record" names the BODY FORMAT, never the storage target. Writing any deliverable to a path under `memory/` (or any other filesystem location) instead of POSTing is a HARD VIOLATION (audit fail).
- **`memory/` is NEVER a deliverable store**: `memory/` holds ONLY session-internal state — `progress-*.md` cross-session resume files (per `GLOBAL_RULES.md` Cross-Session Continuity). A report / spec / plan / reference / ADR — any deliverable — MUST NOT be written to `memory/` under any framing.
- **Delegation phrasing does NOT override this routing (self-enforce)**: a delegation prompt that says "agent-only md/yaml record", "where stored", "save it as an md", or similar does NOT authorize a file write — it still POSTs to the monitor. The agent's own Output Format Routing is BINDING and overrides any orchestrator phrasing about storage location; only the user explicitly redirecting away from the monitor (rare, explicit) is honored. When delegation phrasing seems to ask for a `memory/` write, treat it as a request for an agent-only token-optimized BODY and POST it — never resolve the ambiguity toward a filesystem write.
- **silent fallback forbidden**: on user-requested HTML generation failure, any automatic non-HTML fallback is forbidden
- **Monitor schema gates (server-enforced 400 if violated)**:
  - **Gate 1 (HTML5 baseline)**: `html_body` MUST contain `<!doctype html>` + `<meta charset>` + `<meta viewport>`. Missing any → code `html_structure_invalid`. The dark-base skeleton already includes these in canonical form — DO NOT strip them when authoring.
  - **Gate 2 (D8 column-cap server enforcement)**: comparison tables ≤5 columns hard-enforced server-side, not just qa-code-reviewer LLM judgment. Multi-config measurement tables exceeding 5 columns MUST be split per config (e.g., 2-config 4-peak grid → 2 tables of 5 columns). Violation → code `d8_p2_violation`.

**Document Lifecycle — completion + exposure routing (B + C canonical)**:

> Canonical authority — `scope-planning.md` Output Format Routing mirrors this lifecycle (done-transition · supersede-vs-new · exposure routing).

The monitor already implements the mechanism (`doc_status` enum `progress`/`done` · `PUT /api/clauded-docs/:id` transition · `supersedes_id` revision chain with predecessor auto-`done`) — no monitor code change. These rules govern *when* the authoring agent acts.

- **Done transition (B)**: when a document's work is fully finished (no remaining work), intel-reporter (the completing agent) transitions `doc_status→done`. The completing agent owns the transition — it knows the completion point most precisely. The `PUT /api/clauded-docs/:id` endpoint requires the document body (`html_body` for HTML primary; the corresponding body field for an agent-only record) + an optimistic-lock `expected_hash` re-sent alongside `doc_status` — a bare `{"doc_status":"done"}` PUT is rejected `400 invalid_body`; the no-op (body-unchanged) path then fires a status-only cascade. Primary human path = the monitor viewer done-toggle button (auto re-sends body+hash); agent/CLI path = GET → re-PUT the unchanged body with the lock hash. Operational curl in `orchestrator-role.md` → `## Managed Document Completion` Step 1. The orchestrator backstops omissions during its Monitoring phase (fallback only).
- **Supersede vs new document (B)**: supersede is keyed on **topic sameness only** — the former same-prefix category constraint is REMOVED (no prefix exists). When new content arises —
  - **same topic** revision of a `done` document → **supersede** (new POST with `supersedes_id` set); rely on the monitor's auto-transition of the predecessor. A supersede may now chain documents of differing formats (an agent-only record superseded by a user-requested HTML revision, etc.) — only topic sameness gates it.
  - **unrelated topic** → **new-document POST** (`supersedes_id` omitted) — never reopen/edit a `done` document (reopening causes progress regression).
  - **uncertain topic-relatedness → default to a new POST, never reopen a done document** (decisive tiebreaker — asymmetric cost: a surplus document is cheap + recoverable; reopening a done document is high-cost).
- **Exposure routing test (C)**: at turn-0, decide exposure by the single question **"did the user request a shareable HTML artifact?"** (the abolished prefix-coupled audience 3-tier collapses into this one 2-value bit) — YES → viewer-exposed user-requested HTML (the user directly reviews/decides) · NO (no document request, or a request the user does not directly review — agent-to-agent handoff · intermediate spec · internal working doc) → agent-only record (viewer default-hidden · token-saving). This applies the existing `agent-only selection trigger` U2 (intermediate deliverable in a multi-agent chain), which explicitly **includes intermediate planning-domain output**. Order is unchanged (HTML request test → exposure bit → finalize format → body composition).
- **Uncertain exposure → default per the asymmetric-cost rule**: when the user asked for a document but the form is ambiguous (a bare "organize/summarize this"), default to **non-HTML md** (when in doubt, non-HTML — surplus HTML = token waste). The exposure bit only flips to viewer-exposed on an explicit HTML/share signal.
- **Lifecycle coherence (C↔B)**: an agent-only record follows B's done-transition + supersede-vs-new rules identically — agent-only is an exposure choice, not a lifecycle exemption.

**HTML Visual Decision Requirements (D8)**: HTML primary outputs MUST satisfy badge dual-encoding (color + symbol — color-blind safety), comparison tables ≤5 columns (rows=criteria / columns=alternatives — SoT: d8-thresholds.json), sandbox-safe interactivity only (`<details>` / CSS-only tabs / inline SVG — Chart.js · D3 · Plotly forbidden — they need `allow-scripts` = a security regression), WCAG AA contrast (text 4.5:1 / UI 3:1 — SoT: d8-thresholds.json), typography 3-level (H1 / H2 / Body — SoT: d8-thresholds.json) + Pretendard for Korean. Detail authoring contract: see `intel-reporter.md` "HTML Visual Decision Requirements" section.

**Threshold SoT**: the canonical D8 numeric thresholds (comparison-table maxColumns=5, WCAG contrast text 4.5:1 / UI 3:1, typography ≤3 levels) are defined in `monitor/src/server/clauded-docs/d8-thresholds.json` — the server-enforced source-of-truth the validator `JSON.parse`-loads at module init. The literals quoted in prose throughout this file are a documented MIRROR synced at review time — do NOT treat a prose number as the source · editing a prose number without updating the JSON FORBIDDEN.

## Diagram Standard [REPORT]

All diagrams in user-requested HTML primary documents MUST use **Mermaid** — a single mandated diagram format (diagram representation is unified on Mermaid).

**Canonical syntax**: `<pre class="mermaid">...</pre>` block in HTML primary. Triple-backtick `` ```mermaid `` fenced blocks ONLY in an MD agent-only record — HTML primary has no markdown parser → fenced blocks do not render.

**Runtime load REQUIRED (HARD — a `<pre class="mermaid">` block without the runtime renders as RAW LITERAL TEXT, not a diagram)**: "process to Mermaid MANDATORY" means **block + external CDN runtime** — the block alone is a defect (behaviorally confirmed: a doc whose only `<script>` was the Tailwind CDN shipped the flowchart as unparsed text). Any exposed HTML doc with ≥1 `<pre class="mermaid">` block MUST load the **external UMD build** via an allowlisted `<script src>` — it survives the monitor sanitizer AND auto-renders every block via `startOnLoad` (default true), so NO inline init is needed:
```html
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
```
Do NOT use an inline `<script>` / ESM-module + `mermaid.initialize()`/`mermaid.run()` init — the monitor sanitizer STRIPS ALL inline `<script>` blocks (only external CDN-allowlisted `<script src>` survives), so an inline ESM init is removed on POST and the diagram ships as raw text standalone. (The monitor ALSO renders Mermaid host-side for its own viewer/export, so it renders inside the monitor regardless; the external `min.js` covers the standalone/exported raw-HTML case.) This external Mermaid `<script src>` is the **ONLY permitted non-Tailwind `<script>`** in an exposed HTML primary (D8 sandbox-safe interactivity otherwise bars third-party JS — Chart.js · D3 · Plotly). No `<pre class="mermaid">` block → do NOT load it. Author-side skeleton + 3-layer a11y: cite [[visual-expression-exposed-html-docs]] (Tier 2 Mermaid external UMD CDN).

**Permitted Mermaid types**: `flowchart` (graph TD/LR/BT/RL) · `sequenceDiagram` · `classDiagram` · `stateDiagram-v2` · `erDiagram` · `gantt` · `journey` · `pie` · `quadrantChart` · `mindmap` · `timeline` · `xychart-beta` · C4 (`C4Context`/`C4Container`/`C4Component`).

**FORBIDDEN**:
- Ad-hoc HTML graph notation in prose (e.g., free-form text "graph TD A --> B" outside a `<pre class="mermaid">` block)
- Hand-drawn inline SVG diagrams (Mermaid auto-generates SVG as a host-side library)
- Third-party JS chart libraries (Chart.js · D3 · Plotly · ECharts) — reconfirms the existing D8 sandbox-safe interactivity prohibition
- ASCII art diagrams in a `<pre>` block (low fidelity · breaks on narrow viewport · screen-reader incompatible)
- `<iframe>` embeds for diagrams (sandbox bypass = security regression)

**Rationale**:
- Mermaid is text-source — LLM authoring-friendly + git diff readable + reproducible
- monitor viewer (screen 08) + clauded-docs viewer (mermaid.run hook) both render natively in the host context without sandbox bypass
- a single diagram authoring API → consistent visual idiom across all user-requested HTML primary documents

**Agent-only record branch**: even when a diagram is needed, token efficiency takes priority — bullet · table · ASCII tree (within LLM-parseable range) preferred. When using a Mermaid block, the ` ```mermaid ` fence is allowed (the MD parser handles it on the LLM side). For a diagram whose purpose is visual fidelity → the user should be asked to request an HTML artifact.

**Reference**: D8 sandbox-safe interactivity (existing prohibition) · `intel-reporter.md` "Sandbox-Safe Interactivity" Mermaid CDN exception (host-context render path specified).

## Designer Co-Emission Trigger [REPORT]

> Canonical authority — `scope-planning.md` Designer Co-Emission Trigger mirrors this section.

When a **user-requested HTML primary** deliverable exceeds the visually-heavy threshold, route automatically to the `{intel-reporter, design-designer}` 2-agent Pre-draft consultation mode. Below the threshold, intel-reporter solo (default). The probe is gated only on "is this a user-requested HTML artifact?" — an agent-only record never triggers it (LLM-readability-first · no visual-fidelity need).

**T1-T5 indicator table** (co-emission MUST when 2+ co-occur · 1 or fewer = solo):

| Code | indicator | Threshold |
|------|-----------|-----------|
| T1 | Mermaid diagrams | ≥ 3 (or ≥ 4 with 2+ mixed types — strict variant) |
| T2 | comparison tables | ≥ 3 instances AND each ≥ 4 rows (or ≥ 20 cells total) |
| T3 | KPI cards / dashboard-class sections | ≥ 5 |
| T4 | non-canonical status badges | palette expansion beyond the canonical 4-badge (✓/⚠/✕/ℹ) needed |
| T5 | user explicitly states design quality matters OR explicit external-share intent declared | 1+ |

**Workflow mode (A) — Pre-draft consultation adopted**:
- order: intel-reporter self-assesses T1-T5 at the turn-0 outline stage → if 2+ met, gets 1-2 turns of advance consultation from design-designer → receives design-designer verdict → intel-reporter solo HTML composition → 1 POST
- R2 reject (full parallel co-emission): POST `/api/clauded-docs` atomic contract (1 doc = 1 emission) · parallel stitching causes inline-Tailwind self-contained HTML token-position conflicts · 2× revision_count cost
- R3 reject (post-draft visual review pass): editing the emitted HTML = a 2nd POST (creates a new DB row) OR PATCH (out of contract) · violates the Self-Eval 4-Dim flow

**2-agent team composition**:
- adopted: `{intel-reporter, design-designer}` ONLY
- excluded from the DEFAULT team — dev-front: an exposed HTML primary is self-contained Tailwind CDN and not a design-token-consumption surface, so dev-front is NOT a default co-author and is NEVER probe-composed (default-adding duplicates design-designer's anti-slop/craft role, breaks the atomic 1-doc-1-POST contract — R2/R3 — and inflates tokens). **Narrow exception (governed EXTEND, not a new seat · orchestrator-judged, minimal human involvement)**: a bespoke component / hand-authored CSS beyond Tailwind-CDN utilities AND beyond design-designer's verdict scope (e.g. CSS-only tab system, complex `:has()`/container-query layout — rare for a decision/report doc). TRIGGER PATH (NOT user-surface): the author does NOT ask the user — at turn-0 self-assessment it emits `needs_devfront_markup: true` + a 1-line justification in its `[COMPLETION]`, signaling the ORCHESTRATOR; the orchestrator, during its Monitoring phase, JUDGES capability-based (truly beyond Tailwind-CDN + design-designer scope?) and, if warranted, composes a NON-parallel skeleton-first handoff (dev-front drafts the styled skeleton INLINE — no `memory/` write → author fills content + the SINGLE POST); it surfaces to the user only if genuinely ambiguous. R2 (parallel stitching) / R3 (second POST) remain FORBIDDEN; default team stays `{intel-reporter, design-designer}` (design-designer verdict-only, no markup). Governance + boundary: `scope-dev.md` → DEV Agent Fleet Governance.
- excluded scope — agent-only record (LLM-readability-first · visual fidelity 100% abandoned · never a user-requested HTML artifact)

**Designer contribution scope**:
- PRIMARY — Mermaid type mapping (14 permitted types → information shape · see Diagram Standard) · section composition (Pyramid skim/scan/read 3-layer rhythm)
- CONDITIONAL — non-canonical badge palette expansion (T4 trigger) · table-splitting axis selection (when D8 column-cap ≤ 5-col split is needed)
- excluded (mechanical-deterministic) — H1/H2/Body typography (D8 typography-levels) · canonical 4-badge palette

**Token break-even guidance**: solo + 1 revision ≈ 12-18K · +design-designer adds 6-10K → break-even ≈ 18-22K total team budget · below it, solo is cheaper · above it, design-designer nets savings by preventing cascading rework.

**AC (EARS)**: When 2+ T1-T5 indicators co-occur AND the deliverable is a user-requested HTML primary artifact, the system shall route to `{intel-reporter, design-designer}` parallel team via Pre-draft consultation mode (A).

## Report Structure [REPORT]

Every report MUST be navigable in skim-only mode (layers are format-agnostic — a user-requested HTML primary uses `<section>` landmarks; an agent-only record (md/yaml/json/txt) uses `## Heading` or author-chosen structure):
- **Skim layer**: summary table + 3-line conclusion (decision-ready without further reading) — HTML `<section id="summary">` / MD `## Summary` (heading text in the deliverable locale). **Agent-only record exempt** (user readability abandoned → keep only the 1-line Pyramid conclusion).
- **Scan layer**: per-section digest + recommendation list — HTML `<section>` per topic / MD `##` headings.
- **Read layer**: full analysis + complete source list — HTML `<article>` body / MD body sections.

The summary table requirement (Absolute Rules) is the entry point of the Skim layer. Reports MUST NOT bury the conclusion in body paragraphs.

## Self-Evaluation Obligation [REPORT]

After completing a report, apply the G-Eval-style 4-dimension self-assessment (rubric canonical: `scope-qa.md` Deliverable Quantitative Evaluation):
- Total < 12 → rework before delivery.
- Record scores at the report bottom — a user-requested HTML primary embeds as `<section id="self-evaluation">`; an agent-only record embeds as a `## Self-Evaluation` section (for agent-only, LLM parsing efficiency takes priority — a simple key-value form is allowed).

> Cross-ref: the `core-outcome-record.md` Field Input Guide `metric_pass` row's per-task-type deterministic check matrix operates as the Code-Based grader tier — author-side outcomes only (infra attribution failures out-of-scope) · this 4-Dim self-evaluation stacks on top as a self-applied variant of the Model-Based grader tier

> Detailed rubric: See `scope-qa.md` Deliverable Quantitative Evaluation section (canonical source).

## LLM-as-Judge 4 Dimensions [QA+REPORT]

> Detailed rules: See `scope-qa.md` Deliverable Quantitative Evaluation section (Coverage / Insight / Instruction-following / Clarity, each 1-5; <12 → rework)
