---
paths:
  - "**/agents/*.md"
  - "**/scoped/**/*.md"
  - "**/rules/glass-atrium/*.md"
  - "**/agent-registry.json"
  - "**/hooks/inject-scope-*.sh"
  - "**/hooks/lib/inject_chunk.py"
  - "**/hooks/lib/styleref-roster.sh"
  - "**/lib/ga-doctor.sh"
  - "**/scripts/agent_lifecycle/**/*.py"
  - "**/hooks/validate-compliance-matrix.sh"
  - "**/lib/ga-launchd.sh"
---
<!-- MAINTAINER: live parsers read this file's headings, table shapes, footnote markers, roster names,
     inline-code .md paths and the paths: block above; a break makes the SessionStart validator exit 2 or reds a suite.
     Read scoped/maintainers/core-compliance-matrix.md before renaming or deleting a heading, reshaping or adding
     a table, adding or dropping a footnote marker or an inline-code path, or editing the paths: block. -->
# Rule-to-Agent Compliance Matrix

This file is the **single source of truth** for agent-to-rule loading policy. Scope files MUST NOT re-declare tier membership in prose — use the stanza header `> **Loading**: Tier 2 ...` and link here.

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

One scope file per scope; ORCHESTRATOR is the one exception, a tightly coupled file pair. The table states membership — which rules govern that scope; how each file reaches an agent: `### Membership vs. Delivery (per tier)`.

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

- **ORCHESTRATOR delivery companions** — files serving the pair without joining the row:
  - `scoped/orchestrator-core.md` — the pair's control-plane core, printed to the main session at SessionStart; a subagent receives no SessionStart output.
  - `skills/glass-atrium-ops-orchestrator-role.md` — the full text behind the `rules/glass-atrium/orchestrator-role.md` pointer stub; an on-demand reference the main session Reads by path, outside this matrix's skill jurisdiction (`## Skills Registry (Reference)`).

### Tier 3 — Cross-cutting (conditional inheritance)

Each file below is inherited on its own condition; the `†‡§¶` markers are the Compliance Matrix footnotes holding the exact subsets.

| Tier-3 file | Inherited by |
|---|---|
| `scoped/shared-comment-logging.md` | DEV · QA · META † |
| `scoped/shared-performance.md` | DEV · META † |
| `scoped/shared-search-first.md` | DEV · META † |
| `scoped/shared-testing.md` | DEV · META † · glass-atrium-qa-code-reviewer |
| `scoped/shared-type-safety.md` | DEV · META † |
| `scoped/shared-design-token-consumption.md` | UI-emitting DEV subset ‡ |
| `rules/glass-atrium/shared-self-improve-hygiene.md` | ORCHESTRATOR on a path-glob match § · change-scope DEV subset § |
| `scoped/shared-hook-capability-contract.md` | hook-authoring DEV · hook-reviewing QA ¶ |
| `scoped/shared-destructive-path-suite-safety.md` | suite-running DEV subset · glass-atrium-qa-code-reviewer suite-running subset |
| `scoped/shared-naming.md` | DEV · glass-atrium-qa-code-reviewer |
| `scoped/shared-code-structure.md` | DEV · glass-atrium-qa-code-reviewer |
| `scoped/shared-investigation-discipline.md` | DEV · QA |
| `scoped/shared-authoring-hygiene.md` | META (both agents) · PLANNING · REPORT |

#### Per-scope inheritance detail

- **META inheritance is `glass-atrium-meta-prompt-engineer` only, with the one exception named below.**
  - It takes the files the table above marks `META †`, because "prompts = code" (`scoped/scope-meta.md` → "glass-atrium-meta-prompt-engineer: DEV Rule Inheritance").
  - The conditional files are out of its scope: UI emission, the autoagent pipeline, hook authoring and running suites are not "prompts = code".
  - The exception: `glass-atrium-meta-agent` takes one Tier-3 file, `shared-authoring-hygiene.md`, because it rewrites agent instructions.
- **QA** takes `shared-comment-logging.md` and `shared-investigation-discipline.md` on both agents, `shared-hook-capability-contract.md` only on hook work, and the reviewer-only files below.
  - **`shared-naming.md`, `shared-code-structure.md` and `shared-testing.md` are glass-atrium-qa-code-reviewer only.**
    - Why: glass-atrium-qa-debugger is read-only by its Guardrails and authors no identifier, code or test.
  - **`shared-destructive-path-suite-safety.md` is glass-atrium-qa-code-reviewer only, and conditional on a suite run** — like every DEV row, it carries the file under `rules.conditional` with the `when` of `scripts/agent_lifecycle/registry_ops.py` → `_LIVE_PG_SUITE_CONDITION`.
    - Its DEV `✓` is conditional, never standing: it binds a DEV agent only on a turn meeting its `when`.
