# Maintainer note — `rules/glass-atrium/core-security.md`

- Corpus-maintenance companion to that Tier-1 rule file: the rule file reaches every agent on the host channel; this note reaches none.
- Read it before editing the rule file or building a runtime per-agent tool-grant layer.
- Do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no stub heading and no pointer to this note.

## Coupled readers

- No test reads the rule file's body text; `scripts/test/startup-budget.bats` counts its chars toward the startup budget.
- Renaming the file is a multi-site edit: grep `core-security.md` across the repo and read every hit.
  - Most hits hold the path as their own data (a fixture row, a comment), so a rename can leave them green but stale.
  - `monitor/test/architecture.governance-membership.unit.test.ts` reads the real compliance matrix and asserts it declares the path.
  - `scripts/fixtures/retired-seed.json` holds the retired `rules/core-security.md` path, not the current one.
- Cited phrases — grep the corpus before rewording one:
  - "High-impact actions": `autoagent/daemon_cycle.py`, `autoagent/daemon-apply.sh`, and `rules/glass-atrium/core-learning-log.md` (the Tier-2 trigger reuses the definition).
  - **Prompt Injection Refusal**: `rules/glass-atrium/core-wiki-reference.md` → its untrusted-data clause, which is machine-extracted; `skills/glass-atrium-ops-orchestrator.md` → `### Prompt Injection Gate [LLM01:2025]`.
  - `## Secret Management`, `## Input Validation`, `## Execution Security`, `## Dependency Auditing`, `## OWASP Top 10`, `## Prompt & Tool Input Security [LLM01:2025]`: code comments, skills, agent bodies and other maintainer notes.
  - `## Agent Tool Authorization [LLM06:2025]` → `### Enforcement boundary`, Unbounded consumption: code comments, skills and other maintainer notes.
  - Inline `[LLMxx:2025]` tags: cited bare from agent bodies, skills, hook and daemon comments, so each of the ten stays at its rule.
- Canonical + mirror: `### Enforcement boundary` → protected surfaces restate `hooks/enforce-harness-critical.sh` → its header list; change them together.

## Runtime per-agent tool-grant layer — why it is not built

- The rule file keeps only the not-implemented lead, as its honest backing; the rationale and the entry gate live here because no agent acts on them.
- Not because the caller is unidentifiable: the caller's `agent_type` is recoverable at pre-tool time from the `agent-<agent_id>.meta.json` sidecar, even though the `tool_use` envelope carries only an opaque `agent_id`.
  - `hooks/block-doc-routing-leak.sh` blocks on it; `hooks/advisory-subagent-budget.sh` only records it on its overage row.
- That recovery fails open (missing sidecar / unresolved anchor / absent `jq` → empty type → the call proceeds), so a layer built on it is detective, never preventive.
  - The one blocking use is a single hardcoded file-routing rule keyed on two agent types, not a per-agent tool-grant allowlist.
- Deferred, not impossible: the entry gate is a measurement of sidecar-resolution success across real spawns, which does not exist yet.

## Restructure + diet pass — dispositions

- Input Validation: the command/query/dynamic-code ban keeps its exact wording — it is a security absolute.
  - Rewording it needs an owner ruling written into the plan and a security review of the new wording covering argv/option injection.
  - Flag, unresolved (의미 상충): read literally, "based on user input" bans every query that carries user input, which conflicts with `SQL raw queries → parameterized binding is REQUIRED`.
- Caps: constraint modals (MUST, REQUIRED, FORBIDDEN, STRICTLY FORBIDDEN) stay.
  - The protected-surfaces sub-bullets keep their capitals (`AND`, `NEW`): harness-path text is a fragile operation, so its wording stays.
- `## Secret Management` keeps its wording: secrets is a fragile operation.
  - Recorded pair: its read ban, handoff ban and masking line overlap `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `## Absolute Rules [ALL]`.
  - Classed canonical + mirror: the rule file is the security canonical that overrides the other ALL rules.
