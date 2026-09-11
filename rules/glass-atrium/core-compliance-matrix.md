# Rule-to-Agent Compliance Matrix

This file is the **single source of truth** for agent-to-rule loading policy. Scope files MUST NOT re-declare tier membership in prose — use the stanza header `> **Loading**: Tier 2 ...` and link here.

## Machine-Read Structure

Four live consumers parse this file. Reword around what they read, never through it.

| Consumer | Reads | Breaks when |
|---|---|---|
| `hooks/validate-compliance-matrix.sh` — SessionStart, exit 2 on a confirmed mismatch | Tier-1 Core bullets ↔ the ALL column · footnote markers used in matrix cells ↔ their `>` definitions, 1:1 · matrix column headers ↔ Scope Legend scopes · legend agent names ↔ `agent-registry.json` | a Tier-1 bullet is dropped · a footnote definition is orphaned · a legend row is removed |
| `monitor/src/server/architecture/governance-membership.ts` | every `scoped/…`, `rules/glass-atrium/…` or `agents/…` `.md` path written in inline code, reporting it absent when no such file exists | an illustrative or placeholder path is written in that form |
| `hooks/test/injector-roster-docs-closed-set.bats` | the roster variables declared in `hooks/inject-scope-rules.sh` and `hooks/lib/styleref-roster.sh`, asserting each is named here | a roster name, or the inject-block name it owns, is named nowhere here |
| `scripts/agent_lifecycle/scope_infer.py`, via `readers.py` | the `## Scope Legend` table, as an agent-name → scope map | the legend's two-column shape changes, or an agent cell gains a lowercase hyphenated non-agent token |

Reserved beyond that table:

- **Headings**: `## Loading Tiers`, `## Scope Legend` and `## Compliance Matrix` carry anchors the scope files and `agents/GLASS_ATRIUM_GLOBAL_RULES.md` link to; `### Tier 1` is a parse prefix; `### Membership vs. Delivery (per tier)` is cited by name from `scoped/scope-qa.md`, `hooks/inject-scope-rules.sh` and `hooks/inject-session-context.sh`.
- **Literals**: the matrix header cell `Rule File`, the `✓` glyph, the footnote markers †‡§¶, and the Scope Legend's `~~DATA~~` strikethrough row.
- **Row shape**: a table row anywhere in this file whose first cell is a bare `name.md` is read as a declared rule file by the drift scan — only Compliance Matrix rows may take that shape.

Coupled suites, so the next editor sees which pins are live:

- **Live-file pins** — `hooks/test/injector-roster-docs-closed-set.bats` (per the table above) and `monitor/test/architecture.governance-membership.unit.test.ts`, whose last case reads the real matrix and asserts it still declares `scoped/scope-dev.md` and `rules/glass-atrium/core-security.md` as inline-code paths.
- **Fixture-driven, so they catch nothing here** — `hooks/test/validate-compliance-matrix.bats` and `scripts/test/test_inject_sync.py` both drive temp-dir fixtures through the validator's env overrides, so a live edit that breaks the validator's parse passes both.

## Loading Tiers

### Tier 1 — Core (ALL agents auto-load)

Every agent session loads these unconditionally:

- `agents/GLASS_ATRIUM_GLOBAL_RULES.md`
- `rules/glass-atrium/core-git-workflow.md`
- `rules/glass-atrium/core-learning-log.md`
- `rules/glass-atrium/core-outcome-record.md`
- `rules/glass-atrium/core-security.md`
- `rules/glass-atrium/core-wiki-reference.md`

### Tier 2 — Scope (loaded when agent scope matches)

One scope file per scope. This is a MEMBERSHIP statement — which rules govern that scope — and NOT a claim that the file reaches the agent. ORCHESTRATOR is the one exception: a tightly coupled file pair.

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

**No code selects a scope file by agent.** No `agents/*.md` frontmatter carries a `scope:` key and `agent-registry.json` carries no scope field, so nothing at spawn time resolves a row above to a file. The only agent→scope-file map in the tree is the one `autoagent/daemon_cycle.py` uses to excerpt a scope file into the daemon's rule-improvement verify prompt, and no spawn path reads it. What a running agent actually holds is `### Membership vs. Delivery (per tier)` below — read it before relying on a row here.

