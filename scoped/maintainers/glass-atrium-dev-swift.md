# Maintainer note — agents/glass-atrium-dev-swift.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Frontmatter `skills:` key

The key reads `skills: []` — no skill is preloaded. The naming canon reaches this body through `scoped/shared-naming.md` membership, not a preload.

Placement facts, each deliberate:

- **The insertion anchors on the `maxTurns:` line, never on `tools:`.**
  - `hooks/enforce-harness-critical.sh` blocks any live-install write that touches an `agents/*.md` frontmatter identity key — name, tools, scope — for every caller, agent-id-independent (LLM06; `core-security.md` → Agent Tool Authorization → Enforcement boundary).
  - An edit whose anchor string overlaps the `tools:` line risks tripping it.
  - `skills:` is not a frozen identity key.
  - The same hook also reacts to a change in the frontmatter fence-line count, which stays at two.
- **`skills:` is not local-only.** `autoagent/lib/editable_merge.py` keeps `model` as the local-only frontmatter key and treats `effort` as base-aware; `skills:` is in neither set, so a repo-added key propagates to live installs through the ordinary update path.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | the turn-budget meter is sized from it |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys + fence-line count | see above |
| `autoagent/autoagents-eval.sh` | frontmatter `name` / `description`, a well-formed `skills:` list, English body | a malformed `skills:` list is an eval FAIL condition; headings are a ceiling, not a floor |

## What moved out of the body, and why

- **Secrets and signing credentials** — the no-hardcoding rule is `core-security.md` → Secret Management (host-delivered); the Guardrails bullet keeps only the Keychain / env delta.
- **Comment and logging rules** — `scoped/shared-comment-logging.md` (part slots); Self-Review keeps the Swift residue: the `os.Logger` privacy-redaction form, no shipped `print`.
  - Sensitive-data logging duty, cut from Self-Review: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Absolute Rules [ALL]` (`When logging, sensitive info in logs MUST be masked`) and `core-security.md` → Secret Management; `scoped/shared-comment-logging.md` carries no such rule.
- **`## Red Flags` and `## Prohibitions`** — removed: each item restated a rule this body keeps. The unconfirmed-API-claim item is the charter's `### Verified References`.
- **Self-Review rule restatements and the Success Criteria triple** — Self-Review names the rule sections and lists only what they do not state; Success Criteria points at Self-Review.
- **Completion format** — `core-outcome-record.md` → Completion Report Output Obligation (host-delivered) and the slot-1 emit-format block; no suite reads a DEV body's emit text.
  - Kept in the body: the fallback for a schema declaring no `completion_block`, which neither canonical states.
- **Package provenance** — `core-security.md` → Dependency Auditing (host).

## Decisions worth keeping

- **Naming subordination**: the Project Convention Probe bullet under Pre-Execution Verification names the probe, which is delivered through `scoped/scope-dev.md`.
  - The probe points at `scoped/shared-search-first.md` → **Step 3 — Mirror** for the mirrored code-form axes; identifier form follows `scoped/shared-naming.md`.
  - The line adds only the Swift isolation-style axis.
  - It sits outside every editable region.
