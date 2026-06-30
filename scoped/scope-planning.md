# PLANNING Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {intel-planner}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to PLANNING agents: intel-planner.

## Absolute Rules [PLANNING]

- **No code in plans**: SQL, TS, pseudocode, or new function-name proposals are FORBIDDEN — code authoring is the DEV agent's domain

## Output Policy [PLANNING]

- **Save location**: Plans / specs MUST be emitted via `POST /api/clauded-docs` to the monitor-internal store (per this file's Output Format Routing → Emission contract), not `memory/plans/`.
- **Spec-as-Prompt**: A intel-planner output IS the downstream agent's input context — write for machine consumption, not humans only. Structure facts/AC/scope as parseable bullets.
- **ADR hook**: When a plan includes a significant design choice → append an ADR section noting the chosen approach + alternatives rejected + reason. Format-agnostic: a user-requested HTML primary embeds it as `<section id="adr">`; a standalone agent-only ADR record = MD only (see Output Format Routing).
- **Plan Direction Verification subject**: on completing a **complex** plan, intel-planner is subject to the post-authoring Plan Direction Verification Gate — the orchestrator routes the plan to a `{qa-code-reviewer, DEV}` team that judges implementation-direction validity before implementation entry. Planner MUST accept verification feedback and resubmit the revised plan (at most 1 revision; gate spec canonical in `orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)` · DEV-side duty in `scope-dev.md`). Simple plans (typo/import/config-class) are exempt.

## Output Format Routing [PLANNING]

> **Mirror of the CANONICAL SoT** — `scope-report.md` Output Format Routing is the source-of-truth for the request-driven emission model; this section mirrors it scoped to planning. There is **NO document category/prefix**. Format is decided by two request signals only — **did the user request a document, and did the user explicitly ask for a shareable HTML artifact?** The wiki domain is a permanent exception to this policy (the wiki is an Atrium-internal, git-ignored, LLM-only markdown store at `~/.glass-atrium/wiki/` managed by the wiki daemon — see `scope-wiki.md`).

**Two emission modes** (request-driven decision — evaluate in order):

| Mode | Trigger | Format | Storage / Exposure |
|------|---------|--------|--------------------|
| **Agent-only record (DEFAULT fallback)** | User did NOT request a document, but a record is worth keeping — incl. an intermediate plan/spec the user does not directly review (agent-to-agent handoff · backlog stub · standalone ADR) | LLM autonomous selection from {md, yaml, json, txt} per content shape (token-optimized · see `intel-planner.md` Format Selection guidance · no silent default) | monitor-internal (via POST API) · viewer default-hidden |
| **User-requested HTML** | User explicitly requested HTML / a shareable artifact (explicit format request OR explicit share intent — see "HTML request test" below) | HTML primary (single self-contained output) · Mermaid C4 single-file render | monitor-internal (`$CLAUDED_DOCS_HTML_ROOT`, default `~/.claude/monitor/data/documents/` — outside the vault) · viewer-exposed |
| **User-requested non-HTML** | User requested a plan/spec but did NOT specify HTML / a shareable artifact | the form the user asked for · unspecified (a bare "organize/summarize this" with no form) → **md default** (when in doubt, non-HTML — asymmetric cost) | monitor-internal (via POST API) · exposure follows the format (md/yaml/json/txt → default-hidden) |

**HTML request test (explicit-request-only — heuristic auto-HTML FORBIDDEN)**: HTML primary is produced ONLY when 1+ explicit signal is present (canonical detail in `scope-report.md`) —
- **Explicit format request (HTML/web/PDF form ONLY)**: the user explicitly names an HTML / web / PDF output form — e.g. "HTML로", "웹 문서로", "as HTML", "as a web document / web doc", "PDF로", "export it as PDF". A generic plan/spec/document request ("계획서로 작성", "기획서 정리", "make a plan", "write it up") is **NOT** an HTML signal — it routes to user-requested non-HTML (md default) per the 3-mode table above.
- **Explicit share intent**: third-party sharing or direct human review/presentation made clear — e.g. "share with the team", "팀에 공유", "something to show", "for a presentation", "for sharing".

Content visual-richness (diagram count, table density), LLM self-judgment that "this looks visual", and a bare plan/spec/document request are **NOT triggers** (that is the abolished prefix-heuristic reappearing). EARS: `When the user utterance contains 1+ explicit HTML/web/PDF-form or share signal, the system shall emit HTML primary; otherwise (0 signals) the system shall fall back to an agent-only token-optimized format (or user-requested non-HTML md when a plan was requested).`

A backlog stub (TBD/lightweight memo) and a standalone ADR file are agent-only records by default (token-efficient · git-diff readable · viewer-hidden · `md_body` accepted) — an `## ADR` section embedded inside a user-requested HTML plan stays HTML, while a standalone ADR file stays an agent-only md record.

**HTML primary requirements** (user-requested HTML only — full authoring contract in `intel-planner.md` "Output Format Routing"):
- Single-file self-contained (no external CSS, no build step)
- Tailwind CDN inline + semantic HTML5 landmarks
- Inline JS auto-ToC + `@media print` + the **external UMD** Mermaid CDN runtime (`<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>`) LOADED whenever a `<pre class="mermaid">` block is present — auto-renders via `startOnLoad` (default true), NO inline init; the only permitted non-Tailwind `<script>`. Full runtime contract (inline-strip warning · host-side render · raw-text-without-runtime): `## Diagram Standard` below
- Design Expression Rules (No-code zero tolerance) apply inside the HTML body identically to inside an agent-only record (backlog stub / standalone ADR)
- **Target-files section** — when the plan defines a target-file set, emit exactly one flat-leaf `<section id="target-files">` (no nested `<section>`; literal id; one absolute path per `<li>`; OMIT when empty) → consumed by `validate-scope-drift.sh` for per-file scope-binding · full contract: `intel-planner.md` "Target-Files Section".

**Visual-Maximization Floor (exposed HTML primary — MIRROR of `scope-report.md` Output Format Routing → Visual-Maximization Floor, canonical policy SoT; author detail: `intel-planner.md` → Visual Design Spec)**: an exposed HTML plan MUST maximize visual communication; a text dump FAILS. Tiered, exposed-HTML-only (never forces a plan TO HTML; HTML request test above unchanged). **BASELINE** (always): semantic landmarks + `aria-labelledby` per `<section>` + correct heading order · no-print `<nav>` ToC · the Dark base default below as the REQUIRED canvas · **validator-safe dark palette (d8 `inline-color-literal`-aligned; full rule: `scope-report.md` canonical d8 rule + [[visual-expression-exposed-html-docs]])**: all dark colors as `oklch()` (or `hsl()`/`lab()`/`lch()`/`var(--token)`) `:root` custom properties — NEVER hex (`#…`), `rgb()`/`rgba()`, or the words `white`/`black` in any SCREEN-context `<style>` rule, inline `style=`, or CSS comment (`oklch()` is structurally safe); the near-black/near-white halation-avoidance palette is expressed in `oklch`, NOT `#000`/`#fff` · Tailwind v4 CDN dark mode the v4 way (`<style type="text/tailwindcss">` + `@variant dark` — v3 script-config `darkMode` silently FAILS on v4 CDN) · `@media print` reset REQUIRED, the ONE d8-exempt place for `white`/`black`/hex (`<style> @media print { body { background: white; color: black } }`, NOT inline `style=`; hide nav/aside; `break-inside: avoid`) · WCAG 2.2 AA incl. new SC 2.4.11 focus-visible ring (≥3:1 change) + SC 2.5.8 target size ≥24×24px · all status dual-encoded (color + symbol/text, never color-only; verify BOTH dark+light themes) · ≥1 primary visual structure beyond prose. **CONTENT-DRIVEN ESCALATION** (apply the matching visual only): process/DAG/relationship/state/sequence → Mermaid MANDATORY = block + external UMD CDN runtime (full runtime contract — inline-strip warning · host-side render · raw-text-without-runtime · only-non-Tailwind-`<script>`: `## Diagram Standard` below; hand-built div/ASCII/SVG flows FORBIDDEN); diagram-type SELECTION GATE — flowchart=process · sequenceDiagram=interaction · stateDiagram-v2=state · erDiagram=data · pie ≤6 slices; every `<pre class="mermaid">` carries `accTitle`+`accDescr` + an adjacent visible text description · 2+ alternatives → comparison/decision table (semantic `thead`/`tbody`/`th scope`, JetBrains Mono numerics) · real quantified claim → KPI/stat card (5-component, dual-encoded delta, optional `aria-hidden` inline-SVG sparkline; CSS-only bar charts for the right data shapes) · described UI → structural mockup. **RESTRAINT** is part of the standard (no force-fitting visuals a short human-facing plan does not support) — enforce via an EXPLICIT PROHIBITION LIST (prohibition lowers LLM default-trope probability better than positive description): no purple/indigo/lavender AI-brand gradients · no glassmorphism/`backdrop-filter` (also an a11y exclusion) · no gradient text on headings · no centered body text (left-align ragged-right) · no equal `grid-cols-3` (prefer asymmetric 1fr/3fr) · no decoration stacking (one treatment per element) · no emoji-as-icons · no unverified stat banners · max 1 gradient per layer, 2-stop max. `prefers-reduced-motion` SUBSTITUTES (gentle fade) not removes. Deep visual patterns + CSS snippets: [[visual-expression-exposed-html-docs]].

**Dark base default** — HTML primary body defaults to dark mode (aligns with the user's dark homepage · reduces eye strain):
- Set `color-scheme: dark` + a dark background on `<html>` or `<body>` (Tailwind `bg-zinc-950` / `bg-slate-950` / `bg-neutral-950` recommended)
- text light (`text-zinc-100` / `text-slate-100`) — AAA contrast recommended (≥ 7:1) · WCAG AA minimum 4.5:1 guaranteed
- decision/verdict badges (T1 dual-encoded) — dark-friendly hues: `bg-green-900/40 text-green-200` (✓) / `bg-yellow-900/40 text-yellow-200` (⚠) / `bg-red-900/40 text-red-200` (✕) / `bg-blue-900/40 text-blue-200` (ℹ)
- code blocks / tables / Mermaid containers — `bg-zinc-900` + `border-zinc-800` light hint
- environment alignment — monitor dark viewer + dark document body = visual consistency + zero eye strain
- the `@media print` (S-7) branch keeps a forced light theme — `@media print{ body{ background: white; color: black } }` inside a `<style>` block (the ONE d8-exempt place for `white`/`black`/hex; NOT inline `style=`, which has no `@media` context → always raises)
- **Anti-pattern**: light-default body · silent dark/light branching (beyond the single dark default) · screen-context hex (`#…`) / `rgb()`/`rgba()` / `white`/`black` in any `<style>` rule, inline `style=`, or CSS comment (use Tailwind dark tokens or `oklch()`/`var(--token)` — see the d8 validator-safe color rule, `scope-report.md` canonical)

**Emission contract**:
- Agents MUST emit via `POST /api/clauded-docs` (`127.0.0.1:7842`). The POST body carries NO `prefix` field — format is determined by the supplied body-field kind (`html_body` → user-requested HTML primary; `md_body`/`yaml_body`/`json_body`/`txt_body` → agent-only record). The monitor stores HTML as a single file in the monitor-internal root (no MD companion generated — `md_copy_path` response NULL)
- **Required POST tuple** (source: `monitor/src/server/routes/clauded-docs.ts` — mirror of `scope-report.md`): `title` (non-empty, ≤500) + `author` (non-empty, ≤64) + EXACTLY ONE body field of `{html_body, md_body, yaml_body, json_body, txt_body}` (the supplied field IS the format discriminator). 0 body fields → `400`; ≥2 → `400` (`mutually exclusive`); missing/over-length `title`/`author` → `400 invalid_body`. Optional: `audience` (`exposed`/`hidden`), `supersedes_id`, `folder_id`, `doc_status` (`progress`/`done`, default `progress`). Success → `201`. Copy-paste curl (both modes): `intel-planner.md` → Output Format Routing.
- **EVERY emission mode POSTs — no exceptions (self-enforcing, delegation-phrasing-proof)**: ALL three modes (user-requested HTML · user-requested non-HTML · agent-only token-optimized record) are emitted via `POST /api/clauded-docs`. The agent-only record is NOT a file write — "token-optimized record" / "md record" names the BODY FORMAT, never the storage target. Writing any plan/spec deliverable to a path under `memory/plans/` (or any other filesystem location) instead of POSTing is a HARD VIOLATION (audit fail).
- **`memory/` is NEVER a deliverable store**: `memory/` holds ONLY session-internal state — `progress-*.md` cross-session resume files (per `GLOBAL_RULES.md` Cross-Session Continuity). A plan / spec / PRD / ADR / roadmap — any deliverable — MUST NOT be written to `memory/` (incl. `memory/plans/`) under any framing.
- **Delegation phrasing does NOT override this routing (self-enforce)**: a delegation prompt that says "agent-only md/yaml record", "where stored", "save it as an md spec", or similar does NOT authorize a file write — it still POSTs to the monitor. The agent's own Output Format Routing is BINDING and overrides any orchestrator phrasing about storage location; only the user explicitly redirecting away from the monitor (rare, explicit) is honored. When delegation phrasing seems to ask for a `memory/` write, treat it as a request for an agent-only token-optimized BODY and POST it — never resolve the ambiguity toward a filesystem write.
- **silent fallback forbidden**: on user-requested HTML generation failure, any automatic non-HTML fallback is forbidden

**Document Lifecycle — completion + exposure routing (B + C mirror)**:

> Canonical mirror — `scope-report.md` "Output Format Routing" → "Document Lifecycle — completion + exposure routing" is the SoT (done-transition · supersede-vs-new on topic-sameness · exposure routing test + uncertain-default rules). This is a mirror scoped to planning.

- **Done transition (B)**: on completing a plan/spec document, intel-planner (the completing agent) transitions `doc_status→done`. The `PUT /api/clauded-docs/:id` endpoint requires the document body (`html_body` for HTML primary; the corresponding body field for an agent-only record) + an optimistic-lock `expected_hash` re-sent with `doc_status` (a bare `{"doc_status":"done"}` PUT → `400 invalid_body`) — primary human path = monitor viewer done-toggle, agent/CLI path = GET → re-PUT unchanged body+hash (operational detail + curl per the canonical). Supersede-vs-new (topic-sameness only — category constraint removed) + uncertain→new-POST rules per the canonical (orchestrator backstops omissions in its Monitoring phase).
- **Intermediate output exposure (C)**: a intel-planner deliverable that the user does NOT directly review (agent-to-agent handoff · intermediate spec · internal working doc) routes to an agent-only record (viewer default-hidden · token-saving) rather than a user-requested HTML primary — HTML primary stays reserved for plans where the user explicitly requested a shareable HTML artifact. When the user asked for a plan but the form is ambiguous → default non-HTML md (when in doubt, non-HTML). Decision test (single exposure bit: "did the user request a shareable HTML artifact?") + U1-U4 triggers per the canonical.

**HTML Visual Decision Requirements (D8)**: HTML primary outputs MUST satisfy badge dual-encoding (color + symbol — color-blind safety), comparison tables ≤5 columns (rows=criteria / columns=alternatives — SoT: d8-thresholds.json), sandbox-safe interactivity only (`<details>` / CSS-only tabs / inline SVG — Chart.js · D3 · Plotly forbidden — they need `allow-scripts` = a security regression), WCAG AA contrast (text 4.5:1 / UI 3:1 — SoT: d8-thresholds.json), typography 3-level (H1 / H2 / Body — SoT: d8-thresholds.json) + Pretendard for Korean. Detail authoring contract: see `intel-planner.md` "HTML Visual Decision Requirements" section.

**Threshold SoT**: the canonical D8 numeric thresholds (comparison-table maxColumns=5, WCAG contrast text 4.5:1 / UI 3:1, typography ≤3 levels) are defined in `monitor/src/server/clauded-docs/d8-thresholds.json` — the server-enforced source-of-truth the validator `JSON.parse`-loads at module init. The literals quoted in prose throughout this file are a documented MIRROR synced at review time — do NOT treat a prose number as the source · editing a prose number without updating the JSON FORBIDDEN.

## Diagram Standard [PLANNING]

All diagrams in user-requested HTML primary documents MUST use **Mermaid** — a single mandated diagram format (diagram representation is unified on Mermaid).

**Canonical syntax + runtime load (HARD — a block without the runtime renders as RAW LITERAL TEXT, not a diagram)**: `<pre class="mermaid">...</pre>` block in HTML primary, PLUS the **external UMD** Mermaid CDN runtime in the same document via `<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>` — it auto-renders every block via `startOnLoad` (default true), so NO inline init is needed. Do NOT use an inline `<script>`/ESM-module `mermaid.initialize()`/`run()` call — the monitor sanitizer STRIPS ALL inline scripts (only CDN-allowlisted `<script src=…>` survives), so an inline ESM init is removed on POST and the diagram ships as raw text standalone. (The monitor ALSO renders Mermaid host-side for its viewer/export, so it renders inside the monitor regardless; the external min.js covers the standalone/raw-export case.) This external script is the ONLY permitted non-Tailwind `<script>`. No `<pre class="mermaid">` block → do NOT load it. Triple-backtick `` ```mermaid `` fenced blocks ONLY in an MD agent-only record (backlog stub / standalone ADR) — HTML primary has no markdown parser → fenced blocks do not render.

**Permitted Mermaid types**: `flowchart` (graph TD/LR/BT/RL) · `sequenceDiagram` · `classDiagram` · `stateDiagram-v2` · `erDiagram` · `gantt` · `journey` · `pie` · `quadrantChart` · `mindmap` · `timeline` · `xychart-beta` · C4 (`C4Context`/`C4Container`/`C4Component`).

**FORBIDDEN**:
- Ad-hoc HTML graph notation in prose (e.g., free-form text "graph TD A --> B" outside a `<pre class="mermaid">` block)
- Hand-drawn inline SVG diagrams (Mermaid auto-generates SVG as a host-side library — hand-rolled SVG = maintenance cost + reduced consistency)
- Third-party JS chart libraries (Chart.js · D3 · Plotly · ECharts) — reconfirms the existing D8 sandbox-safe interactivity prohibition
- ASCII art diagrams in a `<pre>` block (low fidelity · breaks on narrow viewport · screen-reader incompatible)
- `<iframe>` embeds for diagrams (sandbox bypass = security regression)

**Rationale**:
- Mermaid is text-source — LLM authoring-friendly + git diff readable + reproducible
- monitor viewer (screen 08 architecture) + clauded-docs viewer (mermaid.run hook) both render natively in the host context without sandbox bypass
- a single diagram authoring API → consistent visual idiom across all user-requested HTML primary documents

**Reference**: D8 sandbox-safe interactivity (existing prohibition) · `intel-planner.md` "Abstraction Level & Diagram Requirement Matrix" (5+ task DAG nodes → flowchart · 3+ async actors → sequenceDiagram, etc. trigger table canonical).

## Designer Co-Emission Trigger [PLANNING]

> Canonical mirror — `scope-report.md` "Designer Co-Emission Trigger" is the SoT · this section is a mirror scoped to user-requested HTML primary plans. Cross-reference to prevent duplication drift.

When a **user-requested HTML primary** plan deliverable exceeds the visually-heavy threshold, route automatically to the `{intel-planner, design-designer}` 2-agent Pre-draft consultation mode. Below the threshold, intel-planner solo (default). The probe is gated only on "is this a user-requested HTML artifact?" — an agent-only record never triggers it.

**T1-T5 indicator table** (co-emission MUST when 2+ co-occur · 1 or fewer = solo):

| Code | indicator | Threshold |
|------|-----------|-----------|
| T1 | Mermaid diagrams | ≥ 3 (or ≥ 4 with 2+ mixed types) |
| T2 | comparison tables | ≥ 3 instances AND each ≥ 4 rows (or ≥ 20 cells total) |
| T3 | KPI cards / dashboard-class sections | ≥ 5 |
| T4 | non-canonical status badges | palette expansion beyond the canonical 4-badge (✓/⚠/✕/ℹ) needed |
| T5 | user explicitly states design quality matters OR external-share intent declared | 1+ |

**Workflow mode (A) — Pre-draft consultation adopted**:
- order: intel-planner self-assesses T1-T5 at the turn-0 outline stage → if 2+ met, gets 1-2 turns of advance consultation from design-designer → receives design-designer verdict → intel-planner solo HTML composition → 1 POST
- R2 reject (full parallel co-emission): violates the POST `/api/clauded-docs` atomic contract · token-position conflict · 2× revision_count
- R3 reject (post-draft visual review pass): editing the emitted HTML = a 2nd POST OR PATCH, out of contract · violates the Self-Eval flow

**2-agent team composition**:
- adopted: `{intel-planner, design-designer}` ONLY
- excluded from the DEFAULT team — dev-front: an exposed HTML primary is self-contained Tailwind CDN and not a design-token-consumption surface, so dev-front is NOT a default co-author and is NOT probe-composed (default-adding duplicates design-designer, breaks the atomic 1-doc-1-POST contract R2/R3, inflates tokens). **Narrow exception (governed EXTEND, not a new seat)**: a bespoke interactive component / hand-authored CSS beyond Tailwind-CDN utilities AND beyond design-designer's verdict scope (e.g. CSS-only tab system, complex `:has()`/container-query layout — rare for a plan). TRIGGER PATH (orchestrator-judged, NOT user-surface): the author does NOT ask the user — at turn-0 self-assessment it emits `needs_devfront_markup: true` + a 1-line justification in its `[COMPLETION]`; the orchestrator, during its Monitoring phase, JUDGES capability-based (truly beyond Tailwind-CDN + design-designer scope?) and, if warranted, composes the skeleton-first NON-parallel handoff (dev-front drafts a self-contained styled HTML skeleton — content placeholders only, NO POST — INLINE → planner fills content + Pre-Emission validation + the SINGLE POST); it surfaces to the USER only if genuinely ambiguous (human involvement minimized). R2/R3 remain FORBIDDEN (atomic 1-doc-1-POST preserved); design-designer stays verdict-only (no markup). Default team stays `{intel-planner, design-designer}`. Governance: `scope-dev.md` → DEV Agent Fleet Governance. (Mirror of `scope-report.md` Designer Co-Emission Trigger.)
- excluded scope — every agent-only record (backlog stub · standalone ADR · intermediate handoff spec): LLM-readability-first, no visual-fidelity need, never a user-requested HTML artifact → never triggers design-designer consultation (an agent-only record IS a valid intel-planner intermediate-output channel per Output Format Routing → "Document Lifecycle" C-mirror, it just never co-emits)

**Designer contribution scope**:
- PRIMARY — Mermaid type mapping (14 permitted types → information shape · see `intel-planner.md` "Abstraction Level & Diagram Requirement Matrix") · section composition (3-layer Pyramid rhythm)
- CONDITIONAL — non-canonical badge palette expansion (T4) · table-splitting axis selection (D8 column-cap ≤ 5-col split)
- excluded (mechanical-deterministic) — H1/H2/Body typography (D8 typography-levels) · canonical 4-badge palette · ADR section structure (intel-planner SoT)

**Token break-even guidance**: solo + 1 revision ≈ 12-18K · +design-designer adds 6-10K → break-even ≈ 18-22K total team budget.

**AC (EARS)**: When 2+ T1-T5 indicators co-occur AND the deliverable is a user-requested HTML primary plan, the system shall route to `{intel-planner, design-designer}` parallel team via Pre-draft consultation mode (A).

## Ambiguity Gate [PLANNING]

> Detailed rules: See `scope-dev.md` Ambiguity Gate section (6-axis weighted score; ≥0.8 → proceed, below → clarify with user)

- **6-axis Ambiguity Gate** (in sync with DEV — scope-dev.md "Ambiguity Gate" canonical): Purpose 30% · Scope 25% · Technical 20% · Acceptance 15% · Audience 5% · Dependency 5%
- **Audience axis ≥ 0.9 obligation**: at PLANNING time, resolve the single exposure question — "will the user explicitly request a shareable HTML artifact, or is this an intermediate record?" — so the request-driven format routing is pre-decided rather than discovered at emission time

**Score–evidence consistency** (PLANNING-only):

- Axis containing ≥ 1 unresolved-uncertainty item (any marker meaning "needs confirmation" / "TBD" / "undecided" / "needs investigation") → axis score **capped at 0.85**
- Axis score ≥ 0.9 → body MUST contain an explicit "0 unresolved-uncertainty items" audit line
- Every Acceptance Criterion MUST declare a **measurement method**
  - Good: "AC2: p95 < 500ms — measured via: Grafana prod-api dashboard, 1-week average"
  - Bad: "AC2: responses get faster"
- Integrates with `intel-planner.md` self-check 4-pass as Pass 4 self-contradiction scan

**Confidence-tiered plan generation**:
- Score < 0.6 → do NOT generate plan; conduct clarification interview first.
- Score 0.6 – 0.79 → generate Draft Plan; mark every unresolved axis as `[DRAFT: clarify before DEV]`.
- Score ≥ 0.8 → generate Final Plan (existing rule).

**EARS Acceptance Criteria format**: Every AC MUST use EARS syntax — `When [trigger], the system shall [response]` (with optional `unless [exception]`).
- The existing AC example format ("AC2: p95 < 500ms — measured via: …") remains valid as measurement-method reinforcement; the EARS sentence itself is required for every new AC.

## CQRS Exception [META+PLANNING+DESIGN]

> Detailed rules: See `scope-meta.md` CQRS Exception section (read+write allowed; self-review mandatory)