### Tier 3 — Cross-cutting (conditional inheritance)

Each file below is inherited on its OWN condition. DEV is the common carrier, but QA, META and ORCHESTRATOR each carry some, so this tier is not DEV-exclusive. The `†‡§¶` markers are the Compliance Matrix footnotes below, which hold the exact subsets — stated there once.

| Tier-3 file | Inherited by |
|---|---|
| `scoped/shared-comment-logging.md` | DEV · QA · META † |
| `scoped/shared-performance.md` | DEV · META † |
| `scoped/shared-search-first.md` | DEV · META † |
| `scoped/shared-testing.md` | DEV · META † |
| `scoped/shared-type-safety.md` | DEV · META † |
| `scoped/shared-design-token-consumption.md` | UI-emitting DEV subset ‡ |
| `rules/glass-atrium/shared-self-improve-hygiene.md` | ORCHESTRATOR unconditionally · autoagent-touching DEV subset § |
| `scoped/shared-hook-capability-contract.md` | hook-authoring DEV · hook-reviewing QA ¶ |

- **META inheritance is `glass-atrium-meta-prompt-engineer` only.** It takes the original cross-cutting set — `shared-comment-logging.md` · `shared-performance.md` · `shared-search-first.md` · `shared-testing.md` · `shared-type-safety.md` — because "prompts = code" (`scoped/scope-meta.md` → "glass-atrium-meta-prompt-engineer: DEV Rule Inheritance"). The conditional files are out of its scope: UI emission, the autoagent pipeline and hook authoring are none of them "prompts = code". `glass-atrium-meta-agent` inherits no Tier-3 file.
  - **Hook-capability exclusion, adjudicated 2026-09-11**: the Tier-3 row above and the Compliance Matrix `shared-hook-capability-contract.md` row each carried a META marker asserting the opposite; both were corrected to match this bullet.
  - It stands because `glass-atrium-meta-prompt-engineer` authors prompts, not hooks — and code already agreed: `SCOPE_CONDITIONAL_RULES` in `scripts/agent_lifecycle/registry_ops.py` has no META entry, and that agent's registry row keeps an empty `conditional` list.
- **QA** loads Tier 1 + `scoped/scope-qa.md` + `shared-comment-logging.md` always, and `shared-hook-capability-contract.md` only when reviewing hook work — never the full set.

### Injected Blocks (SubagentStart allowlist)

Tier MEMBERSHIP is not rule-TEXT delivery: an agent's Tier-2 and Tier-3 membership is DECLARED on its registry row — `agents.<name>.rules.scope` (the one Tier-2 file) · `.shared` (unconditional Tier-3) · `.conditional` (task-conditional Tier-3, each entry carrying its own `when`) in `agent-registry.json` — and no spawn path reads that object, so a row naming `comment-logging` delivers no rule text. Tier 1 is universal and therefore sits in the ALL column below rather than on any row. The retired `> Rules:` body header carried the same declaration and is gone from every body; the lifecycle CLI refuses one. `hooks/inject-scope-rules.sh` delivers extracted marker blocks — never whole scope-file bodies — as `hookSpecificOutput.additionalContext`. This is a curated, deliberate allowlist of named blocks against named rosters; any addition is a governance decision, never an ad-hoc generalization to another rule or scope.

| Block | Source | Roster |
|---|---|---|
| `AGENT-INJECT` (comment-logging core) | `scoped/shared-comment-logging.md` → `## Agent Injection Core` | `INJECT_AGENTS` |
| `AGENT-INJECT:STYLE-REF` | `scoped/scope-dev.md` | `STYLEREF_AGENTS` |
| `AGENT-INJECT:MINIMALISM` | `scoped/scope-dev.md` | `MINIMALISM_AGENTS` |
| `AGENT-INJECT:PLAN-GATE` | `scoped/scope-dev.md` | `PLAN_GATE_AGENTS` |
| `AGENT-INJECT:NAMING` | the `glass-atrium-dev-naming` SKILL.md | `NAMING_AGENTS` |
| `AGENT-INJECT:BUDGET-DEV` | `scoped/shared-turn-budget.md` | `BUDGET_DEV_AGENTS` |
| `AGENT-INJECT:BUDGET-ANALYSIS` | `scoped/shared-turn-budget.md` | `BUDGET_ANALYSIS_AGENTS` |
| `AGENT-INJECT:WIKI-UNTRUSTED` | `rules/glass-atrium/core-wiki-reference.md` | `WIKI_UNTRUSTED_AGENTS` |

