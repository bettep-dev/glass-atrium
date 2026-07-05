# Rule-to-Agent Compliance Matrix

## Loading Tiers

This file is the **single source of truth** for agent-to-rule loading policy. Scope files MUST NOT re-declare tier membership in prose — use the stanza header `> **Loading**: Tier 2 ...` and link here.

### Tier 1 — Core (ALL agents auto-load)

Every agent session loads these unconditionally:

- `agents/GLASS_ATRIUM_GLOBAL_RULES.md`
- `rules/core-git-workflow.md`
- `rules/core-learning-log.md`
- `rules/core-outcome-record.md`
- `rules/core-security.md`
- `rules/core-wiki-reference.md`

### Tier 2 — Scope (loaded when agent scope matches)

One scope file (or, exceptionally, a tightly coupled file pair like ORCHESTRATOR's `scope-orchestrator.md` + `orchestrator-role.md`) loads per agent based on its registered scope:

| File | Loads when `agent_scope =` |
|------|---------------------------|
| `scoped/scope-dev.md` | DEV |
| `scoped/scope-meta.md` | META |
| `scoped/scope-design.md` | DESIGN |
| `scoped/scope-research.md` | RESEARCH |
| `scoped/scope-planning.md` | PLANNING |
| `scoped/scope-report.md` | REPORT |
| `scoped/scope-qa.md` | QA |
| `scoped/scope-security.md` | SECURITY |
| `rules/scope-orchestrator.md` + `rules/orchestrator-role.md` | ORCHESTRATOR |
| `scoped/scope-wiki.md` | WIKI |

### Tier 3 — Cross-cutting (DEV-only inheritance)

Loaded **only** when the agent scope is DEV (plus one META exception, see note):

- `scoped/shared-comment-logging.md` — also loads for QA (review-side comment audit)
- `scoped/shared-performance.md`
- `scoped/shared-search-first.md`
- `scoped/shared-testing.md`
- `scoped/shared-type-safety.md`
- `scoped/shared-design-token-consumption.md` — UI-emitting DEV subset only (see note below)
- `rules/shared-self-improve-hygiene.md` — ORCHESTRATOR scope auto-load + autoagent-touching DEV subset only (see note below)
- `scoped/shared-hook-capability-contract.md` — hook-authoring DEV/QA reference (see note below)

**glass-atrium-meta-prompt-engineer exception (META)**: `glass-atrium-meta-prompt-engineer` — and only `glass-atrium-meta-prompt-engineer`, not `glass-atrium-meta-agent` — additionally loads 5 of the 8 Tier-3 files (`shared-comment-logging.md` · `shared-performance.md` · `shared-search-first.md` · `shared-testing.md` · `shared-type-safety.md` — the original cross-cutting set) because "prompts = code" (see `scope-meta.md` → "glass-atrium-meta-prompt-engineer: DEV Rule Inheritance"). The other 3 Tier-3 files are OUT of glass-atrium-meta-prompt-engineer scope: `shared-design-token-consumption.md` (UI-emission specific), `shared-self-improve-hygiene.md` (autoagent-pipeline specific), `shared-hook-capability-contract.md` (hook-authoring specific). `glass-atrium-meta-agent` loads Tier 1 + scope-meta.md only.

**QA exception**: QA scope (`glass-atrium-qa-code-reviewer`, `glass-atrium-qa-debugger`) loads Tier 1 + scope-qa.md + `shared-comment-logging.md` (single Tier-3 file, not the full set).

**design-token-consumption exception**: `shared-design-token-consumption.md` loads only for UI-emitting DEV agents (glass-atrium-dev-front · glass-atrium-dev-react · glass-atrium-dev-angular · glass-atrium-dev-android · glass-atrium-dev-gsap · glass-atrium-dev-animator). Backend / data / shell DEV agents (glass-atrium-dev-nestjs · glass-atrium-dev-node · glass-atrium-dev-python · glass-atrium-dev-db · glass-atrium-dev-rag · glass-atrium-dev-shell) do NOT emit UI markup; rule is structurally inapplicable. glass-atrium-dev-swift emits native SwiftUI (not web CSS/Tailwind design-token markup), so this web design-token rule is structurally inapplicable to it as well — same outcome as the backend/data/shell agents, different reason. See `scoped/shared-design-token-consumption.md` header for scope declaration.

**self-improve-hygiene exception**: `shared-self-improve-hygiene.md` loads automatically for ORCHESTRATOR scope (main session) + conditionally for DEV agents whose change scope touches `~/.glass-atrium/autoagent/` paths or the launchd self-improvement loop configuration (typically glass-atrium-dev-shell / glass-atrium-dev-python / glass-atrium-dev-node when modifying daemon-apply.sh / daemon_cycle.py / monitor `/api/improvement` routes). Other DEV agents do NOT load this rule (autoagent pipeline is out of scope for general feature work). See `rules/shared-self-improve-hygiene.md` header for scope declaration.

**comment-logging subagent injection**: tier MEMBERSHIP ≠ rule-TEXT delivery. The rows above declare which rules a scope *should* load, but spawned subagents only receive the `comment-logging` pointer token in their `> Rules:` header — not the rule body. `shared-comment-logging.md`'s core is now actively delivered to all DEV + QA agents at spawn time via the `~/.claude/hooks/inject-scope-rules.sh` SubagentStart hook, which extracts the `AGENT-INJECT` block (see `shared-comment-logging.md` → "## Agent Injection Core") and returns it as `hookSpecificOutput.additionalContext`. comment-logging is the **only Tier-3 rule** injected this way — every other Tier-3 rule remains pointer-referenced only (membership declared here, body not auto-injected into subagents). The same `inject-scope-rules.sh` hook ALSO injects THREE additional blocks via the same `extract_block()` → `additionalContext` path (NOT Tier-3 rules): the `AGENT-INJECT:STYLE-REF` and `AGENT-INJECT:MINIMALISM` blocks (both sourced from `scope-dev.md`, each to the DEV agents) and the `AGENT-INJECT:NAMING` block (sourced from the `glass-atrium-dev-naming` SKILL.md), whose `NAMING_AGENTS` roster is deliberately NARROWER — DEV minus glass-atrium-dev-swift plus glass-atrium-qa-code-reviewer, EXCLUDING glass-atrium-qa-debugger. The injected set is a **curated, deliberate allowlist** (these named blocks → these named agent lists), NOT an open-ended mechanism: any addition is a deliberate governance decision (like these were), never ad-hoc generalization to arbitrary rules or scopes.

## Precedence Resolution

- Conflict precedence: Tier 1 > Tier 2 > Tier 3.
- Within the same Tier: `core-security.md` overrides other ALL rules (security-first principle).
- Within Tier 2: conflicts are impossible — each agent loads exactly one scope file.
- Within Tier 3: the more conservative (restrictive) rule wins.
- Ambiguous interpretation: the relevant scope file's Absolute Rules section is the final authority.

## Scope Legend

> **New-agent doc-sync note**: the `agent_lifecycle` CLI auto-writes a created agent's file + `agent-registry.json` entry + (via reconcile) the `inject-scope-rules.sh` arrays, but the Scope Legend row + Compliance Matrix rows below are NOT auto-written — adding a new agent here is a separate post-creation doc update (see `scoped/scope-dev.md` → New-Agent Creation Gate doc-sync note).

| Scope | Agents |
|-------|--------|
| ALL | All agents |
| DEV | glass-atrium-dev-front, glass-atrium-dev-react, glass-atrium-dev-angular, glass-atrium-dev-gsap, glass-atrium-dev-android, glass-atrium-dev-nestjs, glass-atrium-dev-node, glass-atrium-dev-python, glass-atrium-dev-db, glass-atrium-dev-rag, glass-atrium-dev-animator, glass-atrium-dev-shell, glass-atrium-dev-swift |
| META | glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent |
| DESIGN | glass-atrium-design-designer |
| ~~DATA~~ | All DATA agents archived; scope inactive — see Archived Agents section |
| RESEARCH | glass-atrium-intel-researcher |
| PLANNING | glass-atrium-intel-planner |
| REPORT | glass-atrium-intel-reporter |
| QA | glass-atrium-qa-code-reviewer, glass-atrium-qa-debugger |
| SECURITY | glass-atrium-sec-guard |
| ORCHESTRATOR | Global agent / coordinator |
| WIKI | glass-atrium-wiki-curator |

## Compliance Matrix

| Rule File | ALL | DEV | META | DESIGN | RESEARCH | PLANNING | REPORT | QA | SECURITY | ORCHESTRATOR | WIKI |
|-----------|-----|-----|------|--------|----------|----------|--------|----|----------|--------------|------|
| GLASS_ATRIUM_GLOBAL_RULES.md | ✓ | | | | | | | | | | |
| scope-dev.md | | ✓ | | | | | | | | | |
| scope-meta.md | | | ✓ | | | | | | | | |
| scope-design.md | | | | ✓ | | | | | | | |
| scope-qa.md | | | | | | | | ✓ | | | |
| scope-orchestrator.md | | | | | | | | | | ✓ | |
| scope-planning.md | | | | | | ✓ | | | | | |
| scope-research.md | | | | | ✓ | | | | | | |
| scope-report.md | | | | | | | ✓ | | | | |
| scope-security.md | | | | | | | | | ✓ | | |
| scope-wiki.md | | | | | | | | | | | ✓ |
| shared-comment-logging.md | | ✓ | ✓† | | | | | ✓ | | | |
| shared-design-token-consumption.md | | ✓‡ | | | | | | | | | |
| shared-hook-capability-contract.md | | ✓¶ | ✓† | | | | | ✓ | | | |
| core-git-workflow.md | ✓ | | | | | | | | | | |
| core-learning-log.md | ✓ | | | | | | | | | | |
| orchestrator-role.md | | | | | | | | | | ✓ | |
| core-outcome-record.md | ✓ | | | | | | | | | | |
| shared-performance.md | | ✓ | ✓† | | | | | | | | |
| shared-search-first.md | | ✓ | ✓† | | | | | | | | |
| core-security.md | ✓ | | | | | | | | | | |
| shared-self-improve-hygiene.md | | ✓§ | | | | | | | | ✓ | |
| shared-testing.md | | ✓ | ✓† | | | | | | | | |
| shared-type-safety.md | | ✓ | ✓† | | | | | | | | |
| core-wiki-reference.md | ✓ | | | | | | | | | | |

> † META column: glass-atrium-meta-prompt-engineer ONLY (not glass-atrium-meta-agent). Per scope-meta.md "DEV Rule Inheritance" section, glass-atrium-meta-prompt-engineer inherits 5 of the 8 Tier-3 files — the original cross-cutting set (`shared-comment-logging.md` · `shared-performance.md` · `shared-search-first.md` · `shared-testing.md` · `shared-type-safety.md`) — because "prompts = code". glass-atrium-meta-agent does NOT inherit Tier 3. The 3 conditional Tier-3 files are OUT of glass-atrium-meta-prompt-engineer scope: `shared-design-token-consumption.md` (‡, UI-emission specific), `shared-self-improve-hygiene.md` (autoagent-pipeline specific), `shared-hook-capability-contract.md` (¶, hook-authoring specific) — none part of "prompts = code" inheritance.

> ‡ DEV column: UI-emitting subset only — glass-atrium-dev-front · glass-atrium-dev-react · glass-atrium-dev-angular · glass-atrium-dev-android · glass-atrium-dev-gsap · glass-atrium-dev-animator. Backend / data / shell DEV agents (glass-atrium-dev-nestjs · glass-atrium-dev-node · glass-atrium-dev-python · glass-atrium-dev-db · glass-atrium-dev-rag · glass-atrium-dev-shell) do NOT load this rule (rule is structurally inapplicable). glass-atrium-dev-swift (native SwiftUI, not web CSS/Tailwind) likewise does not load this web-token rule. See `scoped/shared-design-token-consumption.md` header for scope declaration.

> § DEV column: autoagent-touching subset only — DEV agents whose change scope includes `~/.glass-atrium/autoagent/` paths or self-improvement launchd configuration (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node when modifying daemon-apply.sh / daemon_cycle.py / monitor `/api/improvement` routes). General feature-work DEV agents do NOT load this rule. ORCHESTRATOR scope (main session) auto-loads unconditionally. See `rules/shared-self-improve-hygiene.md` header for scope declaration.

> ¶ DEV + QA columns: hook-authoring reference only — DEV agents that write/modify hooks under `~/.claude/hooks/` (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node) + QA agents that review hook changes (glass-atrium-qa-code-reviewer) or analyze hook failures (glass-atrium-qa-debugger). Structurally parallel to `shared-comment-logging.md` (DEV+QA cross-cutting). META (‡-style `✓†`) = glass-atrium-meta-prompt-engineer ONLY per "prompts = code" Tier-3 inheritance; glass-atrium-meta-agent does NOT load it. NOT loaded by ALL / ORCHESTRATOR (orchestrator delegates hook work, does not author hooks). See `scoped/shared-hook-capability-contract.md` header for scope declaration.

> QA only loads shared-comment-logging.md from Tier 3, not the full set. See core-compliance-matrix.md QA exception note.

## Skills Registry (Reference)

SKILL.md files under `~/.claude/skills/` are outside this matrix's jurisdiction.
- Skills load globally at session start regardless of agent scope; Claude decides whether to invoke each one based on its SKILL.md `description` field.
- Adding / removing skills does NOT require updating this matrix.
- Exception: when a specific scope must restrict skill usage → record it in `scope-{name}.md` under a "Prohibited Skills" section.

---

## Archived Agents

Agents in `~/.claude/agents/archive/` are excluded from all active scope rows above. They retain their original rule references internally but are NOT subject to registry routing or compliance enforcement until reactivated.

(No agents currently archived.)
