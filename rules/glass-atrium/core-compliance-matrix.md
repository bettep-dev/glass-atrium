# Rule-to-Agent Compliance Matrix

## Loading Tiers

This file is the **single source of truth** for agent-to-rule loading policy. Scope files MUST NOT re-declare tier membership in prose — use the stanza header `> **Loading**: Tier 2 ...` and link here.

Machine-read structure — `hooks/validate-compliance-matrix.sh` parses this live file at SessionStart and exits 2 on a confirmed mismatch, checking the Tier-1 Core list against the ALL column, each conditional-exception footnote marker used in a table cell against its one blockquote definition, and every Compliance Matrix column header against the Scope Legend scopes, so a dropped Tier-1 bullet, an orphaned footnote definition or a removed legend row breaks it (the accompanying Bats suite drives temp-dir fixtures and would not catch a live edit).

Machine-read path spellings — `monitor/src/server/architecture/governance-membership.ts` treats every document path this file writes in inline code as a declared document and reports it as absent when no such file exists, so an illustrative or placeholder path in that form must never be written here; the live-file guard for that extraction is `monitor/test/architecture.governance-membership.unit.test.ts`, which runs under the node test runner rather than the bats runner.

### Tier 1 — Core (ALL agents auto-load)

Every agent session loads these unconditionally:

- `agents/GLASS_ATRIUM_GLOBAL_RULES.md`
- `rules/glass-atrium/core-git-workflow.md`
- `rules/glass-atrium/core-learning-log.md`
- `rules/glass-atrium/core-outcome-record.md`
- `rules/glass-atrium/core-security.md`
- `rules/glass-atrium/core-wiki-reference.md`

### Tier 2 — Scope (loaded when agent scope matches)

The table below assigns one scope file per scope. This is a MEMBERSHIP statement — which rules govern that scope — and NOT a claim that the file reaches the agent. Exceptionally a tightly coupled file pair is assigned instead, as for ORCHESTRATOR (`scope-orchestrator.md` + `orchestrator-role.md`):

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
| `rules/glass-atrium/scope-orchestrator.md` + `rules/glass-atrium/orchestrator-role.md` | ORCHESTRATOR |
| `scoped/scope-wiki.md` | WIKI |

**No code selects a scope file by agent** (measured 2026-09-10): no `agents/*.md` frontmatter carries a `scope:` key and `agent-registry.json` carries no scope field, so nothing at spawn time resolves a row above to a file. The only agent→scope-file map in the tree is the one `autoagent/daemon_cycle.py` uses to excerpt a scope file into the daemon's rule-improvement verify prompt, and no spawn path reads it. What a running agent actually holds is `### Membership vs. Delivery (per tier)` below — read it before relying on a row here.

### Tier 3 — Cross-cutting (DEV-only inheritance)

Loaded **only** when the agent scope is DEV (plus one META exception, see note):

- `scoped/shared-comment-logging.md` — also loads for QA (review-side comment audit)
- `scoped/shared-performance.md`
- `scoped/shared-search-first.md`
- `scoped/shared-testing.md`
- `scoped/shared-type-safety.md`
- `scoped/shared-design-token-consumption.md` — UI-emitting DEV subset only (see note below)
- `rules/glass-atrium/shared-self-improve-hygiene.md` — ORCHESTRATOR scope auto-load + autoagent-touching DEV subset only (see note below)
- `scoped/shared-hook-capability-contract.md` — hook-authoring DEV/QA reference (see note below)

**glass-atrium-meta-prompt-engineer exception (META)**: `glass-atrium-meta-prompt-engineer` — and only `glass-atrium-meta-prompt-engineer`, not `glass-atrium-meta-agent` — additionally loads 5 of the 8 Tier-3 files.

- The 5 it loads are the original cross-cutting set: `shared-comment-logging.md` · `shared-performance.md` · `shared-search-first.md` · `shared-testing.md` · `shared-type-safety.md`. It loads them because "prompts = code" (see `scope-meta.md` → "glass-atrium-meta-prompt-engineer: DEV Rule Inheritance").
- The other 3 Tier-3 files are OUT of glass-atrium-meta-prompt-engineer scope: `shared-design-token-consumption.md` (UI-emission specific), `shared-self-improve-hygiene.md` (autoagent-pipeline specific), `shared-hook-capability-contract.md` (hook-authoring specific).
- `glass-atrium-meta-agent` loads Tier 1 + scope-meta.md only.

**QA exception**: QA scope (`glass-atrium-qa-code-reviewer`, `glass-atrium-qa-debugger`) loads Tier 1 + scope-qa.md + `shared-comment-logging.md` (single Tier-3 file, not the full set).