`comment-logging` is the only Tier-3 rule injected this way; every other Tier-3 rule is pointer-referenced only. `STYLEREF_AGENTS` is single-sited in `hooks/lib/styleref-roster.sh`, the rest in the hook itself.

Roster curation — why each is the shape it is:

- `NAMING_AGENTS` — deliberately narrower: DEV minus glass-atrium-dev-swift, plus glass-atrium-qa-code-reviewer, excluding glass-atrium-qa-debugger.
- `PLAN_GATE_AGENTS` — the whole DEV roster and deliberately not a subset: the Stage-2 gate's DEV participant is whichever agent matches the plan's primary implementation domain, a selection rule that excludes no DEV agent, so a narrower roster would silently deny the duty to whichever agent gets picked.
  - Membership is byte-identical to `MINIMALISM_AGENTS` today and the two stay SEPARATE declarations on purpose — one is a minimalism-reflex scope decision, the other a gate-eligibility decision, and sharing a constant would make either narrowing silently narrow the other.
  - UNTRACKED-manual (no inject_sync reconcile): a newly registered DEV agent must be added by hand or it receives no plan-gate block.
- `BUDGET_DEV_AGENTS` — DEV minus the daemon-carrier agents (glass-atrium-dev-nestjs · glass-atrium-dev-python · glass-atrium-dev-react · glass-atrium-dev-shell), each of which keeps a daemon-evolved in-body budget bullet the daemon owns, so injecting on top would double-deliver.
- `BUDGET_ANALYSIS_AGENTS` — glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-design-designer · glass-atrium-meta-agent · glass-atrium-wiki-curator, with glass-atrium-intel-researcher excluded as a carrier. MANUAL-curated: membership is not roster-derivable, so it stays a governance decision.
- `WIKI_UNTRUSTED_AGENTS` — glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-qa-debugger · glass-atrium-design-designer · glass-atrium-wiki-curator, the LIGHT Bash-holding wiki-reader cluster. The code-DEV agents hold Bash too but their assembly already sits near the byte ceiling, so adding the block would shed a proven one; they stay covered by the agent-independent write-side control and the read-time advisory. MANUAL-curated — a new heavy DEV agent is deliberately NOT added.

Two injection sources are not rule files of this matrix, and neither gains membership by being injected:

- `scoped/shared-turn-budget.md` is an injection-TEXT source only, like the naming SKILL.md — its policy SoT stays the Tier-1 `agents/GLASS_ATRIUM_GLOBAL_RULES.md` Turn Budget & Graceful Exit section, so it carries NO tier membership and no matrix row.
- `AGENT-INJECT:WIKI-UNTRUSTED` is the ONLY injected block sourced from a **Tier-1** rule file, carrying that file's raw-store data-not-instruction clause [LLM01] to `WIKI_UNTRUSTED_AGENTS`. `core-wiki-reference.md` is ALL-scope Tier 1, so its membership sits in the ALL column below and on no registry row; the injection delivers a clause body, grants no membership and changes no tier.

`AGENT-INJECT:PLAN-GATE` delivers a RESIDUAL, not the duty. What fits the byte contract is the verdict shape, the load-bearing premise test, the refuted-premise consequence and the non-waiver clause; the three-part answer shape for the revision-cycle first-link question did not fit and stays readable only in `scoped/scope-dev.md`, which is the block's SoT and does not reach a DEV agent. Do not read the block's arrival as the gate duty having been delivered. Delivery is also not guaranteed: the block sits low in the shed order — below both budget blocks, above the proven ones — and nothing sheds it only because today's block sizes leave the worst-case DEV assembly under the ceiling. A later source growth sheds it, and the drop marker that names it is recovery rather than delivery.

