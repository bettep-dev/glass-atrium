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

- **Headings**:
  - `## Loading Tiers`, `## Scope Legend` and `## Compliance Matrix` carry anchors the scope files and `agents/GLASS_ATRIUM_GLOBAL_RULES.md` link to; `### Tier 1` is a parse prefix.
  - `### Membership vs. Delivery (per tier)` is cited in full by `agents/glass-atrium-intel-researcher.md` and by maintainer notes under `scoped/maintainers/` — named as a group, because which companions carry that citation changes as they are edited.
  - `hooks/inject-scope-rules.sh` and `hooks/inject-session-context.sh` cite that same heading by its `Membership vs. Delivery` prefix.
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

**What MUST resolve a row above to a file at spawn** is the agent's `agent-registry.json` row — `rules.scope` (the one Tier-2 file) and `rules.shared` — read by the SubagentStart injector. No `agents/*.md` frontmatter carries a `scope:` key, and the registry carries no top-level `scope` field either: the resolution is `rules.scope` per row, and this table is the AUTHORING input for those rows rather than a runtime input. `autoagent/daemon_cycle.py` holds a second agent→scope-file map, used only to excerpt a scope file into the daemon's rule-improvement verify prompt. No spawn path reads either one TODAY — the selector is a requirement of the split channel, not a description of it. What a running agent actually holds is `### Membership vs. Delivery (per tier)` below — read it before relying on a row here.

### Tier 3 — Cross-cutting (conditional inheritance)

Each file below is inherited on its OWN condition. DEV is the common carrier, but QA, META, PLANNING, REPORT and ORCHESTRATOR each carry some, so this tier is not DEV-exclusive — one file has no DEV member at all. The `†‡§¶` markers are the Compliance Matrix footnotes below, which hold the exact subsets — stated there once.

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
| `scoped/shared-naming.md` | DEV · glass-atrium-qa-code-reviewer |
| `scoped/shared-code-structure.md` | DEV · glass-atrium-qa-code-reviewer |
| `scoped/shared-investigation-discipline.md` | DEV · QA |
| `scoped/shared-authoring-hygiene.md` | META (both agents) · PLANNING · REPORT |

- **META inheritance is `glass-atrium-meta-prompt-engineer` only, with the one exception named below.** It takes the original cross-cutting set — `shared-comment-logging.md` · `shared-performance.md` · `shared-search-first.md` · `shared-testing.md` · `shared-type-safety.md` — because "prompts = code" (`scoped/scope-meta.md` → "glass-atrium-meta-prompt-engineer: DEV Rule Inheritance"). The conditional files are out of its scope: UI emission, the autoagent pipeline and hook authoring are none of them "prompts = code". `glass-atrium-meta-agent` inherits no Tier-3 file but `shared-authoring-hygiene.md`.
  - **`shared-authoring-hygiene.md` is the exception on both counts** — the one Tier-3 file BOTH META agents take, and the one with no DEV member. `glass-atrium-meta-agent` rewrites agent instructions, so a rule binding authored instruction text binds it. Its other members are PLANNING and REPORT, whose authored documents it binds equally, so its META cell carries a bare `✓` and no subset marker.
  - **Hook-capability exclusion, adjudicated 2026-09-11**: the Tier-3 row above and the Compliance Matrix `shared-hook-capability-contract.md` row each carried a META marker asserting the opposite; both were corrected to match this bullet.
  - It stands because `glass-atrium-meta-prompt-engineer` authors prompts, not hooks — and code already agreed: `SCOPE_CONDITIONAL_RULES` in `scripts/agent_lifecycle/registry_ops.py` has no META entry, and that agent's registry row keeps an empty `conditional` list.
- **QA** loads Tier 1 + `scoped/scope-qa.md` + `shared-comment-logging.md` always, and `shared-hook-capability-contract.md` only when reviewing hook work — never the full set.
  - **`shared-naming.md` is glass-atrium-qa-code-reviewer ONLY**, and its Compliance Matrix QA cell carries no footnote marker for that subset — the Tier-3 row above names the single agent outright, which no marker could state more precisely. DEV takes it unconditionally, all 13.
    - glass-atrium-qa-debugger is read-only by its Guardrails and authors no identifier, so the rule is structurally inapplicable to it.
  - **`shared-code-structure.md` is glass-atrium-qa-code-reviewer ONLY** for the same reason and with the same bare `✓` in its Compliance Matrix QA cell — the Tier-3 row above names the single agent. glass-atrium-qa-debugger authors no code, so a structural authoring rule is inapplicable to it; DEV takes it unconditionally, all 13.
  - **`shared-investigation-discipline.md` is the one Tier-3 file BOTH QA agents take**, so its `✓` carries no subset qualifier and glass-atrium-qa-debugger is its heaviest consumer — diagnosis IS the investigation sequence.
    - ORCHESTRATOR is deliberately absent: its half of the duty (routing the escalation, rejecting a conclusion carrying no evidence) lives in `rules/glass-atrium/orchestrator-role.md` → `### Failure Recovery Loop`.

