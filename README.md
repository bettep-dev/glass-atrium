<!-- banner: https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/banner.webp -->
<p align="center">
  <img src="https://github.com/bettep-dev/glass-atrium/raw/main/docs/assets/banner.webp" alt="Glass Atrium — a self-improving multi-agent harness for Claude Code" width="720">
</p>

**A self-improving, centrally-orchestrated multi-agent harness for Claude Code.**

A single orchestrator watches over and reins in a fleet of specialist agents, and never allows the kind of setup where agents pass work back and forth among themselves until it spirals out of control.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
<!-- CI badge gated until the repo is public and the owner/repo slug is final:
[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml) -->
![Platform: macOS](https://img.shields.io/badge/platform-macOS-black?logo=apple)
![Node 24](https://img.shields.io/badge/node-24.x-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL 14+](https://img.shields.io/badge/PostgreSQL-14%2B-4169E1?logo=postgresql&logoColor=white)
![Made with Claude Code](https://img.shields.io/badge/made%20with-Claude%20Code-D97757)

**English** · [한국어](README.ko.md) · [中文](README.zh.md) · [日本語](README.ja.md)

The orchestrator takes a single request, breaks it apart and hands the pieces to a team of specialist agents, then pulls the results back together. Every cost, outcome, and agent event surfaces on the real-time monitor dashboard — laid bare as if you were looking through a glass wall — and the system revises its own instructions in response to recurring failures, with no prompt tweaking on your part.

> [!WARNING]
> Once installed, background daemons start running **automatically**. Some of them call Claude on a daily schedule, so tokens (and cost) pile up even if you never touch it.
>
> This harness is also a **high-token-usage system**. Because the orchestrator splits a single request across a team of specialist agents, one request fans out into many subagent calls, and token consumption can run to several times that of a single agent.
>
> That said, these tokens are **not** billed per use through a direct Anthropic API connection. The harness runs **on top of the Claude Code CLI** you already subscribe to, so it simply draws on the tokens included in that subscription plan — no separate API key, no metered billing.

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

The "glass atrium" in the name is also a lens for seeing the system. Rather than treat the AI as one clever individual, picture a single glass building — see-through even in the dead of night, running around the clock — a company where many specialists do the work but every piece of it passes through one supervisor at the center. Transparent glass, and a central supervisor through whom every path runs: those two together are the identity the name carries.

On top of that, a default install alone bundles in five things that come together as one coherent system:

- a **capability-routed fleet of specialist agents** (developers per stack, plus QA, planning, research, design, security, wiki, and meta) in place of a single general-purpose prompt;
- a **layered rule system** that spells out, in a matrix, exactly which agent loads which rules;
- a **lifecycle hook pipeline** that enforces those rules (secrets, dangerous commands, budgets, outcomes) *mechanically* at every tool boundary;
- a **real-time monitoring dashboard** (the Atrium Monitor) that gathers every cost, outcome, and agent event in one place;
- a **self-improvement loop** in which the agents rewrite their own instructions to correct recurring failures.

## Why it was built

A single `CLAUDE.md` prompt does not scale. The moment you ask one model to be a React expert *and* a database expert *and* a security reviewer *and* a planner all at once, the instructions start colliding. The rules that actually matter get diluted in a vast wall of text, and under load the model quietly drifts away from them.

So the work has to be divided — a team of specialists beats a lone genius, and once you split the work, each specialist gets a clean memory (context) of its own and can focus on the job in front of it.

The obvious next step — letting agents hand work off to one another — only trades one problem for a bigger one. In an agent-to-agent **handoff** system, control passes from agent A to B, then from B on to C. Each agent is left to enforce its own rules, observability scatters across the chain, and a single misbehaving agent can propagate unchecked, with no one ultimately accountable.

Glass Atrium was built to reap the benefits of specialization without giving up control — and the answer is centralization. What decides success or failure, in this view, is not the model's raw talent but the operating system around it: the harness. Because every specialist runs under continuous central supervision, a slip on one floor never spreads through the whole building.

## The core idea: one orchestrator, not a chain of handoffs

Glass Atrium is built on the **Manager Pattern** (the centralized manager pattern). A single orchestrator — the main Claude Code session — serves as the **strategic control plane**, *decomposing* your intent into sub-tasks, *delegating* each one to a specialist, and *synthesizing* the results. It never writes code or produces artifacts itself.

The opposite model, the **Handoff Pattern** (agents transferring control directly among themselves), is **deliberately not supported** — and that is precisely the point.

In Glass Atrium the orchestrator holds the full context alone and keeps control at every delegation boundary.

Each sub-task is routed by capability rather than keyword (no keyword or alias matching), so it is always clear exactly who is doing what. Each agent returns a structured completion record, and the orchestrator verifies that intent and result line up. A failed subagent is handled by the Failure Recovery Loop (retry → fallback → debugger escalation), while spawn depth, concurrency caps, and per-agent budgets are all enforced so that no delegation can run away. Independent, non-overlapping sub-tasks run in parallel by default, without your having to ask for it.

This control is **mechanical, not merely procedural** — it does not stop at writing rules into a prompt and hoping they hold.

Lifecycle hooks intercept every tool call, the monitor observes every event, and outcome records keep every delegation traceable and auditable. Hook-backed enforcement, full observability, and a closed learning loop — that combination is exactly what sets this apart from an uncontrolled handoff system.

## How it works, end to end

A single request moves through the system like this:

1. **You ask the orchestrator** (the main session) for something — fix a bug, plan a feature, write a report.
2. **The orchestrator investigates and decomposes** the request, then consults the capability registry to assemble a team of specialist agents and an execution order.
3. **It delegates each sub-task** — every delegation clears the **PreToolUse hooks** (dangerous-command blocking, secret scanning, scope-drift flagging, plan-verification gate) *before* the action actually runs.
4. **The specialist agent does the work** — within its own scope rules, injected by the **SubagentStart hook**, and within enforced spawn, turn, and tool budgets. Rather than being cut off abruptly when a budget runs out, a long task records its progress and pauses in a resumable state.
5. **Outcomes are recorded.** Each agent emits a `[COMPLETION]` block, and the **PostToolUse hook** captures it as an Outcome Record.
6. **The orchestrator synthesizes** — folding the verified results into one answer, or running the recovery loop when something fails.
7. **Everything is observable.** Every cost, outcome, and agent event streams into PostgreSQL and the Atrium Monitor in real time.
8. **The system improves itself.** A background daemon reads the outcome records and correction signals and patches the agent instructions automatically — without you editing a single line of any prompt.

## Big tasks carefully, small tasks fast

The system **decides for itself which steps to take, sized to the task.** You never have to spell out, step by step, that it should "proceed carefully."

- **Big, complex tasks** — it walks through a careful flow on its own: **plan → check that the plan holds up → build it → test that it works → confirm it's done and wrap up.**
- **Small tasks** — it skips that procedure and handles them fast.

Which path it takes is the system's own call, based on the size and complexity of the task. A "workflow" refers to how those steps are executed — if you explicitly ask it to "proceed as a workflow," an automation engine bundles the same steps and runs them in one pass instead of you triggering each one by hand. The steps it goes through are the same either way; all that changes is how they run.

> In one line: **which steps you go through is set automatically by task size, and only how they execute is up to you.**

## What's inside

- **Fleet of specialist agents** — routed by a capability registry (`agent-registry.json`) rather than by keyword (developers per stack, plus QA, planning · research · reporting, design · audio, security, wiki, and meta).
- **Layered rule system** — a global charter (`agents/GLASS_ATRIUM_GLOBAL_RULES.md`), core cross-cutting rules (`rules/`), and per-scope rules (`scoped/`), all bound together by an explicit compliance matrix.
- **Lifecycle hook pipeline** — a set of hook scripts (`hooks/`) that mechanically enforce secrets, dangerous commands, budgets, and outcome records at every tool boundary.
- **Self-improvement loop** — the autoagent daemon (`autoagent/`) turns accumulated outcome records and correction signals into agent-instruction patches, auto-applying only the safe ones. It sets the original aside before each apply and restores it as-is if anything goes wrong. Separately from those instruction patches, whenever a new task starts it injects the success and failure patterns learned earlier straight into that agent's session, so they are reused right away.
- **Atrium Monitor** — a 10-screen real-time dashboard built on Fastify 5 + Prisma 7 + React 18 (`http://127.0.0.1:16145`).
- **Direct model + budget assignment** — the monitor's **Models & budgets** screen assigns a per-domain model and a per-call USD hard cap without your having to edit the config file.
- **Live architecture map** — the monitor's System map screen renders the 7 maintained Mermaid diagrams alongside live daemon status.
- **Wiki knowledge store** — an LLM-only store (`wiki/`) with a raw-source → curated-notes pipeline and a SQLite BM25 full-text search index. The research agents' web findings accumulate here, and it is consulted first — ahead of any new research or analysis — to reuse existing knowledge.
- **Internal agent skills** — progressive-disclosure `SKILL.md` packages that the agents and orchestrator invoke automatically (see [Skills](#skills-the-internal-quality-layer)).
- **Per-file symlink farm install** — idempotently creates `~/.claude/<rel>` → `~/.glass-atrium/<rel>` symlinks at the file level, not the directory level, so they coexist with user-owned files without conflict.
- **8 background daemons** — `com.glass-atrium.*` launchd jobs (3 keepalive: monitor · autoagent · wiki; 5 scheduled: log rotation · PG backup · autoagent cycle · wiki compile · daily restart), all declared in `config.toml`. Like heating and ventilation left running through the night, they are the building's utility room — designed never to stop, with nobody's hand on the switch.
- **Zero secret material in the repository** — peer-auth-only PostgreSQL (no passwords), secret-scan hooks, and a release-gate PII scan.

## Skills: the internal quality layer

Skills in Glass Atrium are **not** user-invoked commands — they are an internal quality and governance layer.

They load globally at session start, and Claude activates them on its own to suit the task at hand. They cover code and design conventions, safety invariants (the "iron laws"), ops and verification gates, and wiki and web tooling, and some fire in response to monitor signals (the System map drift badge, a Models & budgets save, and so on). You never need to know which skill is running — the harness picks and invokes them for you.

## Quickstart

**Prerequisites**: macOS · Claude Code CLI. Everything else is detected and installed automatically by the install TUI, with your consent.

```sh
curl -fsSL https://github.com/bettep-dev/glass-atrium/raw/main/install.sh | bash
```

When the interactive menu opens, choose **Install** — once it finishes, the dependencies and daemons are configured and started automatically, and the dashboard is reachable at `http://127.0.0.1:16145`.

> **Leave the installed folder where it is.** The installer downloads a release bundle, unpacks it into the `~/.glass-atrium` folder, and links it into your Claude config directory through a **per-file symlink farm** (the method described earlier). The real files live here, so moving or deleting the folder breaks the links.

### Uninstall

Choose **Uninstall** from the menu. It removes the installed symlinks and drops the GA database to cleanly detach the Atrium from your existing Claude system, leaving your own files untouched and no residue behind. Note that **the database is backed up before it is deleted** (the dump is kept in `~/.claude/backups/postgres/`), and a reinstall creates a fresh one. The backup is not restored automatically — if you need the old data, restore it yourself with `pg_restore`.

### How to write Atrium Monitor documents

A request for a document, report, summary, or reference goes to **glass-atrium-intel-reporter**; a request for planning, requirements definition, or task decomposition goes to **glass-atrium-intel-planner**.

Which format you get **comes down to how you word the request**:

- the default is a **hidden "agent-only," token-optimized record** on the monitor — chosen from md, yaml, json, or txt depending on the shape of the content. It is an internal record for later reference.
- if you make your intent to share or read it plain — say "**as HTML**," "**as a web document**," or "**for the team to share**" — you get an **HTML document** a person can view and share (a single file with a dark theme, diagrams, and tables).

Both formats show up on the Atrium Monitor's **Documents** screen, where a document can move between in-progress and done, and a new document on the same topic can replace an earlier one.

Even when you do not explicitly ask for a document, an agent-only record may be left behind if it is judged worth keeping.

### Adding a dev agent

When you make a request like "Add a development agent that does OOO," the orchestrator does not rush to create a new agent — it first judges **whether to extend an existing agent or create a new one**. **The default is to extend; creation is allowed only when it clears the gate.**

For creation to be allowed, three conditions must **all be met independently**:

- **a different artifact type** — the files it produces are structurally distinct.
- **a different decision domain** — the expertise needed to judge correctly does not overlap.
- **a non-transferable quality judgment** — one side's quality review cannot be stood in for by the other side's expertise alone.

On top of this, if the proposed agent's domain **overlaps with an existing agent beyond a certain ratio, creation is blocked** — heavy overlap is a signal to extend what already exists, not to spin up something new.

Along the way there are **two user-approval pauses**: first the orchestrator lays out its rationale and recommendation to settle create-versus-extend, and then it checks with you once more just before it actually writes to the agent file and the registry.

The body (the system prompt) is authored by **glass-atrium-meta-prompt-engineer**, and registration is handled by a dedicated CLI. All you have to do is ask to "add one" — the extend-versus-create judgment and the approval requests are the orchestrator's job.

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