### Membership vs. Delivery (per tier)

Tier MEMBERSHIP — which rules a scope *should* load — is DISTINCT from DELIVERY, the channel that actually carries the text to a running agent. There are two channels with different budgets, and the injection hook above is only one of them.

| Tier | Channel | Arrives? |
|---|---|---|
| Tier 1 — Core bodies | HOST project-instructions (unceilinged, unmeasured) | YES — all six files |
| Tier 2 — scope-file bodies | none | NO |
| Tier 2 — `scope-dev.md` marker blocks (style_ref · minimalism · plan-gate) | `inject-scope-rules.sh`, byte-ceilinged | YES, to the DEV roster only |
| Tier 3 — `shared-comment-logging.md` extracted core | `inject-scope-rules.sh`, byte-ceilinged | YES, to DEV + QA |
| Tier 3 — every other file | none | NO — pointer-referenced only |

- **Tier-2 scope bodies do NOT reach the agent whose scope they name.** What a spawned subagent receives on the host channel is the set the MAIN SESSION holds — the six Tier-1 files, the ORCHESTRATOR Tier-2 pair, this file and `rules/glass-atrium/shared-self-improve-hygiene.md` — whatever the subagent's own scope. `inject-scope-rules.sh` is not the missing path: it injects NO Tier-2 scope-file BODY and performs NO per-agent Tier-2 scope-file SELECTION.
- **The mechanism is unread — do not state it as fact anywhere.** The likeliest explanation is that the host propagates the PARENT session's project-instructions verbatim to each spawned subagent, but no configuration for that channel was located: treat WHAT arrives as established and WHY as open.
- **Standing consequence**: a duty that binds a given agent MUST live in that agent's own body file under `agents/`, or in an injected block. Homing it in X's scope file and leaving a pointer in the body delivers the pointer and nothing else — the COUNT of a closed list survives, its MEMBERSHIP does not. Never cut a body mirror on the ground that the scope file already carries it.
- **The injected channel is byte-ceilinged at 9984 bytes** (`INJECT_CTX_MAX_BYTES`): over-ceiling blocks are shed, logged to the drop sink, and named in an in-context drop marker (see the hook header). Adding a block sheds one.

Net: the channel carrying the BULK of what an agent actually holds — Tier-1 bodies plus the orchestrator's own Tier-2 pair — is the UNMEASURED host one; the channel this repo budgets carefully is the MINOR one; and a Tier-2 scope body rides NEITHER.

**Known divergence**: `hooks/inject-scope-rules.sh` → "T8 — membership vs. delivery" still states that a subagent's scope-rule body arrives on the host channel. This section supersedes it; correcting the hook header is a change to a file outside this one.

## Precedence Resolution

- Across tiers: Tier 1 > Tier 2 > Tier 3.
- Within Tier 1: `rules/glass-atrium/core-security.md` overrides the other ALL rules (security-first principle).
- Within Tier 3: the more conservative (restrictive) rule wins.
- Within Tier 2: conflicts are impossible by ASSIGNMENT — one scope file per scope (the ORCHESTRATOR pair excepted). That says nothing about what is in an agent's context: a spawned subagent holds the ORCHESTRATOR pair and not the file assigned to its own scope (`### Membership vs. Delivery (per tier)`). Where that happens the governing rule is still the one this table assigns to the agent's own scope — `rules/glass-atrium/orchestrator-role.md` disclaims itself for subagents in its own opening line.
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

Rows are grouped by tier: Tier 1 first, then Tier 2, then Tier 3.