**design-token-consumption exception**: `shared-design-token-consumption.md` loads only for UI-emitting DEV agents.

- The UI-emitting DEV agents are glass-atrium-dev-front · glass-atrium-dev-react · glass-atrium-dev-angular · glass-atrium-dev-android · glass-atrium-dev-gsap · glass-atrium-dev-animator.
- Backend / data / shell DEV agents (glass-atrium-dev-nestjs · glass-atrium-dev-node · glass-atrium-dev-python · glass-atrium-dev-db · glass-atrium-dev-rag · glass-atrium-dev-shell) do NOT emit UI markup; rule is structurally inapplicable.
- glass-atrium-dev-swift emits native SwiftUI (not web CSS/Tailwind design-token markup), so this web design-token rule is structurally inapplicable to it as well.
- See `scoped/shared-design-token-consumption.md` header for scope declaration.

**self-improve-hygiene exception**: `shared-self-improve-hygiene.md` loads automatically for ORCHESTRATOR scope (main session) + conditionally for a DEV subset.

- The conditional DEV subset is those DEV agents whose change scope touches `~/.glass-atrium/autoagent/` paths or the launchd self-improvement loop configuration (typically glass-atrium-dev-shell / glass-atrium-dev-python / glass-atrium-dev-node when modifying daemon-apply.sh / daemon_cycle.py / monitor `/api/improvement` routes).
- Other DEV agents do NOT load this rule (autoagent pipeline is out of scope for general feature work).
- See `rules/glass-atrium/shared-self-improve-hygiene.md` header for scope declaration.

**comment-logging subagent injection**: tier MEMBERSHIP ≠ rule-TEXT delivery.

- The rows above declare which rules a scope *should* load, but spawned subagents only receive the `comment-logging` pointer token in their `> Rules:` header — not the rule body.
- `shared-comment-logging.md`'s core is actively delivered to all DEV + QA agents at spawn time via the `~/.glass-atrium/hooks/inject-scope-rules.sh` SubagentStart hook, which extracts the `AGENT-INJECT` block (see `shared-comment-logging.md` → "## Agent Injection Core") and returns it as `hookSpecificOutput.additionalContext`.
- comment-logging is the **only Tier-3 rule** injected this way — every other Tier-3 rule remains pointer-referenced only (membership declared here, body not auto-injected into subagents).

The same `inject-scope-rules.sh` hook ALSO injects SIX additional blocks via the same `extract_block()` → `additionalContext` path (NOT Tier-3 rules):

- **`AGENT-INJECT:STYLE-REF` and `AGENT-INJECT:MINIMALISM`** — both sourced from `scope-dev.md`, each to the DEV agents.
- **`AGENT-INJECT:NAMING`** — sourced from the `glass-atrium-dev-naming` SKILL.md. Its `NAMING_AGENTS` roster is deliberately NARROWER — DEV minus glass-atrium-dev-swift plus glass-atrium-qa-code-reviewer, EXCLUDING glass-atrium-qa-debugger.
- **`AGENT-INJECT:BUDGET-DEV` and `AGENT-INJECT:BUDGET-ANALYSIS`** — both sourced from `scoped/shared-turn-budget.md`, an injection-TEXT source only, like the naming SKILL.md: its policy SoT stays the Tier-1 `GLASS_ATRIUM_GLOBAL_RULES.md` Turn Budget & Graceful Exit section, so the file carries NO tier membership and no matrix row. Their rosters are carrier-exclusion curated:
  - `BUDGET_DEV_AGENTS` (9) = DEV minus the four daemon-carrier agents (glass-atrium-dev-nestjs · glass-atrium-dev-python · glass-atrium-dev-react · glass-atrium-dev-shell — each keeps a daemon-evolved in-body budget bullet the daemon owns, so injecting on top would double-deliver).
  - `BUDGET_ANALYSIS_AGENTS` (6) = glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-design-designer · glass-atrium-meta-agent · glass-atrium-wiki-curator (glass-atrium-intel-researcher EXCLUDED — carrier), a MANUAL-curated roster (not auto-reconciled; membership is not roster-derivable, so it stays a governance decision).