### Injected Blocks (SubagentStart allowlist)

Tier MEMBERSHIP is DECLARED on each agent's registry row — `agents.<name>.rules.scope` (the one Tier-2 file) · `.shared` (unconditional Tier-3) · `.conditional` (task-conditional Tier-3, each entry carrying its own `when`) in `agent-registry.json`. Tier 1 is universal and therefore sits in the ALL column below rather than on any row. The retired `> Rules:` body header carried the same declaration and is gone from every body; the lifecycle CLI refuses one.

Two SubagentStart channels carry text, and they divide the work by kind:

| Channel | Code | What it carries |
|---|---|---|
| Part slots | `hooks/inject-scope-part-*.sh` → `hooks/lib/inject_chunk.py` | every `scoped/` file in the row's `scope` and `shared` entries, packed whole at heading boundaries (an over-cap section is named by an in-context marker instead); `.conditional` entries as path pointers only |
| Slot 1 | `hooks/inject-scope-rules.sh` | the named marker blocks below, plus the emit-format directive, the turn-budget meter and the lesson recall, which the hook builds rather than extracts |

- **Slot 1 MUST carry no scope-file text.** The comment-logging, style_ref, minimalism, naming and plan-gate cores ride the part slots only; `hooks/inject-scope-rules.sh` extracts none of them, and their source files carry no marker.
- **Retirement precondition**: `python3 hooks/lib/inject_chunk.py --audit` MUST report `events=none` for every agent. An OVERFLOW displaces a member band, and no slot-1 copy remains behind it.
- **Degraded mode**: an install with no runnable python3, or an unreadable registry, delivers no scope-file text at all; `lib/ga-doctor.sh` MUST warn when a part slot is bound in that state.

The slot-1 blocks are a curated, deliberate allowlist of named blocks against named rosters; any addition is a governance decision, never an ad-hoc generalization to another rule or scope.

| Block | Source | Roster |
|---|---|---|
| `AGENT-INJECT:BUDGET-DEV` | `scoped/shared-turn-budget.md` | `BUDGET_DEV_AGENTS` |
| `AGENT-INJECT:BUDGET-ANALYSIS` | `scoped/shared-turn-budget.md` | `BUDGET_ANALYSIS_AGENTS` |
| `AGENT-INJECT:WIKI-UNTRUSTED` | `rules/glass-atrium/core-wiki-reference.md` | `WIKI_UNTRUSTED_AGENTS` |

Those block rosters are declared in the hook itself. `STYLEREF_AGENTS`, single-sited in `hooks/lib/styleref-roster.sh`, is NOT an injection roster: it is the `style_ref` review_flag roster that `hooks/lib/style-ref-consts.sh` reads, and it equals the DEV rows whose `rules.scope` is `scoped/scope-dev.md`.

Roster curation — why each is the shape it is:

- `BUDGET_DEV_AGENTS` — DEV minus the daemon-carrier agents (glass-atrium-dev-nestjs · glass-atrium-dev-python · glass-atrium-dev-react · glass-atrium-dev-shell), each of which keeps a daemon-evolved in-body budget bullet the daemon owns, so injecting on top would double-deliver.
- `BUDGET_ANALYSIS_AGENTS` — glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-design-designer · glass-atrium-meta-agent · glass-atrium-wiki-curator, with glass-atrium-intel-researcher excluded as a carrier. MANUAL-curated: membership is not roster-derivable, so it stays a governance decision.
- `WIKI_UNTRUSTED_AGENTS` — glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-qa-debugger · glass-atrium-design-designer · glass-atrium-wiki-curator, the LIGHT Bash-holding wiki-reader cluster. The code-DEV agents hold Bash too and are deliberately NOT on it; they stay covered by the agent-independent write-side control and the read-time advisory. MANUAL-curated — a new heavy DEV agent is deliberately NOT added.

