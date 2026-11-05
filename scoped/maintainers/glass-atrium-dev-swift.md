# Maintainer note — agents/glass-atrium-dev-swift.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Frontmatter `skills:` key

- `skills: []` preloads no skill: the naming canon reaches this agent through `scoped/shared-naming.md` membership (`rules.shared`).
- **`skills:` is not local-only.** `autoagent/lib/editable_merge.py` → `_LOCAL_ONLY_FRONTMATTER_KEYS` and `_BASE_AWARE_FRONTMATTER_KEYS` both omit it, so a repo-added key propagates to live installs through the ordinary update path.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | the turn-budget meter is sized from it |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys (name, tools, scope) and the fence-line count | a live edit changing either is blocked for every caller (LLM06) |
| `autoagent/autoagents-eval.sh` | frontmatter `name` / `description`, a well-formed `skills:` list, English body | a malformed `skills:` list is an eval FAIL condition; headings are a ceiling, not a floor |

## What moved out of the body, and why

Restatements of rules the agent already receives — do not re-add them:

| Removed from the body | Canonical that reaches the agent |
|---|---|
| no-hardcoding clause of the secrets Guardrail, and any `## Security` copy; the Keychain / env delta stays | `core-security.md` → Secret Management (host) |
| SPM package-provenance clause | `core-security.md` → Dependency Auditing (host) |
| Self-Review comment and TODO rules; `os.Logger` redaction, no shipped `print`, no logged sensitive data stay | `scoped/shared-comment-logging.md` (`rules.shared`) |
| Success Criteria emit-mode table and notes; the no-`completion_block` fallback stays, as neither canonical states it | `core-outcome-record.md` → Completion Report Output Obligation (host), plus the slot-1 emit-format block |

## Decisions worth keeping

- **Naming subordination**: Pre-Execution Verification → **Project structure** points at `scoped/scope-dev.md` → Project Convention Probe, leaving the mirrored axes to `scoped/shared-search-first.md` → **Step 3 — Mirror** and identifier form to `scoped/shared-naming.md`.
  - The line adds only the Swift isolation-style axis.
- **`@unchecked Sendable` in Red Flags** — a scan target there, and not a duplicate of the Error Recovery item, which forbids silencing a strict-concurrency diagnostic with it.