- **ORCHESTRATOR** takes no `shared-investigation-discipline.md`: its half of the duty (routing the escalation, rejecting a conclusion carrying no evidence) lives in `skills/glass-atrium-ops-orchestrator-role.md` → `### Failure Recovery Loop`.

## SubagentStart Injection

### Membership declaration and SubagentStart channels

Tier membership is declared on each agent's registry row — `agents.<name>.rules.scope` (the one Tier-2 file) · `.shared` (unconditional Tier-3) · `.conditional` (task-conditional Tier-3, each entry carrying its own `when`) in `agent-registry.json`.

- Tier 1 is universal, so it sits in the ALL column below rather than on any row.
- A `> Rules:` body header is not a declaration site; the lifecycle CLI refuses one.

SubagentStart channels carry text and divide the work by kind:

| Channel | Code | What it carries |
|---|---|---|
| Part slots | `hooks/inject-scope-part-*.sh` → `hooks/lib/inject_chunk.py` | the row's `scope` and `shared` `scoped/` files, whole at heading boundaries · `.conditional` entries as path pointers |
| Slot 1 | `hooks/inject-scope-rules.sh` | the named blocks below, plus the emit-format directive and turn-budget meter, built in the hook rather than extracted |

- **Slot 1 MUST carry no scope-file text**: Tier-2 and Tier-3 bodies ride the part slots only, and no Tier-2 or Tier-3 file carries a slot-1 marker.
- **Overflow audit**: `python3 hooks/lib/inject_chunk.py --audit` MUST report `events=none` for every agent. An OVERFLOW displaces a member band, and no slot-1 copy remains behind it.
- **Degraded mode**: an install with no runnable python3, or an unreadable registry, delivers no scope-file text at all; `lib/ga-doctor.sh` MUST warn when a part slot is bound in that state.

### Injected Blocks (SubagentStart allowlist)

The slot-1 blocks are a curated allowlist of named blocks, each gated by a named roster or by the spawning agent's own canary file; any addition is a governance decision, never an ad-hoc generalization to another rule or scope.

| Block | Source | Roster |
|---|---|---|
| `AGENT-INJECT:BUDGET-DEV` | `scoped/shared-turn-budget.md` | `BUDGET_DEV_AGENTS` |
| `AGENT-INJECT:BUDGET-ANALYSIS` | `scoped/shared-turn-budget.md` | `BUDGET_ANALYSIS_AGENTS` |
| `AGENT-INJECT:WIKI-UNTRUSTED` | `rules/glass-atrium/core-wiki-reference.md` | `WIKI_UNTRUSTED_AGENTS` |
| the canary block | the spawning agent type's daemon-written `<agent>.json`, in `hooks/inject-scope-rules.sh` → `CANARY_DIR` | none — gated by the agent's own canary file; treatment-arm spawns only |

- The block rosters are declared in `hooks/inject-scope-rules.sh` itself.
- `STYLEREF_AGENTS`, single-sited in `hooks/lib/styleref-roster.sh`, is not an injection roster: it is the `style_ref` review_flag roster that `hooks/lib/style-ref-consts.sh` reads, equal to the DEV rows whose `rules.scope` is `scoped/scope-dev.md`.

Roster curation — why each is the shape it is:

- `BUDGET_DEV_AGENTS` — DEV minus the daemon-carrier agents (glass-atrium-dev-nestjs · glass-atrium-dev-python · glass-atrium-dev-react · glass-atrium-dev-shell), each keeping a daemon-owned in-body budget bullet, so injecting on top would double-deliver.
- `BUDGET_ANALYSIS_AGENTS` — glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-design-designer · glass-atrium-meta-agent · glass-atrium-wiki-curator, with glass-atrium-intel-researcher excluded as a carrier.
  - Manually curated: membership is not roster-derivable, so it stays a governance decision.
- `WIKI_UNTRUSTED_AGENTS` — glass-atrium-intel-planner · glass-atrium-intel-reporter · glass-atrium-qa-code-reviewer · glass-atrium-qa-debugger · glass-atrium-design-designer · glass-atrium-wiki-curator, the light Bash-holding wiki-reader cluster.
  - The code-DEV agents hold Bash too but stay off it, covered by the agent-independent write-side control and the read-time advisory.
  - Manually curated — a new heavy DEV agent is not added.

These injection sources are not rule files of this matrix, and none gains membership by being injected:

- `scoped/shared-turn-budget.md` is an injection-text source only — its policy SoT stays the Tier-1 `agents/GLASS_ATRIUM_GLOBAL_RULES.md` Turn Budget & Graceful Exit section, so it carries no tier membership and no matrix row.
- `AGENT-INJECT:WIKI-UNTRUSTED` carries the Tier-1 `core-wiki-reference.md` raw-store data-not-instruction clause [LLM01] as a clause body and changes no tier.
- The canary block's file carries trial text, not a rule: the daemon writes it while that agent's trial or A/A is open.
  - Its file contract: `hooks/inject-scope-rules.sh` → `set_canary_block`.