Two injection sources are not rule files of this matrix, and neither gains membership by being injected:

- `scoped/shared-turn-budget.md` is an injection-TEXT source only — its policy SoT stays the Tier-1 `agents/GLASS_ATRIUM_GLOBAL_RULES.md` Turn Budget & Graceful Exit section, so it carries NO tier membership and no matrix row.
- `AGENT-INJECT:WIKI-UNTRUSTED` is the ONLY injected block sourced from a **Tier-1** rule file, carrying that file's raw-store data-not-instruction clause [LLM01] to `WIKI_UNTRUSTED_AGENTS`. `core-wiki-reference.md` is ALL-scope Tier 1, so its membership sits in the ALL column below and on no registry row; the injection delivers a clause body, grants no membership and changes no tier.

### Membership vs. Delivery (per tier)

Tier MEMBERSHIP — which rules a scope *should* load — is DISTINCT from DELIVERY, the channel that actually carries the text to a running agent. Two channels carry rule text and they have different budgets; the injection hook above is only one of them.

**Read the "Arrives?" column with its tense.** A row reading YES records a measurement. A row reading REQUIRED records what the split SubagentStart channel MUST do once it is bound on the live install, and nothing more: that channel is not bound today, so no `scoped/` body reaches any agent by any route, and per-scope arrival is verified agent by agent at the end of the wave. Do not read a REQUIRED row as a description of what happens now.

| Tier | Channel | Arrives? |
|---|---|---|
| Tier 1 — Core bodies | HOST project-instructions (unceilinged, unmeasured) | YES — all six files (measured 2026-09-10) |
| Tier 2 — the agent's own scope file | the split SubagentStart channel, selected from the registry row | REQUIRED — not bound yet; verified per scope at the end of the wave |
| Tier 3 — unconditional `shared-*` members | same channel | REQUIRED — same verification |
| Tier 3 — CONDITIONAL members (footnote cells) | path pointer only | NO body — selection cannot key on a task at spawn |
| `rules/glass-atrium/` members and the ALL column | HOST project-instructions | YES — and deliberately NOT selected, to avoid delivering them twice |

- **A Tier-2 scope body is not delivered by the HOST channel.** What a spawned subagent receives there is the set the MAIN SESSION holds — the six Tier-1 files, the ORCHESTRATOR Tier-2 pair, this file and `rules/glass-atrium/shared-self-improve-hygiene.md` — whatever the subagent's own scope (measured 2026-09-10, by reading a spawned subagent's received project-instructions directly).
- **The host mechanism is unread — do not state it as fact anywhere.** The likeliest explanation is that the host propagates the PARENT session's project-instructions verbatim to each spawned subagent, but no configuration for that channel was located: treat WHAT arrives as established and WHY as open.
- **Membership MUST be read from the registry row, not from this file.** `agent-registry.json` → `agents.<name>.rules` carries `{scope, shared, conditional}`, AUTHORED from this matrix. This matrix stays the governance SoT; the reconcile that binds the two is `agent_lifecycle orphan-scan --mode rules-membership-mismatch`, which runs off the delivery path, where a fail-open matrix parser is the right instrument.
  - That reconcile reads the **Tier-2 and Tier-3 DECLARATION ROWS, never the Compliance Matrix table cell.** The declaration rows are the membership statement and the table below is a coarser summary of them: `scoped/shared-naming.md` is declared for DEV and for glass-atrium-qa-code-reviewer alone, while its Compliance Matrix QA cell carries a bare tick covering both QA agents, so a cell reader reports a permanent false divergence for glass-atrium-qa-debugger. `shared-code-structure.md` is the identical shape.
  - **Why the registry and not this file:** the registry is merge-claimed by the updater and this file is not, so a lifecycle-created agent's row survives a deploy and a hand-added Scope Legend row does not (driven against `autoagent/lib/roster_merge.py`, 2026-09-13).
- **Standing consequence, narrowed but NOT yet inverted**: once the channel is bound and arrival is verified, a duty that binds an agent may live in that agent's `scoped/` member file. It may NEVER live in a CONDITIONAL member, an un-membered file, or a skill — those deliver a pointer at most. Until arrival is verified per scope, a body mirror is the only proven channel: **do not cut one.**
- **The per-chunk budget replaces the old 9984-byte block ceiling for the split channel.** Nothing may be shed silently — a section that cannot fit, and an agent whose chunk count exceeds the bound slots, each MUST produce a stderr warning, a drop-sink record and an in-context marker naming a path pointer. A membership entry resolving to a file absent on the live install takes the same loud-and-degrade path.

