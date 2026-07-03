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

The orchestrator decomposes a single request into a team of specialist agents, then delegates and synthesizes. Every cost, outcome, and agent event surfaces on the real-time monitor dashboard, laid bare as if behind a glass wall, and the system fixes its own instructions from repeated failures — without you editing a single line of any prompt.

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

The "glass atrium" in the name is also a lens for seeing the system. Instead of treating the AI as a single clever individual, picture one glass building — see-through even in the dead of night, running around the clock — a company where many specialists work but every piece of work passes through a single supervisor at the center. Transparent glass, and a central supervisor through whom all paths run: those two together are the identity the name carries.

On top of that, a default install alone bundles in five things that come together as one coherent system:

- a **capability-routed fleet of specialist agents** (developers per stack, QA, planning, research, design, security, wiki, meta) instead of a single general-purpose prompt;
- a **layered rule system** that defines, in a matrix, exactly which agent loads which rules;
- a **lifecycle hook pipeline** that enforces those rules (secrets, dangerous commands, budgets, outcomes) *mechanically* at every tool boundary;
- a **real-time monitoring dashboard** (the Atrium Monitor) that surfaces every cost, outcome, and agent event in one place;
- a **self-improvement loop** that rewrites the agents' own instructions to fix recurring failures.

## Why it was built

A single `CLAUDE.md` prompt does not scale. The moment you ask one model to be a React expert *and* a database expert *and* a security reviewer *and* a planner all at once, the instructions collide. The rules that actually matter get diluted in a vast wall of text, and the model quietly drifts from them under load.

So the work has to be divided — a team of specialists beats a lone genius, and once the work is split, each specialist gets a clean memory (context) of its own and can concentrate on its own job.

The obvious next step — letting agents hand work off to one another — trades one problem for a worse one. In an agent-to-agent **handoff** system, control passes from agent A to B, and from B on to C. Each agent has to enforce its own rules, observability is fragmented across the chain, and a single misbehaving agent in the middle propagates unchecked. No one is in charge.

Glass Atrium was built to get the benefits of specialization without giving up control — and the answer is centralization. What decides success or failure, in this view, is not the model's raw talent but the operating system around it: the harness. Because every specialist runs under continuous central supervision, a mistake on one floor never spreads through the whole building.

## The core idea: one orchestrator, not a chain of handoffs

Glass Atrium is built on the **Manager Pattern** (the centralized manager pattern). A single orchestrator — the main Claude Code session — is the permanent **strategic control plane**. Its only role is to *decompose* your intent into sub-tasks, *delegate* each one to the right specialist, and *synthesize* the results. It never writes code or produces artifacts directly.

The opposite model, the **Handoff Pattern** (peer-to-peer agent-to-agent control transfer), is **explicitly not supported** — and that is exactly the point.

In Glass Atrium the orchestrator holds the entire context by itself and keeps control at every delegation boundary.

Each sub-task is routed by capability rather than keyword (keyword and alias matching is forbidden), so it is always clear exactly who is doing what. Each agent returns a structured completion record, and the orchestrator checks that intent and result line up. A failed subagent is handled by the Failure Recovery Loop (retry → fallback → debugger escalation), and spawn depth, concurrency caps, and per-agent budgets are all enforced so no delegation can ever run away.

This control is **mechanical, not merely procedural** — it does not stop at writing rules into prompts and hoping they are followed.

Lifecycle hooks intercept every tool call, the monitor observes every event, and outcome records make every delegation traceable and auditable. Hook-backed enforcement, full observability, and a closed learning loop — that combination is exactly what separates this from an uncontrolled handoff system.

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

## Big tasks carefully, small tasks fast

The system **decides for itself which steps to take, sized to the task.** You do not have to tell it, step by step, to "proceed carefully."

- **Big, complex tasks** — it follows a careful flow on its own: **plan → check that the plan is sound → build it → test that it works → confirm it is done and wrap up.**
- **Small tasks** — it skips this procedure and handles them fast.

Which path it takes is the system's own call, based on the task's size and complexity. A "workflow" refers to how those steps are executed — if you explicitly ask it to "proceed as a workflow," an automated engine bundles the same steps and runs them in one pass instead of you triggering each one by hand. The steps it goes through are the same on either path; only the way they run changes.

> In one line: **what it goes through is decided automatically by task size, and only how it executes is optional.**

## What's inside

