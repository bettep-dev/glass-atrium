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

Each counterpart is present in `agents/glass-atrium-design-designer.md`:

- **`**No AI-generated aesthetics**` font list** → `### AI Slop Tropes (forbidden patterns — Single SoT for all DEV agents)` carries `Overused fonts: Inter · Roboto · Arial · Fraunces · generic system fonts`.
  - `### Typography` additionally resolves the fallback-versus-primary subtlety the scope-file line lacked.
  - A fallback face is a rendering substitute; selecting one as a primary is the trope.
- **Vendor-routing sane-default and cross-vendor-parity bullets** → `### Figma Make + MCP Integration Guardrails` carries `Vendor-Routing: Figma is the default design tool; do NOT assume Sketch / XD parity in design specs.` Only the routing-rationale bullet had no counterpart, so only it survives in the rule file.
- **`Verify no prohibited fonts`** in the handoff checklist → the same AI Slop Tropes line.
- **The WCAG AA ratios** → `## Pre-Execution Verification` pins `WCAG AA (4.5:1 text · 3:1 large-text ≥18pt) verified · AAA (7:1) recommended`.
  - `## Red Flags` → **Color & contrast** carries the derive-then-verify obligation.
  - The rule file keeps a bare one-line contrast item with no numbers; the next section says why the item stays.

## Why the contrast item was kept despite being a duplicate

The item's section, `## LLM Output Validation`, is cited by name, once specifically for contrast:

- `skills/glass-atrium-design-contrast-check/SKILL.md` describes it as the contrast verification gate before downstream DEV handoff.
- `skills/glass-atrium-design-md-lint/SKILL.md` describes it as the pre-emit gate family that lint joins.
- `agents/glass-atrium-design-designer.md` → `### Figma Make + MCP Integration Guardrails` says LLM Output Validation applies to auto-generated layouts.

Deleting the item would leave the contrast-check skill describing a section that no longer contains what it names. The numbers are gone; the anchor stays.

## Headings and their citers

| Heading | Cited from |
|---|---|
| `Absolute Rules` | nothing cites it by name — kept because the heading names the content beneath it |
| `Platform Design Token Policy` | `scoped/maintainers/shared-design-token-consumption.md` → Cross-references |
| `LLM Output Validation` | the two design skills and the designer body named in the section above · `scoped/maintainers/shared-design-token-consumption.md` |
| `Vendor-Routing Awareness` | nothing cites this file's copy; `scoped/scope-dev.md` has its own same-named section |
| `CQRS Exception` | nothing; this file is a citER of `scoped/scope-meta.md` → `## CQRS Exception`, not a citee |

## Stale material removed

- **Loading stanza** (`> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {glass-atrium-design-designer}` plus `> **Inherits**` and `> **See**`) and the `Rules specific to DESIGN agents` line. The stanza described a selection mechanism that does not select this file; no roster parser reads a brace list outside `scoped/scope-dev.md`, so removing it costs no machine reader.

## Delivery — what actually reads this file

- `scoped/scope-design.md` is glass-atrium-design-designer's `rules.scope` in `agent-registry.json`, so the SubagentStart part slots (`hooks/inject-scope-part-*.sh` → `hooks/lib/inject_chunk.py`) carry it whole to that agent. No other agent row names it.
- The platform token policy is the file's most exposed content: its three platform facts (Material Web in maintenance mode, M3 Expressive via Compose, HIG semantic-role tokens) appear nowhere in the designer body, so this file is their only delivered copy.

## Readers, coupled tests, and operational constraints

- **No test and no code reads this file's TEXT**; nothing in `test/`, `hooks/test/`, `scripts/test/` or `autoagent/test/` quotes a literal from it.
- **Path-only consumers** break on a rename or a move out of `scoped/`, never on a content edit: `agent-registry.json` (`rules.scope`), `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP`, `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_RULE_FILES`, and `manifest.json`.
- **Never diet the file to zero bytes**: `autoagent/daemon_cycle.py` → `SCOPE_EMPTY_SIGNAL` (`SCOPE-FILE-EMPTY`) directs a `C3: FAIL` verdict on an empty scope file.
- **Manifest**: `manifest.json` carries a sha256 row for this note as well as for the rule file, so an edit to either needs a manifest regeneration — a whole-tree barrier step, not a content pin.
