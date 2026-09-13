# Maintainer note — agents/glass-atrium-dev-swift.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Frontmatter `skills:` key

The key reads `skills: []` — no skill is preloaded. The naming canon reaches this body through `scoped/shared-naming.md` membership, not a preload.

Two placement facts, both deliberate:

- **The insertion anchors on the `maxTurns:` line, never on `tools:`.** `hooks/enforce-harness-critical.sh` blocks any live-install write that touches an `agents/*.md` frontmatter identity key — name, tools, scope — for every caller, agent-id-independent (LLM06; `core-security.md` → Agent Tool Authorization → Enforcement boundary). An edit whose anchor string overlaps the `tools:` line risks tripping it. `skills:` is not a frozen identity key. The same hook also reacts to a change in the frontmatter fence-line count, which stays at two.
- **`skills:` is not local-only.** `autoagent/lib/editable_merge.py` keeps `model` as the local-only frontmatter key and treats `effort` as base-aware; `skills:` is in neither set, so a repo-added key propagates to live installs through the ordinary update path.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | the turn-budget meter is sized from it |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys + fence-line count | see above |
| `autoagent/autoagents-eval.sh` | frontmatter `name` / `description`, a well-formed `skills:` list, English body | a malformed `skills:` list is an eval FAIL condition; headings are a ceiling, not a floor |

## What moved out of the body, and why

- **Tech Stack prose run** — became a table; no fact dropped, the reader no longer parses one long middot chain.
- **Secrets and signing credentials** — the no-hardcoding rule is `core-security.md` → Secret Management (host-delivered). The Guardrails bullet keeps only the Keychain / env delta and names that canonical; `## Security` carries no copy.
- **Comment / TODO restatements in Self-Review** — the comment-rule core is delivered to every DEV subagent through `scoped/shared-comment-logging.md` membership (part slots). The Swift residue (the `os.Logger` privacy-redaction form, no shipped `print`, no sensitive data logged) stayed.
- **Red Flags and Prohibitions items already stated as Guardrails MUST NOTs** — both sections name Guardrails as the owner and list only the residue, the same shape as the dev-shell body.
- **Emit instructions under Success Criteria** — the emit-mode table and its notes restated `core-outcome-record.md` → Completion Report Output Obligation, which is host-delivered and also compressed into the slot-1 emit-format block. One pointer line remains; no suite reads a DEV body's emit text.
- **In-file repeats in the editable regions** — the Work Rules Concurrency and SPM bullets, the `@Published` / main-actor / `[weak self]` repeats under Design Principles, and "keep `body` small" each restated a Guardrails bullet or a Design Principles line that stays.
- **SPM confirmation under Pre-Execution Verification** — the Guardrails bullet owns it; the line keeps the `Package.swift` + `Package.resolved` check.

## Decisions worth keeping

- **Naming subordination**: the Project Convention Probe line under Pre-Execution Verification points at `scoped/scope-dev.md` → Project Convention Probe, which carries the mirrored axes (import order, error+log, layout) and subordinates identifier naming to the naming canon. The line adds only the Swift isolation-style axis. It sits outside every editable region.
- **`@unchecked Sendable` added to Red Flags** — the Error Recovery region already forbade silencing a strict-concurrency diagnostic with it, but nothing listed it as a scan target.
