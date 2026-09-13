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

## Roster work this body does NOT carry

Membership in the naming INJECTION roster is separate from `scoped/shared-naming.md` membership. Adding this agent to that roster is a multi-file change owned by another track of this wave: the injector's roster array and header comments, `scripts/agent_lifecycle/inject_sync.py`'s naming-exclusion set and docstrings, the second functional exclusion set in `orphan_scan.py`, `readers.py` docstrings, the lifecycle roster comment in `add.py`, the roster prose in `rules/glass-atrium/core-compliance-matrix.md` (corrected, never deleted — a suite enumerates roster declarations from code and requires each to be named in the live matrix), and four absence-asserting suites that must be inverted together with their comments. Byte headroom is the binding constraint there, not here: this body is not injected, so its length costs install bytes only.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | the turn-budget meter is sized from it |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys + fence-line count | see above |
| `autoagent/autoagents-eval.sh` | frontmatter `name` / `description`, a well-formed `skills:` list, English body | a malformed `skills:` list is an eval FAIL condition; headings are a ceiling, not a floor |

## What moved out of the body, and why

- **Tech Stack prose run** — became a table; no fact dropped, the reader no longer parses one long middot chain.
- **"Never hardcode secrets or signing credentials" under `## Security`** — stated twice in one file; the Guardrails bullet owns it.
- **Comment / TODO restatements in Self-Review** — the comment-rule core is injected into every DEV subagent. The Swift residue (the `os.Logger` privacy-redaction form, no shipped `print`, no sensitive data logged) stayed.
- **Red Flags and Prohibitions items already stated as Guardrails MUST NOTs** — both sections now name Guardrails as the owner and list only the residue, the shape `agents/glass-atrium-dev-shell.md` already uses.

## Decisions worth keeping

- **Naming subordination (this wave)**: the Project Convention Probe line under Pre-Execution Verification is the single site naming a naming axis. It mirrors import order, isolation style and error handling from the sibling and subordinates identifier naming to the `scoped/shared-naming.md` canon. Both that line and the body's other edits sit outside every editable region, so no merge seam is involved.
- **`@unchecked Sendable` added to Red Flags** — the Error Recovery region already forbade silencing a strict-concurrency diagnostic with it, but nothing listed it as a scan target.
