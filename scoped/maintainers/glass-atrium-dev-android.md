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
- **Comment, TODO and logging restatements** in Self-Review and Red Flags — `scoped/shared-comment-logging.md` reaches this row through `rules.shared`.
  - It owns why-only comments, the TODO form, log levels, the empty-catch and log+rethrow prohibitions, and Platform-Specific Rules → Android (Timber, Crashlytics, the R8 strip).
  - Only the ProGuard/R8 keep-rules check for reflection classes stayed, under Self-Review → **Release build**.
- **Guardrails restated in Design Principles and Work Rules** — the layer-mixing and GlobalScope/runBlocking `MUST NOT` lines were cut there, so the Prohibitions claim that Guardrails states each `MUST NOT` once holds.
- **Project Convention Probe and Motion detail** — the probe's axes and naming precedence live in `scoped/scope-dev.md` → Project Convention Probe; the motion-philosophy condition and the spring families live in `scoped/shared-design-token-consumption.md` (Mandatory Pre-Execution Gate, Motion Tokens). Both files reach this row, so the body keeps only its Kotlin/Compose delta.
- **FINAL STEP emit block and its mode table** — restated `core-outcome-record.md` → Completion Report Output Obligation (host-delivered), plus the slot-1 emit-format block; reduced to a one-line pointer.
- **Security bullets on WebView JS interfaces, process spawning and secret logging** — `core-security.md` is Tier-1, arrives at spawn, and already states all three in mobile-app terms. The Android-only residue (Intent / deep-link validation, Keystore storage) stayed.
- **Guardrails items re-listed under Red Flags and Prohibitions** — both sections now name Guardrails as the owner and list only what has no Guardrails entry, the shape `agents/glass-atrium-dev-shell.md` already uses.

## Decisions worth keeping

- **Naming subordination**: the body names no naming axis. Pre-Execution Verification → **Structure** keeps "Glob the target module" and points at `scoped/scope-dev.md` → Project Convention Probe, which takes code form from the sibling and identifier naming from the `scoped/shared-naming.md` canon.
- **Anti-slop guardrail kept, made actionable**: the designer body is not in this agent's context, so the bullet instructs an on-demand Read of that path and says so, rather than citing a file the agent never receives.
- **Motion bullet keeps only the Compose mapping** — `spring(stiffness, dampingRatio)` and the ad-hoc-constant ban; the condition and the families read off `scoped/shared-design-token-consumption.md`, never off another agent's selection.
