# Maintainer note — agents/glass-atrium-dev-android.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | sizes the turn-budget meter; not a free knob |
| `lib/ga-doctor.sh` → `get_integrity_drift` | live frontmatter identity keys (name, tools, scope) and text outside EDITABLE regions | a live edit to either is reported as drift, never blocked; repo-tree edits are outside it |
| `autoagent/autoagents-eval.sh` | frontmatter `name` / `description` validity, `skills:` list shape, English body | no heading is required: body headings are a ceiling, not a floor |
| `autoagent/lib/editable_merge.py` | EDITABLE region count, local vs release | a count change routes the merge to the manual structural-change ceremony |
| `autoagent/daemon_cycle.py` → `match_sensitive_diff` | added lines of any patch to this body | a dynamic-exec call form written with its paren routes the patch to safety |

- No suite reads this body's prose.
  - `hooks/test/inject-scope-rules-nodrop.bats` and `hooks/test/inject-scope-single-delivery.bats` read the real `maxTurns` for the meter.
  - `hooks/test/corpus/agents-blocklist/glass-atrium-dev-android.md` is a standalone fixture, not a copy of the body's frontmatter; a body edit does not reach it.
  - Other suites that name the agent use the name as roster or fixture data.

## Body text other files cite

- `## Pre-Execution Verification` **Motion**: `scoped/maintainers/shared-design-token-consumption.md` → `## Headings other files cite`.
- `## Pre-Execution Verification` **Structure**, for its Project Convention Probe pointer: `scoped/maintainers/scope-dev.md` → `## Inbound citations to the rule file`.

## Canonicals the body states no copy of

- host: `core-outcome-record.md` → Completion Report Output Obligation (plus the slot-1 emit-format block).
- host: `GLASS_ATRIUM_GLOBAL_RULES.md` → Thinking Budget Policy and 3-Tier Boundary.
  - One exception: Guardrails **New dependencies need user confirmation** restates the Confirm action for installing a dependency, naming the version catalog and build files.
- host: `core-security.md` → Execution Security (WebView JS interfaces, mobile process spawning) · Secret Management (BuildConfig) · Dependency Auditing.
- `rules.scope`: `scoped/scope-dev.md` → Ambiguity Gate and Project Convention Probe.
- `rules.shared`: `scoped/shared-comment-logging.md` (Platform-Specific Rules → Android among them) · `scoped/shared-testing.md` · `scoped/shared-naming.md`.
- slot 1: `AGENT-INJECT:BUDGET-DEV` carries the sizing rule, because this agent is on `BUDGET_DEV_AGENTS`, not a daemon carrier.
- The Success Criteria no-`completion_block` fallback stays: neither the Obligation nor the emit-format block states it.

## Decisions worth keeping

- **Motion bullet keeps the Compose mapping under its condition**: "only when the project carries `motion-philosophy.md`".
  - Without the condition the rule reads as binding every Android project; `scoped/shared-design-token-consumption.md` → Mandatory Pre-Execution Gate obliges the read only where the file exists.
  - Not a redundant mirror: `shared-design-token-consumption.md` reaches this agent through `rules.shared` but states no Compose `spring(...)` mapping.
  - Motion families read off that file's `## Motion Tokens`, never off another agent's selection.
- **Red Flags and Prohibitions intros**: name Guardrails as the owner and list only what has no Guardrails entry — the `agents/glass-atrium-dev-shell.md` shape, recorded in `scoped/maintainers/glass-atrium-dev-shell.md`.