- **`AGENT-INJECT:WIKI-UNTRUSTED`** — sourced from `rules/glass-atrium/core-wiki-reference.md`, the ONLY injected block whose source is a **Tier-1** rule file rather than a scope-file / SKILL.md / injection-text source, carrying that file's raw-store data-not-instruction clause [LLM01]; the hook header records that a subagent otherwise receives that rule as a `> Rules:` pointer, not the clause body.
  - `WIKI_UNTRUSTED_AGENTS` (6) = glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-qa-debugger · glass-atrium-design-designer · glass-atrium-wiki-curator — the LIGHT Bash-holding wiki-reader cluster, deliberately NOT the 13 code-DEV agents (they hold Bash too, but their assembly already sits near the 9984-byte ceiling, so adding this block would shed a proven one; they stay covered by the agent-independent write-side control and the read-time advisory instead), and likewise a MANUAL-curated governance roster (not auto-reconciled — a new heavy DEV agent is deliberately NOT added).

The injected set is a **curated, deliberate allowlist** (these named blocks → these named agent lists), NOT an open-ended mechanism: any addition is a deliberate governance decision (like these were), never ad-hoc generalization to arbitrary rules or scopes.

The roster names above are machine-checked against code: `hooks/test/injector-roster-docs-closed-set.bats` enumerates every roster variable declared in `hooks/inject-scope-rules.sh` and `hooks/lib/styleref-roster.sh` and fails when one of them — or the inject-block name it owns — is named nowhere in this live file, so deleting a roster name here reds that suite rather than merely thinning the prose.

### Membership vs. Delivery (per tier)

Tier MEMBERSHIP (the rows above — which rules a scope *should* load) is DISTINCT from DELIVERY (the channel that actually carries the text to a running agent). The two delivery channels have different budgets, and this file's `inject-scope-rules.sh` SubagentStart hook is only ONE of them:

- **Tier 1 (Core) bodies → HOST project-instructions channel (UNCEILINGED, UNMEASURED), and they DO arrive.** (measured 2026-09-10) A spawned subagent's received project-instructions were read directly and carry all six Tier-1 files; a behavioural probe of three subagent types answered 3/3 Tier-1 questions correctly with 9/9 controls declined.
- **Tier 2 (Scope) bodies do NOT reach the agent whose scope they name.** (measured 2026-09-10) What a spawned subagent receives on this channel is the set the MAIN SESSION holds — the six Tier-1 files, the ORCHESTRATOR Tier-2 pair, this file and `shared-self-improve-hygiene.md` — whatever the subagent's own scope. Two instruments agree: the code reading (no selector exists — see the note under the Tier 2 table), and a probe in which glass-atrium-intel-reporter scored 0/5 on `scope-report.md` and glass-atrium-intel-planner 0/5 on `scope-planning.md` while both scored 6/6 on grammar unique to `orchestrator-role.md`. The code reading carries the claim; the probe's zeros corroborate it and are not proof on their own, since a wrong answer can be a recall failure. `inject-scope-rules.sh` is not the missing path: it injects NO Tier-2 scope-file BODY and performs NO per-agent Tier-2 scope-file SELECTION.
  - (inferred — mechanism unread) The likeliest explanation is that the host propagates the PARENT session's project-instructions verbatim to each spawned subagent. No configuration for this channel was located, so treat WHAT arrives as measured and WHY as open; do not state the mechanism as fact anywhere.
  - **Standing consequence**: a duty that binds a given agent must live in that agent's own body file under `agents/`, or in an injected block. Homing it in X's scope file and leaving a pointer in the body delivers the pointer and nothing else — the COUNT of a closed list survives, its MEMBERSHIP does not. This inverts the older instinct to cut a body mirror because the scope file has it.
- **One Tier-2 file is partially delivered, and only to DEV** (measured): two marker-extracted blocks sourced from `scope-dev.md` (style_ref, minimalism) ride the hook channel to the DEV roster. That is the existing, tested shape for moving scope-file text to an agent — and it is byte-ceilinged, so adding a block sheds one.
- **Tier 3 (Cross-cutting) → split delivery.**
  - Only `shared-comment-logging.md`'s extracted AGENT-INJECT **core** is delivered to DEV + QA subagents via `inject-scope-rules.sh` on the MEASURED, **9984-byte-ceilinged** SubagentStart channel (over-ceiling blocks are shed → logged to the drop sink → named in an in-context drop marker; see the hook header).
  - Every other Tier-3 rule is **pointer-referenced only** (membership declared here, body NOT injected).
  - The hook additionally carries six NON-Tier-3 marker blocks (style_ref · minimalism · naming · budget-dev · budget-analysis · wiki-untrusted) on that same ceilinged channel against the HARDCODED rosters named in the hook header (`INJECT_AGENTS` · `STYLEREF_AGENTS` · `MINIMALISM_AGENTS` · `NAMING_AGENTS` · `BUDGET_DEV_AGENTS` · `BUDGET_ANALYSIS_AGENTS` · `WIKI_UNTRUSTED_AGENTS` — a CLOSED set; `STYLEREF_AGENTS` is single-sited in `hooks/lib/styleref-roster.sh`, the rest in the hook itself) — again extracted cores, not scope-file bodies.
  - **wiki-untrusted is the one case where a Tier-1 rule file also has an extracted core on this channel**: its membership row in the Compliance Matrix below is unchanged (`core-wiki-reference.md` is ALL-scope Tier 1), and the injection delivers only that file's clause body to the `WIKI_UNTRUSTED_AGENTS` roster above — it grants no membership and changes no tier.