Net: the channel carrying the BULK of what an agent holds today — Tier-1 bodies plus the orchestrator's own Tier-2 pair — is the UNMEASURED host one, and a Tier-2 scope body rides neither channel until the split channel is bound.

## Precedence Resolution

- Across tiers: Tier 1 > Tier 2 > Tier 3.
- Within Tier 1: `rules/glass-atrium/core-security.md` overrides the other ALL rules (security-first principle).
- Within Tier 3: the more conservative (restrictive) rule wins.
- Within Tier 2: conflicts are impossible by ASSIGNMENT — one scope file per scope (the ORCHESTRATOR pair excepted).
  - That says nothing about what is in an agent's context. A spawned subagent holds the ORCHESTRATOR pair, which the host propagates from the main session whatever the subagent's own scope; once the split channel is bound it will ALSO hold the file assigned to its own scope, delivered from its registry row (`### Membership vs. Delivery (per tier)`).
  - Either way the governing rule is the one this table assigns to the agent's own scope. `rules/glass-atrium/orchestrator-role.md` disclaims itself for subagents in its own opening line, which is what makes the overlap harmless rather than ambiguous.
- Ambiguous interpretation: the final authority is the scope file the Tier 2 table assigns to that scope — the whole file, never a named section inside it.
  - A scope file MAY concentrate that authority in an Absolute Rules section and cite this clause by name; `scoped/scope-research.md` and `scoped/scope-security.md` carry no such section and govern whole.

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
| shared-naming.md | | ✓ | | | | | | ✓ | | | |
| shared-code-structure.md | | ✓ | | | | | | ✓ | | | |
| shared-investigation-discipline.md | | ✓ | | | | | | ✓ | | | |
| shared-authoring-hygiene.md | | | ✓ | | | ✓ | ✓ | | | | |

> † META column = `glass-atrium-meta-prompt-engineer` ONLY, never `glass-atrium-meta-agent`. Which files it inherits, and why: `### Tier 3 — Cross-cutting (conditional inheritance)` above.

> ‡ DEV column = the UI-emitting subset: glass-atrium-dev-front · glass-atrium-dev-react · glass-atrium-dev-angular · glass-atrium-dev-android · glass-atrium-dev-gsap · glass-atrium-dev-animator. The backend / data / shell agents (glass-atrium-dev-nestjs · glass-atrium-dev-node · glass-atrium-dev-python · glass-atrium-dev-db · glass-atrium-dev-rag · glass-atrium-dev-shell) emit no UI markup and glass-atrium-dev-swift emits native SwiftUI rather than web CSS/Tailwind token markup, so this web design-token rule is structurally inapplicable to each of them. Scope declaration: `scoped/shared-design-token-consumption.md` header.

> § DEV column = the autoagent-touching subset: DEV agents whose change scope includes `~/.glass-atrium/autoagent/` paths or the self-improvement launchd configuration (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node modifying daemon-apply.sh / daemon_cycle.py / monitor `/api/improvement` routes). General feature-work DEV agents do NOT load it. ORCHESTRATOR scope (main session) auto-loads it unconditionally. Scope declaration: `rules/glass-atrium/shared-self-improve-hygiene.md` header.

> ¶ DEV + QA columns = hook authoring and hook review only: DEV agents that write or modify hooks under `~/.glass-atrium/hooks/` (typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node), plus glass-atrium-qa-code-reviewer reviewing hook changes and glass-atrium-qa-debugger analysing hook failures. Structurally parallel to `shared-comment-logging.md` as a DEV+QA cross-cutting file. NOT loaded by ALL or ORCHESTRATOR — the orchestrator delegates hook work rather than authoring it. Scope declaration: `scoped/shared-hook-capability-contract.md` header.

## Skills Registry (Reference)

SKILL.md files under `~/.claude/skills/` are outside this matrix's jurisdiction — they load globally at session start regardless of agent scope, and Claude decides whether to invoke each one from its SKILL.md `description` field. Adding or removing a skill does NOT require a matrix update. Where a specific scope must restrict skill usage, record it in that scope's file under a "Prohibited Skills" section; no scope declares one today.

## Archived Agents

Agents under `~/.claude/agents/archive/` are excluded from every active scope row above. They retain their internal rule references but are NOT subject to registry routing or compliance enforcement until reactivated. No agents are currently archived.
