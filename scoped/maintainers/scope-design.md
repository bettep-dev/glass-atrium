# Maintainer note — `scoped/scope-design.md`

Maintainer-facing material for that rule file. Nothing here binds glass-atrium-design-designer; the rule file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: no pointer to this note survives in the rule file. Nothing moved out from under an externally-cited heading — what left was duplicate text and one duty that was dropped outright.

## Token versioning — dropped, and why

The former `**Token versioning**: changes MUST be branch-isolated; rollback path required before merging` is gone rather than reworded.

- **The defect is role, not capability.** glass-atrium-design-designer holds Bash, so it could run git — but it authors specs and does not land token changes, so branch isolation and merge gating name an act it never performs, and the line named no one to hand them to.
- **Already governed, and delivered**: `rules/glass-atrium/core-git-workflow.md` is Tier 1 and reaches every agent, including this one, with the branch-naming and PR/merge rules. A second, weaker statement scoped to tokens could only diverge from it.
- **What survives is the actor-specific residue**, restated in a form the designer can discharge: under `## LLM Output Validation`, a token-changing handoff must name the rollback path in the handoff itself. It pairs with the token-existence check directly above it, so the DEV agent that lands the change receives both what the token is and what reverts it.

## Duplicates dropped, with the delivered copy that made them redundant

Each counterpart was confirmed present in `agents/glass-atrium-design-designer.md` by grep this pass:

- **`**No AI-generated aesthetics**` font list** → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` carries `Overused fonts: Inter · Roboto · Arial · Fraunces · generic system fonts`, and `### Typography` additionally resolves the fallback-versus-primary subtlety the scope-file line lacked (a fallback face is a rendering substitute; selecting one as a primary is the trope).
- **Vendor-routing sane-default and cross-vendor-parity bullets** → `### Figma Make + MCP Integration Guardrails` carries `Vendor-Routing: Figma is the default design tool; do NOT assume Sketch / XD parity in design specs.` Only the routing-rationale bullet had no counterpart, so only it survives in the rule file.
- **`Verify no prohibited fonts`** in the handoff checklist → the same AI Slop Tropes line, plus `### Red Flags` → `**Color & contrast**`.
- **The WCAG AA ratios** → `### Output Contract` pins `WCAG AA (4.5:1 text · 3:1 large-text ≥18pt) verified · AAA (7:1) recommended`, `## Pre-Execution Verification` pins the same pair, and `### Red Flags` carries the derive-then-verify obligation. The rule file keeps a bare one-line contrast item with no numbers — see the next section for why the item itself stays.

## Why the contrast item was kept despite being a duplicate

Three sites cite `## LLM Output Validation` by name, and one of them cites it specifically for contrast: `skills/glass-atrium-design-contrast-check/SKILL.md` describes it as the contrast verification gate before downstream DEV handoff, `skills/glass-atrium-design-md-lint/SKILL.md` as the pre-emit gate family it joins, and `agents/glass-atrium-design-designer.md` → `### Figma Make + MCP Integration Guardrails` says LLM Output Validation applies to auto-generated layouts. Deleting the item would leave the first of those describing a section that no longer contains what it names. The numbers are gone, the anchor stays, and both skill files are outside this pass's declared `[SCOPE]`.

## Headings and their citers

| Heading | Cited from |
|---|---|
| `Absolute Rules` | nothing cites it by name — kept because the heading names the content beneath it |
| `Platform Design Token Policy` | `scoped/maintainers/shared-design-token-consumption.md` → Cross-references |
| `LLM Output Validation` | the two design skills and the designer body named in the section above · `scoped/maintainers/shared-design-token-consumption.md` |
| `Vendor-Routing Awareness` | nothing cites this file's copy — `scoped/scope-dev.md` carries a same-named section of its own, which is what `agents/glass-atrium-dev-db.md` cites |
| `CQRS Exception` | nothing; this file is a citER of `scoped/scope-meta.md` → `## CQRS Exception`, not a citee |

No heading was renamed in this pass.

## Stale material removed

- **Loading stanza** (`> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-design-designer}` plus `> **Inherits**` and `> **See**`) and the `Rules specific to DESIGN agents` line. The stanza described a selection mechanism that does not select this file; no roster parser reads a brace list outside `scoped/scope-dev.md`, so removing it costs no machine reader.

## Delivery — what actually reads this file

- No spawn path delivers it. `hooks/inject-scope-rules.sh` sources exactly three files under `scoped/` (`shared-comment-logging.md`, `scope-dev.md`, `shared-turn-budget.md`), and `scope-design.md` is not one of them.
- The platform token policy is therefore the file's most exposed content: the three platform facts it carries (Material Web in maintenance mode, M3 Expressive via Compose, HIG semantic-role tokens) appear nowhere in the designer body, so a designer that never reads this file recommends a token system without them.
- **Required follow-up, out of this pass's declared `[SCOPE]`** (`scoped/scope-meta.md`, `scoped/scope-design.md`, `scoped/maintainers/`): give `agents/glass-atrium-design-designer.md` a conditional-load line naming `~/.glass-atrium/scoped/scope-design.md` → `## Platform Design Token Policy [DESIGN]` and `## LLM Output Validation [DESIGN]`, triggered by a platform-token recommendation or a DEV handoff. Copy both literals verbatim — the bracketed suffix is part of the heading, and a prefix resolves to nothing. `agents/glass-atrium-intel-researcher.md` carries the precedent for that line.

## Readers, coupled tests, and operational constraints

- **No test and no code reads this file's TEXT**; nothing in `test/`, `hooks/test/`, `scripts/test/` or `autoagent/test/` quotes a literal from it.
- **Path-only consumers** break on a rename or a move out of `scoped/`, never on a content edit: `agent-registry.json` (`rules.scope`), `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP`, `scripts/agent_lifecycle/registry_ops.py`, `scripts/test/test_agent_lifecycle_overhaul.py`, and `manifest.json`.
- **Never diet the file to zero bytes**: `autoagent/daemon_cycle.py` → `_read_sections` emits SCOPE-FILE-EMPTY and directs a `C3: FAIL` verdict on an empty scope file.
- **Manifest**: this companion is a new file, so it must be `git add`-ed and the manifest regenerated before `scripts/generate-manifest.sh --check` is clean — the script's file list comes from `git ls-files`, so an untracked companion produces no row at all and the add must precede the regeneration.