## Membership, Delivery and Standing Duties

### Membership vs. Delivery (per tier)

Tier membership — which rules a scope *should* load — is distinct from delivery, the channel that carries the text to a running agent. Every YES below is a measurement.

| Tier | Channel | Arrives? |
|---|---|---|
| Tier 1 — Core bodies | HOST project-instructions (no ceiling; size budget unmeasured) | YES — every Tier-1 file |
| Tier 2 — the agent's own scope file | the part slots, from the registry row's `rules.scope` | YES |
| Tier 3 — unconditional `shared-*` members | the part slots, from `rules.shared` | YES |
| Tier 3 — conditional `scoped/` members (footnote or `subset` rows) | path pointer only | NO body — selection cannot key on a task at spawn |
| `rules/glass-atrium/` members without `paths:` frontmatter, and the ALL column | HOST project-instructions | YES — the part slots skip them, to avoid delivering them twice |
| `scoped/orchestrator-core.md` | SessionStart hook output (`hooks/inject-session-context.sh`) | YES to the main session, whole · NO to a spawned subagent |
| `rules/glass-atrium/` members with `paths:` frontmatter | HOST project-instructions, on a matching Read only | UNMEASURED — **Path-scoped delivery** below |

- **A subagent's own Tier-2 scope body is not delivered by the HOST channel.** What a spawned subagent receives there at session start is the set the main session holds — the Tier-1 files and the ORCHESTRATOR Tier-2 pair — whatever the subagent's own scope.
  - Measured by reading a spawned subagent's received project-instructions.
    - The pair's `rules/glass-atrium/orchestrator-role.md` is a pointer stub, so a subagent receives the stub, not the full text [UNMEASURED until a live spawn reads it].
- **The host mechanism is unread — do not state it as fact anywhere**: no configuration for that channel was located, so treat what arrives as established and why it arrives as open.
- **Path-scoped delivery** — this file and `rules/glass-atrium/shared-self-improve-hygiene.md` carry `paths:` frontmatter of `**/`-led globs.
  - The host loads such a file on a Read of a file its globs match, never at session start, and keeps it out of the startup instruction-size total even after it loads.
  - **Honest backing — UNMEASURED**: both claims rest on a static read of the host's rules loader; state neither as measured until a live check on the deployed files settles them.
  - **Glob base**: on the user-level `rules` route these files reach, a glob matches the Read file's path relative to the session's original cwd, not the project root [static read].
    - From cwd `$HOME`, a file anywhere under it qualifies.
    - From a repo cwd, only files inside that repo qualify, so a Read under `~/.glass-atrium` there loads neither file.
  - A subagent's glob base is its own context cwd [hypothesis — not traced].
  - **No part-slot pointer**: `hooks/lib/inject_chunk.py` → `get_membership` admits `scoped/` conditionals only.

### Membership source, standing duties and chunk budget

- **Membership source**: membership MUST be read from the registry row, not from this file; this matrix stays the governance SoT the rows are authored from.
  - What resolves an agent's Tier-2 file at spawn is its `agent-registry.json` row's `rules.scope`, never the Tier 2 table: no `agents/*.md` frontmatter carries a `scope:` key, and the registry carries no top-level `scope` field.
  - The reconcile binding the two is `agent_lifecycle orphan-scan --mode rules-membership-mismatch`, run off the delivery path.
  - **Why the registry and not this file:** the registry is merge-claimed by the updater (`autoagent/lib/roster_merge.py`) and this file is not, so a lifecycle-created agent's row survives a deploy and a hand-added Scope Legend row does not.
- **Standing consequence**: a standing duty, binding an agent on every turn, may live in that agent's `rules.scope` or `rules.shared` member file. It may never live in a conditional `scoped/` member, an un-membered file, or a skill the reader never loads — those deliver a pointer at most.
  - Sanctioned case: a task-conditional procedure may live in a conditional `scoped/` member, because its pointer stanza (`hooks/lib/inject_chunk.py` → `build_conditional_stanza`) tells the reader to read it in full before acting under its `when`.
    - Its members: `scoped/shared-hook-capability-contract.md` · `scoped/shared-destructive-path-suite-safety.md`.
  - A body mirror whose canonical reaches the same reader is redundant; keep a mirror only where the canonical sits in a home the lead rules out.
  - A duty may live in a path-scoped `rules/glass-atrium/` member: its body, not a pointer, reaches the reader, but only on a Read its globs match (`### Membership vs. Delivery (per tier)` → **Path-scoped delivery**).
