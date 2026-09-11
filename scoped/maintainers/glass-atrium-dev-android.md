# Maintainer note — agents/glass-atrium-dev-android.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 of the frontmatter | the turn-budget meter is sized from it; it is machine-read, not a free knob |
| `hooks/enforce-harness-critical.sh` | live-install `agents/*.md` frontmatter identity keys (name, tools, scope) and the fence-line count | a live edit changing an identity key or the fence count is blocked for every caller (LLM06); repo-tree edits are out of its path scope |
| `autoagent/autoagents-eval.sh` | frontmatter `name` / `description` validity, a `skills:` key's list shape, English body | body headings are explicitly a ceiling, not a floor — no heading is required |

## What moved out of the body, and why

- **Effort/thinking blockquote** — restated `GLASS_ATRIUM_GLOBAL_RULES.md` → Thinking Budget Policy, a Tier-1 rule that measurably reaches every subagent. Duplicate, and its tail ("no re-declaration here") was maintainer prose.
- **Mobile UX source-of-truth blockquote** — pointed at another agent's body for "conceptual rules". It named where rules live rather than obliging anything; the Compose mapping under that heading is self-sufficient.
- **`## Architecture Validation`** — every clause restated Design Principles (layer roles, mixing prohibition, boundary conversion, no circular deps). The one non-duplicated fact, the per-layer membership list, was folded into Pre-Execution Layer Validation, which already names the same chain.
- **Comment / TODO restatements** in Self-Review and Red Flags — the comment-rule core is injected into every DEV subagent and owns why-only comments, the TODO owner/ticket form, log levels and the production-logger rule. The Android residue the core does not carry (Timber, Crashlytics, the R8 strip, empty catch, log+rethrow) stayed.
- **Security bullets on WebView JS interfaces, process spawning and secret logging** — `core-security.md` is Tier-1, arrives at spawn, and already states all three in mobile-app terms. The Android-only residue (Intent / deep-link validation, Keystore storage) stayed.
- **Guardrails items re-listed under Red Flags and Prohibitions** — both sections now name Guardrails as the owner and list only what has no Guardrails entry, the shape `agents/glass-atrium-dev-shell.md` already uses.

## Decisions worth keeping

- **Naming subordination (this wave)**: the Project Convention Probe line under Pre-Execution Verification is the single site in this body that names a naming axis. It now mirrors import order, error handling and layout from the sibling, and subordinates identifier naming to the `glass-atrium-dev-naming` canon. Before this change the mirror silently won over the canon, because the probe listed naming among the mirrored axes and no delivered text said otherwise.
- **Anti-slop guardrail kept, made actionable**: it cited a file the agent never receives, which obliges the unreachable. Rather than drop a live duty, the bullet now instructs an on-demand Read of that path and says the file is not in context.
- **Motion bullet is conditional and states its condition** — it fires only when the project carries the motion-philosophy document, and the spring-family requirement now reads off that document rather than off another agent's selection.