Net: the channel carrying the BULK of what an agent actually holds (Tier-1 bodies, plus the orchestrator's own Tier-2 pair) is the UNMEASURED host project-instructions one; the channel this repo budgets carefully (the hook's 9984-byte SubagentStart injection) is the MINOR one; and a Tier-2 scope body rides NEITHER. (Hook SoT: `hooks/inject-scope-rules.sh` header → "T8 — membership vs. delivery" — that header still carries the superseded sentence that a subagent's scope-rule body arrives on the host channel. Correcting it is a change to a file outside this one's scope and is tracked separately.)

## Precedence Resolution

- Conflict precedence: Tier 1 > Tier 2 > Tier 3.
- Within the same Tier: `core-security.md` overrides other ALL rules (security-first principle).
- Within Tier 2: conflicts are impossible by ASSIGNMENT — the Tier 2 table gives each scope exactly one scope file (the ORCHESTRATOR pair excepted). That is not a claim about what is in an agent's context: a spawned subagent measurably holds the ORCHESTRATOR pair and not the file assigned to its own scope (see `### Membership vs. Delivery (per tier)`). Where that happens the governing rule is still the one this table assigns to the agent's own scope — `orchestrator-role.md` disclaims itself for subagents in its own opening line.
- Within Tier 3: the more conservative (restrictive) rule wins.
- Ambiguous interpretation: the relevant scope file's Absolute Rules section is the final authority.

## Scope Legend

> **New-agent doc-sync note**: the `agent_lifecycle` CLI auto-writes a created agent's file + `agent-registry.json` entry + (via reconcile) the `inject-scope-rules.sh` arrays. It does NOT auto-write the Scope Legend row or the Compliance Matrix rows below — adding a new agent here is a separate post-creation doc update (see `scoped/scope-dev.md` → New-Agent Creation Gate doc-sync note).

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

> § DEV column: autoagent-touching subset only — DEV agents whose change scope includes `~/.glass-atrium/autoagent/` paths or self-improvement launchd configuration (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node when modifying daemon-apply.sh / daemon_cycle.py / monitor `/api/improvement` routes). General feature-work DEV agents do NOT load this rule. ORCHESTRATOR scope (main session) auto-loads unconditionally. See `rules/glass-atrium/shared-self-improve-hygiene.md` header for scope declaration.

> ¶ DEV + QA columns: hook-authoring reference only — DEV agents that write/modify hooks under `~/.glass-atrium/hooks/` (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node) + QA agents that review hook changes (glass-atrium-qa-code-reviewer) or analyze hook failures (glass-atrium-qa-debugger). Structurally parallel to `shared-comment-logging.md` (DEV+QA cross-cutting). META (‡-style `✓†`) = glass-atrium-meta-prompt-engineer ONLY per "prompts = code" Tier-3 inheritance; glass-atrium-meta-agent does NOT load it. NOT loaded by ALL / ORCHESTRATOR (orchestrator delegates hook work, does not author hooks). See `scoped/shared-hook-capability-contract.md` header for scope declaration.

> QA loads shared-comment-logging.md (always) from Tier 3, plus shared-hook-capability-contract.md conditionally (hook-review only — per the row above and footnote ¶), not the full set. See core-compliance-matrix.md QA exception note.

## Skills Registry (Reference)

SKILL.md files under `~/.claude/skills/` are outside this matrix's jurisdiction.
- Skills load globally at session start regardless of agent scope; Claude decides whether to invoke each one based on its SKILL.md `description` field.
- Adding / removing skills does NOT require updating this matrix.
- Exception: when a specific scope must restrict skill usage → record it in `scope-{name}.md` under a "Prohibited Skills" section.

---

## Archived Agents

Agents in `~/.claude/agents/archive/` are excluded from all active scope rows above. They retain their original rule references internally but are NOT subject to registry routing or compliance enforcement until reactivated.

(No agents currently archived.)