| Rule File | ALL | DEV | META | DESIGN | RESEARCH | PLANNING | REPORT | QA | SECURITY | ORCHESTRATOR | WIKI |
|-----------|-----|-----|------|--------|----------|----------|--------|----|----------|--------------|------|
| GLASS_ATRIUM_GLOBAL_RULES.md | ✓ | | | | | | | | | | |
| core-git-workflow.md | ✓ | | | | | | | | | | |
| core-learning-log.md | ✓ | | | | | | | | | | |
| core-outcome-record.md | ✓ | | | | | | | | | | |
| core-security.md | ✓ | | | | | | | | | | |
| core-wiki-reference.md | ✓ | | | | | | | | | | |
| scope-dev.md | | ✓ | | | | | | | | | |
| scope-meta.md | | | ✓ | | | | | | | | |
| scope-design.md | | | | ✓ | | | | | | | |
| scope-research.md | | | | | ✓ | | | | | | |
| scope-planning.md | | | | | | ✓ | | | | | |
| scope-report.md | | | | | | | ✓ | | | | |
| scope-qa.md | | | | | | | | ✓ | | | |
| scope-security.md | | | | | | | | | ✓ | | |
| scope-orchestrator.md | | | | | | | | | | ✓ | |
| orchestrator-role.md | | | | | | | | | | ✓ | |
| scope-wiki.md | | | | | | | | | | | ✓ |
| shared-comment-logging.md | | ✓ | ✓† | | | | | ✓ | | | |
| shared-performance.md | | ✓ | ✓† | | | | | | | | |
| shared-search-first.md | | ✓ | ✓† | | | | | | | | |
| shared-testing.md | | ✓ | ✓† | | | | | | | | |
| shared-type-safety.md | | ✓ | ✓† | | | | | | | | |
| shared-design-token-consumption.md | | ✓‡ | | | | | | | | | |
| shared-hook-capability-contract.md | | ✓¶ | | | | | | ✓ | | | |
| shared-self-improve-hygiene.md | | ✓§ | | | | | | | | ✓ | |

> † META column = `glass-atrium-meta-prompt-engineer` ONLY, never `glass-atrium-meta-agent`. Which files it inherits, and why: `### Tier 3 — Cross-cutting (conditional inheritance)` above.

> ‡ DEV column = the UI-emitting subset: glass-atrium-dev-front · glass-atrium-dev-react · glass-atrium-dev-angular · glass-atrium-dev-android · glass-atrium-dev-gsap · glass-atrium-dev-animator. The backend / data / shell agents (glass-atrium-dev-nestjs · glass-atrium-dev-node · glass-atrium-dev-python · glass-atrium-dev-db · glass-atrium-dev-rag · glass-atrium-dev-shell) emit no UI markup and glass-atrium-dev-swift emits native SwiftUI rather than web CSS/Tailwind token markup, so this web design-token rule is structurally inapplicable to each of them. Scope declaration: `scoped/shared-design-token-consumption.md` header.

> § DEV column = the autoagent-touching subset: DEV agents whose change scope includes `~/.glass-atrium/autoagent/` paths or the self-improvement launchd configuration (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node modifying daemon-apply.sh / daemon_cycle.py / monitor `/api/improvement` routes). General feature-work DEV agents do NOT load it. ORCHESTRATOR scope (main session) auto-loads it unconditionally. Scope declaration: `rules/glass-atrium/shared-self-improve-hygiene.md` header.

> ¶ DEV + QA columns = hook authoring and hook review only: DEV agents that write or modify hooks under `~/.glass-atrium/hooks/` (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node), plus glass-atrium-qa-code-reviewer reviewing hook changes and glass-atrium-qa-debugger analysing hook failures. Structurally parallel to `shared-comment-logging.md` as a DEV+QA cross-cutting file. NOT loaded by ALL or ORCHESTRATOR — the orchestrator delegates hook work rather than authoring it. Scope declaration: `scoped/shared-hook-capability-contract.md` header.

## Skills Registry (Reference)

SKILL.md files under `~/.claude/skills/` are outside this matrix's jurisdiction — they load globally at session start regardless of agent scope, and Claude decides whether to invoke each one from its SKILL.md `description` field. Adding or removing a skill does NOT require a matrix update. Where a specific scope must restrict skill usage, record it in that scope's file under a "Prohibited Skills" section; no scope declares one today.

## Archived Agents

Agents under `~/.claude/agents/archive/` are excluded from every active scope row above. They retain their internal rule references but are NOT subject to registry routing or compliance enforcement until reactivated. No agents are currently archived.