- **Fleet of specialist agents** — routed by a capability registry (`agent-registry.json`), not by keyword (developers per stack, QA, planning · research · reporting, design · audio, security, wiki, meta).
- **Layered rule system** — a global charter (`agents/GLOBAL_RULES.md`), core cross-cutting rules (`rules/`), and per-scope rules (`scoped/`) bound together by an explicit compliance matrix.
- **Lifecycle hook pipeline** — a collection of hook scripts (`hooks/`) that mechanically enforce secrets, dangerous commands, budgets, and outcome records at every tool boundary.
- **Self-improvement loop** — the autoagent daemon (`autoagent/`) turns accumulated outcome records and correction signals into agent-instruction patches, auto-applying only the safe ones. The original is set aside before each apply and restored as-is if anything goes wrong.
- **Atrium Monitor** — a 10-screen real-time dashboard on Fastify 5 + Prisma 7 + React 18 (`http://127.0.0.1:7842`).
- **Editable models + budget assignments** — the monitor's **Models & budgets** screen assigns a per-domain model and a per-call USD hard cap without editing the config file.
- **Live architecture map** — the monitor's System map screen renders the 7 maintained Mermaid diagrams together with live daemon status.
- **Wiki knowledge store** — an LLM-only store (`wiki/`) with a raw-source → curated-notes pipeline and a SQLite BM25 full-text search index. The research agents' web findings accumulate here, and it is consulted first before a new research or analysis task to reuse existing knowledge.
- **Internal agent skills** — progressive-disclosure `SKILL.md` packages the agents and orchestrator invoke automatically (see [Skills](#skills-the-internal-quality-layer)).
- **Per-file symlink farm install** — idempotently creates `~/.claude/<rel>` → `~/.glass-atrium/<rel>` symlinks at the file (not directory) level, so they can coexist with user-owned files.
- **8 background daemons** — `com.glass-atrium.*` launchd jobs (3 keepalive: monitor · autoagent · wiki; 5 scheduled: log rotation · PG backup · autoagent cycle · wiki compile · daily restart), all declared in `config.toml`. Like heating and ventilation left running all night, they are the building's utility room — designed never to stop, with nobody's hand on the switch.
- **Zero secret material in the repository** — peer-auth-only PostgreSQL (no passwords), secret-scan hooks, a release-gate PII scan.

## Skills: the internal quality layer

Skills in Glass Atrium are **not** user-invoked commands — they are an internal quality and governance layer.

They load globally at session start, and Claude activates them on its own to fit the task at hand. They cover code and design conventions, safety invariants (the "iron laws"), ops and verification gates, and wiki and web tooling, and some fire in response to monitor signals (the System map drift badge, a Models & budgets save, and so on). You never need to know which skill is running — the harness picks and invokes them for you.

## Quickstart

**Prerequisites**: macOS · Claude Code CLI. Everything else is detected and installed automatically by the install TUI, with your consent.

```sh
curl -fsSL https://github.com/bettep-dev/glass-atrium/raw/main/install.sh | bash
```

When the interactive menu opens, choose **Install** — after install, the dependencies and daemons are configured and started automatically, and the dashboard responds at `http://127.0.0.1:7842`.

> **Leave the installed folder where it is.** The installer downloads a release bundle, extracts it into the `~/.glass-atrium` folder, and links it into your Claude config directory as a **per-file symlink farm** (the method described earlier). Because the real files live here, moving or deleting the folder breaks the links.

### Uninstall

Choose **Uninstall** from the menu. It removes the installed symlinks and drops the GA database to cleanly detach the Atrium from your existing Claude system, leaving your own files untouched and no residue behind. Note that **the database is deleted without a backup**, and a reinstall creates a fresh one.

### How to write Atrium Monitor documents

A request for a document, report, summary, or reference is delegated to **intel-reporter**; a request for planning, requirements definition, or task decomposition is delegated to **intel-planner**.

Which format you get **is determined by the wording of your request**:

- the default is a **hidden "agent-only" token-optimized record** on the monitor — chosen from md, yaml, json, or txt depending on the shape of the content. It is an internal record for later reference.
- if you make your share/viewing intent clear — like "**as HTML**," "**as a web document**," or "**for the team to share**" — an **HTML document** a person can view and share is produced (a single file with a dark theme, diagrams, and tables).

Both formats appear on the Atrium Monitor's **Documents** screen.

Examples:

- "Write up a retrospective report on this change" → an agent-only record (the default).
- "Make it an HTML report for the team to share" → an HTML document.

Even when you do not explicitly request a document, an agent-only record may be left behind if it is judged worth recording.

### Adding a dev agent

When you make a request like "Add a development agent that does OOO," the orchestrator does not immediately create a new agent — it first judges **whether to extend an existing agent or create a new one**. **The default is to extend, and creation is allowed only when it passes the gate.**

For creation to be allowed, three conditions must **all be met independently**:

- **a different artifact type** — the files it produces are structurally distinct.
- **a different decision domain** — the expertise needed for correct judgment does not overlap.
- **a non-transferable quality judgment** — one side's quality review cannot be substituted by the other side's expertise alone.

On top of this, if the proposed agent's domain **overlaps with an existing agent by more than a certain ratio, creation is blocked** — heavy overlap is a signal to extend what exists, not to create something new.

Along the way there are **two user-approval pauses**: first the orchestrator lays out its rationale and recommendation to settle create-versus-extend, and then it checks with you once more just before it actually writes to the agent file and the registry.

The body (the system prompt) is authored by **meta-prompt-engineer**, and registration is handled by a dedicated CLI. All you have to do is ask to "add one" — the extend-versus-create judgment and the approval requests are the orchestrator's job.

## Monitor screens

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-dashboard.webp" alt="Dashboard" width="100%"></p>
<p align="center"><em>Dashboard overview — today's cost, the last 30 days of spend, the token-usage trend, and the session and failure counters at a glance.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-cost.webp" alt="Cost & tokens" width="100%"></p>
<p align="center"><em>Cost & tokens — cost KPIs, the 30-day daily cost trend (with spike markers), and a burn-rate forecast.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-agents.webp" alt="Agents" width="100%"></p>
<p align="center"><em>Agents — per-agent run counts, success rates, P95, and trend sparklines.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-learning.webp" alt="Learning" width="100%"></p>
<p align="center"><em>Learning — the self-improvement proposal board (pending/applied/rejected) with confidence and pre-verification results.</em></p>

<p align="center"><img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/screen-system-map.webp" alt="System map" width="100%"></p>
<p align="center"><em>System map — the maintained Mermaid architecture diagrams with a live-status overlay.</em></p>

## License

[MIT](LICENSE) © 2026 Bettep
