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
| `autoagent/lib/editable_merge.py` | EDITABLE region count, local vs release | a count change routes the merge to the manual structural-change ceremony |
| `autoagent/daemon_cycle.py` → `match_sensitive_diff` | added lines of any patch to this body | a dynamic-exec call form written with its paren routes the patch to safety |

- No suite reads this body's prose; the autoagent and scripts tests that name this agent use its name or path as fixture data.

## Body text other files cite

- `## Pre-Execution Verification` **Motion** — listed in `scoped/maintainers/shared-design-token-consumption.md` → `## Headings other files cite`.
- `## Pre-Execution Verification` **Structure**, for its `scoped/scope-dev.md` → Project Convention Probe pointer — listed in `scoped/maintainers/scope-dev.md` → `## Inbound citations to the rule file`.
- The Red Flags and Prohibitions intros name Guardrails as the owner and list only what has no Guardrails entry — the `agents/glass-atrium-dev-shell.md` shape, recorded in `scoped/maintainers/glass-atrium-dev-shell.md`.

## Canonicals the body states no copy of

- host: `core-outcome-record.md` → Completion Report Output Obligation (plus the slot-1 emit-format block) · `GLASS_ATRIUM_GLOBAL_RULES.md` → Thinking Budget Policy and 3-Tier Boundary (installing a dependency is a Confirm action).
- host: `core-security.md` → Execution Security (WebView JS interfaces, process spawning in mobile apps), Secret Management (BuildConfig, no secrets in logs) and Dependency Auditing (license and security history of a new dependency).
- `rules.scope`: `scoped/scope-dev.md` → Ambiguity Gate and Project Convention Probe.
- `rules.shared`: `scoped/shared-comment-logging.md` (why-only comments, TODO form, log levels, empty-catch, Platform-Specific Rules → Android) · `scoped/shared-testing.md` · `scoped/shared-naming.md`.
- slot 1: this agent is on `BUDGET_DEV_AGENTS`, not a daemon carrier, so `AGENT-INJECT:BUDGET-DEV` carries its sizing rule and the body states none.
- The Success Criteria no-`completion_block` fallback stays: neither canonical states it.

## Decisions worth keeping

- **Naming subordination**: the body names no naming axis; Pre-Execution Verification → **Structure** points at `scoped/scope-dev.md` → Project Convention Probe.
  - The probe points at `scoped/shared-search-first.md` → **Step 3 — Mirror** for the mirrored code-form axes; identifier form follows `scoped/shared-naming.md`.
- **Anti-slop bullet is an on-demand Read**: the designer body is not in this agent's context, so the bullet instructs a Read of that path rather than citing a file the agent never receives.
- **Motion bullet keeps the Compose mapping under its condition** — `spring(stiffness, dampingRatio)` over ad-hoc constants, led by "only when the project carries `motion-philosophy.md`".
  - The condition stays in the lead: without it the rule reads as binding every Android project, while `scoped/shared-design-token-consumption.md` → Mandatory Pre-Execution Gate proceeds on framework defaults when no motion file exists.
  - `shared-design-token-consumption.md` reaches this agent through `rules.shared`; the bullet is not a redundant mirror, because the rule file states no Compose `spring(...)` mapping.
  - The spring families read off that file's Motion Tokens section, never off another agent's selection.
- **Security holds the Android-only residue**: Intent / deep-link validation, `android:exported` and permissions, Keystore storage; the mobile-app clauses already in `core-security.md` are not restated.
