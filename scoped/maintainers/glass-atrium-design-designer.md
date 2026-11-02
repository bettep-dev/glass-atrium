# Maintainer note — agents/glass-atrium-design-designer.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 of the frontmatter | the turn-budget meter is sized from it |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys (name, tools, scope) | live edits to them are blocked for every caller (LLM06) |
| `autoagent/lib/editable_merge.py` | EDITABLE region count, local vs release | a count change routes the merge to the manual structural-change ceremony |
| `hooks/test/enforce-harness-critical-frontmatter.bats`, `-pathnorm.bats` | `hooks/test/corpus/agents-blocklist/glass-atrium-design-designer.md`, a frontmatter copy | its body is synthetic, so body edits are invisible to it; mirror a frontmatter edit there |
| `manifest.json` | the body's sha256 | any edit needs a manifest regeneration |

- No suite reads this body's prose; `scripts/test/test_inject_sync.py` and `hooks/test/h2-untrusted-ingest.bats` name the agent in injector rosters only.
- No suite checks that the body headings cited in `## Body text other files cite` still exist.

## Body text other files cite

| Body text | Cited from |
|---|---|
| `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` | **AI Slop Tropes citers** |
| `## Red Flags` (WCAG AA not verified · **Color & contrast** derive-then-verify) | contrast-check skill · `scoped/maintainers/scope-design.md` · AI Slop Tropes citers' heading paths |
| `## Pre-Emit 5-Axis Self-Critique` (axes · band rubric · emit gate) | 5-axis-critique skill, whose `**Gate**: PASS (all ≥7)` line reads the band rubric · `scoped/scope-design.md` |
| `## Design Evaluation 4-Axis (1-5 each, 20 total)` | 5-axis-critique skill · `scoped/scope-qa.md` |
| `## HTML Primary Co-Emission Role` | **HTML Primary Co-Emission Role citers** |
| **Section minimalism** (consumers preserve unrecognized sections) | md-lint skill · `agents/templates/DESIGN.md` |
| `### Dark Theme Rules` → **Hierarchy (rgba white)** alpha values | `agents/references/design-color-algorithms.md` (alpha SoT) · dev-front body (dark text lower-bound defaults) |
| `### Motion Philosophy (first-class stage — Owner: glass-atrium-design-designer · WHAT/why)` | dev-front body · `scoped/maintainers/shared-design-token-consumption.md` |
| `### Figma Make + MCP Integration Guardrails` (LLM Output Validation line · Vendor-Routing line) | `scoped/maintainers/scope-design.md` |
| `## Pre-Execution Verification` contrast row | `scoped/maintainers/scope-design.md` |

- **AI Slop Tropes citers**: `git grep 'AI Slop Tropes'`; the `hooks/test/` hits are the frontmatter copy's `skills:` comment and `rationale` literal (`## Machine constraints on the body`), plus the `AC-B7 containment` fixture in `enforce-harness-critical-frontmatter.bats`, quoting the rationale.
- **HTML Primary Co-Emission Role citers** (trigger · output fields · markup prohibition · veto line, its sole copy): `git grep 'HTML Primary Co-Emission Role'`.

## Copies kept in step with this body

- **AI Slop Tropes mirrors** (a closed set — edit together):
  - `skills/glass-atrium-design-anti-slop/SKILL.md` → `## Pattern Categories (mirror glass-atrium-design-designer.md SoT)` — the detector layer, preloaded by the agent.
  - `agents/glass-atrium-dev-front.md` → `### Anti-AI-Slop (Mandatory — single SoT for full catalogue)` — pointer plus enforcement subset.
  - `scoped/scope-report.md` → `### Visual-Maximization Floor` → **Residual anti-slop patterns** — a deliberate supplement of patterns the SoT lacks, not a copy.
- **Diverged, unreconciled** (the rule owner's call):
  - the detector holds patterns absent from the SoT: three colour patterns (a white-on-dark text floor whose hex has no canonical home among them) and the 3-column equal-distribution layout;
  - the SoT holds the pure-black `#000` text trope, the mixed-radius trope and the Workflow-tropes group, which the detector lacks.
- **Default-style tropes are an open group**: a new one lands in the SoT and its detector mirror together.
- **Token Architecture copies** — edit `### Token Architecture (3-tier)` together with:
  - `agents/glass-atrium-dev-front.md` → `### Design Token 3-Tier System` (its frontmatter claims the design-token SSoT).
  - `agents/references/design-token-architecture.md` → `## 3-Tier Token Architecture` (the alias-chain hard rules).
  - `skills/glass-atrium-design-md-lint/SKILL.md` and its lint script.
  - `agents/templates/DESIGN.md`.
  - `scoped/shared-design-token-consumption.md` → `## Token Lookup Order` (not in the agent's registry row).
  - Which is canonical is unresolved; route that to the rule owner.
- **Reduced-motion fallback statements** — canonical: `scoped/shared-design-token-consumption.md` → `## Motion Tokens` → `prefers-reduced-motion`. Also stated in:
  - `agents/references/design-motion-tokens.md`
  - `agents/templates/DESIGN.md`
  - the HTML-document variant in the intel-reporter and intel-planner bodies
- **DESIGN.md sections**: the body states no section order.
  - The md-lint section-order rule checks `lint.sh` → `CANONICAL_SECTIONS`, a hardcoded copy of the template's section 1-9 order, and reports drift at warning severity (exit 0).
  - Edit `agents/templates/DESIGN.md`, `CANONICAL_SECTIONS` and the order list in the skill's `SKILL.md` → **section-order** together.

## Canonicals the body states no copy of

- host: `rules/glass-atrium/core-outcome-record.md` → Completion Report Output Obligation and Role → Allowed task_types.
- slot 1: the emit-format block; `BUDGET_ANALYSIS_AGENTS` (budget discipline); `WIKI_UNTRUSTED_AGENTS` (raw-store data clause).
- `rules.scope`: `scoped/scope-design.md`, whole.
- `agents/templates/DESIGN.md` carries the default brand token examples, the Numeric-to-Unit pairs and the weight discipline line.

## Decisions worth keeping

- **No-self-approval kernel**: the canvas waits for the user's explicit go-ahead on both philosophy documents — a consent point, not a process step, so it stays in Guardrails.
- The no-`completion_block` fallback stays in the body: neither `rules/glass-atrium/core-outcome-record.md` nor the emit-format block states it.
- **Numbers that stay**:
  - WCAG ratios and the 44×44px target — WCAG criteria the contrast-check skill and the template use.
  - the dark-theme alpha values, and the 5-axis 0-10 bands with the ≥7 gate — readers in `## Body text other files cite`.
  - the D8 `≤5 col` invariant in the veto line — `monitor/src/server/clauded-docs/d8-thresholds.json` → `maxColumns`.
  - `7 properties × 5 states` and `12-step` — names of spec shapes, not limits; no reader.