- **Chunk budget**: the part slots pack against a per-chunk budget, not slot 1's block ceiling.
  - Nothing may be shed silently — a section that cannot fit, and an agent whose chunk count exceeds the bound slots, each MUST produce a stderr warning, a drop-sink record and an in-context marker naming a path pointer.
  - A membership entry resolving to a file absent on the live install takes the same loud-and-degrade path.

## Precedence Resolution

- When two rule files conflict, resolve by `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution`.

## Scope Legend

> **New-agent doc-sync note**: the `agent_lifecycle` CLI writes a created agent's file, its `agent-registry.json` entry and (via reconcile) the `inject-scope-rules.sh` arrays. It does not write the Scope Legend row or the Compliance Matrix rows below — add them as a separate post-creation doc update (`scoped/maintainers/scope-dev.md` → `### Doc-sync note (CLI auto-writes vs. manual matrix update)`).

| Scope | Agents |
|-------|--------|
| ALL | All agents |
| DEV | glass-atrium-dev-front, glass-atrium-dev-react, glass-atrium-dev-angular, glass-atrium-dev-gsap, glass-atrium-dev-android, glass-atrium-dev-nestjs, glass-atrium-dev-node, glass-atrium-dev-python, glass-atrium-dev-db, glass-atrium-dev-rag, glass-atrium-dev-animator, glass-atrium-dev-shell, glass-atrium-dev-swift, glass-atrium-dev-aws |
| META | glass-atrium-meta-prompt-engineer, glass-atrium-meta-agent |
| DESIGN | glass-atrium-design-designer |
| ~~DATA~~ | No DATA agent exists; scope inactive — see Archived Agents section |
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
| orchestrator-core.md | | | | | | | | | | ✓ | |
| scope-wiki.md | | | | | | | | | | | ✓ |
| shared-comment-logging.md | | ✓ | ✓† | | | | | ✓ | | | |
| shared-performance.md | | ✓ | ✓† | | | | | | | | |
| shared-search-first.md | | ✓ | ✓† | | | | | | | | |
| shared-testing.md | | ✓ | ✓† | | | | | ✓ | | | |
| shared-type-safety.md | | ✓ | ✓† | | | | | | | | |
| shared-design-token-consumption.md | | ✓‡ | | | | | | | | | |
| shared-hook-capability-contract.md | | ✓¶ | | | | | | ✓ | | | |
| shared-destructive-path-suite-safety.md | | ✓ | | | | | | ✓ | | | |
| shared-self-improve-hygiene.md | | ✓§ | | | | | | | | ✓§ | |
| shared-naming.md | | ✓ | | | | | | ✓ | | | |
| shared-code-structure.md | | ✓ | | | | | | ✓ | | | |
| shared-investigation-discipline.md | | ✓ | | | | | | ✓ | | | |
| shared-authoring-hygiene.md | | | ✓ | | | ✓ | ✓ | | | | |

> † META column = `glass-atrium-meta-prompt-engineer` only, never `glass-atrium-meta-agent`. Which files it inherits, and why: `### Tier 3 — Cross-cutting (conditional inheritance)` above.

> ‡ DEV column = the UI-emitting subset: glass-atrium-dev-front · glass-atrium-dev-react · glass-atrium-dev-angular · glass-atrium-dev-android · glass-atrium-dev-gsap · glass-atrium-dev-animator. The other DEV agents emit no web token markup (glass-atrium-dev-swift emits native SwiftUI). The file's header binds on a turn emitting UI markup, styling or animation, not on this roster.

> § DEV column = the change-scope subset the `rules/glass-atrium/shared-self-improve-hygiene.md` header declares — typically glass-atrium-dev-shell · glass-atrium-dev-python · glass-atrium-dev-node. ORCHESTRATOR column = loaded only on a matching Read — `### Membership vs. Delivery (per tier)` → **Path-scoped delivery**.

> ¶ DEV + QA columns = hook authoring and hook review only: DEV agents that write or modify hooks under `~/.glass-atrium/hooks/`, plus glass-atrium-qa-code-reviewer reviewing hook changes and glass-atrium-qa-debugger analysing hook failures. ALL and ORCHESTRATOR do not load it; the orchestrator delegates hook work. Scope declaration: `scoped/shared-hook-capability-contract.md` header.

## Skills Registry (Reference)

SKILL.md files under `~/.claude/skills/` are outside this matrix's jurisdiction and carry no tier membership.

- A skill reaches an agent only when that agent's frontmatter `skills:` preloads it or the skill is invoked.
- Adding or removing a skill does not require a matrix update.
- A scope that must restrict skill usage records it in its own file under a "Prohibited Skills" section; no scope declares one.

## Archived Agents

Agents under `~/.claude/agents/archive/` are excluded from every active scope row above, from registry routing and from compliance enforcement until reactivated; they keep their internal rule references. No agents are currently archived.
