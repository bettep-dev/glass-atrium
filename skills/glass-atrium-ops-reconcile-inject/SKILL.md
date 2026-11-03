---
name: glass-atrium-ops-reconcile-inject
description: Reconcile the tracked roster arrays (BUDGET_DEV_AGENTS, STYLEREF_AGENTS) with the DEV roster by running the agent_lifecycle sync-inject CLI after a DEV agent is added or deleted. Use when a DEV agent was just registered or deleted (including when a lifecycle result or CLI NOTE names this skill), when asked to sync the roster arrays, when a DEV agent is missing its BUDGET-DEV sizing block or style_ref flag, or via /glass-atrium-ops-reconcile-inject. Do NOT use for model/budget config or an agent whose scope-RULE membership looks wrong (a registry or selector problem).
---

# Reconcile the tracked roster arrays

One transactional `agent_lifecycle sync-inject` run inserts every missing DEV roster member into the tracked arrays and removes every stale name.

## When to Use

- After a DEV agent add (insert path) or delete (remove path): the add CLI prints a NOTE naming this skill, and an agent-delete commit result names it in `skill_to_run`.

### Exclusions

- Model / token-budget configuration → the monitor Models & budgets screen.
- An agent whose scope-RULE membership looks wrong → not this skill; start with `python3 -m agent_lifecycle orphan-scan --mode rules-membership-mismatch` (why: `## The gap this closes` → **Not the scope-RULE gap.**).

## The gap this closes

- **Not the scope-RULE gap.** `build_entry` records per-agent rule membership on the `agent-registry.json` row (`rules`) at ADD time, and the part slots deliver those rule files from it.
  - A run for a wrong-looking rule membership would report already-in-sync and prove nothing.
- **STYLEREF_AGENTS** — the whole DEV roster, declared in `hooks/lib/styleref-roster.sh`.
  - It is the `style_ref` `review_flag` predicate roster, not an injection roster: a DEV agent missing here never has its `style_ref` omission flagged.
- **BUDGET_DEV_AGENTS** — declared in `hooks/inject-scope-rules.sh`; each member receives the BUDGET-DEV sizing block.
  - Membership is the DEV roster minus `_BUDGET_DAEMON_CARRIERS` (`scripts/agent_lifecycle/inject_sync.py`), a constant that changes only by manual governance.
  - Why: each carrier keeps a daemon-owned in-body budget bullet, so injecting the block too would double-deliver.
- **Untracked rosters** — `BUDGET_ANALYSIS_AGENTS` and `WIKI_UNTRUSTED_AGENTS` are governance memberships, not roster-derivable, so every run leaves them byte-identical.

## Core Process

### Step 1 — Run the reconcile CLI

- Invoke the `agent_lifecycle` package as a module from the `scripts/` directory, its package root, not the repo root.
- Normal operator use takes no flags and no agent name: the package resolves the GA root and derives membership from the DEV roster in `scoped/scope-dev.md`.

```bash
cd ~/.glass-atrium/scripts && python3 -m agent_lifecycle sync-inject
```

- **Argument ordering (only for a test run against a disposable temp copy of the tree)**: `--ga-root` is a global flag and MUST precede the subcommand — `python3 -m agent_lifecycle --ga-root DIR sync-inject`, never `sync-inject --ga-root DIR`, which fails as a usage error (exit 2).

### Step 2 — Read what it reports

- **Already in sync** — prints `sync-inject: already in sync (no names inserted or removed).`.
  - Nothing is written, so re-running the skill is safe.
- **Names reconciled** — prints each name inserted and/or removed under its array (`[STYLEREF_AGENTS]` / `[BUDGET_DEV_AGENTS]`) and a `backup:` line.
  - Only a file whose array needs a change is written, with a `.bak` beside it.
  - Only the first `.bak` is printed: when both files changed, the printed path is the hook's, and a second `.bak` sits beside `hooks/lib/styleref-roster.sh`.
- A stderr `WARNING: agent roster drift` after exit 0 does not fail the reconcile: it flags the Scope Legend row in `core-compliance-matrix.md`, a manual doc update a freshly added agent always lacks.

### Step 3 — Report the outcome + exit code

- Relay the outcome to the user per `## Output Format`.
- Never present the run as having fixed an agent's scope-RULE membership: what it fixes is the BUDGET-DEV roster and the `style_ref` flag roster.
- Exit-code contract, owned by `cli.py`:

| Exit | Meaning |
|---|---|
| `0` | success — names reconciled, or already in sync |
| `2` | usage error — nothing ran |
| `4` | halted before any write — a precondition was not met (e.g. a store could not be read) |
| `5` | transaction failed mid-write — every touched file was restored to its pre-run text |
| `6` | the restore itself failed — a touched file may be partial; escalate: compare each `.bak` with its live file |

## Output Format

- The outcome (reconciled, already in sync or failed), the exit code, the names inserted and removed per array, and every `.bak` path when a write occurred.

## Prohibitions

- **No in-session array edit** — never edit `hooks/inject-scope-rules.sh` or `hooks/lib/styleref-roster.sh` via in-session Edit/Write/sed. The only sanctioned mutation path is the CLI subprocess (`.bak` backup + atomic write + rollback).
  - Backing: `hooks/enforce-harness-critical.sh` blocks in-session writes under the live `~/.glass-atrium/hooks/`.
