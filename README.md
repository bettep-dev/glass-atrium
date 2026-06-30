<!-- banner: https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/banner.webp -->
<p align="center">
  <img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/banner.webp" alt="Glass Atrium — a self-improving multi-agent harness for Claude Code" width="720">
</p>

**A self-improving, centrally-orchestrated multi-agent harness for Claude Code.**

One orchestrator monitors and controls a fleet of specialist agents, and never allows an uncontrolled chain of agents handing work off to one another.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
<!-- CI badge gated until the repo is public and the owner/repo slug is final:
[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml) -->
![Platform: macOS](https://img.shields.io/badge/platform-macOS-black?logo=apple)
![Node 24](https://img.shields.io/badge/node-24.x-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL 14+](https://img.shields.io/badge/PostgreSQL-14%2B-4169E1?logo=postgresql&logoColor=white)
![Made with Claude Code](https://img.shields.io/badge/made%20with-Claude%20Code-D97757)

**English** · [한국어](README.ko.md) · [中文](README.zh.md) · [日本語](README.ja.md)

The orchestrator decomposes a single request into a team of specialist agents, then delegates and synthesizes. Every cost, outcome, and agent event surfaces on the real-time monitor dashboard, and the system fixes its own instructions from repeated failures — without you editing a single line of any prompt.

> [!WARNING]
> Once installed, background daemons run **automatically**. Some of them call Claude automatically every day, so tokens (and cost) accrue even when you leave it untouched.
>
> This harness is also a **high-token-usage system**. Because the orchestrator decomposes a single request into a team of specialist agents, one request fans out into many subagent calls, and token consumption can reach several times that of a single agent.

---

<details>
<summary>Contents</summary>

- [What it is](#what-it-is)
- [Why it was built](#why-it-was-built)
- [The core idea: one orchestrator, not a chain of handoffs](#the-core-idea-one-orchestrator-not-a-chain-of-handoffs)
- [How it works, end to end](#how-it-works-end-to-end)
- [Big tasks carefully, small tasks fast](#big-tasks-carefully-small-tasks-fast)
- [What's inside](#whats-inside)
- [Skills: the internal quality layer](#skills-the-internal-quality-layer)
- [Quickstart](#quickstart)
- [Monitor screens](#monitor-screens)
- [License](#license)

</details>

## What it is

Glass Atrium is a configuration-and-tooling layer that turns the Claude Code CLI into a coordinated, observable, self-improving multi-agent system. It is **not** a new agent framework, and it does **not** replace Claude Code — it installs into `~/.claude/` and runs on top of the CLI you already use.

Out of the box it adds five things, deployed as one coherent system:

- a **capability-routed fleet of specialist agents** (developers per stack, QA, planning, research, design, security, wiki, meta) instead of a single general-purpose prompt;
- a **layered rule system** that defines, in a matrix, exactly which agent loads which rules;
- a **lifecycle hook pipeline** that enforces those rules (secrets, dangerous commands, budgets, outcomes) *mechanically* at every tool boundary;
- a **real-time monitoring dashboard** (the Atrium Monitor) that surfaces every cost, outcome, and agent event in one place;
- a **self-improvement loop** that rewrites the agents' own instructions to fix recurring failures.

## Why it was built

A single `CLAUDE.md` prompt does not scale. The moment you ask one model to be a React expert *and* a database expert *and* a security reviewer *and* a planner all at once, the instructions collide, important rules get diluted in a vast wall of text, and the model quietly drifts from those rules under load.

The obvious next step — letting agents hand work off to one another — trades one problem for a worse one. In an agent-to-agent **handoff** system, control passes from agent A to B to C, each agent has to enforce its own rules, observability is fragmented across the chain, and a single misbehaving agent in the middle propagates unchecked. No one is in charge.

Glass Atrium was built to get the benefits of specialization without giving up control. Every specialist runs under continuous central oversight, every rule that matters is enforced by the harness itself rather than by the prompt, and the system records what happened and — automatically — learns from it.

## The core idea: one orchestrator, not a chain of handoffs

Glass Atrium is built on the **Manager Pattern** (the centralized manager pattern). A single orchestrator — the main Claude Code session — is the permanent **strategic control plane**. Its only role is to *decompose* your intent into sub-tasks, *delegate* each one to the right specialist, and *synthesize* the results. It never writes code or produces artifacts directly.

The opposite model, the **Handoff Pattern** (peer-to-peer agent-to-agent control transfer), is **explicitly not supported** — and that is exactly the point.

In Glass Atrium the orchestrator keeps control at every delegation boundary:

- **It knows who is doing what.** Each sub-task is routed by capability, not keyword (keyword/alias matching is forbidden).
- **It verifies every outcome.** Each agent returns a structured completion record, and the orchestrator checks intent-versus-result alignment.
- **It can halt, redirect, or escalate.** A failed subagent triggers the Failure Recovery Loop (retry → fallback → debugger escalation).
- **It is bounded.** Spawn depth and concurrency caps, plus per-agent budgets, are enforced so no delegation can run away.

This control is **mechanical, not merely procedural.** Rather than just writing rules in prompts and hoping they are followed, lifecycle hooks intercept every tool call, the monitor observes every event, and outcome records make every delegation traceable and auditable. That combination — central routing **+** hook-backed enforcement **+** full observability **+** a closed learning loop — is the key differentiator versus an uncontrolled handoff system.

## How it works, end to end

A single request flows through the system like this:

1. **You ask the orchestrator** (the main session) for something — fix a bug, plan a feature, write a report.
2. **The orchestrator investigates and decomposes**, then consults the capability registry to compose a team of specialist agents and an execution order.
3. **It delegates each sub-task** — every delegation passes through **PreToolUse hooks** (dangerous-command blocking, secret scanning, scope-drift flagging, plan-verification gate) *before* the action runs.
4. **The specialist agent does the work** — within its own scope rules injected by the **SubagentStart hook** and within enforced spawn/turn/tool budgets.
5. **Outcomes are recorded.** Each agent emits a `[COMPLETION]` block, and the **PostToolUse hook** captures it into an Outcome Record.
6. **The orchestrator synthesizes** — verified results into one answer, or runs the recovery loop on failure.
7. **Everything is observable.** Every cost, outcome, and agent event streams into PostgreSQL and the Atrium Monitor in real time.
8. **The system improves itself.** A background daemon reads the outcome records and correction signals and automatically patches the agent instructions — without you editing a single prompt.

You do not assemble the harness from parts. Pick **Install** once from the interactive menu in `./glass-atrium`, and the entire system is stood up in a single verified run (config, symlink farm, hook wiring, database, monitor build, health gate), with the background daemons running automatically after install. The runnable commands are in [Quickstart](#quickstart).

## Big tasks carefully, small tasks fast

The system **decides for itself which steps to take, sized to the task.** You do not have to tell it, step by step, to "proceed carefully."

When a task is large and complex, the system automatically follows a careful sequence. In plain terms, the flow is: **plan → check that the plan is sound → actually build it → test that it works → confirm it is done and wrap up.** Conversely, for a small task it skips this procedure and handles it fast. Which path it takes is something the system judges on its own, by looking at the task's size and complexity.

You may hear the word "workflow" here. It refers to **how the steps above are executed.** If you explicitly specify "proceed as a workflow," the same steps are bundled and handled all at once by an automated engine instead of a human triggering them one at a time. The key point is that the safety mechanisms and the steps it goes through — like the checks and the testing — are **the same either way.** What changes is only "how it executes" (whether an automated engine handles them all at once, or they are handled one step at a time).

> In one line: **what it goes through is decided automatically by task size, and only how it executes is optional.**

## What's inside

- **Fleet of specialist agents** — routed by a capability registry (`agent-registry.json`), not by keyword (developers per stack, QA, planning · research · reporting, design · audio, security, wiki, meta).
- **Layered rule system** — a global charter (`agents/GLOBAL_RULES.md`), core cross-cutting rules (`rules/`), and per-scope rules (`scoped/`) bound together by an explicit compliance matrix.
- **Lifecycle hook pipeline** — a collection of hook scripts (`hooks/`) that mechanically enforce secrets, dangerous commands, budgets, and outcome records at every tool boundary.
- **Self-improvement loop** — the autoagent daemon (`autoagent/`) turns accumulated outcome records and correction signals into agent-instruction patches, auto-applying only the safe ones with git-native rollback.
- **Atrium Monitor** — a 10-screen real-time dashboard on Fastify 5 + Prisma 7 + React 18 (`http://127.0.0.1:7842`).
- **Editable models + budget assignments** — the monitor's **Models & budgets** screen assigns a per-domain model and a per-call USD hard cap without editing the config file.
- **Live architecture map** — the monitor's System map screen renders the 7 maintained Mermaid diagrams together with live daemon status.
- **Wiki knowledge store** — an LLM-only store (`wiki/`) with a raw-source → curated-notes pipeline and a SQLite BM25 full-text search index. The research agents' web findings accumulate here, and it is consulted first before a new research or analysis task to reuse existing knowledge.
- **Internal agent skills** — progressive-disclosure `SKILL.md` packages the agents and orchestrator invoke automatically (see [Skills](#skills-the-internal-quality-layer)).
- **Per-file symlink farm install** — idempotently creates `~/.claude/<rel>` → `~/.glass-atrium/<rel>` symlinks at the file (not directory) level, so they can coexist with user-owned files.
- **8 background daemons** — `com.glass-atrium.*` launchd jobs (3 keepalive: monitor · autoagent · wiki · 5 scheduled: log rotation · PG backup · autoagent cycle · wiki compile · daily restart), all declared in `config.toml`.
- **Zero secret material in the repository** — peer-auth-only PostgreSQL (no passwords), secret-scan hooks, a release-gate PII scan.

## Skills: the internal quality layer

Skills in Glass Atrium are **not** user-invoked commands — they are an internal quality and governance layer that loads globally at session start and that Claude activates automatically based on the task at hand. They cover code/design conventions, safety invariants (the "iron laws"), ops/verification gates, and wiki/web tooling, and some fire in response to monitor signals (the System map drift badge, a Models & budgets save, and so on). **You do not need to know which skill is running** — the harness picks and invokes them as part of "just working."

## Quickstart

**Prerequisites**: macOS · Claude Code CLI. Everything else is detected and installed automatically by the install TUI, with your consent.

```sh
curl -fsSL https://github.com/bettep-dev/glass-atrium/raw/main/install.sh | bash
```

When the interactive menu opens, choose **Install** — after install, the dependencies and daemons are configured and started automatically, and the dashboard responds at `http://127.0.0.1:7842`.

> Leave the cloned folder where it is. The Atrium installs as a per-file symlink farm, not a directory swap: files in your Claude config directory become symlinks pointing at the real files inside the cloned `~/.glass-atrium`, so it coexists with your own files without collisions. Because the real files live in this project folder and the installed symlinks point back to it, moving or deleting the folder breaks the links.

### Uninstall

Choose **Uninstall** from the menu. It removes the installed symlinks and drops the GA database, cleanly and completely separating the Atrium from your existing Claude system — your own files are left untouched, and no Atrium residue remains. The database is dropped with no backup, by design; a reinstall recreates a fresh one.

### How to write Atrium Monitor documents

A request for a document, report, summary, or reference is delegated to **intel-reporter** (in charge of reports, summaries, references); a request for planning, requirements definition, or task decomposition is delegated to **intel-planner** (in charge of planning).

Which format you get **is determined by the wording of your request**:

- the default is a **hidden "agent-only" token-optimized record** on the monitor — chosen from md, yaml, json, or txt depending on the shape of the content. It is an internal record for later reference.
- if you make your share/viewing intent clear — like "**as HTML**," "**as a web document**," or "**for the team to share**" — an **HTML document** a person can view and share is produced (a single file with a dark theme, diagrams, and tables).

Both formats appear on the Atrium Monitor's **Documents** screen.

Examples:

- "Write up a retrospective report on this change" → an agent-only record (the default).
- "Make it an HTML report for the team to share" → an HTML document.

Even when you do not explicitly request a document, an agent-only record may be left behind if it is judged worth recording.

### Adding a development (DEV) agent

When you make a request like "Add a development agent that does OOO," the orchestrator does not immediately create a new agent — it first judges **whether to extend (EXTEND) an existing agent or create (CREATE) a new one**. **The default is to extend, and creation is allowed only when it passes the gate.**

For creation to be allowed, three conditions must **all be met independently**:

- **a different artifact type** — the files it produces are structurally distinct.
- **a different decision domain** — the expertise needed for correct judgment does not overlap.
- **a non-transferable quality judgment** — one side's quality review cannot be substituted by the other side's expertise alone.

On top of this, if the proposed agent's domain **overlaps with an existing agent by more than a certain ratio, creation is blocked** — heavy overlap is a signal to extend an existing agent rather than create a new one (duplication prevention).

There are **two user-approval pauses** along the way:

1. **Create-vs-extend decision approval** — the orchestrator presents its rationale and recommendation, and you confirm.
2. **Registration (commit) approval** — one more confirmation just before it actually writes to the agent file and the registry.

The body (the system prompt) is authored by **meta-prompt-engineer**, and the registration itself is handled by a dedicated CLI. In short, all you have to do is ask to "add one" — the orchestrator judges and proposes whether an extension or a new agent is the right fit, and asks for approval when creating a new one.

## Monitor screens

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-dashboard.webp" alt="Dashboard" width="100%"></p>
<p align="center"><em>Dashboard overview — today's cost, the last 30 days of spend, the token-usage trend, and the session and failure counters at a glance.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-cost.webp" alt="Cost & tokens" width="100%"></p>
<p align="center"><em>Cost & tokens — cost KPIs, the 30-day daily cost trend (with spike markers), and a burn-rate forecast.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-agents.webp" alt="Agents" width="100%"></p>
<p align="center"><em>Agents — per-agent run counts, success rates, P95, and trend sparklines.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-learning.webp" alt="Learning" width="100%"></p>
<p align="center"><em>Learning — the self-improvement proposal board (pending/applied/rejected) with confidence, pre-verification, and commit hashes.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-system-map.webp" alt="System map" width="100%"></p>
<p align="center"><em>System map — the maintained Mermaid architecture diagrams with a live-status overlay.</em></p>

## License

[MIT](LICENSE) © 2026 Bettep
